'use client'

/**
 * SubmitSection — Phase 1: upload files to COS, Phase 2: dispatch tasks to fleet.
 *
 * Upload strategy:
 * - Primary path:  browser → COS via presigned PUT URL (XHR with upload.onprogress)
 * - Fallback path: browser → /api/upload SSE stream (real progress even through the server)
 * - Concurrency:   NEXT_PUBLIC_MAX_CONCURRENT_UPLOADS workers (default: navigator cores, capped at 12)
 * - Retry:         NEXT_PUBLIC_MAX_UPLOAD_RETRIES retries per file (default 3, exponential back-off)
 * - Timeout:       NEXT_PUBLIC_UPLOAD_TIMEOUT_MS per file (default 600 000 ms = 10 min)
 * - Partial dispatch: files that still fail after all retries are skipped from the JSONL;
 *   only successfully uploaded files are dispatched to the fleet.
 *
 * Security:
 * - File objects are read via FileContext — no window globals.
 * - All uploads use HMAC credentials from the CE project secret — bucket is always private.
 *
 * NOTE: dispatchFleet is imported directly from app/actions because it is a
 * Next.js Server Action. Calling a server action from a Client Component is the
 * correct and intentional Next.js 15+ pattern — the framework serialises the
 * arguments and response over an internal RPC call. No manual fetch() needed.
 */

import { useState, useRef } from 'react'
import { Button, InlineNotification, Tag, Tooltip } from '@carbon/react'
import type { Fleet } from '@/lib/ce'
import type { Template, StagedFile } from '@/lib/jsonl'
import { dispatchFleet } from '@/app/actions'
import { useFileStore } from './FileContext'

// ── Configuration ─────────────────────────────────────────────────────────────
// All NEXT_PUBLIC_ vars are evaluated at build time by Next.js.
// Set them in .env.local or pass them as Docker build args / CE env vars.

/** How many files upload simultaneously. Defaults to the number of logical CPU cores,
 *  capped at 12 — this maximises throughput on fast networks without overwhelming slower ones. */
const MAX_CONCURRENT: number = (() => {
  const fromEnv = parseInt(process.env.NEXT_PUBLIC_MAX_CONCURRENT_UPLOADS ?? '', 10)
  if (!isNaN(fromEnv) && fromEnv > 0) return fromEnv
  // Browser heuristic: navigator.hardwareConcurrency is available client-side
  if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency > 0) {
    return Math.min(12, navigator.hardwareConcurrency)
  }
  return 6 // safe server-side SSR fallback
})()

/** Max retries per file before it is skipped (default 3). */
const MAX_RETRIES = Math.max(1, parseInt(process.env.NEXT_PUBLIC_MAX_UPLOAD_RETRIES ?? '3', 10))

/** Per-file upload timeout in milliseconds (default 10 min = 600 000 ms).
 *  If a file stalls — network drop, COS throttle — the upload is aborted and retried. */
const UPLOAD_TIMEOUT_MS = Math.max(
  30_000,
  parseInt(process.env.NEXT_PUBLIC_UPLOAD_TIMEOUT_MS ?? '600000', 10)
)

interface Props {
  fleet: Fleet
  template: Template
  files: StagedFile[]
  /** COS bucket selected in the Files section — selects the matching HMAC secret server-side */
  bucket: string
  demoMode: boolean
  open: boolean
  onToggle: () => void
  onReset: () => void
}

type Phase = 'idle' | 'uploading' | 'dispatching' | 'done' | 'error'
type FileState = 'pending' | 'uploading' | 'done' | 'skipped' | 'error'

interface FileStatus {
  name: string
  key: string
  size: string
  state: FileState
  progress: number   // 0–100, only valid when state === 'uploading'
  retryCount: number
  error?: string
}

export default function SubmitSection({
  fleet, template, files, bucket, demoMode, open, onToggle, onReset,
}: Props) {
  const fileStore = useFileStore()

  const [phase, setPhase]               = useState<Phase>('idle')
  const [fileStatuses, setFileStatuses] = useState<FileStatus[]>([])
  const [dispatchResult, setDispatchResult] = useState<{
    fleetName: string; taskCount: number; monitorCmd: string
  } | null>(null)
  const [errorMsg, setErrorMsg]   = useState('')
  const doneCountRef  = useRef(0)
  const [doneCount, setDoneCount] = useState(0)

  // ── Helpers ───────────────────────────────────────────────────────────────

  function initStatuses(): FileStatus[] {
    return files.map(f => {
      const fname = f.cosKey.split('/').pop() ?? f.name
      return { name: fname, key: f.cosKey, size: f.sizeLabel, state: 'pending', progress: 0, retryCount: 0 }
    })
  }

  function updateStatus(i: number, patch: Partial<FileStatus>) {
    setFileStatuses(prev => {
      const next = [...prev]
      next[i] = { ...next[i], ...patch }
      return next
    })
  }

  // ── XHR presigned PUT (with progress + timeout) ───────────────────────────

  function xhrPut(url: string, file: File, onProgress: (pct: number) => void): Promise<boolean> {
    return new Promise(resolve => {
      const xhr = new XMLHttpRequest()
      xhr.open('PUT', url)
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
      xhr.timeout = UPLOAD_TIMEOUT_MS
      xhr.upload.onprogress = e => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
      }
      xhr.onload   = () => resolve(xhr.status >= 200 && xhr.status < 300)
      xhr.onerror  = () => resolve(false)
      xhr.ontimeout = () => resolve(false)
      xhr.send(file)
    })
  }

  // ── Fallback: SSE streaming upload via /api/upload ────────────────────────
  // The route handler streams progress events back as SSE (text/event-stream).
  // Each event is: data: {"type":"progress","pct":N}\n\n
  // Final event is either: data: {"type":"done","key":"..."}\n\n
  //                     or: data: {"type":"error","message":"..."}\n\n

  async function sseUpload(
    actualFile: File,
    fname: string,
    cosKey: string,
    onProgress: (pct: number) => void
  ): Promise<void> {
    const fd = new FormData()
    // Fields MUST precede the file part so busboy reads them before the stream starts
    fd.append('key',       cosKey)
    fd.append('projectId', fleet.projectId)
    fd.append('region',    fleet.region)
    fd.append('bucket',    bucket)
    fd.append('file',      actualFile, fname)

    // The timeout covers the whole exchange (upload + reading the SSE stream)
    const controller = new AbortController()
    const timeoutId  = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS)

    try {
      const res = await fetch('/api/upload', { method: 'POST', body: fd, signal: controller.signal })
      if (!res.body) throw new Error('No response body from upload route')

      // Read the SSE stream line by line
      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer    = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // Process complete SSE event lines
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? '' // keep incomplete last line

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const json = line.slice('data: '.length).trim()
          if (!json) continue
          let evt: { type: string; pct?: number; message?: string }
          try { evt = JSON.parse(json) } catch { continue }

          if (evt.type === 'progress' && typeof evt.pct === 'number') {
            onProgress(evt.pct)
          } else if (evt.type === 'done') {
            return // success
          } else if (evt.type === 'error') {
            throw new Error(evt.message ?? 'Upload failed')
          }
        }
      }
      // The stream closed without a 'done' event: the upload was interrupted. Treating
      // this as success would dispatch tasks for a file that is not in COS.
      throw new Error(res.ok ? 'Upload stream ended unexpectedly' : `Upload failed (HTTP ${res.status})`)
    } finally {
      clearTimeout(timeoutId)
    }
  }

  // ── Single-file upload (with retry) ──────────────────────────────────────

  async function uploadOne(file: StagedFile, idx: number): Promise<'done' | 'skipped'> {
    const fname     = file.cosKey.split('/').pop() ?? file.name
    const cosKey    = file.cosKey
    let lastError   = ''

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      updateStatus(idx, { state: 'uploading', progress: 0, retryCount: attempt - 1, error: undefined })

      // Demo mode — fake progress then mark done
      if (demoMode) {
        for (let p = 0; p <= 100; p += 20) {
          updateStatus(idx, { progress: p })
          await new Promise(r => setTimeout(r, 20 + Math.random() * 30))
        }
        updateStatus(idx, { state: 'done', progress: 100 })
        doneCountRef.current += 1
        setDoneCount(doneCountRef.current)
        return 'done'
      }

      const actualFile = fileStore.getFile(file.name)
      if (!actualFile) {
        updateStatus(idx, { state: 'error', error: 'File not available — please re-select files' })
        return 'skipped'
      }

      // ── Primary: presigned PUT with XHR progress ─────────────────────────
      try {
        const presignRes = await fetch('/api/presign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            key: cosKey,
            contentType: actualFile.type || 'application/octet-stream',
            projectId: fleet.projectId,
            region: fleet.region,
            bucket,
          }),
        })
        if (presignRes.ok) {
          const { url } = await presignRes.json() as { url: string }
          const ok = await xhrPut(url, actualFile, pct => updateStatus(idx, { progress: pct }))
          if (ok) {
            updateStatus(idx, { state: 'done', progress: 100 })
            doneCountRef.current += 1
            setDoneCount(doneCountRef.current)
            return 'done'
          }
        }
      } catch { /* fall through to multipart */ }

      // ── Fallback: SSE upload with real progress ───────────────────────────
      try {
        await sseUpload(actualFile, fname, cosKey, pct => updateStatus(idx, { progress: pct }))
        updateStatus(idx, { state: 'done', progress: 100 })
        doneCountRef.current += 1
        setDoneCount(doneCountRef.current)
        return 'done'
      } catch (err: unknown) {
        lastError = err instanceof Error ? err.message : String(err)
      }

      // Wait before retry (exponential back-off: 1s, 2s, 4s…)
      if (attempt < MAX_RETRIES) {
        updateStatus(idx, { state: 'error', error: `Retry ${attempt}/${MAX_RETRIES}: ${lastError}` })
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)))
      }
    }

    // All retries exhausted
    updateStatus(idx, { state: 'error', error: lastError, retryCount: MAX_RETRIES })
    return 'skipped'
  }

  // ── Concurrent upload pool ─────────────────────────────────────────────────

  async function uploadAll(): Promise<StagedFile[]> {
    const results = new Array<'done' | 'skipped'>(files.length)
    const queue   = files.map((_, i) => i)

    async function worker() {
      while (queue.length > 0) {
        const idx = queue.shift()!
        results[idx] = await uploadOne(files[idx], idx)
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(MAX_CONCURRENT, files.length) }, worker)
    )

    // Return only the files that uploaded successfully
    return files.filter((_, i) => results[i] === 'done')
  }

  // ── Main submit handler ────────────────────────────────────────────────────

  async function handleSubmit() {
    doneCountRef.current = 0
    setDoneCount(0)
    setPhase('uploading')
    setErrorMsg('')
    setDispatchResult(null)
    setFileStatuses(initStatuses())

    const successfulFiles = await uploadAll()

    if (successfulFiles.length === 0) {
      setPhase('error')
      setErrorMsg('All file uploads failed. Check the table for details and try again.')
      return
    }

    const failedCount = files.length - successfulFiles.length
    if (failedCount > 0) {
      // Continue with partial dispatch — skipped files are excluded from the JSONL
      console.warn(`${failedCount} file(s) failed upload and will not be included in the dispatch.`)
    }

    setPhase('dispatching')
    try {
      // Only dispatch the files that were successfully uploaded
      const result = await dispatchFleet({ fleet, template, files: successfulFiles })
      setDispatchResult(result)
      setPhase('done')
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err))
      setPhase('error')
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const isRunning  = phase === 'uploading' || phase === 'dispatching'
  const failedCount = fileStatuses.filter(s => s.state === 'error' || s.state === 'skipped').length
  const showTable  = phase === 'uploading' || phase === 'error' || (phase === 'done' && failedCount > 0)

  const uploadSummaryTag = () => {
    const p: string = phase
    if (p === 'uploading') return (
      <Tag type="blue" size="sm">Uploading… {doneCount}/{files.length}</Tag>
    )
    if (p !== 'idle' && fileStatuses.length > 0 && fileStatuses.every(s => s.state === 'done')) {
      return <Tag type="green" size="sm">✓ All {fileStatuses.length} uploaded</Tag>
    }
    if (failedCount > 0 && p !== 'uploading') {
      return <Tag type="red" size="sm">✕ {failedCount} failed (skipped from dispatch)</Tag>
    }
    return null
  }

  return (
    <div className={`section-card ${open ? 'section-card--open' : ''}`}>
      <button className="section-header" onClick={onToggle} type="button">
        <div className={`section-num ${phase === 'done' ? 'section-num--done' : ''}`}>
          {phase === 'done' ? '✓' : <span>4</span>}
        </div>
        <div className="section-title">Submit</div>
        <div className="section-meta">
          {phase === 'idle'        && 'Upload to COS & dispatch fleet'}
          {phase === 'uploading'   && `Uploading… ${doneCount}/${files.length} files`}
          {phase === 'dispatching' && 'Dispatching to fleet…'}
          {phase === 'done'        && `✓ ${dispatchResult?.taskCount ?? 0} tasks dispatched`}
          {phase === 'error'       && '✕ Error — see details below'}
        </div>
        <span className="section-arrow">▼</span>
      </button>

      {open && (
        <div className="section-body">
          {/* Fleet summary strip */}
          <div style={{ display:'flex', flexWrap:'wrap', gap:'1rem', background:'var(--cds-layer-02)', padding:'0.625rem 0.875rem', border:'1px solid var(--cds-border-subtle-01)', marginBottom:'1.25rem' }}>
            {[
              { label: 'Fleet',  value: fleet.name },
              { label: 'Region', value: fleet.region },
              {
                label: 'Task State Store',
                value: fleet.taskStateStore,
                tooltip: 'The Task State Store tracks the status of each task submitted to this fleet.',
              },
              { label: 'Files (selected)',  value: String(files.length) },
            ].map(({ label, value, tooltip }) => (
              <div key={label} style={{ display:'flex', flexDirection:'column', gap:2 }}>
                <span style={{ fontSize:'0.6875rem', color:'var(--cds-text-helper)', textTransform:'uppercase', letterSpacing:'0.5px' }}>
                  {tooltip ? (
                    <Tooltip label={tooltip} align="bottom">
                      <span style={{ borderBottom:'1px dotted var(--cds-text-helper)', cursor:'help' }}>{label}</span>
                    </Tooltip>
                  ) : label}
                </span>
                <span style={{ fontSize:'0.8125rem', fontWeight:600, fontFamily:'IBM Plex Mono, monospace' }}>{value}</span>
              </div>
            ))}
          </div>

          {/* Upload config summary */}
          <p style={{ fontSize:'0.75rem', color:'var(--cds-text-helper)', marginBottom:'0.75rem' }}>
            Uploading with <strong>{Math.min(MAX_CONCURRENT, files.length)}</strong> parallel worker{Math.min(MAX_CONCURRENT, files.length) !== 1 ? 's' : ''} ·{' '}
            up to <strong>{MAX_RETRIES}</strong> retr{MAX_RETRIES !== 1 ? 'ies' : 'y'} per file ·{' '}
            <strong>{Math.round(UPLOAD_TIMEOUT_MS / 60_000)} min</strong> timeout per file.{' '}
            Files that fail all retries are skipped; the rest are still dispatched.
            {' '}Tune with <code>NEXT_PUBLIC_MAX_CONCURRENT_UPLOADS</code>, <code>NEXT_PUBLIC_MAX_UPLOAD_RETRIES</code>,{' '}
            <code>NEXT_PUBLIC_UPLOAD_TIMEOUT_MS</code>.
          </p>

          {/* ── Phase 1: Upload ── */}
          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:'0.625rem' }}>
            <span style={{ fontWeight:600, fontSize:'0.875rem' }}>Phase 1 — Upload files to COS</span>
            {uploadSummaryTag()}
          </div>

          {showTable && fileStatuses.length > 0 && (
            <div style={{ overflowX:'auto', marginBottom:'1.25rem' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:'0.8125rem' }}>
                <thead>
                  <tr>
                    {['File', 'Size', 'COS key', 'Progress', 'Status'].map(h => (
                      <th key={h} style={{
                        background:'var(--cds-layer-02)', padding:'7px 10px',
                        textAlign:'left', fontSize:'0.6875rem', fontWeight:700,
                        borderBottom:'1px solid var(--cds-border-subtle-01)', whiteSpace:'nowrap',
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {fileStatuses.map((s, i) => (
                    <tr key={i} style={{ borderBottom:'1px solid var(--cds-border-subtle-01)' }}>
                      <td style={{ padding:'5px 10px', fontFamily:'monospace' }}>{s.name}</td>
                      <td style={{ padding:'5px 10px', color:'var(--cds-text-secondary)', whiteSpace:'nowrap' }}>{s.size}</td>
                      <td style={{ padding:'5px 10px', fontFamily:'monospace', fontSize:'0.6875rem', color:'var(--cds-text-secondary)', wordBreak:'break-all' }}>{s.key}</td>
                      <td style={{ padding:'5px 10px', minWidth:100 }}>
                        <ProgressBar value={s.progress} state={s.state} />
                      </td>
                      <td style={{ padding:'5px 10px', minWidth:120 }}>
                        <StatusBadge state={s.state} retryCount={s.retryCount} error={s.error} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* ── Phase 2: Dispatch ── */}
          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:'0.5rem', marginTop: showTable ? 0 : '0.25rem' }}>
            <span style={{ fontWeight:600, fontSize:'0.875rem' }}>Phase 2 — Submit tasks to fleet</span>
            {phase === 'dispatching' && <Tag type="blue"  size="sm">Dispatching…</Tag>}
            {phase === 'done'        && <Tag type="green" size="sm">✓ Dispatched</Tag>}
          </div>

          {/* Error */}
          {phase === 'error' && (
            <InlineNotification
              kind="error"
              title="Submission failed:"
              subtitle={errorMsg}
              style={{ marginBottom:'1rem' }}
            />
          )}

          {/* Success */}
          {phase === 'done' && dispatchResult && (
            <InlineNotification
              kind="success"
              title={`✓ ${dispatchResult.taskCount} task${dispatchResult.taskCount !== 1 ? 's' : ''} dispatched to ${dispatchResult.fleetName}`}
              subtitle={`Monitor: ${dispatchResult.monitorCmd}`}
              style={{ marginTop:'0.5rem' }}
            />
          )}
          {phase === 'done' && failedCount > 0 && (
            <InlineNotification
              kind="warning"
              title={`${failedCount} file${failedCount !== 1 ? 's' : ''} were not uploaded`}
              subtitle="These files were skipped from the dispatch. Re-add them and dispatch another batch."
              style={{ marginTop:'0.5rem' }}
            />
          )}

          {/* Action buttons */}
          <div style={{ display:'flex', gap:'0.75rem', marginTop:'1.5rem', flexWrap:'wrap' }}>
            {(phase === 'idle' || phase === 'error') && (
              <Button onClick={handleSubmit} size="lg">
                🚀 Upload &amp; Dispatch Fleet
              </Button>
            )}
            {isRunning && (
              <Button disabled size="lg">
                <span style={{ display:'flex', alignItems:'center', gap:8 }}>
                  <span style={{
                    width:16, height:16, borderRadius:'50%',
                    border:'2px solid #525252', borderTopColor:'#fff',
                    animation:'spin .8s linear infinite', display:'inline-block',
                  }} />
                  {phase === 'uploading' ? `Uploading ${doneCount}/${files.length}…` : 'Dispatching…'}
                </span>
              </Button>
            )}
            {phase === 'done' && (
              <Button kind="secondary" size="lg" onClick={() => { fileStore.clear(); onReset() }}>
                Dispatch another batch
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Progress bar ──────────────────────────────────────────────────────────────

function ProgressBar({ value, state }: { value: number; state: FileState }) {
  if (state === 'pending')  return <span style={{ color:'var(--cds-text-helper)', fontSize:'0.6875rem' }}>—</span>
  if (state === 'done')     return <span style={{ color:'#24a148', fontSize:'0.6875rem' }}>100%</span>
  if (state === 'skipped')  return <span style={{ color:'var(--cds-text-helper)', fontSize:'0.6875rem' }}>skipped</span>
  const color = state === 'error' ? '#da1e28' : '#0f62fe'
  return (
    <div style={{ display:'flex', alignItems:'center', gap:6 }}>
      <div style={{ flex:1, height:4, background:'var(--cds-layer-03)', borderRadius:2, overflow:'hidden', minWidth:60 }}>
        <div style={{ width:`${value}%`, height:'100%', background:color, transition:'width 0.2s', borderRadius:2 }} />
      </div>
      <span style={{ fontSize:'0.6875rem', color:'var(--cds-text-secondary)', flexShrink:0, minWidth:30 }}>
        {value}%
      </span>
    </div>
  )
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ state, retryCount, error }: { state: FileState; retryCount: number; error?: string }) {
  if (state === 'pending')  return <Tag type="gray"  size="sm">Pending</Tag>
  if (state === 'done')     return <Tag type="green" size="sm">✓ Done</Tag>
  if (state === 'skipped')  return <Tag type="purple" size="sm" title={error}>Skipped</Tag>
  if (state === 'uploading') {
    return retryCount > 0
      ? <Tag type="blue" size="sm">Retry {retryCount}/{MAX_RETRIES}…</Tag>
      : <Tag type="blue" size="sm">Uploading…</Tag>
  }
  return (
    <Tag type="red" size="sm" title={error}>
      ✕ {retryCount > 0 ? `Failed (attempt ${retryCount})` : 'Error'}
    </Tag>
  )
}
