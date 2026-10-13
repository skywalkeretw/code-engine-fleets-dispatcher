/**
 * app/api/presign/route.ts
 *
 * Issues a time-limited presigned PUT URL so the browser can upload directly
 * to IBM COS without routing bytes through this server.
 *
 * Security:
 * - HMAC credentials are derived from the CE project's own secret store.
 *   No hardcoded keys, no public bucket access.
 * - The presigned URL is scoped to a single object key and expires after
 *   PRESIGN_EXPIRY_SECONDS (default 3600 s = 1 h). For large files on slow
 *   connections, increase this value via the env var.
 */

import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { resolveCosCredentials, isDemoMode } from '@/lib/ce'
import { createPresignedPutUrl } from '@/lib/cos'
import { isTrustedProfileConfigured, getTrustedProfileToken } from '@/lib/iam'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Presigned URL lifetime in seconds.
// Override with PRESIGN_EXPIRY_SECONDS env var (e.g. 21600 for 6 h on slow links).
const PRESIGN_EXPIRY_SECONDS = Math.max(
  60,
  parseInt(process.env.PRESIGN_EXPIRY_SECONDS ?? '3600', 10)
)

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json() as {
      key: string
      contentType?: string
      projectId: string
      region: string
      /** COS bucket the user selected — picks the matching persistent data store/HMAC secret */
      bucket?: string
    }
    const { key, contentType = 'application/octet-stream', projectId, region, bucket } = body

    if (!key || !projectId || !region) {
      return NextResponse.json({ error: 'key, projectId, region required' }, { status: 400 })
    }

    if (isDemoMode()) {
      // Demo mode: return a dummy URL — the browser will attempt PUT which fails,
      // triggering the /api/upload SSE fallback (which is also a no-op in demo mode).
      return NextResponse.json({ url: 'https://demo.invalid/presigned-url', bucket: 'demo-bucket', key })
    }

    // Trusted profile active: presigned URLs can only be signed with HMAC keys, which this
    // mode deliberately never reads. 501 makes the browser use the /api/upload route, which
    // authenticates to COS with the trusted profile's IAM token instead.
    if (isTrustedProfileConfigured() && await getTrustedProfileToken().then(() => true, () => false)) {
      return NextResponse.json(
        { error: 'Presigned URLs are unavailable with trusted profile auth; use /api/upload' },
        { status: 501 }
      )
    }

    // Backup: credentials come from the CE project's HMAC secret — always private, never public
    const creds = await resolveCosCredentials(projectId, region, bucket)
    const url   = await createPresignedPutUrl(creds, creds.bucketName, key, contentType, PRESIGN_EXPIRY_SECONDS)
    return NextResponse.json({ url, bucket: creds.bucketName, key, expiresIn: PRESIGN_EXPIRY_SECONDS })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
