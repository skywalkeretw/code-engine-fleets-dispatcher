/**
 * lib/iam.ts — IBM Cloud IAM token manager
 * Exchanges IBMCLOUD_API_KEY for a bearer token, caches it, refreshes 60s before expiry.
 *
 * Endpoint: POST https://iam.cloud.ibm.com/identity/token
 * grant_type: urn:ibm:params:oauth:grant-type:apikey
 */

import { logIamCall } from './apilog'

interface TokenCache {
  token: string
  expiresAt: number // unix ms
}

let cache: TokenCache | null = null
let inflight: Promise<string> | null = null

export async function getIamToken(): Promise<string> {
  const now = Date.now()
  if (cache && cache.expiresAt - now > 60_000) return cache.token
  if (inflight) return inflight
  inflight = fetchToken().finally(() => { inflight = null })
  return inflight
}

async function fetchToken(): Promise<string> {
  const key = process.env.IBMCLOUD_API_KEY
  if (!key) throw new Error('IBMCLOUD_API_KEY is not set')

  logIamCall()

  const res = await fetch('https://iam.cloud.ibm.com/identity/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'urn:ibm:params:oauth:grant-type:apikey',
      apikey: key,
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`IAM token fetch failed ${res.status}: ${text}`)
  }

  const data = await res.json() as { access_token: string; expiration: number }
  cache = {
    token: data.access_token,
    expiresAt: data.expiration * 1000, // API returns unix seconds
  }
  return cache.token
}
