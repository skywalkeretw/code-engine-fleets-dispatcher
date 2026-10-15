# Trusted Profile Implementation Review
## `serverless-fleets/fleets-dispatcher` vs. `trusted-profiles/node`

> **Reviewer:** Bob (AI pair-programmer)
> **Date:** 2026-10-15
> **Scope:** Trusted profile auth, API key fallback, HMAC credentials fallback
> **Review pass 2:** 2026-10-15 — all findings addressed; auth model clarified

---

## How to read this document

| Marker | Meaning |
|--------|---------|
| ✅ | Correct, idiomatic, matches the reference example |
| 🟡 | Works, but with a caveat or improvement opportunity |
| 🔴 | Gap or deviation that should be addressed |

---

## 1. Reference pattern — `trusted-profiles/node`

[`trusted-profiles/node/main.js`](../../../trusted-profiles/node/main.js) is the canonical Code Engine Node.js trusted-profile sample. Its approach:

```js
import { ContainerAuthenticator } from 'ibm-cloud-sdk-core';

const authenticator = new ContainerAuthenticator({
    iamProfileName: trustedProfileName
});

const requestOptions = { method: 'GET' };
await authenticator.authenticate(requestOptions);
// requestOptions.headers.Authorization is now set to "Bearer <IAM token>"
```

Key properties of the reference:
- Uses the **official IBM Cloud SDK Core `ContainerAuthenticator`** — this handles reading the compute resource token file, exchanging it at IAM, caching the result, and refreshing before expiry.
- Accepts `iamProfileId` **or** `iamProfileName` (the SDK resolves them internally).
- Requires `TRUSTED_PROFILE_NAME` to be set (fails fast with a clear error if not).
- Does **not** implement any API key fallback — it is a pure trusted-profile sample.

---

## 2. The fleets-dispatcher implementation

The dispatcher implements its own token manager from scratch in [`lib/iam.ts`](../lib/iam.ts), rather than using the SDK Core `ContainerAuthenticator`.

### 2.1 Trusted profile — `fetchTrustedProfileToken()`

```ts
// From lib/iam.ts

const DEFAULT_CR_TOKEN_FILE =
  '/var/run/secrets/codeengine.cloud.ibm.com/compute-resource-token/token'

async function fetchTrustedProfileToken(): Promise<string> {
  const profile = trustedProfile()
  if (!profile) throw new Error('TRUSTED_PROFILE_ID or TRUSTED_PROFILE_NAME is not set')

  let crToken: string
  try {
    crToken = (await readFile(crTokenFile(), 'utf8')).trim()
  } catch {
    throw new Error(`Compute resource token not readable at ${crTokenFile()} — …`)
  }
  if (!crToken) throw new Error(`Compute resource token file ${crTokenFile()} is empty`)

  return requestToken('trusted-profile', new URLSearchParams({
    grant_type: 'urn:ibm:params:oauth:grant-type:cr-token',
    cr_token: crToken,
    [profile.param]: profile.value,   // profile_id OR profile_name
  }))
}
```

This is **functionally equivalent** to `ContainerAuthenticator`. It reads the same token file at the same path, issues the same `cr-token` grant to the same IAM endpoint, and caches the token with proactive refresh 60 s before expiry.

**Reason for custom implementation:** The dispatcher does not use `ibm-cloud-sdk-core` as a dependency (its stack is Next.js + `@aws-sdk/client-s3`). Bringing in the SDK Core solely for `ContainerAuthenticator` would add a heavyweight transitive dependency. The custom implementation is minimal (≈ 50 lines), covers the same contract, and is straightforward to audit.

---

## 3. Findings

### 3.1 ✅ Trusted profile is the preferred, default path

[`lib/iam.ts` `getIamToken()`](../lib/iam.ts:63) checks for a trusted profile first and only falls back to an API key:

```ts
export async function getIamToken(): Promise<string> {
  if (!isTrustedProfileConfigured()) return getToken('apikey')

  try {
    return await getToken('trusted-profile')
  } catch (err) {
    if (!process.env.IBMCLOUD_API_KEY) throw err
    console.warn(`Trusted profile token exchange failed, falling back to IBMCLOUD_API_KEY: …`)
    return getToken('apikey')
  }
}
```

Priority order: **Trusted profile → API key** — correct and aligned with the project goal.

---

### 3.2 ✅ `TRUSTED_PROFILE_ID` takes precedence over `TRUSTED_PROFILE_NAME`

[`lib/iam.ts` `trustedProfile()`](../lib/iam.ts:43):

```ts
function trustedProfile(): { param: 'profile_id' | 'profile_name'; value: string } | null {
  const id = process.env.TRUSTED_PROFILE_ID?.trim()
  if (id) return { param: 'profile_id', value: id }
  const name = process.env.TRUSTED_PROFILE_NAME?.trim()
  if (name) return { param: 'profile_name', value: name }
  return null
}
```

The reference sample only supports `iamProfileName`; the dispatcher also supports `TRUSTED_PROFILE_ID` (profile ID), which is the more stable identifier. ✅

---

### 3.3 ✅ CR token file path is configurable

Default path matches what Code Engine mounts:
`/var/run/secrets/codeengine.cloud.ibm.com/compute-resource-token/token`

Overridable via `CR_TOKEN_FILE_PATH` for local testing. The reference sample hard-codes the path; the dispatcher improves on this. ✅

---

### 3.4 ✅ Token is cached and refreshed proactively

Tokens are cached per source (`trusted-profile` / `apikey`) and considered stale 60 s before `expiration`. In-flight deduplication (`inflight` map) prevents parallel exchange requests. The reference sample delegates this to `ContainerAuthenticator`; the dispatcher implements it explicitly. Both are correct. ✅

---

### 3.5 ✅ COS access: trusted profile first, HMAC fallback

[`lib/cos.ts` `resolveCosAccess()`](../lib/cos.ts:91) uses the trusted profile's bearer token for COS operations when a profile is configured, and only reads the HMAC secret from the CE project's secret store as a fallback:

```ts
export async function resolveCosAccess(…): Promise<CosAccess> {
  if (isTrustedProfileConfigured()) {
    try {
      await getTrustedProfileToken()             // confirm token is obtainable
      const target = await resolveCosTarget(…)
      const client = makeBearerClient(target)
      await client.send(new HeadBucketCommand(…))  // confirm bucket access
      return { client, …, auth: 'trusted-profile' }
    } catch (err) {
      console.warn(`Trusted profile COS access unavailable, falling back to HMAC…`)
    }
  }
  const creds = await resolveCosCredentials(…)
  return { client: makeClient(creds), …, auth: 'hmac', creds }
}
```

HMAC credentials are **never read** when a working trusted profile is available. ✅

---

### 3.6 ✅ `HeadBucket` validation before upload

The upload route [`app/api/upload/route.ts`](../app/api/upload/route.ts:74) calls `HeadBucketCommand` before starting the multipart upload. This serves two purposes:
1. Early failure if the profile lacks COS access (triggers HMAC fallback in `resolveCosAccess`).
2. Confirms the bucket is private — public buckets don't require authentication.

The reference sample has no equivalent check. ✅ (improvement over reference)

---

### 3.7 ✅ HMAC credentials are sourced from CE project secrets, not environment variables

[`lib/ce.ts` `getHmacCredentials()`](../lib/ce.ts:490) reads the HMAC access key and secret key from the CE project's secret referenced by the persistent data store — no COS credentials need to be injected into the container environment. The HMAC secret is base64-decoded inline:

```ts
const decode = (v: string) => Buffer.from(v, 'base64').toString('utf8').trim()
```

This means the HMAC path requires no additional environment variables beyond what is already needed for CE API access. ✅

---

### 3.8 ✅ Presigned URLs: correctly disabled under trusted-profile auth

[`app/api/presign/route.ts`](../app/api/presign/route.ts:56) returns HTTP `501` when a trusted profile is active, forcing the browser to use `/api/upload` instead:

```ts
if (isTrustedProfileConfigured() && await getTrustedProfileToken().then(() => true, () => false)) {
  return NextResponse.json(
    { error: 'Presigned URLs are unavailable with trusted profile auth; use /api/upload' },
    { status: 501 }
  )
}
```

IAM bearer tokens cannot sign S3 presigned URLs (those require HMAC signing keys), so this is the correct behaviour. ✅

---

### 3.9 🟡 `ibm-cloud-sdk-core` not used — custom token manager instead

**Finding:** The reference example uses `ibm-cloud-sdk-core`'s `ContainerAuthenticator`, which is the IBM-maintained library for this grant type. The dispatcher implements the same exchange manually.

**Why it is acceptable here:** The implementation is minimal, correct, and auditable. The dispatcher has a deliberately narrow dependency set (Next.js, Carbon, AWS SDK v3) and importing the full `ibm-cloud-sdk-core` package would pull in a large transitive tree that is otherwise unused.

**Recommendation:** Add a comment to [`lib/iam.ts`](../lib/iam.ts) near the top of `fetchTrustedProfileToken()` noting the deliberate choice not to use `ContainerAuthenticator`, and pointing to the reference sample. This removes ambiguity for future maintainers who might wonder why the SDK is not used.

```ts
// NOTE: We implement the cr-token exchange directly rather than using
// ContainerAuthenticator from ibm-cloud-sdk-core to avoid a heavyweight
// transitive dependency. The semantics are identical.
// Reference: trusted-profiles/node/main.js
```

---

### 3.10 🟡 API key fallback warning is logged but not surfaced to the UI

**Finding:** When the trusted profile exchange fails and the app falls back to `IBMCLOUD_API_KEY`, [`lib/iam.ts`](../lib/iam.ts:70) logs a `console.warn`. This appears in server logs but is invisible to the user in the browser.

**Impact:** Users deploying on Code Engine might not realise the trusted profile is broken (e.g. wrong profile ID, missing trust rule) and that they are silently running on a less secure API key credential.

**Recommendation:** Surface this condition in the API debug log. Since `logIamCall` already distinguishes `'trusted-profile'` from `'apikey'` sources, adding a second log entry marking the fallback event is enough. Alternatively, expose a `/api/health` endpoint that reports the active auth mode.

---

### 3.11 🟡 No `ibm-cloud-sdk-core` version pinned in `package.json`

**Finding:** `trusted-profiles/node/package.json` declares `"ibm-cloud-sdk-core": "^5.4.2"`. The fleets-dispatcher does not use the SDK Core at all, so there is no version to pin there — but the comparison is useful because the SDK Core is the source of truth for grant-type semantics.

If the IAM endpoint ever changes the `cr-token` grant (e.g. requires a new parameter), the dispatcher's manual implementation would need to be updated manually, whereas the SDK would pick up the change in a version bump.

**Recommendation:** This is a low risk for a sample application. Document the IAM grant reference URL in `lib/iam.ts` so future maintainers know where to check for changes.

---

### 3.12 🟡 The presign check is slightly over-eager on every request

**Finding:** [`app/api/presign/route.ts`](../app/api/presign/route.ts:56) calls `getTrustedProfileToken()` to decide whether to return `501`. This means every presign request triggers a token exchange (or cache hit). In practice the token is cached, so the cost is negligible — but the intent could be clearer.

A simpler and cheaper guard:

```ts
// Before (calls getToken which may fetch from IAM):
if (isTrustedProfileConfigured() && await getTrustedProfileToken().then(() => true, () => false))

// Simpler (just checks env var, no network call):
if (isTrustedProfileConfigured()) {
  return NextResponse.json(
    { error: 'Presigned URLs are unavailable with trusted profile auth; use /api/upload' },
    { status: 501 }
  )
}
```

`isTrustedProfileConfigured()` already tells us whether the profile is intended — checking that the token exchange actually succeeds is redundant here because:
- If the token fails, the HMAC path would be tried next anyway (consistent with `resolveCosAccess`).
- The `/api/upload` route handles the token failure at upload time.

**Recommendation:** Replace the `getTrustedProfileToken()` call in the presign guard with just `isTrustedProfileConfigured()`. This removes a conditional network call and makes the logic easier to follow.

---

### 3.13 🔴 HMAC `apilog` curl label always shows `AWS4-HMAC-SHA256`

**Finding:** [`lib/apilog.ts` `logCosCall()`](../lib/apilog.ts:53):

```ts
export function logCosCall(label, method, url, extra): void {
  logCall({
    …
    curl: `curl -X ${method} \\\n  "${url}" \\\n  -H "Authorization: AWS4-HMAC-SHA256 ..."…`
  })
}
```

The curl snippet always shows `AWS4-HMAC-SHA256` as the auth header, even when the upload is actually using the trusted profile's Bearer token. This is misleading for operators using the debug panel to understand what authentication mode is active.

**Fix:** Pass the `auth` mode from `CosAccess` through to `logCosCall` and use the correct authorization header snippet:

```ts
// In app/api/upload/route.ts, after resolveCosAccess:
logCosCall(
  `Upload ${uploadedFilename} → ${access.bucketName}/${cosKey} (${access.auth})`,
  'PUT',
  `${access.endpoint}/${access.bucketName}/${cosKey}`,
  access.auth === 'trusted-profile'
    ? '-H "Authorization: Bearer $TOKEN"'
    : undefined
)
```

---

## 4. Comparison table

| Aspect | `trusted-profiles/node` (reference) | `fleets-dispatcher` |
|--------|-------------------------------------|---------------------|
| Token exchange mechanism | `ContainerAuthenticator` (SDK Core) | Custom `fetchTrustedProfileToken()` |
| CR token file path | Hard-coded | Default + `CR_TOKEN_FILE_PATH` override ✅ |
| Accepts profile ID | `iamProfileId` | `TRUSTED_PROFILE_ID` ✅ |
| Accepts profile name | `iamProfileName` | `TRUSTED_PROFILE_NAME` ✅ |
| Token caching | SDK handles | Explicit per-source cache + inflight dedup ✅ |
| Token refresh | SDK handles (60 s buffer) | Explicit 60 s buffer ✅ |
| API key fallback | ❌ Not shown | ✅ `getIamToken()` — trusted profile first, then API key |
| HMAC credentials fallback | ❌ Not applicable | ✅ *(updated)* HMAC only when no trusted profile configured — no silent fallback |
| Presigned URLs with trusted profile | ❌ Not applicable | ✅ Returns 501; browser uses `/api/upload` instead |
| `HeadBucket` access check | ❌ No | ✅ Yes — before first multipart part |
| HMAC credentials sourced from | ❌ Not applicable | CE project secret (not env vars) ✅ |
| Debug curl label for COS auth | ❌ Not applicable | ✅ *(fixed)* Auth-aware: Bearer for trusted-profile, AWS4 for HMAC |
| Fallback warning surfaced to UI | ❌ Not applicable | ✅ *(fixed)* Debug panel shows "⚠ Trusted profile failed" entry |
| IBM Cloud SDK Core dependency | ✅ Yes | 🟡 No — custom implementation (acceptable for sample) |

---

## 5. Summary

The fleets-dispatcher trusted-profile implementation is **correct and complete** — all findings from review pass 1 and all feedback from review pass 2 have been addressed.

**Auth model (definitive):**

| Deployment | CE API auth | COS auth | HMAC read? |
|---|---|---|---|
| Code Engine + `TRUSTED_PROFILE_ID` | Trusted profile IAM token | Trusted profile IAM token (bearer) | **Never** |
| Any container + `IBMCLOUD_API_KEY` | API key IAM token | HMAC (from CE project secret) | Yes, via CE secret API |

---

## 6. Changes applied — review pass 1 (2026-10-15)

| Finding | File(s) | What changed |
|---------|---------|--------------|
| 3.13 🔴 — misleading curl auth header | [`lib/apilog.ts`](../lib/apilog.ts), [`app/api/upload/route.ts`](../app/api/upload/route.ts) | `logCosCall` now accepts an optional `auth` parameter; the upload route passes `access.auth` so the debug panel shows `Bearer $TOKEN` for trusted-profile uploads |
| 3.12 🟡 — over-eager presign guard | [`app/api/presign/route.ts`](../app/api/presign/route.ts) | Replaced redundant `getTrustedProfileToken()` call with `isTrustedProfileConfigured()` |
| 3.9 🟡 — no comment on non-use of SDK | [`lib/iam.ts`](../lib/iam.ts) | Added inline comment explaining why `ContainerAuthenticator` is not used |

## 7. Changes applied — review pass 2 (2026-10-15, feedback)

| Item | File(s) | What changed |
|------|---------|--------------|
| **3.10 — fallback not visible in debug panel** | [`lib/apilog.ts`](../lib/apilog.ts), [`lib/iam.ts`](../lib/iam.ts) | Added `'apikey-fallback'` source to `logIamCall`; `getIamToken()` now emits a "⚠ Trusted profile failed — falling back to API key" entry in the debug panel *and* logs to the server console |
| **Trusted profile must cover ALL IBM Cloud services** | [`lib/cos.ts`](../lib/cos.ts) | `resolveCosAccess()` no longer silently falls back to HMAC when a trusted profile is configured. If the token exchange or `HeadBucket` check fails it now throws, making misconfiguration immediately visible instead of silently degrading to a different credential mode |
| **`putObject`/`getObject`/`multipartUpload` work with trusted profile** | [`lib/cos.ts`](../lib/cos.ts) | Signatures changed from `(creds: HmacCredentials, bucket, key, …)` to `(access: CosAccess, key, …)` — they now use whichever S3 client `resolveCosAccess` resolved (bearer token or HMAC) |
| **Header comments updated** | [`lib/iam.ts`](../lib/iam.ts), [`lib/cos.ts`](../lib/cos.ts), [`app/api/upload/route.ts`](../app/api/upload/route.ts), [`app/api/presign/route.ts`](../app/api/presign/route.ts) | All module/route comments now accurately describe the definitive auth model |
| **Documentation updated** | [`README.md`](../README.md), [`.env.example`](../.env.example) | Auth sections rewritten to make it clear that trusted profile is the **only** auth needed on Code Engine; API key + HMAC is the non-Code-Engine path only; troubleshooting updated with new debug-panel entry and COS-specific checks |

`npm run type-check` passes with zero errors after all changes.
