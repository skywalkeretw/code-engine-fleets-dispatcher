/**
 * lib/ce.ts — IBM Code Engine REST client
 *
 * Key design:
 * - Auth: IAM tokens are obtained via lib/iam.ts.
 *   Preferred: trusted profile (TRUSTED_PROFILE_ID / TRUSTED_PROFILE_NAME) — Code Engine
 *   mounts a compute resource token automatically when the app has trusted profiles
 *   enabled (ibmcloud ce app update --trusted-profiles-enabled=true). No stored credential.
 *   Backup: IBMCLOUD_API_KEY — set it as a CE secret / env var if no trusted profile is used;
 *   also used as an automatic fallback if the trusted profile exchange fails.
 * - CE_REGION is injected automatically by Code Engine; restricts to one region
 *   (use CE_REGIONS to override with a comma-separated list for multi-region testing)
 * - COS bucket + cosPrefix are derived from the fleet's own persistent data stores.
 *   HMAC credentials are retrieved from the CE secret store using the IAM token — no COS
 *   credential needs to be set in the environment.
 * - DEMO_MODE=true simulates all API calls: real code paths execute, log entries are
 *   generated, but no actual HTTP requests are made — safe without any credentials
 * - Every outbound API call is logged via lib/apilog.ts for the debug panel
 *
 * API version: 2025-07-10
 * Reference: https://cloud.ibm.com/apidocs/codeengine
 */

import { getIamToken } from './iam'
import { logCall, logIamCall } from './apilog'

// ── API version ────────────────────────────────────────────────────────────

export const CE_API_VERSION = '2025-07-10'

// ── Types ──────────────────────────────────────────────────────────────────

export interface CeProject {
  id: string
  name: string
  region: string
}

export interface FleetMount {
  mountPath: string
  storeName: string
  subpath?: string
}

export interface Fleet {
  id: string
  name: string
  projectId: string
  projectName: string
  region: string
  status: string
  taskStateStore: string
  subnetPool?: string
  mounts: FleetMount[]
}

export interface PersistentDataStore {
  name: string
  bucketName: string
  bucketRegion: string
  /** COS prefix pre-configured on this store (e.g. "input/"). May be empty. */
  cosPrefix: string
  hmacSecretName: string
}

export interface HmacCredentials {
  accessKeyId: string
  secretAccessKey: string
  endpoint: string
  bucketName: string
  bucketRegion: string
}

/** Where a bucket lives — everything needed to address it except the credentials. */
export interface CosTarget {
  endpoint: string
  bucketName: string
  bucketRegion: string
}

export interface AddTasksResult {
  fleetName: string
  taskCount: number
}

// ── Config ─────────────────────────────────────────────────────────────────

/**
 * Regions to scan for CE projects.
 *
 * Priority:
 * 1. CE_REGION  — single region, injected automatically by IBM Code Engine
 * 2. CE_REGIONS — comma-separated override for local multi-region testing
 * 3. All 10 CE regions (fallback when neither env var is set)
 *
 * In demo mode always uses ['us-south'] to match the synthetic demo fleet.
 */
const ALL_REGIONS = [
  'us-south', 'us-east', 'eu-de', 'eu-gb', 'eu-es',
  'jp-tok', 'jp-osa', 'au-syd', 'br-sao', 'ca-tor',
]

function ceRegions(): string[] {
  if (isDemoMode()) return ['us-south']
  const single = process.env.CE_REGION?.trim()
  if (single) return [single]
  const multi = process.env.CE_REGIONS
  if (multi) return multi.split(',').map(r => r.trim()).filter(Boolean)
  return ALL_REGIONS
}

function ceBase(region: string) {
  // `region` can originate from the browser (server-action / route-handler args).
  // Reject anything that is not a plain region name so the IAM bearer token can
  // never be sent to an attacker-controlled host.
  if (!/^[a-z]{2}-[a-z]+$/.test(region)) throw new Error(`Invalid region: ${region}`)
  return `https://api.${region}.codeengine.cloud.ibm.com/v2`
}

/** Truncate a request body for the debug-log curl string (JSONL bodies can be MBs). */
function curlBody(body: unknown): string {
  const s = JSON.stringify(body)
  return s.length > 2000 ? `${s.slice(0, 2000)}…(truncated, ${s.length} bytes)` : s
}

function withVersion(url: string): string {
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}version=${CE_API_VERSION}`
}

// ── Demo / debug mode flags ────────────────────────────────────────────────

export function isDemoMode(): boolean {
  return process.env.DEMO_MODE === 'true' || process.env.DEMO_MODE === '1'
}

export function isDebugMode(): boolean {
  return isDemoMode() || process.env.ENABLE_DEBUG === 'true' || process.env.ENABLE_DEBUG === '1'
}

// ── Synthetic demo data ────────────────────────────────────────────────────
// Used only as return values in demo mode — the real code path still runs
// so that every log call is generated in the correct sequence.

const DEMO_PROJECT: CeProject = {
  id: 'demo-project-us-abc123',
  name: 'demo-project-us-south',
  region: 'us-south',
}

const DEMO_FLEET: Fleet = {
  id: 'demo-fleet-001',
  name: 'demo-fleet',
  projectId: DEMO_PROJECT.id,
  projectName: DEMO_PROJECT.name,
  region: 'us-south',
  status: 'standby',
  taskStateStore: 'demo-task-store',
  subnetPool: 'default-subnet-pool',
  mounts: [
    { mountPath: '/mnt/input',  storeName: 'input-store'  },
    { mountPath: '/mnt/output', storeName: 'output-store' },
  ],
}

const DEMO_PDS: PersistentDataStore[] = [
  {
    name: 'input-store',
    bucketName: 'demo-bucket',
    bucketRegion: 'us-south',
    cosPrefix: 'input/',
    hmacSecretName: 'demo-hmac-secret',
  },
  {
    name: 'output-store',
    bucketName: 'demo-bucket',
    bucketRegion: 'us-south',
    cosPrefix: 'output/',
    hmacSecretName: 'demo-hmac-secret',
  },
]

// ── In-memory caches ───────────────────────────────────────────────────────
//
// STATELESS CONTAINER DESIGN
// Each container instance maintains its own in-process cache — this is intentional.
// The application is stateless: all authoritative state lives in IBM Code Engine
// (projects, fleets, secrets) and IBM COS (objects). The cache is purely a
// performance optimisation to avoid hammering the CE API on every request within
// a single session. When the container is replaced or scaled horizontally, each
// new instance starts with an empty cache and warms up on first use.
// There is no cross-replica synchronisation needed because:
//   1. CE API is the source of truth — any replica can refresh from it.
//   2. The dispatcher is a low-QPS interactive UI, not a high-throughput API.
//   3. Cache TTL is short (5 min) — staleness window is acceptable.
//
// If you need fleet data to be consistent across replicas within < 5 min,
// replace these Maps with a shared Redis/Memcached cache and set the TTL there.

const projectCache = new Map<string, { projects: CeProject[]; fetchedAt: number }>()
const fleetCache   = new Map<string, { fleets: Fleet[];       fetchedAt: number }>()
const pdsCache     = new Map<string, PersistentDataStore[]>()
// HMAC cache has no TTL — credentials are valid until the CE secret is rotated.
// If a secret rotation is needed, restart the container to clear the cache.
const hmacCache    = new Map<string, HmacCredentials>()
const CACHE_TTL_MS = 5 * 60_000

// ── HTTP helpers ───────────────────────────────────────────────────────────

async function ceGet<T>(url: string, label?: string): Promise<T> {
  const versionedUrl = withVersion(url)

  logCall({
    method: 'GET',
    url: versionedUrl,
    service: 'CE',
    label: label ?? 'GET ' + new URL(versionedUrl).pathname,
    curl: `curl -X GET \\\n  "${versionedUrl}" \\\n  -H "Authorization: Bearer $TOKEN"`,
  })

  if (isDemoMode()) {
    // In demo mode: log the call (done above) but throw so callers know not to use the result.
    // Each caller handles isDemoMode() before calling ceGet, so this is a safety net only.
    throw new Error('DEMO_MODE: ceGet should not be called directly in demo paths')
  }

  const token = await getIamToken()
  // no-store: responses (incl. HMAC secrets) must not land in Next's on-disk fetch
  // cache. In-process caching with a TTL is handled explicitly below.
  const res = await fetch(versionedUrl, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    cache: 'no-store',
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`CE GET ${versionedUrl} → ${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

async function cePost<T>(url: string, body: unknown, label?: string): Promise<T> {
  const versionedUrl = withVersion(url)

  logCall({
    method: 'POST',
    url: versionedUrl,
    service: 'CE',
    label: label ?? 'POST ' + new URL(versionedUrl).pathname,
    curl: `curl -X POST \\\n  "${versionedUrl}" \\\n  -H "Authorization: Bearer $TOKEN" \\\n  -H "Content-Type: application/json" \\\n  -d '${curlBody(body)}'`,
  })

  if (isDemoMode()) {
    throw new Error('DEMO_MODE: cePost should not be called directly in demo paths')
  }

  const token = await getIamToken()
  const res = await fetch(versionedUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`CE POST ${versionedUrl} → ${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

// Log-only helpers for demo mode — emit the correct log entry without making a real request.

function logCeGet(url: string, label: string): void {
  const versionedUrl = withVersion(url)
  logCall({
    method: 'GET',
    url: versionedUrl,
    service: 'CE',
    label,
    curl: `curl -X GET \\\n  "${versionedUrl}" \\\n  -H "Authorization: Bearer $TOKEN"`,
  })
}

function logCePost(url: string, body: unknown, label: string): void {
  const versionedUrl = withVersion(url)
  logCall({
    method: 'POST',
    url: versionedUrl,
    service: 'CE',
    label,
    curl: `curl -X POST \\\n  "${versionedUrl}" \\\n  -H "Authorization: Bearer $TOKEN" \\\n  -H "Content-Type: application/json" \\\n  -d '${curlBody(body)}'`,
  })
}

// ── Paginated list helper ──────────────────────────────────────────────────

async function listAll<T>(baseUrl: string, key: string, label?: string): Promise<T[]> {
  const results: T[] = []
  let start: string | undefined
  do {
    const url = start
      ? `${baseUrl}?limit=100&start=${encodeURIComponent(start)}`
      : `${baseUrl}?limit=100`
    type Page = Record<string, unknown> & { next?: { start: string } }
    const page = await ceGet<Page>(url, label)
    results.push(...((page[key] as T[] | undefined) ?? []))
    start = page.next?.start
  } while (start)
  return results
}

// ── Projects ───────────────────────────────────────────────────────────────

export async function listAllProjects(): Promise<CeProject[]> {
  const regions = ceRegions()
  const now = Date.now()

  if (isDemoMode()) {
    // Log IAM first (would be the first call in a real flow), then CE calls
    logIamCall('trusted-profile')
    for (const region of regions) {
      logCeGet(`${ceBase(region)}/projects?limit=100`, `List projects (${region})`)
    }
    return [DEMO_PROJECT]
  }

  const results = await Promise.allSettled(
    regions.map(async (region) => {
      const cached = projectCache.get(region)
      if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached.projects

      type RawProject = { id: string; name: string }
      const raw = await listAll<RawProject>(
        `${ceBase(region)}/projects`,
        'projects',
        `List projects (${region})`
      )
      const projects: CeProject[] = raw.map(p => ({ id: p.id, name: p.name, region }))
      projectCache.set(region, { projects, fetchedAt: now })
      return projects
    })
  )

  throwIfAllRejected(results)
  return results
    .filter((r): r is PromiseFulfilledResult<CeProject[]> => r.status === 'fulfilled')
    .flatMap(r => r.value)
}

/** If every parallel request failed, surface the first error instead of an empty list. */
function throwIfAllRejected(results: PromiseSettledResult<unknown>[]): void {
  if (results.length === 0) return
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (rejected.length === results.length) {
    const reason = rejected[0].reason
    throw reason instanceof Error ? reason : new Error(String(reason))
  }
}

// ── Fleets ─────────────────────────────────────────────────────────────────

interface RawFleet {
  id: string
  name: string
  status: string
  task_state_store?: { id: string; name: string }
  subnet_pool?: { id: string; name: string }
  persistent_data_store_mounts?: Array<{
    name: string
    mount_path: string
    reference: { name: string }
  }>
}

function parseFleet(raw: RawFleet, project: CeProject): Fleet {
  return {
    id: raw.id,
    name: raw.name,
    projectId: project.id,
    projectName: project.name,
    region: project.region,
    status: raw.status,
    taskStateStore: raw.task_state_store?.name ?? '',
    subnetPool: raw.subnet_pool?.name,
    mounts: (raw.persistent_data_store_mounts ?? []).map(m => ({
      mountPath: m.mount_path,
      storeName: m.reference.name,
    })),
  }
}

export async function listAllFleets(): Promise<Fleet[]> {
  const projects = await listAllProjects()
  const now = Date.now()

  if (isDemoMode()) {
    // Log fleet list + individual fleet GET for each project
    for (const project of projects) {
      logCeGet(
        `${ceBase(project.region)}/projects/${project.id}/fleets?limit=100`,
        `List fleets (${project.name})`
      )
      logCeGet(
        `${ceBase(project.region)}/projects/${project.id}/fleets/${DEMO_FLEET.name}`,
        `Get fleet (${DEMO_FLEET.name})`
      )
    }
    return [DEMO_FLEET]
  }

  const results = await Promise.allSettled(
    projects.map(async (project) => {
      const cached = fleetCache.get(project.id)
      if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached.fleets

      const raw = await listAll<RawFleet>(
        `${ceBase(project.region)}/projects/${encodeURIComponent(project.id)}/fleets`,
        'fleets',
        `List fleets (${project.name})`
      )
      // Individual GET for each fleet to retrieve full detail (mounts, task state
      // store). Falls back to the list entry if the detail call fails.
      const fleets = await Promise.all(raw.map(async f => {
        const detail = await ceGet<RawFleet>(
          `${ceBase(project.region)}/projects/${encodeURIComponent(project.id)}/fleets/${encodeURIComponent(f.name)}`,
          `Get fleet (${f.name})`
        ).catch(() => null)
        return parseFleet({ ...f, ...(detail ?? {}) }, project)
      }))
      fleetCache.set(project.id, { fleets, fetchedAt: now })
      return fleets
    })
  )

  throwIfAllRejected(results)
  return results
    .filter((r): r is PromiseFulfilledResult<Fleet[]> => r.status === 'fulfilled')
    .flatMap(r => r.value)
}

export function invalidateFleetCache() {
  fleetCache.clear()
  projectCache.clear()
}

// ── Persistent Data Stores ─────────────────────────────────────────────────

export async function listPersistentDataStores(
  projectId: string,
  region: string
): Promise<PersistentDataStore[]> {
  if (isDemoMode()) {
    logCeGet(
      `${ceBase(region)}/projects/${projectId}/persistent_data_stores?limit=100`,
      `List persistent data stores (${projectId})`
    )
    return DEMO_PDS
  }

  const cached = pdsCache.get(projectId)
  if (cached) return cached

  type RawPDS = {
    name: string
    cos_bucket_name: string
    cos_bucket_region: string
    cos_prefix?: string
    cos_access_secret: { name: string }
  }
  const raw = await listAll<RawPDS>(
    `${ceBase(region)}/projects/${encodeURIComponent(projectId)}/persistent_data_stores`,
    'persistent_data_stores',
    `List persistent data stores (${projectId})`
  )
  const stores: PersistentDataStore[] = raw.map(p => ({
    name: p.name,
    bucketName: p.cos_bucket_name,
    bucketRegion: p.cos_bucket_region,
    cosPrefix: p.cos_prefix ?? '',
    hmacSecretName: p.cos_access_secret.name,
  }))
  pdsCache.set(projectId, stores)
  return stores
}

// ── HMAC Secrets ───────────────────────────────────────────────────────────

export async function getHmacCredentials(
  projectId: string,
  region: string,
  secretName: string,
  bucketName: string,
  bucketRegion: string
): Promise<HmacCredentials> {
  // Include bucket in the key: several stores can share one HMAC secret but point
  // at different buckets, and the cached object carries the bucket name/endpoint.
  const cacheKey = `${projectId}:${secretName}:${bucketRegion}:${bucketName}`

  if (isDemoMode()) {
    logCeGet(
      `${ceBase(region)}/projects/${projectId}/secrets/${encodeURIComponent(secretName)}`,
      `Get HMAC secret (${secretName})`
    )
    if (hmacCache.has(cacheKey)) return hmacCache.get(cacheKey)!
    const creds: HmacCredentials = {
      accessKeyId:  'DEMO_ACCESS_KEY',
      secretAccessKey: 'DEMO_SECRET_KEY',
      endpoint:     `https://s3.${bucketRegion}.cloud-object-storage.appdomain.cloud`,
      bucketName,
      bucketRegion,
    }
    hmacCache.set(cacheKey, creds)
    return creds
  }

  if (hmacCache.has(cacheKey)) return hmacCache.get(cacheKey)!

  type RawSecret = {
    name: string
    format: string
    data: { access_key_id: string; secret_access_key: string }
  }
  const secret = await ceGet<RawSecret>(
    `${ceBase(region)}/projects/${encodeURIComponent(projectId)}/secrets/${encodeURIComponent(secretName)}`,
    `Get HMAC secret (${secretName})`
  )

  const decode = (v: string) => Buffer.from(v, 'base64').toString('utf8').trim()
  const creds: HmacCredentials = {
    accessKeyId:     decode(secret.data.access_key_id),
    secretAccessKey: decode(secret.data.secret_access_key),
    endpoint:        `https://s3.${bucketRegion}.cloud-object-storage.appdomain.cloud`,
    bucketName,
    bucketRegion,
  }
  hmacCache.set(cacheKey, creds)
  return creds
}

/**
 * Find the persistent data store whose bucket matches `bucketName` (the bucket the
 * user picked in the UI). Falls back to the first store only when no bucket is given.
 */
async function findStore(
  projectId: string,
  region: string,
  bucketName?: string
): Promise<PersistentDataStore> {
  const stores = await listPersistentDataStores(projectId, region)
  if (stores.length === 0) {
    throw new Error(`No persistent data stores found in project ${projectId}`)
  }
  const store = bucketName ? stores.find(s => s.bucketName === bucketName) : stores[0]
  if (!store) {
    throw new Error(`No persistent data store in project ${projectId} uses bucket "${bucketName}"`)
  }
  return store
}

function cosEndpoint(bucketRegion: string): string {
  return `https://s3.${bucketRegion}.cloud-object-storage.appdomain.cloud`
}

/**
 * Resolve the bucket + endpoint for a project WITHOUT reading the HMAC secret.
 * Used with an IAM token (trusted profile) to access COS.
 */
export async function resolveCosTarget(
  projectId: string,
  region: string,
  bucketName?: string
): Promise<CosTarget> {
  const store = await findStore(projectId, region, bucketName)
  return {
    endpoint: cosEndpoint(store.bucketRegion),
    bucketName: store.bucketName,
    bucketRegion: store.bucketRegion,
  }
}

/**
 * Resolve HMAC COS credentials for a project (backup path, and required for
 * presigned URLs). Reads the HMAC secret referenced by the persistent data store.
 */
export async function resolveCosCredentials(
  projectId: string,
  region: string,
  bucketName?: string
): Promise<HmacCredentials> {
  const store = await findStore(projectId, region, bucketName)

  return getHmacCredentials(
    projectId, region,
    store.hmacSecretName,
    store.bucketName,
    store.bucketRegion
  )
}

// ── Add Tasks to Fleet ─────────────────────────────────────────────────────

/**
 * Dispatch tasks to an existing standby fleet.
 *
 * Endpoint: POST /v2/projects/{id}/fleets/{name}/add_tasks
 * Body: { tasks_specification: { tasks_from_content: "<JSONL>" } }
 *
 * Reference: https://cloud.ibm.com/apidocs/codeengine#create-fleet-tasks
 */
export async function addTasksToFleet(
  fleet: Fleet,
  jsonlContent: string
): Promise<AddTasksResult> {
  const taskCount = jsonlContent.trim().split('\n').filter(Boolean).length
  const body = { tasks_specification: { tasks_from_content: jsonlContent } }

  if (isDemoMode()) {
    logCePost(
      `${ceBase(fleet.region)}/projects/${fleet.projectId}/fleets/${encodeURIComponent(fleet.name)}/add_tasks`,
      body,
      `Add tasks to fleet (${fleet.name})`
    )
    await new Promise(r => setTimeout(r, 600))
    return { fleetName: fleet.name, taskCount }
  }

  type RawResult = { fleet?: { name: string }; task_count?: number }
  const result = await cePost<RawResult>(
    `${ceBase(fleet.region)}/projects/${encodeURIComponent(fleet.projectId)}/fleets/${encodeURIComponent(fleet.name)}/add_tasks`,
    body,
    `Add tasks to fleet (${fleet.name})`
  )
  return {
    fleetName: result.fleet?.name ?? fleet.name,
    taskCount: result.task_count ?? taskCount,
  }
}
