/**
 * lib/cos.ts — IBM COS S3 client
 *
 * Two authentication modes (see resolveCosAccess):
 * - Trusted profile (preferred): requests carry an IAM bearer token obtained via lib/iam.ts.
 *   No HMAC secret is read. Bearer tokens cannot sign presigned URLs, so uploads go
 *   through the server (/api/upload).
 * - HMAC (backup): credentials from the CE project's HMAC secret. Supports presigned
 *   PUT URLs and multipart upload.
 */

import {
  S3Client,
  type S3ClientConfig,
  HeadBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { resolveCosCredentials, resolveCosTarget } from './ce'
import type { HmacCredentials, CosTarget } from './ce'
import { getTrustedProfileToken, isTrustedProfileConfigured } from './iam'

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

/**
 * S3 client that authenticates with an IAM bearer token instead of an AWS4 signature.
 * The token is fetched per request (cached in lib/iam.ts) so long uploads keep working
 * across token expiry.
 */
function makeBearerClient(target: CosTarget): S3Client {
  // RequestSigner (the object form of S3ClientConfig['signer']), derived to avoid a
  // direct dependency on @smithy/types.
  type Signer = Exclude<NonNullable<S3ClientConfig['signer']>, (...args: never[]) => unknown>
  const signer: Signer = {
    sign: async (request) => {
      request.headers['authorization'] = `Bearer ${await getTrustedProfileToken()}`
      return request
    },
  }

  return new S3Client({
    region: 'us-east-1',
    endpoint: target.endpoint,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    // Placeholder identity: the SDK requires one, but the custom signer below ignores it.
    credentials: { accessKeyId: 'iam', secretAccessKey: 'iam' },
    signer: async () => signer,
    forcePathStyle: true,
  })
}

// ── Access resolution ──────────────────────────────────────────────────────

export interface CosAccess {
  client: S3Client
  bucketName: string
  endpoint: string
  auth: 'trusted-profile' | 'hmac'
  /** Only set for auth === 'hmac' (needed for presigned URLs). */
  creds?: HmacCredentials
}

/**
 * Resolve how to talk to the bucket behind a project's persistent data store.
 * Trusted profile first; falls back to the HMAC secret when no trusted profile is
 * configured or its token exchange fails.
 */
export async function resolveCosAccess(
  projectId: string,
  region: string,
  bucketName?: string
): Promise<CosAccess> {
  if (isTrustedProfileConfigured()) {
    try {
      await getTrustedProfileToken()
      const target = await resolveCosTarget(projectId, region, bucketName)
      const client = makeBearerClient(target)
      // Confirm the profile can actually reach the bucket (needs a COS access policy);
      // otherwise the HMAC backup below is used.
      await client.send(new HeadBucketCommand({ Bucket: target.bucketName }))
      return {
        client,
        bucketName: target.bucketName,
        endpoint: target.endpoint,
        auth: 'trusted-profile',
      }
    } catch (err) {
      console.warn(
        `Trusted profile COS access unavailable, falling back to HMAC secret: ` +
        `${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  const creds = await resolveCosCredentials(projectId, region, bucketName)
  return {
    client: makeClient(creds),
    bucketName: creds.bucketName,
    endpoint: creds.endpoint,
    auth: 'hmac',
    creds,
  }
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
