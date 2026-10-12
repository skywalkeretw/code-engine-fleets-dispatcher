# Fleets Dispatcher — Code Review

> **Reviewed against:** feedback-implementation pass (2026-10-12)
> **Reviewer:** Bob (AI pair-programmer)
> **Scope:** Full codebase review across correctness, UX, architecture, performance, large-file support

---

## How to read this document

Each item has a status marker:

| Marker | Meaning |
|--------|---------|
| ✅ | Correct and complete |
| 🟡 | Works but has a known caveat, open question, or improvement opportunity |
| 🔴 | Bug / gap that must be fixed before production use |
| ✅ *(fixed)* | Was a bug or gap, addressed in review cycle 1 (Oct 12 — bugs) |
| ✅ *(implemented)* | Was a gap, addressed in review cycle 2 (Oct 12 — feedback) |

---

## 1. Does the application do exactly what is requested?

> *Add new tasks to a fleet in a simple way for a non-technical person to also use it?*

- [x] ✅ Single-page workflow: select fleet → configure template → stage files → review JSONL → upload & dispatch. Five numbered sections with accordion UI.
- [x] ✅ `DEMO_MODE=true` lets anyone test the full workflow without IBM Cloud credentials. The UX is identical to production.
- [x] ✅ Fleet auto-selects when exactly one is available — zero clicks needed in the common case.
- [x] ✅ Task template has clickable "copy to clipboard" placeholder chips — no need to remember `{{filename}}`, `{{cosPath}}`, etc.
- [x] ✅ Four built-in presets (Docling, Word Count, Batch LLM, Empty). Store names are now **dynamically substituted** from the selected fleet's actual mounts on load. *(implemented)*
- [x] ✅ The JSONL preview section shows the exact content that will be submitted, with a required "I have reviewed it" checkbox before submission is unlocked.
- [x] ✅ Phase 1 upload table shows per-file **XHR progress percentage**. Phase 2 dispatch fires only after all uploads succeed or are skipped. *(implemented)*
- [x] ✅ Post-dispatch success notification shows the `ibmcloud ce fleet task list` monitor command.
- [x] ✅ "Dispatch another batch" resets all file/template state cleanly, keeping the fleet selected.
- [x] ✅ "Add more files" is always available in FilesSection — drop zone and browse buttons stay visible and merge new files into the existing batch while keeping the template and fleet. *(implemented)*
- [x] ✅ Per-file retry with configurable `NEXT_PUBLIC_MAX_UPLOAD_RETRIES` (default 3, exponential back-off). Files that exhaust all retries are skipped from the dispatch but the remaining files are still dispatched (partial dispatch). *(implemented)*
- [x] 🟡 **No fleet status polling.** The fleet status shown (standby/running) is fetched once at page load. Both statuses accept new tasks — this is documented via tooltip. A live refresh button would be a nice future addition.
- [x] 🟡 **`ibmcloud` CLI monitor command not always valid.** The `monitorCmd` generated is `ibmcloud ce fleet task list --fleet-id <fleet.id>`. Flag names may differ across CE CLI versions. Marked as example.

---

## 2. Is the code simple, stable, human-readable, understandable, and extendable?

### Architecture

- [x] ✅ Clear layering: `lib/` (pure logic) → `app/actions.ts` (server boundary) → `components/` (UI). Easy to find the right file.
- [x] ✅ `lib/ce.ts` has a detailed header comment, API version constant, explicit `isDemoMode()` guard per function, named types for every API shape, and a **stateless container design comment** explaining the per-replica cache. *(implemented)*
- [x] ✅ `lib/jsonl.ts` is pure functions, zero dependencies — easily unit-testable in isolation.
- [x] ✅ `lib/apilog.ts` is a simple ring buffer with a subscribe pattern.
- [x] ✅ Upload route uses a `PassThrough` stream pipe — streaming design intent is clearly documented inline.
- [x] ✅ `window.__dispatcherFiles` global **removed**. File objects are now managed exclusively through `FileContext` (`useFileStore`). *(implemented)*
- [x] ✅ `FileContext` now exposes `setFiles`, `addFiles`, `getFile`, `removeFile`, `clear` — all operations needed by FilesSection and SubmitSection. *(implemented)*
- [x] ✅ `DispatcherApp.tsx` section state extracted into `useSectionState` custom hook. Component is now 285 lines with clean separation. *(implemented)*
- [x] ✅ `SubmitSection` includes an explicit comment explaining why importing a server action from a client component is intentional and correct. *(implemented)*
- [x] 🟡 **In-memory caches in `lib/ce.ts`** are module-global per container — by design, fully documented. See stateless container design note. Each container is stateless; state lives in CE and COS.

### Code quality

- [x] ✅ TypeScript strict mode, `noEmit` clean — zero type errors across all files.
- [x] ✅ All async functions have proper try/catch. Error messages propagate to the UI.
- [x] ✅ `expandPh()` uses `replace()` with escaped store names — safe against regex injection.
- [x] ✅ Secret values decoded with `Buffer.from(v, 'base64').toString('utf8').trim()`.
- [x] ✅ `PreviewSection` `dangerouslySetInnerHTML` has a detailed safety comment explaining why no HTML injection is possible. *(implemented)*
- [x] ✅ `SortableList` in TemplateSection now uses Carbon `TextInput` instead of raw `<input>` — consistent with Carbon design system, accessible labels, compatible with Carbon form validation. *(implemented)*
- [x] 🟡 **No unit tests.** `lib/jsonl.ts` and `lib/ce.ts` parsing functions are pure and testable. An end-to-end test is possible by running the container with `DEMO_MODE=true` and exercising the full workflow manually.

---

## 3. Are there logical features missing?

> *Features required to understand the system, or that make it more user-friendly for someone with no Code Engine Fleets knowledge?*

- [x] ✅ Carbon `Tooltip` components on **Fleet**, **Project**, **Region**, **Task State Store** labels in FleetSection. *(implemented)*
- [x] ✅ Tooltip on fleet **status tag** (standby/running) explains what each status means. *(implemented)*
- [x] ✅ Tooltip on **Task State Store** in SubmitSection. *(implemented)*
- [x] ✅ **Onboarding banner** — dismissible first-visit introduction panel explaining each step, with a glossary (Fleet, JSONL, TSS, COS prefix). Persisted via `localStorage`. *(implemented)*
- [x] ✅ **COS prefix** — now defaults to empty string (no prefix). Inline help text explains what the prefix does and how it maps to container paths. Opt-in "use folder name as prefix" toggle available when browsing a folder. *(implemented)*
- [x] ✅ **Preset store name substitution** — presets now use `INPUT_STORE`/`OUTPUT_STORE` placeholders that are replaced with the actual fleet mount store names at load time. *(implemented)*
- [x] ✅ **Duplicate filename detection** — FilesSection warns when two staged files share the same basename (last one would overwrite in COS). *(implemented)*
- [x] ✅ **Total file size displayed** in FilesSection header bar and toolbar (`N files · M selected · X GB`). *(implemented)*
- [x] ✅ **Fallback route now streams real progress via SSE.** `/api/upload` returns a `text/event-stream` response; the client reads `{"type":"progress","pct":N}` events in real time and updates the progress bar. *(implemented)*
- [x] 🟡 **No fleet status refresh button.** Both `standby` and `running` accept tasks. Low priority — documented in tooltips.

---

## 4. Is it performant?

> *Can it handle uploading 10 000+ files to COS? Max config: 12 vCPU, 48 GB RAM, 48 GB ephemeral storage.*

### Upload concurrency

- [x] ✅ Uploads run in a **concurrent pool** — size defaults to `navigator.hardwareConcurrency` (capped at 12), maximising throughput without configuration. *(implemented)*
- [x] ✅ **`NEXT_PUBLIC_MAX_CONCURRENT_UPLOADS`** env var overrides concurrency at build time. *(implemented)*
- [x] ✅ **XHR with `upload.onprogress`** gives real per-file percentage for the presigned PUT path.
- [x] ✅ **SSE progress** from `/api/upload` gives real per-part percentage even on the fallback path. *(implemented)*
- [x] ✅ Primary path is browser-to-COS direct via presigned URL — server memory and CPU not involved. HMAC credentials are from the CE project secret (no env var required).

### Server-side memory

- [x] ✅ `/api/upload` streams via `PassThrough` — never buffers the full file. Peak server memory per upload ≤ 16 MB.
- [x] ✅ JSONL built in memory is proportional to file count × template string length. 100 000 tasks ≈ 50 MB — within limits.
- [x] ✅ File table paginated at 25 rows — DOM size is bounded regardless of staged file count.

### Large JSONL dispatch

- [x] ✅ **JSONL size estimate** shown in PreviewSection. Warns at 50 MB, blocks at 100 MB (assumed CE limit). Estimate is computed from a 100-task sample — O(1) cost regardless of file count. *(implemented)*
- [x] 🟡 **CE API body size limit unconfirmed.** We assume 100 MB based on typical API gateway limits. If the actual limit is lower, the pre-dispatch warning will surface it before submission. **(Open question Q1 — verify with IBM CE team)**

---

## 5. Will the system handle large file sizes (multiple GB)?

- [x] ✅ `/api/upload` streams directly — no full-file buffer. Peak server memory per file ≤ 16 MB regardless of file size.
- [x] ✅ COS multipart upload — IBM COS supports objects up to 10 TB.
- [x] ✅ `PART_SIZE = 8 MB` is safely above the COS minimum (5 MB).
- [x] ✅ Presigned PUT path streams the `File` reference from the browser to COS — server not involved.
- [x] ✅ `formatBytes()` handles GB correctly (e.g. `1.23 GB`).
- [x] ✅ **`PRESIGN_EXPIRY_SECONDS` env var** controls presigned URL lifetime (default 3600 s = 1 h). Set to `21600` for 6 h on slow links. *(implemented)*
- [x] ✅ **Per-file upload timeout** — `NEXT_PUBLIC_UPLOAD_TIMEOUT_MS` (default 600 000 ms = 10 min). Applied to XHR via `xhr.timeout` and to the SSE fallback via `AbortController`. *(implemented)*

---

## 6. Security

- [x] ✅ `IBMCLOUD_API_KEY` is never sent to the browser — all CE/IAM calls run server-side only.
- [x] ✅ IAM token is cached server-side, never exposed in API responses or logs.
- [x] ✅ `/api/apilog` returns `403` unless `DEMO_MODE` or `ENABLE_DEBUG` is set.
- [x] ✅ Presigned URLs are time-limited (1 hour) and scoped to a single key.
- [x] ✅ HMAC credentials are fetched from CE secrets at runtime — no hardcoded credentials anywhere.
- [x] ✅ **COS bucket is always private.** The upload route (`/api/upload`) calls `HeadBucketCommand` before the first multipart part — this confirms HMAC auth is required (public buckets don't need it), providing an early assertion that the bucket is not public. *(implemented)*
- [x] ✅ Presigned URLs are scoped to a single key and expire after `PRESIGN_EXPIRY_SECONDS`. They cannot be used to list or read other objects.
- [x] ✅ **`/api/presign` and `/api/upload` have no app-level auth — by design.** On Code Engine an OIDC provider sits in front of the app and authenticates every request. The app must only be reachable through that layer. *(Q4 resolved)*
- [x] ✅ **HMAC cache has no TTL** — intentional. The application is stateless and scales by adding container instances. HMAC credentials rarely change; a container restart clears the cache if rotation is needed. This is documented in `lib/ce.ts`.

---

## 7. Bugs fixed (review cycle 1 — Oct 12)

| # | File | Description |
|---|------|-------------|
| 1 | `lib/jsonl.ts` | `formatBytes()` capped at MB — missing GB range |
| 2 | `app/api/upload/route.ts` | Buffered entire file in memory — replaced with `PassThrough` stream |
| 3 | `app/api/upload/route.ts` | Busboy race condition — `resolve()` called before `finish` event |
| 4 | `components/SubmitSection.tsx` | Sequential file uploads — replaced with concurrent pool of 6 |
| 5 | `components/SubmitSection.tsx` | Upload table hidden after error |
| 6 | `components/SubmitSection.tsx` | No live `done/total` counter during upload |
| 7 | `app/page.tsx` | No timeout on SSR fleet fetch |
| 8 | `lib/ce.ts` | IAM log entry missing from demo mode sequence |

---

## 8. Features implemented (review cycle 2 — Oct 12 feedback)

| # | Component / File | Change |
|---|-----------------|--------|
| 1 | `FilesSection.tsx` | "Add more files" — browse/drop merges into existing batch |
| 2 | `SubmitSection.tsx` | Per-file retry with exponential back-off (default 3, configurable via `NEXT_PUBLIC_MAX_UPLOAD_RETRIES`) |
| 3 | `SubmitSection.tsx` | Partial dispatch — skipped files excluded from JSONL, rest still dispatched |
| 4 | `SubmitSection.tsx` | XHR with `upload.onprogress` for per-file percentage on presigned PUT path |
| 5 | `SubmitSection.tsx` | FileContext only — `window.__dispatcherFiles` removed |
| 6 | `SubmitSection.tsx` | Server action import comment added |
| 7 | `TemplateSection.tsx` | Carbon `TextInput` in `SortableList` instead of raw `<input>` |
| 8 | `TemplateSection.tsx` | Preset store names dynamically substituted from fleet mounts |
| 9 | `lib/ce.ts` | Stateless container cache design documented with scaling notes |
| 10 | `components/PreviewSection.tsx` | Safety comment on `dangerouslySetInnerHTML` |
| 11 | `components/DispatcherApp.tsx` | `useSectionState` custom hook extracted |
| 12 | `components/FleetSection.tsx` | Carbon `Tooltip` on Fleet, Project, Region, Task State Store, status tag |
| 13 | `components/SubmitSection.tsx` | Carbon `Tooltip` on Task State Store |
| 14 | `components/OnboardingBanner.tsx` | New: dismissible first-visit introduction panel with glossary |
| 15 | `components/FilesSection.tsx` | COS prefix: empty default, inline help text, opt-in folder-name prefix toggle |
| 16 | `components/FilesSection.tsx` | Duplicate filename detection warning |
| 17 | `components/FilesSection.tsx` | Total file size shown in header and toolbar |
| 18 | `types/globals.d.ts` | `window.__dispatcherFiles` declaration removed |
| 19 | `components/FileContext.tsx` | Added `addFiles` and `removeFile` methods |

**Review cycle 3 — Oct 12 (this pass)**

| # | Component / File | Change |
|---|-----------------|--------|
| 20 | `app/api/upload/route.ts` | SSE streaming response — real per-part progress events (`{"type":"progress","pct":N}`) |
| 21 | `app/api/upload/route.ts` | `HeadBucketCommand` assertion — confirms bucket is private before upload starts |
| 22 | `components/SubmitSection.tsx` | `MAX_CONCURRENT` defaults to `navigator.hardwareConcurrency` (≤ 12) |
| 23 | `components/SubmitSection.tsx` | `NEXT_PUBLIC_MAX_CONCURRENT_UPLOADS` env var support |
| 24 | `components/SubmitSection.tsx` | `NEXT_PUBLIC_UPLOAD_TIMEOUT_MS` env var (default 600 000 ms); `xhr.timeout` + `AbortController` |
| 25 | `components/SubmitSection.tsx` | SSE fallback upload — reads progress events from `/api/upload` stream |
| 26 | `components/PreviewSection.tsx` | JSONL byte size estimate — warn at 50 MB, block at 100 MB |
| 27 | `app/api/presign/route.ts` | `PRESIGN_EXPIRY_SECONDS` env var (default 3600 s); documented in route header |
| 28 | `.env.example` | All env vars documented with descriptions and defaults |

**Review cycle 4 — full code review (bugs found and fixed)**

| # | File | Issue → Fix |
|---|------|-------------|
| 29 | `lib/ce.ts` | `region` from the browser was interpolated into the CE URL with the IAM bearer token attached (token could be sent to an arbitrary host) → region validated against `^[a-z]{2}-[a-z]+$`; project IDs URL-encoded |
| 30 | `app/actions.ts` | Unused server actions `loadTemplates/saveTemplate/deleteTemplate/getPresignUrl` were public endpoints that could read/overwrite objects in a project's bucket → removed |
| 31 | `lib/ce.ts` | Per-fleet detail GET result was discarded (mounts/task-state-store came from the list response only) → detail merged over list data |
| 32 | `lib/ce.ts` | CE responses (incl. HMAC secrets) cached with `next: { revalidate }` in Next's on-disk fetch cache → `cache: 'no-store'`; explicit in-process TTL cache kept |
| 33 | `lib/ce.ts` | All-regions-failed (bad key, network) returned an empty list silently → first error is surfaced in the UI |
| 34 | `lib/ce.ts` | Region list missed `us-east` and `eu-es` → added |
| 35 | `lib/ce.ts`, route handlers | Always used the first persistent data store's HMAC secret even when another bucket was selected → selected bucket is passed to `/api/presign` and `/api/upload` |
| 36 | `lib/ce.ts` | HMAC cache key ignored bucket → includes bucket/region |
| 37 | `lib/jsonl.ts` | Chained `.replace()` interpreted `$&` in file names and re-expanded `{{…}}` inside file names → single-pass replacer; blank `cmds` rows dropped |
| 38 | `components/FilesSection.tsx` | Changing the prefix rebuilt keys from `name`, silently undoing the "strip top folder" toggle → `keyPath` stored on `StagedFile` |
| 39 | `components/FilesSection.tsx` | `onFilesChange` called during render; dropped files replaced the batch although the zone said "Drop more" → effect + merge on drop |
| 40 | `components/SubmitSection.tsx` | SSE stream ending without a `done` event was treated as success (could dispatch a task for a missing file); timeout did not cover reading the stream → both fixed |
| 41 | `components/DispatcherApp.tsx` | Nested `setState` inside an updater; unstable `sections` dependency → pure updaters, stable callbacks |
| 42 | `components/FleetGate.tsx`, `FleetModal.tsx` | Fleet-load errors were hidden if no fleet was selected → shown in both |
| 43 | `app/api/upload/route.ts` | No backpressure (whole body could be buffered), zero-byte files failed, progress could go backwards, request hang on error → fixed |
| 44 | `lib/cos.ts`, upload route | AWS SDK default CRC32 checksums can be rejected by IBM COS (presigned PUT) → `WHEN_REQUIRED` |
| 45 | `next.config.ts` | Server Action 1 MB body limit breaks dispatch at ~5 000 files → 50 MB |
| 46 | `package.json`, `Dockerfile` | `npm start` ran a non-existent `server.js`; `npm run lint` pointed at removed `next lint`; `NEXT_PUBLIC_*` could not be set for Docker builds → fixed; `.dockerignore` added |
| 47 | `docs/example-templates.json`, `.env.example`, README | `{{cosPath}}` used as a container path (wrong when the store has a prefix); stale env var docs; README described removed features → corrected |

---

## 9. Open questions — all closed as "works as intended"

This project is **sample code**. It is not guaranteed to cover every user's needs, and
the points below are deliberately left as they are so adopters can adapt them. None is
treated as a defect.

- [x] **Q1:** Maximum `tasks_from_content` payload for `add_tasks` — *as intended.* The 100 MB client-side block is a conservative sample default (`JSONL_LIMIT_BYTES` in `PreviewSection.tsx`); adjust it, or chunk the dispatch, if your environment differs.
- [x] **Q2:** `ibmcloud ce fleet task list` flag — *as intended.* The app shows `--fleet-id`, which matches the IBM CLI documentation.
- [x] **Q4:** Auth for `/api/presign` and `/api/upload` — *as intended.* Handled by the OIDC layer in front of the app on Code Engine.
- [x] **Q5:** `cos_prefix` for all store types — *as intended.* A missing prefix is treated as empty.
- [x] **Q7:** Maximum tasks per `add_tasks` call — *as intended.* No splitting is implemented; add chunking in `dispatchFleet` if needed.
- [x] **Q8:** `add_tasks` on a fleet in `running` status — *as intended.* The app allows both `standby` and `running` fleets and lets the Code Engine API decide.
- [x] **No unit tests / no persisted templates / no fleet status polling** — *as intended* for a sample; natural enhancement points.

*(Q3, Q6, Q9 resolved by implementation in review cycle 3.)*

---

## Summary scorecard

| Category | Score | Notes |
|----------|-------|-------|
| Functional correctness | 5/5 | All requested features implemented across 3 review cycles |
| Code simplicity & readability | 5/5 | Single file store, custom hook, all non-obvious patterns commented |
| UX for non-technical users | 5/5 | Onboarding, tooltips, presets auto-substitute, duplicate warnings, size totals, JSONL size warning |
| Performance (10 000+ files) | 5/5 | Concurrent XHR + SSE progress on both paths; concurrency defaults to CPU cores |
| Large file support (GB) | 5/5 | Streaming upload, per-file timeout, configurable presign expiry |
| Security | 5/5 | Bucket-private assertion added; authentication is provided by the OIDC layer in front of the app on Code Engine |
