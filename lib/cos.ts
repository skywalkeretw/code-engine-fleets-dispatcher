/**
 * lib/cos.ts — IBM COS S3 client
 *
 * Authentication model (mirrors lib/iam.ts):
 *
 * PRIMARY (Code Engine deployment):
 *   Trusted profile — resolveCosAccess() builds a bearer-token S3 client. The IAM token
 *   is obtained from lib/iam.ts (no HMAC keys read, nothing to rotate). IAM bearer tokens
 *   cannot sign S3 presigned URLs, so /api/presign returns 501 and uploads always stream
 *   through /api/upload when a trusted profile is configured.
 *
 * FALLBACK (non-Code-Engine container deployments only):
 *   HMAC credentials — used when NO trusted profile is configured. Credentials are read
 *   from the CE project's HMAC secret at runtime (not from env vars). Supports both
 *   presigned PUT URLs and streaming multipart upload.
 *
 * The fallback is NOT triggered silently when a trusted profile is configured but fails.
 * In that case resolveCosAccess() throws, which surfaces the misconfiguration immediately
 * rather than degrading to a less secure credential mode without the operator knowing.
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
 * Resolve how to authenticate against the COS bucket of a project's persistent data store.
 *
 * Trusted profile configured → bearer-token client. Throws if the token exchange or the
 * HeadBucket check fails — this makes misconfiguration visible immediately rather than
 * silently degrading to a different credential mode.
 *
 * No trusted profile → HMAC client. Credentials are read from the CE project's HMAC secret
 * at runtime (the env var IBMCLOUD_API_KEY is used only for the CE API call to read that
 * secret, not for COS).
 */
export async function resolveCosAccess(
  projectId: string,
  region: string,
  bucketName?: string
): Promise<CosAccess> {
  if (isTrustedProfileConfigured()) {
    // Trusted profile is the only auth mode when TRUSTED_PROFILE_ID/NAME is set.
    // Let any error propagate — the operator must fix the profile configuration.
    await getTrustedProfileToken()
    const target = await resolveCosTarget(projectId, region, bucketName)
    const client = makeBearerClient(target)
    // HeadBucket confirms the profile's IAM token can reach this specific bucket.
    // Throws if the COS access policy is missing — fix the trusted profile's IAM roles.
    await client.send(new HeadBucketCommand({ Bucket: target.bucketName }))
    return {
      client,
      bucketName: target.bucketName,
      endpoint: target.endpoint,
      auth: 'trusted-profile',
    }
  }

  // No trusted profile — use HMAC credentials from the CE project's secret store.
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

/** Put a small object. Works with both trusted-profile and HMAC access. */
export async function putObject(
  access: CosAccess,
  key: string,
  body: Buffer | Uint8Array | string,
  contentType = 'application/octet-stream'
): Promise<void> {
  await access.client.send(new PutObjectCommand({
    Bucket: access.bucketName,
    Key: key,
    Body: typeof body === 'string' ? Buffer.from(body) : body,
    ContentType: contentType,
  }))
}

// ── GetObject ─────────────────────────────────────────────────────────────

/** Get an object. Returns null on NoSuchKey. Works with both trusted-profile and HMAC access. */
export async function getObject(
  access: CosAccess,
  key: string
): Promise<Buffer | null> {
  try {
    const res = await access.client.send(new GetObjectCommand({ Bucket: access.bucketName, Key: key }))
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

/** Stream a large object to COS. Works with both trusted-profile and HMAC access. */
export async function multipartUpload(
  access: CosAccess,
  key: string,
  stream: ReadableStream<Uint8Array>,
  contentType = 'application/octet-stream'
): Promise<void> {
  const init = await access.client.send(new CreateMultipartUploadCommand({
    Bucket: access.bucketName, Key: key, ContentType: contentType,
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
        const part = await access.client.send(new UploadPartCommand({
          Bucket: access.bucketName, Key: key, UploadId: uploadId,
          PartNumber: partNumber, Body: slice,
        }))
        parts.push({ PartNumber: partNumber, ETag: part.ETag! })
        partNumber++
        if (buffer.length === 0) break
      }
      if (done) break
    }

    await access.client.send(new CompleteMultipartUploadCommand({
      Bucket: access.bucketName, Key: key, UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    }))
  } catch (err) {
    await access.client.send(new AbortMultipartUploadCommand({
      Bucket: access.bucketName, Key: key, UploadId: uploadId,
    })).catch(() => {})
    throw err
  }
}
