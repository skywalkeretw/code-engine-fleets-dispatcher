/**
 * lib/cos.ts — IBM COS S3 client
 *
 * Credentials are resolved from the CE project's persistent data stores at runtime.
 * Supports presigned PUT URLs (primary) and multipart upload (fallback).
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { HmacCredentials } from './ce'

// Part size for multipart: 8 MB (well within COS limits)
const PART_SIZE = 8 * 1024 * 1024

function makeClient(creds: HmacCredentials): S3Client {
  return new S3Client({
    region: 'us-east-1',          // required by SDK; IBM COS ignores it
    endpoint: creds.endpoint,
    // Recent SDK versions add CRC32 checksum headers/query params by default, which
    // IBM COS can reject (notably on presigned PUTs). Only compute them when required.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
    },
    forcePathStyle: true,          // IBM COS requires path-style
  })
}

// ── Presigned URL ──────────────────────────────────────────────────────────

export async function createPresignedPutUrl(
  creds: HmacCredentials,
  bucket: string,
  key: string,
  contentType = 'application/octet-stream',
  expiresIn = 3600
): Promise<string> {
  const client = makeClient(creds)
  const cmd = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType })
  return getSignedUrl(client, cmd, { expiresIn })
}

// ── Simple PutObject ───────────────────────────────────────────────────────

export async function putObject(
  creds: HmacCredentials,
  bucket: string,
  key: string,
  body: Buffer | Uint8Array | string,
  contentType = 'application/octet-stream'
): Promise<void> {
  const client = makeClient(creds)
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: typeof body === 'string' ? Buffer.from(body) : body,
    ContentType: contentType,
  }))
}

// ── GetObject ─────────────────────────────────────────────────────────────

export async function getObject(
  creds: HmacCredentials,
  bucket: string,
  key: string
): Promise<Buffer | null> {
  const client = makeClient(creds)
  try {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    if (!res.Body) return null
    const chunks: Uint8Array[] = []
    // @ts-expect-error Body is a Node.js ReadableStream in the S3 SDK
    for await (const chunk of res.Body) chunks.push(chunk as Uint8Array)
    return Buffer.concat(chunks)
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'NoSuchKey') return null
    throw err
  }
}

// ── Multipart Upload (streaming from a ReadableStream) ────────────────────

export async function multipartUpload(
  creds: HmacCredentials,
  bucket: string,
  key: string,
  stream: ReadableStream<Uint8Array>,
  contentType = 'application/octet-stream'
): Promise<void> {
  const client = makeClient(creds)
  const init = await client.send(new CreateMultipartUploadCommand({
    Bucket: bucket, Key: key, ContentType: contentType,
  }))
  const uploadId = init.UploadId!

  const parts: { PartNumber: number; ETag: string }[] = []
  let partNumber = 1
  let buffer = Buffer.alloc(0)

  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (value) buffer = Buffer.concat([buffer, value])

      // Flush a part when we have enough data or the stream is done
      while (buffer.length >= PART_SIZE || (done && buffer.length > 0)) {
        const slice = buffer.slice(0, Math.min(PART_SIZE, buffer.length))
        buffer = buffer.slice(slice.length)
        const part = await client.send(new UploadPartCommand({
          Bucket: bucket, Key: key, UploadId: uploadId,
          PartNumber: partNumber, Body: slice,
        }))
        parts.push({ PartNumber: partNumber, ETag: part.ETag! })
        partNumber++
        if (buffer.length === 0) break
      }
      if (done) break
    }

    await client.send(new CompleteMultipartUploadCommand({
      Bucket: bucket, Key: key, UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    }))
  } catch (err) {
    await client.send(new AbortMultipartUploadCommand({
      Bucket: bucket, Key: key, UploadId: uploadId,
    })).catch(() => {})
    throw err
  }
}
