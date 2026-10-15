# Fleets Dispatcher

A web app for sending batch work to an **IBM Cloud Code Engine Serverless Fleet** —
no command line needed. Pick a fleet, describe the command to run, drop in your
files, and press one button. The app uploads the files to Cloud Object Storage (COS)
and adds one task per file to the fleet.

Built with Next.js and the IBM Carbon Design System. It ships as a single stateless
container.

> **Sample code.** This project is provided as a working sample, not a finished
> product, and does not guarantee it will meet every need. Its limits (for example no
> saved templates, no unit tests, no task-progress view, no batch splitting) are
> intentional and are good starting points for adapting or extending it.

---

## Try it in 2 minutes (no IBM Cloud account needed)

Demo mode uses a fake fleet and simulates every upload and dispatch, so you can
click through the whole workflow safely.

```bash
npm install
DEMO_MODE=true npm run dev
```

Open <http://localhost:8080>, choose the demo fleet, load a preset template, add a
few files and press **Upload & Dispatch**. Nothing leaves your machine.

Demo mode also turns on the **API debug panel** (tab on the right edge) which shows
the exact `curl` command for every IBM Cloud call the app would make.

---

## What you need for real use

| You need | Why |
|---|---|
| A Code Engine **fleet** (standby or running) | This is where your tasks run. |
| At least one **persistent data store** in that project, backed by a **private COS bucket** | Your files are uploaded to this bucket. The persistent data store also requires an HMAC secret — the app reads it only in fallback mode (non-Code-Engine deployments); when deployed on Code Engine with a trusted profile the HMAC secret is never read. |
| The fleet has that bucket **mounted** | So your task containers can read the uploaded files. |
| **On Code Engine:** an IAM **trusted profile** that trusts this app as a compute resource, with Viewer + Fleet Operator on the CE project and Writer on the COS bucket | The single IAM token is used for both the Code Engine API and COS. No API key, no HMAC keys, nothing to rotate. |
| **Outside Code Engine:** an **IBM Cloud API key** with access to the CE project (list fleets, read secrets, add tasks) | Used when no trusted profile is configured — local development or other container runtimes. |
| Node.js 20+ **or** Docker | To run the app. |

Not set up yet? The IBM Cloud Code Engine docs cover this under
*Preparing to run a fleet* and *Working with persistent data stores*.

---

## Run it

### Option A — locally with Node

```bash
cp .env.example .env.local
# Edit .env.local: set IBMCLOUD_API_KEY (no trusted profile available outside Code Engine)
npm install
npm run dev                    # http://localhost:8080
```

For a production-style run: `npm run build && npm start`.

### Option B — Docker (outside Code Engine)

```bash
docker build -t fleets-dispatcher .
docker run --rm -p 8080:8080 \
  -e IBMCLOUD_API_KEY=<your-api-key> \
  fleets-dispatcher
```

Open <http://localhost:8080>.

> **Security:** the app has no login of its own. For local and Docker runs, keep it on
> `localhost` or a private network. On Code Engine, authentication is provided by the
> OIDC layer in front of the app (see below).

### Option C — deploy to Code Engine (recommended, trusted profile)

This is the primary deployment target. The trusted profile provides all authentication —
no API key, no HMAC credentials, nothing to store or rotate.

```bash
# 1. Push the image
ibmcloud cr login
docker build -t <region>.icr.io/<namespace>/fleets-dispatcher:latest .
docker push <region>.icr.io/<namespace>/fleets-dispatcher:latest

# 2. In IAM, create a trusted profile:
#    - Trust entity: "Compute resource" → Code Engine → this project → this application
#    - Access: Code Engine (Viewer + Fleet Operator), COS bucket (Writer)
#    https://cloud.ibm.com/docs/codeengine?topic=codeengine-trusted-profiles

# 3. Create the app with trusted profiles enabled
ibmcloud ce app create \
  --name fleets-dispatcher \
  --image <region>.icr.io/<namespace>/fleets-dispatcher:latest \
  --port 8080 \
  --trusted-profiles-enabled=true \
  --env TRUSTED_PROFILE_ID=<trusted-profile-id> \
  --visibility project
```

Code Engine mounts a compute resource token into the container automatically. The app
exchanges it for an IAM bearer token of the trusted profile. **The same token is used
for both the Code Engine API and COS** — no API key, no HMAC credentials are read.

> **Uploads on Code Engine:** IAM bearer tokens cannot sign S3 presigned URLs, so
> `/api/presign` returns 501 and the browser automatically uses `/api/upload` instead,
> which streams through the server using the trusted profile's IAM token. This is the
> normal, expected behaviour with trusted-profile auth.

Code Engine sets `CE_REGION` automatically, so the app only looks at that region.

**Authentication:** the app does not implement login itself. It expects users to be
authenticated by an OIDC provider placed in front of it, so all requests (including
`/api/presign`, `/api/upload` and server actions) must only reach the app through
that layer. `--visibility project` keeps the app itself private to the Code Engine
project, so the OIDC layer is the only way in.

---

## Using the app

1. **Select a fleet** — click *Select a fleet…* (top right). Fleets from every
   project you can access are listed; use the search box and the project / region
   filters to narrow them down. If there is only one, it is chosen for you.
2. **Task Template** — say what each task should run. Pick a preset (Docling,
   word count, batch inferencing) or fill in the three fields yourself:
   - `idx` – optional task name (e.g. `{{filename}}`)
   - `cmds` – the program to run (e.g. `python`, `app.py`)
   - `args` – its arguments, one per row
3. **Files** — choose the COS bucket, drop in files or a folder, and untick any you
   don't want. Each selected file becomes **one task**. You can add more files at any
   time, filter by extension, and set an optional sub-folder (prefix) inside the bucket.
4. **JSONL Preview** — check the exact task lines that will be sent, then tick the
   confirmation box.
5. **Submit** — press **Upload & Dispatch Fleet**. Files upload in parallel (with
   retries), then the tasks are added to the fleet. Files that still fail after all
   retries are skipped; the rest are dispatched.

When it finishes, the app shows a command you can run to watch your tasks:

```bash
ibmcloud ce fleet task list --fleet-id <fleet-id>
```

### Placeholders

Use these in `idx`, `cmds` and `args`. Click a chip in the app to copy it.

| Placeholder | Meaning | Example |
|---|---|---|
| `{{filename}}` | File name | `report.pdf` |
| `{{stem}}` | File name without extension | `report` |
| `{{ext}}` | Extension without the dot | `pdf` |
| `{{relPath}}` | Path of the file **inside the mounted store** — use this after a mount placeholder | `batch-01/report.pdf` |
| `{{cosPath}}` | Full COS object key (includes the store prefix) | `input/batch-01/report.pdf` |
| `{{prefix}}` | The key's folder part | `input/batch-01/` |
| `{{index}}` | Task number, zero-padded | `00003` |
| `{{mount.STORE}}` | Where the fleet mounts persistent data store `STORE` inside the container | `/mnt/input` |

Typical pattern for a file path inside the container:

```
{{mount.my-input-store}}/{{relPath}}
```

Example: for a file `report.pdf` this template…

```json
{ "idx": "{{filename}}", "cmds": ["docling"],
  "args": ["{{mount.my-input-store}}/{{relPath}}", "--output", "{{mount.my-output-store}}/{{stem}}.md"] }
```

…produces this task line:

```json
{"idx":"report.pdf","cmds":["docling"],"args":["/mnt/input/report.pdf","--output","/mnt/output/report.md"]}
```

More examples are in [`docs/example-templates.json`](./docs/example-templates.json).

> Templates are not saved between visits — reload a preset or retype. They are kept
> only while the page is open.

---

## Configuration

On **Code Engine**, set `TRUSTED_PROFILE_ID` (or `TRUSTED_PROFILE_NAME`) — that is the
only auth variable needed. Outside Code Engine (local dev, other containers) set
`IBMCLOUD_API_KEY` instead. Neither is needed in demo mode.
See [`.env.example`](./.env.example) for the full list.

| Variable | Default | Purpose |
|---|---|---|
| `TRUSTED_PROFILE_ID` | — | **Code Engine auth (primary).** IAM trusted profile ID. Takes precedence over the name. Requires `--trusted-profiles-enabled=true`. Covers both CE API and COS — nothing else needed. |
| `TRUSTED_PROFILE_NAME` | — | Alternative to `TRUSTED_PROFILE_ID`. |
| `CR_TOKEN_FILE_PATH` | `/var/run/secrets/codeengine.cloud.ibm.com/compute-resource-token/token` | Compute resource token location. Only override for local testing. |
| `IBMCLOUD_API_KEY` | — | **Non-Code-Engine auth (fallback).** Required when no trusted profile is configured. Covers CE API + CE-secret lookup for HMAC COS credentials. |
| `DEMO_MODE` | off | `true` = fake fleet, simulated uploads. |
| `CE_REGION` | set by Code Engine | Only look at this region. |
| `CE_REGIONS` | all 10 regions | Comma-separated list, for local multi-region use. |
| `ENABLE_DEBUG` | off | `true` = show the API debug panel outside demo mode. |
| `PRESIGN_EXPIRY_SECONDS` | `3600` | How long an upload link stays valid (HMAC mode only). Raise it for huge files on slow links. |
| `PORT` | `8080` | HTTP port. |

Upload tuning (`NEXT_PUBLIC_MAX_CONCURRENT_UPLOADS`, `NEXT_PUBLIC_MAX_UPLOAD_RETRIES`,
`NEXT_PUBLIC_UPLOAD_TIMEOUT_MS`) is fixed **at build time**. For Docker, pass them as
`--build-arg`, for example `docker build --build-arg NEXT_PUBLIC_MAX_UPLOAD_RETRIES=5 .`.

---

## Troubleshooting

| Symptom | What to check |
|---|---|
| "Could not load fleets: IBMCLOUD_API_KEY is not set" | Neither a trusted profile nor an API key is configured. Set `TRUSTED_PROFILE_ID` or `IBMCLOUD_API_KEY` (or try `DEMO_MODE=true`). |
| "Compute resource token not readable …" | Trusted profiles aren't enabled on the app: `ibmcloud ce app update --name <app> --trusted-profiles-enabled=true`. |
| "Could not load fleets: … 401/403" | The API key or trusted profile is wrong, or lacks access to the Code Engine project. For a trusted profile, also check its trust rule targets this specific application. |
| API debug panel shows "⚠ Trusted profile failed — falling back to API key" | The trusted profile exchange failed at runtime. Check `TRUSTED_PROFILE_ID`, that `--trusted-profiles-enabled=true` is set, and that the IAM trust rule matches this application. |
| No fleets listed | Wrong region (`CE_REGION`), or the credentials can't see the project. |
| "No COS buckets found" in the Files step | The fleet's project has no persistent data stores. Create one (see *What you need*). |
| COS access fails with trusted profile | The trusted profile's IAM roles must include Writer on the COS bucket. Check the IAM policy attached to the profile. |
| Uploads always go through `/api/upload` instead of direct presigned PUT | Expected on Code Engine with a trusted profile — IAM bearer tokens cannot sign presigned URLs. This is normal behaviour. |
| "JSONL payload too large" | Too many files for one dispatch. Split into smaller batches. |
| Some files show a red "Failed" badge | They failed every retry and were left out of the dispatch. Hover the badge for the reason, then dispatch them again as a new batch. |

---

## For developers

```bash
npm run dev         # dev server on :8080
npm run type-check  # TypeScript
npm run build       # production build (standalone output)
```

```
app/
  page.tsx            loads the fleet list on the server
  actions.ts          server actions: fetchFleets, fetchPersistentDataStores, dispatchFleet
  api/presign         issues a time-limited direct-upload URL
  api/upload          fallback: streams a file through the server to COS
  api/apilog          debug panel feed (demo / ENABLE_DEBUG only)
components/           Carbon UI: one component per workflow section
lib/ce.ts             Code Engine REST client (projects, fleets, data stores, add_tasks)
lib/cos.ts            COS (S3-compatible) helpers
lib/iam.ts            IAM token exchange + cache
lib/jsonl.ts          placeholder expansion and JSONL generation (pure functions)
docs/                 design notes, mockup, example templates
```

Further reading: [`DESIGN.md`](./DESIGN.md) (original design — some details predate the
current single-page UI), [`docs/CODE_REVIEW.md`](./docs/CODE_REVIEW.md).
