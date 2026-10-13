/**
 * lib/iam.ts — IBM Cloud IAM token manager
 *
 * Two ways to obtain a bearer token, tried in this order:
 *
 * 1. Trusted profile (preferred, no stored credential)
 *    Code Engine mounts a compute resource token into the container when
 *    "trusted profiles" is enabled on the application. It is exchanged for an IAM
 *    access token of the trusted profile. Enabled by setting TRUSTED_PROFILE_ID or
 *    TRUSTED_PROFILE_NAME.
 *    grant_type: urn:ibm:params:oauth:grant-type:cr-token
 *
 * 2. API key (backup)
 *    Exchanges IBMCLOUD_API_KEY. Used when no trusted profile is configured, or when
 *    the trusted profile exchange fails and an API key is available.
 *    grant_type: urn:ibm:params:oauth:grant-type:apikey
 *
 * Tokens are cached per source and refreshed 60s before expiry.
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
 * Token for CE API calls: trusted profile first, API key as backup.
 */
export async function getIamToken(): Promise<string> {
  if (!isTrustedProfileConfigured()) return getToken('apikey')

  try {
    return await getToken('trusted-profile')
  } catch (err) {
    if (!process.env.IBMCLOUD_API_KEY) throw err
    console.warn(
      `Trusted profile token exchange failed, falling back to IBMCLOUD_API_KEY: ` +
      `${err instanceof Error ? err.message : String(err)}`
    )
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
