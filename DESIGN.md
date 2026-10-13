# Fleets Dispatcher — System Design

## Overview

**Fleets Dispatcher** is a browser-based web application that gives users a
graphical, zero-CLI workflow to dispatch batch workloads to IBM Cloud Serverless
Fleets. The application uses **IBM Carbon Design System** components throughout.

### User flow (3 steps)

1. **Fleet selection (header-level)** — a persistent button in the UI shell
   opens a modal that lists all fleets across all projects in standby mode.
   The modal supports filtering by project and region, and searching by name.
   The selected fleet is displayed in the header throughout the session.

2. **JSONL Template Builder (Step 1)** — define the container image, resources,
   mount data stores, command, and argument template. Arguments can mix static
   values and `{{placeholder}}` tokens that are expanded per file. Clicking a
   placeholder chip copies it to the clipboard. Templates can be saved to and
   loaded from COS.

3. **Files, Preview & Submit (Step 2 + Step 3)** — all on one logical screen:
   - Drag-and-drop files or a folder; per-file rows allow overriding the COS
     prefix or providing a `{{custom}}` value.
   - A live JSONL preview (max 20 lines) updates as files are added or the
     template changes.
   - The user confirms the task structure with a checkbox, then advances to the
     Submit step.
   - One button triggers Phase 1 (upload all files to COS sequentially with
     per-file progress) and, on completion, Phase 2 (submit the full JSONL to
     the fleet via the CE REST API).

The entire application — UI and API — ships as a **single stateless container**
built with **Next.js App Router**. There is no local filesystem state, no CLI
tool dependency, and no split frontend/backend deployment. One container image,
one port, fully deployable on IBM Code Engine (or any OCI-compatible runtime).

---

## Table of Contents

- [Goals & Non-Goals](#goals--non-goals)
- [Architecture](#architecture)
- [Stateless Design Principles](#stateless-design-principles)
- [Why Next.js App Router](#why-nextjs-app-router)
- [Component Breakdown](#component-breakdown)
- [Data Flow](#data-flow)
- [JSONL Template System](#jsonl-template-system)
- [IBM Cloud API Integration](#ibm-cloud-api-integration)
- [Template Persistence Strategy](#template-persistence-strategy)
- [API Reference](#api-reference)
- [Configuration](#configuration)
- [Directory Structure](#directory-structure)
- [Container Build](#container-build)
- [Technology Choices](#technology-choices)
- [Security Considerations](#security-considerations)
- [Open Questions / Future Work](#open-questions--future-work)

---

## Goals & Non-Goals

### Goals
- Ship as a **single OCI container image** — no sidecar, no CLI, no volume mounts.
- All IBM Cloud interactions (fleet listing, COS upload, fleet dispatch) use
  **REST APIs directly** with an IAM bearer token obtained from an IAM trusted
  profile (preferred, via the Code Engine compute resource token) or, as backup,
  from an API key.
- Template storage is **stateless**: templates live in a dedicated COS object
  (`dispatcher/templates.json`) in the same bucket. No local filesystem writes.
- Support flexible, template-driven JSONL generation so the dispatcher works
  with any fleet image and command pattern (docling, wc, inferencing, …).
- The container is deployable as a Code Engine **application** with only
  environment variables as configuration.
- UI styled with **IBM Carbon Design System** tokens and component patterns.
- Fleet selection is **project-independent**: the modal lists all standby fleets
  across all projects with filter and search, not scoped to one project.

### Non-Goals
- Creating or deleting fleets (only *consuming* standby fleets is in scope).
- Managing COS buckets or Code Engine projects (those are pre-existing).
- Real-time task monitoring (out of scope for v1; see Future Work).
- Multi-user auth (the app is intended for trusted internal use behind a VPN or
  Code Engine `visibility=project`; full OIDC is a future work item).

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Single OCI Container                             │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │              Next.js Process  (port 8080)                     │  │
│  │                                                               │  │
│  │   Server Components (run on server, never in browser)         │  │
│  │   ├── /                → fetch fleets → render FleetSelector  │  │
│  │   └── /template        → fetch templates → render editor      │  │
│  │                                                               │  │
│  │   Route Handlers  (API endpoints)                             │  │
│  │   ├── POST /api/upload     → COS S3 API  (PutObject, stream)  │  │
│  │   └── POST /api/dispatch   → CE REST API (fleet run)          │  │
│  │                                                               │  │
│  │   Server Actions  (server functions called from UI)           │  │
│  │   ├── saveTemplate()   → COS S3 API  (GetObject + PutObject)  │  │
│  │   └── dispatchFleet()  → CE REST API (fleet run)              │  │
│  │                                                               │  │
│  │   IAM Token Manager (in-process, module-level singleton)      │  │
│  │   └── POST https://iam.cloud.ibm.com/identity/token           │  │
│  │       → trusted profile (CR token) or IBMCLOUD_API_KEY backup │  │
│  │       → caches + auto-refreshes before expiry                 │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  Baked in at image build time (next build --output standalone):     │
│  .next/standalone/   ← self-contained Node.js server               │
│  .next/static/       ← compiled JS/CSS chunks                      │
│  public/             ← static assets                               │
└─────────────────────┬───────────────────────────────┬───────────────┘
                      │ HTTPS REST                     │ HTTPS S3
                      ▼                                ▼
          ┌─────────────────────┐        ┌─────────────────────────┐
          │  IBM Cloud          │        │  IBM Cloud Object       │
          │  Code Engine        │        │  Storage                │
          │  Fleet API          │        │  ├── fleet-input-store  │
          │  (api.<region>.     │        │  │   (file uploads)     │
          │   codeengine.       │        │  └── dispatcher/        │
          │   cloud.ibm.com)    │        │      templates.json     │
          └─────────────────────┘        └─────────────────────────┘
```

---

## Stateless Design Principles

The container has **zero writable state** beyond the in-memory IAM token cache.
Every design decision flows from this constraint:

| Concern | Old (SvelteKit + Express) | New (Next.js) |
|---|---|---|
| Template storage | `templates.json` on local disk | `dispatcher/templates.json` COS object |
| IBM Cloud auth | `ibmcloud` CLI session on host | In-process IAM token exchange via REST |
| Fleet list data | REST round-trip from browser | Server Component fetches directly at render |
| Fleet dispatch | Shell-out to `ibmcloud ce fleet run` | Server Action → CE REST API |
| JSONL temp file | Written to `/tmp`, passed to CLI | Generated in-memory, sent as request body |
| File uploads | Buffered to disk by multer | Streamed from browser → Route Handler → COS |
| Static file serving | Express `express.static()` | Next.js built-in (no extra code) |

**Consequences:**
- The container can run with a **read-only filesystem** (`readOnlyRootFilesystem: true`).
- Horizontal scaling and restarts are safe — no session state is lost.
- Works on Code Engine with zero persistent volume claims.

---

## Why Next.js App Router

The previous design used SvelteKit with `adapter-static` (compile to inert
HTML/JS) combined with a separate Express server. This discarded SvelteKit's
most valuable feature (server-side rendering) and required two build pipelines
glued together in the Dockerfile.

Next.js App Router is the correct fit because:

| Capability | How it maps to this app |
|---|---|
| **Server Components** | Fleet list and template list are fetched server-side at render time — credentials never leave the Node.js process, no `/api/fleets` endpoint needed |
| **Route Handlers** | File upload streaming and dispatch require raw request access — Route Handlers provide `Request`/`Response` with Web Streams, no Express needed |
| **Server Actions** | Template save and fleet dispatch are mutations triggered by button clicks — Server Actions remove the need for explicit `POST /api/templates` and `POST /api/dispatch` endpoints |
| **`output: 'standalone'`** | Produces a single self-contained `server.js` — one process, one port, read-only-filesystem safe, no extra runtime dependencies |
| **One `package.json`** | UI and server logic share one module graph and TypeScript project — shared types, no build-time glue |

---

## Component Breakdown

### Fleet Selection — Header modal (persistent, not a step)

**UI Shell button + Carbon Modal** — available on every step.

- Header button shows the currently selected fleet (name + region + green
  status dot), or "Select a fleet…" if none chosen.
- Clicking opens a Carbon modal populated by a **Server Component** call to
  `listStandbyFleets()` (all projects, all regions).
- Modal toolbar: text search (by name), project dropdown, region dropdown —
  all filter the list client-side with no additional server round-trip.
- Fleet rows show name, project, task-state-store, standby tag, region tag.
- Selecting a row highlights it; "Select Fleet" button confirms and closes.
- The selected fleet is stored in React context / URL state and available to
  all steps.

### Step 1 — JSONL Template Builder (`app/page.tsx`)

**Server Component** wrapping **Client Components**.

- Server Component fetches saved templates from `lib/cos.ts` on page render.
- **Placeholder chip bar**: clickable `{{filename}}`, `{{stem}}`, `{{ext}}`,
  `{{cosPath}}`, `{{prefix}}`, `{{index}}`, `{{custom}}` chips that copy the
  token to the clipboard. When a fleet is selected, the bar also renders
  **`{{mount.STORE_NAME}}`** chips (one per persistent data store mounted on
  the fleet), styled in green. These resolve to the mount path configured on
  the fleet at creation time (e.g. `{{mount.fleet-input-store}}` → `/input`).
- **JSONL fields — only three, all optional:**
  - `idx` — free-text input; supports placeholders; omitted from output if left empty.
  - `cmds` — list of strings; each entry can be a static value or contain placeholders.
  - `args` — list of strings; each entry can be a static value or contain placeholders.
- No other fields are configurable in the template builder. Container image, CPU,
  memory, mount data stores and any other fleet run parameters are configured
  directly on the fleet definition, not in the JSONL task payload.
- **Load / Save template**: dropdown loads a preset from COS; save button
  triggers `saveTemplate()` Server Action.

### Step 2 — Files & Preview (`app/files/page.tsx`)

**Client Component** — runs entirely in the browser until submission.

- **COS prefix field**: global prefix applied to all files unless overridden
  per-file.
- **Carbon FileUploader drop zone**: accepts individual files or a whole folder
  (`webkitdirectory`). Files are staged in browser memory — not yet uploaded.
- **Staged file table**: one row per file showing filename, size, per-file
  prefix override input, and a `{{custom}}` value input. The COS key preview
  column updates live.
- **Live JSONL preview** (Carbon dark code block): generated client-side from
  the template + staged files. Shows up to 20 lines. Updates on every
  template or file change.
- **Confirmation checkbox**: user must tick "I have reviewed the task structure"
  before "Next: Submit" is enabled.

### Step 3 — Submit (`app/submit/page.tsx`)

**Client Component** — runs in the browser; calls Server Actions.

- **Submission summary**: fleet name, region, image, CPU/memory, task count.
- **Phase 1 — Upload to COS**: sequential per-file upload via `POST /api/upload`
  Route Handler (streaming). Each row transitions: Pending → uploading spinner
  → ✓ Done / ✕ Error. Back button is disabled during upload.
- **Phase 2 — Dispatch fleet**: once all uploads complete, the `dispatchFleet()`
  Server Action is called automatically with the in-memory JSONL string. The
  submitted JSONL is shown in a collapsible terminal block.
- **Success notification**: fleet run name, task count, and CLI monitoring
  commands. "Dispatch another batch" resets to Step 1.

---

### Server-side Modules (`lib/`)

#### `lib/iam.ts` — IAM Token Manager

Obtains a bearer token, **trusted profile first, API key as backup**. Implemented as
module-level state so tokens are shared across all concurrent requests in the same
Node.js process and refreshed proactively 60 s before expiry (cached per source).

1. **Trusted profile (preferred)** — active when `TRUSTED_PROFILE_ID` or
   `TRUSTED_PROFILE_NAME` is set. Requires `--trusted-profiles-enabled=true` on the
   Code Engine app, which mounts a compute resource token at
   `/var/run/secrets/codeengine.cloud.ibm.com/compute-resource-token/token`
   (override with `CR_TOKEN_FILE_PATH`).
   ```
   POST https://iam.cloud.ibm.com/identity/token
     grant_type=urn:ibm:params:oauth:grant-type:cr-token
     &cr_token=<contents of token file>
     &profile_id=<TRUSTED_PROFILE_ID>      (or profile_name=<TRUSTED_PROFILE_NAME>)
   → { access_token, expiration }
   ```
2. **API key (backup)** — used when no trusted profile is configured, or when the
   trusted profile exchange fails and `IBMCLOUD_API_KEY` is set (a warning is logged).
   ```
   POST https://iam.cloud.ibm.com/identity/token
     grant_type=urn:ibm:params:oauth:grant-type:apikey
     &apikey=<IBMCLOUD_API_KEY>
   → { access_token, expiration }
   ```

#### `lib/ce.ts` — Code Engine REST Client

```
GET  https://api.<CE_REGION>.codeengine.cloud.ibm.com/v2/projects/<id>/fleets
POST https://api.<CE_REGION>.codeengine.cloud.ibm.com/v2/projects/<id>/fleets
Authorization: Bearer <iam_token>
```

`CE_PROJECT_ID` is resolved once from `CE_PROJECT_NAME` at first call and
cached in the module.

#### `lib/cos.ts` — COS S3 Client

`@aws-sdk/client-s3` configured for IBM COS. `resolveCosAccess()` picks the
authentication mode per request:

- **Trusted profile (preferred):** a custom signer sets `Authorization: Bearer <IAM token>`.
  The HMAC secret is never read. A `HeadBucket` check confirms the profile can reach the
  bucket; if it cannot, the HMAC backup is used.
- **HMAC (backup):** credentials from the CE project's HMAC secret sign requests (AWS
  SigV4). Required for presigned URLs.

#### `lib/jsonl.ts` — JSONL Generator

Pure function: takes a template and a list of `{filename, key}` objects,
expands all `{{placeholder}}` tokens, returns a JSONL string. Used by both
the server (dispatch) and the browser (live preview via a shared module).

#### `app/actions.ts` — Server Actions

```typescript
'use server'
export async function saveTemplate(template: Template): Promise<Template>
export async function dispatchFleet(payload: DispatchPayload): Promise<DispatchResult>
```

---

## Data Flow

```
User clicks "Select a fleet…" in the header (any step)
  └─► Modal opens; fleet list rendered from Server Component data
      User searches / filters → client-side filter (no server round-trip)
      User selects row → "Select Fleet" → fleet stored in React context

──────────────────────────────────────────────
Step 1: Page load /  (Server Component + Client Components)
  └─► Server Component → lib/cos.ts → COS GetObject(dispatcher/templates.json)
      → render TemplateEditor with saved templates pre-loaded
      (+ lib/jsonl.ts placeholder chips rendered server-side)

  User edits image / cmd / args → live preview is client-side only

  User clicks "Save Template" → saveTemplate() Server Action
    → lib/cos.ts GetObject → upsert → PutObject(dispatcher/templates.json)

──────────────────────────────────────────────
Step 2: User navigates to /files  (Client Component)
  User sets COS prefix, drags files → files staged in browser memory
  File table rows allow per-file prefix/custom overrides
  Live JSONL preview regenerates client-side on every change (max 20 lines)
  User ticks confirmation checkbox → "Next: Submit" becomes active

──────────────────────────────────────────────
Step 3: User navigates to /submit  (Client Component)

  Phase 1 — Upload
    for each staged file:
      POST /api/upload (Route Handler)
        └─► busboy stream → lib/cos.ts PutObject(bucket, key=prefix+fname)
        → row status: Pending → spinner → ✓ Done / ✕ Error

  Phase 2 — Dispatch (triggered automatically when all uploads succeed)
    dispatchFleet() Server Action
      → lib/jsonl.ts generate JSONL string in-memory
      → lib/ce.ts POST fleet run { tasks_from_content: jsonl, ... }
      → return { fleetId, fleetName, taskCount }

  Browser shows Carbon success notification with fleet run name + CLI commands
```

---

## JSONL Template System

### Task line format

Each line in the JSONL file submitted to the fleet **may only contain** the
following three optional fields — nothing else:

| Field | Type | Required | Description |
|---|---|---|---|
| `idx` | `string` | optional | Task identifier. Used for tracking. Supports placeholders. |
| `cmds` | `string[]` | optional | The executable and any fixed sub-commands. Supports placeholders. |
| `args` | `string[]` | optional | Arguments passed to the command. Supports placeholders. |

All three fields are optional — the minimal valid task line is `{}`.

**Examples:**

```jsonl
{ "idx": "report.pdf", "cmds": ["docling"], "args": ["--num-threads", "12", "/input/jobs/report.pdf", "--output", "/output/report.md"] }
{ "cmds": ["/bin/bash"], "args": ["-c", "wc /input/jobs/novel.txt > /output/wordcount_novel.txt"] }
{ "idx": "summary.pdf" }
{}
```

> Note: the literal paths above (`/input/`, `/output/`) are what the container
> sees after `{{mount.fleet-input-store}}` and `{{mount.fleet-output-store}}`
> are resolved at dispatch time against the selected fleet's mount configuration.

### Saved template schema

Templates are stored in COS as a JSON array. Each record contains only the
dispatcher's own metadata plus the three JSONL fields:

```json
{
  "id": "docling-pdf",
  "name": "Docling PDF Conversion",
  "idx": "{{filename}}",
  "cmds": ["docling"],
  "args": [
    "--num-threads", "12",
    "{{mount.fleet-input-store}}/{{cosPath}}",
    "--output", "{{mount.fleet-output-store}}/{{stem}}.md"
  ]
}
```

### Placeholder Reference

Placeholders can appear in **any** of the three fields (`idx`, `cmds`, `args`).
They are expanded once per file at dispatch time.

| Placeholder | Expands to | Example |
|---|---|---|
| `{{filename}}` | Full filename including extension | `report.pdf` |
| `{{stem}}` | Filename without extension | `report` |
| `{{ext}}` | File extension without dot | `pdf` |
| `{{prefix}}` | COS prefix for this file (global or per-file override) | `jobs/batch-01/` |
| `{{cosPath}}` | `prefix + filename` — the COS object key after upload; also the subpath visible inside the fleet's input mount | `jobs/batch-01/report.pdf` |
| `{{index}}` | 0-based task index, zero-padded to 5 digits | `00003` |
| `{{custom}}` | Per-file custom value set in the file table | `my-label` |
| `{{mount.STORE_NAME}}` | The container mount path for the named persistent data store on the selected fleet. `STORE_NAME` is the store name exactly as configured on the fleet. Rendered as green chips in the chip bar; chips appear only when a fleet is selected. | `{{mount.fleet-input-store}}` → `/input` |

---

## IBM Cloud API Integration

No `ibmcloud` CLI is installed in the container image. All IBM Cloud calls are
made directly over HTTPS from the Next.js Node.js process.

### IAM Token Exchange

```
POST https://iam.cloud.ibm.com/identity/token
Content-Type: application/x-www-form-urlencoded

# Preferred: trusted profile
grant_type=urn:ibm:params:oauth:grant-type:cr-token&cr_token=<CR token>&profile_id=<id>

# Backup: API key
grant_type=urn:ibm:params:oauth:grant-type:apikey&apikey=<key>
```

Tokens cached in module scope (one per source); refreshed 60 s before `expiration`.

### Code Engine Fleet REST API

The CE API is **region-scoped**. The CE API endpoint for each project encodes its
region. To list fleets across all projects the app:

1. Calls `GET https://api.<region>.codeengine.cloud.ibm.com/v2/projects` for each
   known region, with pagination (`limit=100&start=<token>`).
2. Known regions are discovered from the IAM global endpoint or from a configurable
   `CE_REGIONS` env var (comma-separated, defaults to all IBM Cloud regions where
   CE is available).
3. Fan-outs are run in parallel with `Promise.allSettled` — a region outage does
   not fail the whole list.

| Operation | Method | Path | Notes |
|---|---|---|---|
| List projects | GET | `https://api.<region>.codeengine.cloud.ibm.com/v2/projects` | paginated |
| List fleets | GET | `/v2/projects/<id>/fleets` | paginated; filter `status=standby` client-side |
| Get fleet | GET | `/v2/projects/<id>/fleets/<fleet-name>` | fetch mounts |
| List persistent data stores | GET | `/v2/projects/<id>/persistent_data_stores` | get bucket+secret name |
| Get secret (HMAC) | GET | `/v2/projects/<id>/secrets/<secret-name>` | decode base64 → COS creds |
| Add tasks to fleet | POST | `/v2/projects/<id>/fleets/<fleet-name>/tasks` | dispatch JSONL |

**Add tasks body** (`POST /v2/projects/<id>/fleets/<fleet-name>/tasks`):
```json
{
  "tasks_from_content": "<JSONL string — one task object per line>"
}
```

### COS access — derived from CE project

COS credentials are **not** provided as env vars. The bucket is resolved at runtime
from the CE project's persistent data stores:

1. `GET /v2/projects/<id>/persistent_data_stores` → get `bucket_name` + `hmac_secret_name`
2. Construct COS S3 endpoint as
   `https://s3.<bucket_region>.cloud-object-storage.appdomain.cloud`

Then, depending on the authentication mode:

- **Trusted profile (preferred):** requests to COS carry the trusted profile's IAM
  bearer token. The HMAC secret is **not** read.
- **HMAC (backup):** `GET /v2/projects/<id>/secrets/<hmac_secret_name>` → decode base64
  data → `{ access_key_id, secret_access_key }`.

Credentials are cached per project in the module-level store. The only env var for
COS is `COS_BUCKET` (which COS bucket in the fleet's project to use for uploads).

### IBM COS (S3-compatible)

`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, authenticated with the
trusted profile's IAM token (preferred) or the HMAC credentials retrieved from the CE
project at runtime (backup). Presigned URLs need HMAC keys, so they are only available
in the backup mode.

Operations:
- `PutObject` — template saves and small file uploads (< 5 MB)
- `GetObject` — template reads
- `getSignedUrl(PutObjectCommand)` — presigned PUT URL for browser-side direct uploads
- Multipart upload (`CreateMultipartUpload` + `UploadPart` + `CompleteMultipartUpload`)
  as fallback when presigned URL fails

**Upload flow:**
1. Browser calls `POST /api/presign` → server returns presigned PUT URL (1 h expiry).
   In trusted-profile mode this returns `501` (no HMAC keys are read), so the browser
   goes straight to step 3.
2. Browser `PUT`s file body directly to COS using the presigned URL (bypasses CE 32 MB request limit)
3. If presigned PUT is unavailable or fails, browser falls back to `POST /api/upload`
   which streams through the Next.js Route Handler to COS via AWS SDK multipart upload
   (IAM bearer token in trusted-profile mode, HMAC otherwise)

---

## Template Persistence Strategy

Templates are a single JSON array at COS key `dispatcher/templates.json`:

- **Read**: `GetObject` at page render (Server Component). Returns `[]` on 404.
- **Write**: Server Action: `GetObject` → upsert by `id` → `PutObject`.
- **Concurrency**: Last-writer-wins (acceptable for a lab/internal tool).
- **First run**: Object absent → 404 → empty array → first `saveTemplate()`
  creates it.

---

## API Reference

Only two explicit HTTP endpoints are needed. Fleet listing, template CRUD, and
dispatch use Server Components and Server Actions instead of REST endpoints.

### `POST /api/upload`

Streams files to COS. Needed as a Route Handler (not a Server Action) because
it requires streaming the raw multipart request body.

**Request** — `multipart/form-data`

| Field | Type | Description |
|---|---|---|
| `file` | file | File binary |
| `prefix` | string | COS object key prefix |

**Response**
```json
{
  "uploaded": [
    { "filename": "report.pdf", "key": "jobs/batch-01/report.pdf", "size": 204800 }
  ]
}
```

---

## Configuration

All configuration is provided through environment variables injected at runtime.
No config files are written or read from the local filesystem.

| Variable | Required | Description |
|---|---|---|
| `TRUSTED_PROFILE_ID` | ✅ (preferred) | IAM trusted profile ID; the app exchanges the Code Engine compute resource token for this profile's IAM token. Takes precedence over `TRUSTED_PROFILE_NAME`. Requires `--trusted-profiles-enabled=true` |
| `TRUSTED_PROFILE_NAME` | ❌ | Alternative to `TRUSTED_PROFILE_ID` |
| `CR_TOKEN_FILE_PATH` | ❌ | Compute resource token file (default `/var/run/secrets/codeengine.cloud.ibm.com/compute-resource-token/token`); local testing only |
| `IBMCLOUD_API_KEY` | ✅ (backup) | IBM Cloud IAM API key — used when no trusted profile is configured or as fallback when the trusted profile fails. One of the two auth options is required (neither with `DEMO_MODE=true`) |
| `CE_REGION` | ❌ | Single region to scan; injected automatically by Code Engine |
| `CE_REGIONS` | ❌ | Comma-separated list of CE regions to search. Defaults to all 10 CE regions: `us-south,us-east,eu-de,eu-gb,eu-es,jp-tok,jp-osa,au-syd,br-sao,ca-tor` |
| `PORT` | ❌ | HTTP port (default: `8080`) |

The bucket is chosen in the UI from the fleet project's persistent data stores
(no `COS_BUCKET` variable). See `.env.example` for the complete, current list.

The COS endpoint is derived at runtime from the CE project's persistent data stores.
With a trusted profile, COS is accessed with the profile's IAM token; otherwise the
referenced HMAC secret is read. No COS credentials are needed in the environment.

---

## Directory Structure

```
fleets-dispatcher/
├── DESIGN.md
├── README.md
├── Dockerfile
├── .env.example
├── next.config.ts               ← output: 'standalone'
├── package.json
├── tsconfig.json
│
├── app/                         ← Next.js App Router
│   ├── layout.tsx               ← Shell: header (fleet pill) + progress steps
│   ├── page.tsx                 ← Step 1: JSONL Template Builder (Server + Client)
│   ├── files/
│   │   └── page.tsx             ← Step 2: Files & Preview (Client Component)
│   ├── submit/
│   │   └── page.tsx             ← Step 3: Submit — upload + dispatch (Client)
│   ├── api/
│   │   └── upload/
│   │       └── route.ts         ← POST /api/upload  (Route Handler, streaming)
│   └── actions.ts               ← Server Actions: listFleets, saveTemplate, dispatchFleet
│
├── components/
│   ├── shell/
│   │   ├── Header.tsx           ← Carbon UIShell header with fleet pill
│   │   └── ProgressSteps.tsx    ← Carbon ProgressIndicator (3 steps)
│   ├── FleetModal.tsx           ← Carbon Modal: search + filter + fleet list
│   ├── FleetInfoBar.tsx         ← Selected fleet summary strip
│   ├── TemplateEditor.tsx       ← Step 1: image/cpu/args/mounts editor
│   ├── PlaceholderChips.tsx     ← Clickable placeholder chip bar
│   ├── FileDropZone.tsx         ← Carbon FileUploader drop zone
│   ├── StagedFileTable.tsx      ← Per-file prefix/custom overrides
│   ├── JsonlPreview.tsx         ← Dark terminal live JSONL preview
│   ├── ConfirmCheckbox.tsx      ← Carbon Checkbox confirmation
│   └── UploadProgress.tsx       ← Step 3 per-file upload status table
│
├── lib/                         ← Server-only modules (never bundled to browser)
│   ├── iam.ts                   ← IAM token manager
│   ├── ce.ts                    ← Code Engine REST client
│   ├── cos.ts                   ← COS S3 client
│   └── jsonl.ts                 ← JSONL generation (also imported by browser preview)
│
└── docs/
    ├── mockup.html              ← Interactive HTML mockup for design feedback
    ├── wireframes.md
    └── example-templates.json
```

---

## Container Build

```dockerfile
# Stage 1 — build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build        # next build (output: standalone)

# Stage 2 — production image
FROM node:20-alpine
WORKDIR /app
# standalone output includes its own node_modules — no npm install needed
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

EXPOSE 8080
ENV PORT=8080
ENV NODE_ENV=production
USER 1000
CMD ["node", "server.js"]
```

### Running locally

```bash
docker build -t fleets-dispatcher .
docker run --rm -p 8080:8080 --env-file .env fleets-dispatcher
```

### Deploying to Code Engine

```bash
ibmcloud cr login
docker tag fleets-dispatcher <region>.icr.io/<namespace>/fleets-dispatcher:latest
docker push <region>.icr.io/<namespace>/fleets-dispatcher:latest

# Preferred: trusted profile (create it in IAM first: trust the CE app as a compute
# resource; grant Code Engine project/fleet access and COS Writer)
ibmcloud ce app create \
  --name fleets-dispatcher \
  --image <region>.icr.io/<namespace>/fleets-dispatcher:latest \
  --port 8080 \
  --trusted-profiles-enabled=true \
  --env TRUSTED_PROFILE_ID=<trusted-profile-id> \
  --env CE_REGION=eu-de \
  --env CE_PROJECT_NAME=fleetlab-user1--ce-project \
  --env COS_ENDPOINT=s3.eu-de.cloud-object-storage.appdomain.cloud \
  --env COS_BUCKET=fleet-input-store \
  --visibility project

# Optional backup: API key, used if the trusted profile cannot be used
ibmcloud ce secret create --name dispatcher-secrets \
  --from-literal IBMCLOUD_API_KEY=...
ibmcloud ce app update --name fleets-dispatcher --env-from-secret dispatcher-secrets
```

---

## Technology Choices

| Layer | Choice | Rationale |
|---|---|---|
| Framework | **Next.js 15 App Router** | Server Components + Server Actions + Route Handlers eliminate the need for a separate Express server; `output: standalone` is purpose-built for single-container deployment |
| Language | TypeScript | Shared types between server modules (`lib/`) and client components; catches integration mistakes at build time |
| Design system | **IBM Carbon Design System** (`@carbon/react`) | Official IBM design language; Modal, DataTable, FileUploader, ProgressIndicator, InlineNotification used directly — no custom component reimplementation |
| Multipart streaming | `busboy` (in Route Handler) | Stream-based parser — no temp files, no disk I/O |
| COS client | `@aws-sdk/client-s3` | IBM COS is S3-compatible; AWS SDK v3 streams natively |
| IBM Cloud auth | In-process IAM REST call; trusted profile preferred, API key backup | No `ibmcloud` CLI; single HTTP call, token cached in module scope; trusted profiles avoid stored credentials and rotation |
| Template storage | COS object `dispatcher/templates.json` | Zero additional infrastructure; consistent with the existing COS bucket |
| Container base | `node:20-alpine` | Minimal attack surface |

---

## Security Considerations

1. **Credentials stay in the Node.js process.** With a trusted profile there is no
   stored credential: the compute resource token and the IAM tokens derived from it
   are read only server-side. In backup mode `IBMCLOUD_API_KEY` and the HMAC keys are
   likewise read only by Server Components, Server Actions, and Route Handlers —
   they are never serialised into the client bundle or returned in API responses.
2. **No filesystem writes.** `output: standalone` + `readOnlyRootFilesystem: true`
   is safe. File data flows browser → Route Handler stream → COS S3 stream.
3. **Server Actions are POST-only with CSRF protection.** Next.js Server Actions
   automatically include origin checking — cross-site form submissions are
   rejected.
4. **Fleet allowlist.** The fleet list is scoped to `CE_PROJECT_NAME`; no
   cross-project dispatch is possible.
5. **JSONL sanitisation.** Filenames are validated against
   `[a-zA-Z0-9._\-/]` before JSONL generation.
6. **Non-root user.** Container runs as UID 1000.
7. **Deployment visibility.** Use `--visibility project` on Code Engine to
   restrict access to within the project network.

---

## Future Work (optional enhancements)

This project is sample code. The items below are ideas for adopters who want to
extend it; none is a defect and the current behaviour is as intended.

| # | Topic | Notes |
|---|---|---|
| 1 | **Fleet status polling** | Server Component re-fetches on navigation; add `router.refresh()` polling for live standby list. |
| 2 | **Task progress view** | 5th page using `useEffect` + polling `GET /projects/<id>/fleets/<id>/tasks` via a Route Handler. |
| 3 | **Large batch splitting** | Auto-split >10 k file batches into multiple sequential fleet runs. |
| 4 | **App-level auth** | On Code Engine, an OIDC layer in front of the app provides authentication. Add Next.js middleware only if you deploy without it. |
| 5 | **Output store viewer** | Route Handler proxying `ListObjectsV2` on the output bucket; render as a results table. |
| 6 | **Dry-run mode** | Server Action variant that returns the fleet run payload JSON without submitting. |
| 7 | **Multi-bucket support** | Template-level override for upload bucket, not just prefix. |
