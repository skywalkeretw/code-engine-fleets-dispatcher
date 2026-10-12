/**
 * app/api/apilog/route.ts
 *
 *   GET /api/apilog                 — returns all buffered entries as JSON
 *   GET /api/apilog?after_id=<n>    — only entries newer than id n (used by the debug panel poll)
 *
 * Only active when DEMO_MODE=true or ENABLE_DEBUG=true.
 */

import { type NextRequest, NextResponse } from 'next/server'
import { isDebugMode } from '@/lib/ce'
import { getRecentCalls } from '@/lib/apilog'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ── GET /api/apilog — snapshot of buffered calls ───────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isDebugMode()) {
    return NextResponse.json({ error: 'Debug mode not enabled' }, { status: 403 })
  }

  const url = new URL(req.url)
  const afterId = url.searchParams.get('after_id')
  const all = getRecentCalls()
  // Filter by id so we never miss entries with the same timestamp
  const entries = afterId ? all.filter(e => e.id > Number(afterId)) : all
  return NextResponse.json(entries)
}
