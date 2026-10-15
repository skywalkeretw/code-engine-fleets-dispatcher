/**
 * lib/iam.ts — IBM Cloud IAM token manager
 *
 * Authentication model
 * ────────────────────
 * PRIMARY (Code Engine deployment):
 *   Trusted profile — no stored credential, no rotation needed.
 *   Code Engine mounts a compute resource token at the path below when
 *   --trusted-profiles-enabled=true is set on the application. That token is
 *   exchanged for an IAM access token of the named/ID'd trusted profile.
 *   The same IAM token is used for BOTH the Code Engine API and IBM COS.
 *   Configure: TRUSTED_PROFILE_ID  (preferred, stable)
 *           or TRUSTED_PROFILE_NAME (alternative)
 *   Grant type: urn:ibm:params:oauth:grant-type:cr-token
 *
 * FALLBACK (non-Code-Engine container deployments only):
 *   API key — used when no trusted profile is configured.
 *   Configure: IBMCLOUD_API_KEY
 *   Grant type: urn:ibm:params:oauth:grant-type:apikey
 *
 *   The API key fallback is also triggered (with a logged warning) if a trusted
 *   profile IS configured but the token exchange fails at runtime — this guards
 *   against misconfiguration silently breaking the app. Both the server log and
 *   the API debug panel display a "⚠ Trusted profile failed" entry when this
 *   happens.
 *
 * Tokens are cached per source and refreshed 60 s before expiry.
 * Endpoint: POST https://iam.cloud.ibm.com/identity/token
 */

import { readFile } from 'node:fs/promises'
import { logIamCall } from './apilog'

export type TokenSource = 'trusted-profile' | 'apikey'

interface TokenCache {
  token: string
  expiresAt: number // unix ms
}

const caches: Record<TokenSource, TokenCache | null> = { 'trusted-profile': null, apikey: null }
const inflight: Record<TokenSource, Promise<string> | null> = { 'trusted-profile': null, apikey: null }

/** Where Code Engine mounts the compute resource token (overridable for local testing). */
const DEFAULT_CR_TOKEN_FILE = '/var/run/secrets/codeengine.cloud.ibm.com/compute-resource-token/token'

function crTokenFile(): string {
  return process.env.CR_TOKEN_FILE_PATH?.trim() || DEFAULT_CR_TOKEN_FILE
}

/** Trusted profile selector: an ID takes precedence over a name. */
function trustedProfile(): { param: 'profile_id' | 'profile_name'; value: string } | null {
  const id = process.env.TRUSTED_PROFILE_ID?.trim()
  if (id) return { param: 'profile_id', value: id }
  const name = process.env.TRUSTED_PROFILE_NAME?.trim()
  if (name) return { param: 'profile_name', value: name }
  return null
}

export function isTrustedProfileConfigured(): boolean {
  return trustedProfile() !== null
}

/** Token for the trusted profile only (no API key fallback). Throws if unavailable. */
export function getTrustedProfileToken(): Promise<string> {
  return getToken('trusted-profile')
}

/**
 * Token for all IBM Cloud API calls (CE and COS): trusted profile first, API key as backup.
 *
 * On Code Engine with TRUSTED_PROFILE_ID/NAME set this always returns the trusted-profile
 * token. The API key path is only reached when:
 *   a) No trusted profile is configured (non-Code-Engine deployment), or
 *   b) The profile is configured but the token exchange fails at runtime
 *      (misconfiguration guard — a warning is logged to both the server console
 *      and the API debug panel so the operator can see it).
 */
export async function getIamToken(): Promise<string> {
  if (!isTrustedProfileConfigured()) return getToken('apikey')

  try {
    return await getToken('trusted-profile')
  } catch (err) {
    if (!process.env.IBMCLOUD_API_KEY) throw err
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`Trusted profile token exchange failed, falling back to IBMCLOUD_API_KEY: ${msg}`)
    // Surface the fallback as a visible warning in the API debug panel
    logIamCall('apikey-fallback')
    return getToken('apikey')
  }
}

function getToken(source: TokenSource): Promise<string> {
  const cached = caches[source]
  if (cached && cached.expiresAt - Date.now() > 60_000) return Promise.resolve(cached.token)
  const pending = inflight[source]
  if (pending) return pending
  const request = (source === 'trusted-profile' ? fetchTrustedProfileToken() : fetchApiKeyToken())
    .finally(() => { inflight[source] = null })
  inflight[source] = request
  return request
}

async function fetchApiKeyToken(): Promise<string> {
  const key = process.env.IBMCLOUD_API_KEY
  if (!key) throw new Error('IBMCLOUD_API_KEY is not set')

  logIamCall('apikey')
  return requestToken('apikey', new URLSearchParams({
    grant_type: 'urn:ibm:params:oauth:grant-type:apikey',
    apikey: key,
  }))
}

// NOTE: This implements the same IAM cr-token exchange as ContainerAuthenticator from
// ibm-cloud-sdk-core, without importing that dependency (the dispatcher uses Next.js +
// AWS SDK v3 and has no other use for the IBM Cloud SDK Core).
// Reference implementation: trusted-profiles/node/main.js
// IAM grant type: https://cloud.ibm.com/docs/account?topic=account-iamtoken_from_apikey
async function fetchTrustedProfileToken(): Promise<string> {
  const profile = trustedProfile()
  if (!profile) throw new Error('TRUSTED_PROFILE_ID or TRUSTED_PROFILE_NAME is not set')

  let crToken: string
  try {
    crToken = (await readFile(crTokenFile(), 'utf8')).trim()
  } catch {
    throw new Error(
      `Compute resource token not readable at ${crTokenFile()} — ` +
      `enable trusted profiles on the Code Engine application (--trusted-profiles-enabled=true)`
    )
  }
  if (!crToken) throw new Error(`Compute resource token file ${crTokenFile()} is empty`)

  logIamCall('trusted-profile')
  return requestToken('trusted-profile', new URLSearchParams({
    grant_type: 'urn:ibm:params:oauth:grant-type:cr-token',
    cr_token: crToken,
    [profile.param]: profile.value,
  }))
}

async function requestToken(source: TokenSource, body: URLSearchParams): Promise<string> {
  const res = await fetch('https://iam.cloud.ibm.com/identity/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`IAM token fetch (${source}) failed ${res.status}: ${text}`)
  }

  const data = await res.json() as { access_token: string; expiration: number }
  const entry: TokenCache = {
    token: data.access_token,
    expiresAt: data.expiration * 1000, // API returns unix seconds
  }
  caches[source] = entry
  return entry.token
}
