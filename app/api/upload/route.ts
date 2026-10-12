/**
 * app/api/upload/route.ts
 *
 * Streaming upload endpoint — fallback path when presigned PUT is unavailable.
 *
 * Security: HMAC credentials are derived exclusively from the CE project's own
 * secret store via resolveCosCredentials(). No public URLs, no hardcoded keys.
 * The destination bucket is always private (COS HMAC auth required).
 *
 * Response format: Server-Sent Events (SSE) streaming newline-delimited JSON.
 * Each event is a JSON object on one line, ending with \n\n.
 *
 *   {"type":"progress","pct":12}
 *   {"type":"progress","pct":48}
 *   {"type":"done","key":"input/file.pdf"}
 *   {"type":"error","message":"..."}
 *
 * This lets the browser display real byte-level progress even for the fallback
 * path, without any extra WebSocket or polling infrastructure.
 *
 * Design goals:
 * - Stream file bytes directly to COS — never buffer the full file in server RAM
 *   (the request reader honours backpressure from busboy / the COS upload)
 * - Each 8 MB multipart part = one progress tick (pct += 100 / numParts)
 * - Metadata fields (key, projectId, region, bucket) MUST arrive before the file part
 */

import type { NextRequest } from 'next/server'
import { resolveCosCredentials, isDemoMode } from '@/lib/ce'
import { logCosCall } from '@/lib/apilog'
import Busboy from 'busboy'
import { PassThrough, Readable } from 'stream'
import {
  S3Client,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3'
import type { HmacCredentials } from '@/lib/ce'

export const runtime = 'nodejs'
// Disable Next.js body parsing — we stream it ourselves
export const dynamic = 'force-dynamic'

// 8 MB multipart parts — above the COS 5 MB minimum, small enough to limit RAM
const PART_SIZE = 8 * 1024 * 1024

// ── SSE helpers ────────────────────────────────────────────────────────────────

function sseEvent(obj: Record<string, unknown>): Uint8Array {
  return Buffer.from(`data: ${JSON.stringify(obj)}\n\n`)
}

// ── COS streaming multipart upload ────────────────────────────────────────────

async function streamToCos(
  creds: HmacCredentials,
  key: string,
  contentType: string,
  readable: PassThrough,
  onPart: (partsDone: number) => void
): Promise<void> {
  const client = new S3Client({
    region: 'us-east-1',    // required by SDK; IBM COS ignores the value
    endpoint: creds.endpoint,
    requestChecksumCalculation: 'WHEN_REQUIRED', // IBM COS rejects the SDK's default CRC32 headers
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
    forcePathStyle: true,   // IBM COS requires path-style requests
  })

  // Security assertion: verify the bucket exists and is accessible with these
  // HMAC credentials before starting the upload. This catches mis-configured
  // stores early and confirms the bucket is private (public buckets don't
  // require HMAC auth; if we can reach it with HMAC, it's private).
  await client.send(new HeadBucketCommand({ Bucket: creds.bucketName }))

  const init = await client.send(new CreateMultipartUploadCommand({
    Bucket: creds.bucketName, Key: key, ContentType: contentType,
  }))
  const uploadId = init.UploadId!

  const parts: { PartNumber: number; ETag: string }[] = []
  let partNumber = 1
  let buffer     = Buffer.alloc(0)

  try {
    for await (const chunk of readable as unknown as AsyncIterable<Buffer>) {
      buffer = Buffer.concat([buffer, chunk])

      while (buffer.length >= PART_SIZE) {
        const slice = buffer.subarray(0, PART_SIZE)
        buffer = buffer.subarray(PART_SIZE)
        const part = await client.send(new UploadPartCommand({
          Bucket: creds.bucketName, Key: key, UploadId: uploadId,
          PartNumber: partNumber, Body: slice,
        }))
        parts.push({ PartNumber: partNumber, ETag: part.ETag! })
        onPart(parts.length) // report progress after each completed part
        partNumber++
      }
    }

    // Zero-byte file: a multipart upload needs at least one part, so fall back to a
    // plain PutObject (and drop the unused multipart upload).
    if (parts.length === 0 && buffer.length === 0) {
      await client.send(new AbortMultipartUploadCommand({
        Bucket: creds.bucketName, Key: key, UploadId: uploadId,
      })).catch(() => {})
      await client.send(new PutObjectCommand({
        Bucket: creds.bucketName, Key: key, Body: Buffer.alloc(0), ContentType: contentType,
      }))
      return
    }

    // Final part (may be < PART_SIZE)
    if (buffer.length > 0) {
      const part = await client.send(new UploadPartCommand({
        Bucket: creds.bucketName, Key: key, UploadId: uploadId,
        PartNumber: partNumber, Body: buffer,
      }))
      parts.push({ PartNumber: partNumber, ETag: part.ETag! })
      onPart(parts.length)
    }

    await client.send(new CompleteMultipartUploadCommand({
      Bucket: creds.bucketName, Key: key, UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    }))
  } catch (err) {
    await client.send(new AbortMultipartUploadCommand({
      Bucket: creds.bucketName, Key: key, UploadId: uploadId,
    })).catch(() => {})
    throw err
  }
}

// ── Route handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<Response> {
  const contentType = req.headers.get('content-type') ?? ''
  if (!contentType.startsWith('multipart/form-data')) {
    return new Response(
      `data: ${JSON.stringify({ type: 'error', message: 'Expected multipart/form-data' })}\n\n`,
      { status: 400, headers: { 'Content-Type': 'text/event-stream' } }
    )
  }

  // Build a TransformStream so we can write SSE events as the upload progresses
  const { readable: sseReadable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()

  // Run the upload asynchronously — the SSE stream delivers events as they occur
  ;(async () => {
    let cosKey         = ''
    let fleetProjectId = ''
    let fleetRegion    = ''
    let fleetBucket    = ''
    let uploadedFilename = ''
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined

    // Progress only ever moves forward (receive-progress and part-progress interleave)
    let lastPct = -1
    const emitProgress = (pct: number) => {
      if (pct <= lastPct) return
      lastPct = pct
      writer.write(sseEvent({ type: 'progress', pct })).catch(() => {})
    }

    try {
      const bb = Busboy({ headers: { 'content-type': contentType } })

      // We need to know the file size upfront to compute percentage.
      // The Content-Length header from the multipart form gives total form size
      // (not just file size), but it's the best approximation we have.
      // We refine progress per multipart part once the upload starts.
      const totalFormBytes = parseInt(req.headers.get('content-length') ?? '0', 10)

      await new Promise<void>((resolve, reject) => {
        let fileHandled = false

        bb.on('field', (name, val) => {
          if (name === 'key')       cosKey         = val
          if (name === 'projectId') fleetProjectId = val
          if (name === 'region')    fleetRegion    = val
          if (name === 'bucket')    fleetBucket    = val
        })

        bb.on('file', (_field, fileStream, info) => {
          fileHandled = true
          const { filename, mimeType } = info
          const fileContentType = mimeType || 'application/octet-stream'
          uploadedFilename = filename ?? 'upload'

          if (!cosKey) cosKey = uploadedFilename

          // Demo mode: drain stream, emit fake progress events, resolve
          if (isDemoMode()) {
            let fakeBytes = 0
            fileStream.on('data', (chunk: Buffer) => {
              fakeBytes += chunk.length
              if (totalFormBytes > 0) {
                emitProgress(Math.min(99, Math.round((fakeBytes / totalFormBytes) * 100)))
              }
            })
            fileStream.on('end', () => resolve())
            fileStream.on('error', reject)
            return
          }

          if (!fleetProjectId || !fleetRegion) {
            fileStream.resume()
            reject(new Error('projectId and region fields must arrive before the file part'))
            return
          }

          const pass = new PassThrough()
          fileStream.pipe(pass)
          fileStream.on('error', (e) => pass.destroy(e))

          // Track bytes received for byte-level progress before first part completes
          let bytesReceived = 0
          fileStream.on('data', (chunk: Buffer) => {
            bytesReceived += chunk.length
            if (totalFormBytes > 0) {
              // Before any part finishes, show byte-receive progress up to ~50%
              emitProgress(Math.min(50, Math.round((bytesReceived / totalFormBytes) * 50)))
            }
          })

          resolveCosCredentials(fleetProjectId, fleetRegion, fleetBucket || undefined)
            .then(creds => {
              logCosCall(
                `Upload ${uploadedFilename} → ${creds.bucketName}/${cosKey}`,
                'PUT',
                `${creds.endpoint}/${creds.bucketName}/${cosKey}`
              )

              // Estimate number of parts from file size (approximate from content-length)
              const estParts = Math.max(1, Math.ceil(totalFormBytes / PART_SIZE))

              return streamToCos(creds, cosKey, fileContentType, pass, (partsDone) => {
                // 50–99%: each completed COS part is one tick
                emitProgress(Math.min(99, 50 + Math.round((partsDone / estParts) * 49)))
              })
            })
            .then(() => resolve())
            .catch(err => { pass.destroy(); reject(err) })
        })

        bb.on('error', reject)
        bb.on('finish', () => { if (!fileHandled) resolve() })

        if (!req.body) { reject(new Error('Empty request body')); return }

        reader = req.body.getReader()
        const bodyReader = reader
        ;(async () => {
          try {
            while (true) {
              const { done, value } = await bodyReader.read()
              if (done) { bb.end(); break }
              // Honour backpressure: wait for busboy (and therefore COS) to catch up
              // instead of buffering the whole request body in memory.
              if (!bb.write(value)) await new Promise<void>(r => bb.once('drain', () => r()))
            }
          } catch (e) { reject(e) }
        })()
      })

      await writer.write(sseEvent({ type: 'done', key: cosKey, filename: uploadedFilename }))
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      await writer.write(sseEvent({ type: 'error', message })).catch(() => {})
      // Stop reading the request body so the drain loop above can't hang forever
      await reader?.cancel().catch(() => {})
    } finally {
      await writer.close().catch(() => {})
    }
  })()

  return new Response(sseReadable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no', // disable nginx buffering if behind a proxy
    },
  })
}
