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
| At least one **persistent data store** in that project, backed by a **private COS bucket** with an **HMAC secret** | Your files are uploaded to this bucket. The app reads the HMAC credentials from the project, so you never paste COS keys into the app. |
| The fleet has that bucket **mounted** | So your task containers can read the uploaded files. |
| An **IBM Cloud API key** with access to the Code Engine project (list fleets, read secrets, add tasks) | The app calls the Code Engine API on your behalf. The key stays on the server and is never sent to the browser. |
| Node.js 20+ **or** Docker | To run the app. |

Not set up yet? The IBM Cloud Code Engine docs cover this under
*Preparing to run a fleet* and *Working with persistent data stores*.

---

## Run it

### Option A — locally with Node

```bash
cp .env.example .env.local     # then edit .env.local and set IBMCLOUD_API_KEY
npm install
npm run dev                    # http://localhost:8080
```

For a production-style run: `npm run build && npm start`.

### Option B — Docker

```bash
docker build -t fleets-dispatcher .
docker run --rm -p 8080:8080 \
  -e IBMCLOUD_API_KEY=<your-api-key> \
  fleets-dispatcher
```

Open <http://localhost:8080>.

> **Security:** the app has no login of its own and uses your API key. For local and
> Docker runs, keep it on `localhost` or a private network. On Code Engine,
> authentication is provided by the OIDC layer in front of the app (see below).

### Option C — deploy to Code Engine

```bash
# 1. Push the image
ibmcloud cr login
docker build -t <region>.icr.io/<namespace>/fleets-dispatcher:latest .
docker push <region>.icr.io/<namespace>/fleets-dispatcher:latest

# 2. Store the API key as a secret (Code Engine does not provide one for you)
ibmcloud ce secret create --name dispatcher-secrets \
  --from-literal IBMCLOUD_API_KEY=<your-api-key>

# 3. Create the app (add --registry-secret if the registry is private)
ibmcloud ce app create \
  --name fleets-dispatcher \
  --image <region>.icr.io/<namespace>/fleets-dispatcher:latest \
  --port 8080 \
  --env-from-secret dispatcher-secrets \
  --visibility project
```

Code Engine sets `CE_REGION` for you, so the app only looks at that region.

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

Only `IBMCLOUD_API_KEY` is required. Everything else is optional. See
[`.env.example`](./.env.example) for the full list.

| Variable | Default | Purpose |
|---|---|---|
| `IBMCLOUD_API_KEY` | — | **Required** (not needed in demo mode). |
| `DEMO_MODE` | off | `true` = fake fleet, simulated uploads. |
| `CE_REGION` | set by Code Engine | Only look at this region. |
| `CE_REGIONS` | all 10 regions | Comma-separated list, for local multi-region use. |
| `ENABLE_DEBUG` | off | `true` = show the API debug panel outside demo mode. |
| `PRESIGN_EXPIRY_SECONDS` | `3600` | How long an upload link stays valid. Raise it for huge files on slow links. |
| `PORT` | `8080` | HTTP port. |

Upload tuning (`NEXT_PUBLIC_MAX_CONCURRENT_UPLOADS`, `NEXT_PUBLIC_MAX_UPLOAD_RETRIES`,
`NEXT_PUBLIC_UPLOAD_TIMEOUT_MS`) is fixed **at build time**. For Docker, pass them as
`--build-arg`, for example `docker build --build-arg NEXT_PUBLIC_MAX_UPLOAD_RETRIES=5 .`.

---

## Troubleshooting

| Symptom | What to check |
|---|---|
| "Could not load fleets: IBMCLOUD_API_KEY is not set" | Set the variable (or try `DEMO_MODE=true`). |
| "Could not load fleets: … 401/403" | The API key is wrong or lacks access to the Code Engine project. |
| No fleets listed | Wrong region (`CE_REGION`), or the key can't see the project. |
| "No COS buckets found" in the Files step | The fleet's project has no persistent data stores. Create one (see *What you need*). |
| Uploads are slow or always take the "fallback" route | Direct browser-to-COS uploads need a CORS rule on the bucket allowing `PUT` from the app's URL. Without it the app automatically streams uploads through the server instead — slower, but it works. |
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
