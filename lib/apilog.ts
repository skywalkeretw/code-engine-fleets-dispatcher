/**
 * lib/apilog.ts — Server-side API call ring buffer
 *
 * Records every outbound CE/COS call so the debug panel can display
 * the exact curl equivalent. Safe to import in both server components
 * and route handlers — never runs in the browser.
 *
 * Storage: module-level ring buffer (max 200 entries, oldest dropped).
 * Consumers: app/api/apilog/route.ts (SSE stream) and GET /api/apilog.
 */

export interface ApiLogEntry {
  id: number
  ts: number           // Date.now()
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  service: 'CE' | 'COS' | 'IAM'
  label: string        // human-readable description
  url: string          // full URL including version
  curl: string         // exact curl command equivalent
}

export interface LogCallInput {
  method: ApiLogEntry['method']
  service: ApiLogEntry['service']
  label: string
  url: string
  curl: string
}

// ── Ring buffer ────────────────────────────────────────────────────────────

const MAX_ENTRIES = 200
let _seq = 0
const _buffer: ApiLogEntry[] = []
const _listeners = new Set<(entry: ApiLogEntry) => void>()

export function logCall(input: LogCallInput): void {
  const entry: ApiLogEntry = { id: ++_seq, ts: Date.now(), ...input }
  _buffer.push(entry)
  if (_buffer.length > MAX_ENTRIES) _buffer.shift()
  for (const fn of _listeners) {
    try { fn(entry) } catch { /* never crash the calling code */ }
  }
}

/** Log a COS presign or upload call from a route handler. */
export function logCosCall(label: string, method: ApiLogEntry['method'], url: string, extra?: string): void {
  logCall({
    method,
    service: 'COS',
    label,
    url,
    curl: `curl -X ${method} \\\n  "${url}" \\\n  -H "Authorization: AWS4-HMAC-SHA256 ..."${extra ? ` \\\n  ${extra}` : ''}`,
  })
}

/** Log the IAM token exchange (called from iam.ts). */
export function logIamCall(): void {
  logCall({
    method: 'POST',
    service: 'IAM',
    label: 'Get IAM access token',
    url: 'https://iam.cloud.ibm.com/identity/token',
    curl: `curl -X POST \\
  "https://iam.cloud.ibm.com/identity/token" \\
  -H "Content-Type: application/x-www-form-urlencoded" \\
  -H "Accept: application/json" \\
  -d "grant_type=urn:ibm:params:oauth:grant-type:apikey" \\
  -d "apikey=\${IBMCLOUD_API_KEY}" \\
  | jq .access_token -r`,
  })
}

// ── Query / subscribe ──────────────────────────────────────────────────────

export function getRecentCalls(since?: number): ApiLogEntry[] {
  if (since === undefined) return [..._buffer]
  return _buffer.filter(e => e.ts > since)
}

export function subscribe(fn: (entry: ApiLogEntry) => void): () => void {
  _listeners.add(fn)
  return () => _listeners.delete(fn)
}
