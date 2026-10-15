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

/** Log a COS presign or upload call from a route handler.
 *  auth: 'hmac' (default) uses AWS4-HMAC-SHA256; 'trusted-profile' uses Bearer token.
 */
export function logCosCall(
  label: string,
  method: ApiLogEntry['method'],
  url: string,
  extra?: string,
  auth: 'hmac' | 'trusted-profile' = 'hmac'
): void {
  const authHeader = auth === 'trusted-profile'
    ? '-H "Authorization: Bearer $TOKEN"'
    : '-H "Authorization: AWS4-HMAC-SHA256 ..."'
  logCall({
    method,
    service: 'COS',
    label,
    url,
    curl: `curl -X ${method} \\\n  "${url}" \\\n  ${authHeader}${extra ? ` \\\n  ${extra}` : ''}`,
  })
}

/**
 * Log an IAM event (called from iam.ts).
 * - 'trusted-profile' : cr-token exchange succeeded
 * - 'apikey'          : API key exchange (no trusted profile configured)
 * - 'apikey-fallback' : trusted profile failed; falling back to API key (visible warning in debug panel)
 */
export function logIamCall(source: 'trusted-profile' | 'apikey' | 'apikey-fallback' = 'apikey'): void {
  const trusted = source === 'trusted-profile'
  const fallback = source === 'apikey-fallback'

  logCall({
    method: 'POST',
    service: 'IAM',
    label: trusted
      ? 'Get IAM access token (trusted profile)'
      : fallback
        ? '⚠ Trusted profile failed — falling back to API key'
        : 'Get IAM access token (API key)',
    url: 'https://iam.cloud.ibm.com/identity/token',
    curl: trusted
      ? `curl -X POST \\
  "https://iam.cloud.ibm.com/identity/token" \\
  -H "Content-Type: application/x-www-form-urlencoded" \\
  -H "Accept: application/json" \\
  -d "grant_type=urn:ibm:params:oauth:grant-type:cr-token" \\
  -d "cr_token=$(cat /var/run/secrets/codeengine.cloud.ibm.com/compute-resource-token/token)" \\
  -d "profile_id=\${TRUSTED_PROFILE_ID}" \\
  | jq .access_token -r`
      : `curl -X POST \\
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
