# Fleets Dispatcher — UI Wireframes

ASCII wireframes for each step of the 4-step wizard.

---

## Step 1 — Fleet Selection  (`/`)

```
╔══════════════════════════════════════════════════════════════════╗
║  🚀  Fleets Dispatcher                                           ║
╠══════════════════════════════════════════════════════════════════╣
║                                                                  ║
║  Step  ① Select Fleet  ──  ② Upload  ──  ③ Template  ──  ④ Dispatch  ║
║                                                                  ║
║  ┌────────────────────────────────────────────────────────────┐  ║
║  │  Select a standby fleet                                    │  ║
║  │                                                            │  ║
║  │  Fleet  ▼  fleet-b4bd2a33-1  (eu-de / standby)            │  ║
║  │         ├─ fleet-b4bd2a33-1   eu-de  standby              │  ║
║  │         ├─ fleet-c7fa1122-2   eu-de  standby              │  ║
║  │         └─ fleet-d91ba445-3   us-south  standby           │  ║
║  │                                                            │  ║
║  │  ╔══════════════════════════════════════════════════════╗  │  ║
║  │  ║  Fleet Details                                       ║  │  ║
║  │  ║  Name:             fleet-b4bd2a33-1                  ║  │  ║
║  │  ║  ID:               e3caac88-cfc2-4602-…              ║  │  ║
║  │  ║  Region:           eu-de                             ║  │  ║
║  │  ║  Project:          fleetlab-user1--ce-project        ║  │  ║
║  │  ║  Task State Store: fleet-task-store                  ║  │  ║
║  │  ║  Subnetpool:       fleet-subnetpool                  ║  │  ║
║  │  ╚══════════════════════════════════════════════════════╝  │  ║
║  │                                                            │  ║
║  │                              [ Next: Upload Files → ]      │  ║
║  └────────────────────────────────────────────────────────────┘  ║
╚══════════════════════════════════════════════════════════════════╝
```

---

## Step 2 — File Upload  (`/upload`)

```
╔══════════════════════════════════════════════════════════════════╗
║  🚀  Fleets Dispatcher                                           ║
╠══════════════════════════════════════════════════════════════════╣
║                                                                  ║
║  Step  ✓ Select Fleet  ──  ② Upload  ──  ③ Template  ──  ④ Dispatch  ║
║                                                                  ║
║  ┌────────────────────────────────────────────────────────────┐  ║
║  │  Upload files to COS                                       │  ║
║  │                                                            │  ║
║  │  COS Prefix:  [ jobs/batch-2025-09-01/              ]     │  ║
║  │                                                            │  ║
║  │  ┌──────────────────────────────────────────────────────┐ │  ║
║  │  │                                                      │ │  ║
║  │  │   ⬆  Drop files or a folder here                    │ │  ║
║  │  │      or  [ Browse Files ]  [ Browse Folder ]        │ │  ║
║  │  │                                                      │ │  ║
║  │  └──────────────────────────────────────────────────────┘ │  ║
║  │                                                            │  ║
║  │  ┌──────────────────────────────┬────────┬───────────┐    │  ║
║  │  │ File                         │  Size  │  Status   │    │  ║
║  │  ├──────────────────────────────┼────────┼───────────┤    │  ║
║  │  │ report_2025.pdf              │ 1.2 MB │ ✅ done   │    │  ║
║  │  │ invoice_jan.pdf              │ 340 KB │ ⏳ 67%   │    │  ║
║  │  │ summary.pdf                  │ 89 KB  │ ⏸ queued │    │  ║
║  │  └──────────────────────────────┴────────┴───────────┘    │  ║
║  │                                                            │  ║
║  │  [ ← Back ]                   [ Next: Configure Template → ]  ║
║  └────────────────────────────────────────────────────────────┘  ║
╚══════════════════════════════════════════════════════════════════╝
```

---

## Step 3 — Template Configuration  (`/template`)

```
╔══════════════════════════════════════════════════════════════════╗
║  🚀  Fleets Dispatcher                                           ║
╠══════════════════════════════════════════════════════════════════╣
║                                                                  ║
║  Step  ✓ Select Fleet  ──  ✓ Upload  ──  ③ Template  ──  ④ Dispatch  ║
║                                                                  ║
║  ┌────────────────────────────────────────────────────────────┐  ║
║  │  Task Template                                             │  ║
║  │                                                            │  ║
║  │  Template  ▼  Docling — PDF to Markdown                   │  ║
║  │                                                            │  ║
║  │  Image:     [ ghcr.io/ds4sd/docling:latest          ]     │  ║
║  │  CPU:       [ 4  ]   Memory: [ 8G ]   Max Scale: [ 10 ]  │  ║
║  │                                                            │  ║
║  │  Mount Data Stores:                                        │  ║
║  │  [ /input  ] = [ fleet-input-store  ] : [ pdfs    ]  [x]  │  ║
║  │  [ /output ] = [ fleet-output-store ] : [ docling ]  [x]  │  ║
║  │  [ + Add Mount ]                                           │  ║
║  │                                                            │  ║
║  │  Command:    [ docling                              ]      │  ║
║  │  Arguments:  [ --num-threads        ] [ 12          ]      │  ║
║  │              [ /input/{{filename}}  ]                      │  ║
║  │              [ --output             ] [ /output/{{stem}}.md ]  ║
║  │              [ + Add Argument ]                            │  ║
║  │                                                            │  ║
║  │  ── JSONL Preview (first 3 tasks) ──────────────────────   │  ║
║  │  {"cmds":["docling"],"args":["--num-threads","12",         │  ║
║  │    "/input/report_2025.pdf","--output",                    │  ║
║  │    "/output/report_2025.md"]}                              │  ║
║  │  {"cmds":["docling"],"args":["--num-threads","12",         │  ║
║  │    "/input/invoice_jan.pdf","--output",                    │  ║
║  │    "/output/invoice_jan.md"]}                              │  ║
║  │  ... (1 more)                                              │  ║
║  │                                                            │  ║
║  │  [ 💾 Save Template ]                                      │  ║
║  │                                                            │  ║
║  │  [ ← Back ]                        [ Next: Dispatch → ]   │  ║
║  └────────────────────────────────────────────────────────────┘  ║
╚══════════════════════════════════════════════════════════════════╝
```

---

## Step 4 — Dispatch  (`/dispatch`)

```
╔══════════════════════════════════════════════════════════════════╗
║  🚀  Fleets Dispatcher                                           ║
╠══════════════════════════════════════════════════════════════════╣
║                                                                  ║
║  Step  ✓ Select Fleet  ──  ✓ Upload  ──  ✓ Template  ──  ④ Dispatch  ║
║                                                                  ║
║  ┌────────────────────────────────────────────────────────────┐  ║
║  │  Dispatch Summary                                          │  ║
║  │                                                            │  ║
║  │  Fleet:       fleet-b4bd2a33-1  (eu-de)                   │  ║
║  │  Template:    Docling — PDF to Markdown                    │  ║
║  │  COS Prefix:  jobs/batch-2025-09-01/                       │  ║
║  │  Tasks:       3                                            │  ║
║  │  Image:       ghcr.io/ds4sd/docling:latest                 │  ║
║  │                                                            │  ║
║  │  Fleet run name:  [ dispatcher-docling-{auto}       ]      │  ║
║  │                                                            │  ║
║  │  ── Full JSONL (3 tasks) ───────────────────────────────   │  ║
║  │  {"cmds":["docling"],"args":["--num-threads","12",         │  ║
║  │    "/input/report_2025.pdf","--output","/output/report_2025.md"]}  ║
║  │  {"cmds":["docling"],"args":["--num-threads","12",         │  ║
║  │    "/input/invoice_jan.pdf","--output","/output/invoice_jan.md"]}  ║
║  │  {"cmds":["docling"],"args":["--num-threads","12",         │  ║
║  │    "/input/summary.pdf","--output","/output/summary.md"]}  │  ║
║  │                                         [ ✏ Edit JSONL ]   │  ║
║  │                                                            │  ║
║  │  [ ← Back ]                     [ 🚀 Dispatch Fleet ]     │  ║
║  └────────────────────────────────────────────────────────────┘  ║
║                                                                  ║
║  ── After successful dispatch ──────────────────────────────────  ║
║  ┌────────────────────────────────────────────────────────────┐  ║
║  │  ✅ Fleet dispatched successfully!                          │  ║
║  │                                                            │  ║
║  │  Fleet ID:   3f7a1c2a-6d85-4b27-bc4f-7e519645e23b         │  ║
║  │  Name:       dispatcher-docling-a1b2c3                     │  ║
║  │  Tasks:      3                                             │  ║
║  │                                                            │  ║
║  │  Monitor with:                                             │  ║
║  │  ibmcloud ce fleet get --id 3f7a1c2a-…                    │  ║
║  │  ibmcloud ce fleet task list --fleet-id 3f7a1c2a-…        │  ║
║  │                                                            │  ║
║  │  [ Dispatch Another Batch ]                                │  ║
║  └────────────────────────────────────────────────────────────┘  ║
╚══════════════════════════════════════════════════════════════════╝
```
