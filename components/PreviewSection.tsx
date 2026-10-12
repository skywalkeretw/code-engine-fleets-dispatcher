'use client'

import { useMemo } from 'react'
import { Checkbox, InlineNotification } from '@carbon/react'
import type { Fleet } from '@/lib/ce'
import type { Template, StagedFile } from '@/lib/jsonl'
import { buildTasks, tasksToJsonl } from '@/lib/jsonl'

// Soft warning threshold: 50 MB. Hard limit assumed at 100 MB.
// The CE API has no published limit; we warn early to avoid a 413 at dispatch time.
const JSONL_WARN_BYTES  = 50 * 1024 * 1024
const JSONL_LIMIT_BYTES = 100 * 1024 * 1024

interface Props {
  fleet: Fleet
  template: Template
  files: StagedFile[]
  /** Kept for display context (shown in FleetSection); not used by buildTasks which reads cosKey from each file. */
  cosPrefix: string
  confirmed: boolean
  onConfirm: (v: boolean) => void
  open: boolean
  onToggle: () => void
}

export default function PreviewSection({
  fleet, template, files, confirmed, onConfirm, open, onToggle,
}: Props) {
  const tasks = useMemo(() =>
    buildTasks(template, files, fleet.mounts),
    [template, files, fleet.mounts]
  )

  // Estimate JSONL byte size from the first 100 tasks (proportional to total)
  const jsonlBytes = useMemo(() => {
    if (tasks.length === 0) return 0
    const sample = tasks.slice(0, Math.min(100, tasks.length))
    const sampleBytes = new TextEncoder().encode(tasksToJsonl(sample)).length
    return Math.ceil((sampleBytes / sample.length) * tasks.length)
  }, [tasks])

  const total = tasks.length
  const shown = tasks.slice(0, 20)

  const meta = total > 0
    ? `${total} task${total !== 1 ? 's' : ''} · ${confirmed ? '✓ confirmed' : 'review & confirm'}`
    : 'Stage files to generate preview'

  return (
    <div className={`section-card ${open ? 'section-card--open' : ''} ${confirmed ? 'section-card--done' : ''}`}>
      <button className="section-header" onClick={onToggle} type="button">
        <div className={`section-num ${confirmed ? 'section-num--done' : ''}`}>
          {confirmed ? '✓' : <span>3</span>}
        </div>
        <div className="section-title">JSONL Preview</div>
        <div className="section-meta">{meta}</div>
        <span className="section-arrow">▼</span>
      </button>

      {open && (
        <div className="section-body">
          <p style={{ fontSize:'0.8125rem', color:'var(--cds-text-secondary)', marginBottom:'0.75rem' }}>
            Live preview — showing up to 20 of {total} lines. This is exactly what will be submitted.
            {total > 0 && (
              <span style={{ marginLeft: 8, color: 'var(--cds-text-helper)' }}>
                (~{jsonlBytes < 1024 * 1024
                  ? `${(jsonlBytes / 1024).toFixed(0)} KB`
                  : `${(jsonlBytes / (1024 * 1024)).toFixed(1)} MB`} JSONL)
              </span>
            )}
          </p>

          {jsonlBytes > JSONL_LIMIT_BYTES && (
            <InlineNotification
              kind="error"
              title="JSONL payload too large:"
              subtitle={`Estimated ${(jsonlBytes / (1024 * 1024)).toFixed(0)} MB exceeds the assumed 100 MB API limit. Reduce the number of files or simplify the template args.`}
              style={{ marginBottom: '0.75rem' }}
            />
          )}
          {jsonlBytes > JSONL_WARN_BYTES && jsonlBytes <= JSONL_LIMIT_BYTES && (
            <InlineNotification
              kind="warning"
              title="Large JSONL payload:"
              subtitle={`Estimated ${(jsonlBytes / (1024 * 1024)).toFixed(0)} MB. This is within limits but may be slow to transmit. Consider splitting into smaller batches if dispatch fails.`}
              style={{ marginBottom: '0.75rem' }}
            />
          )}

          {files.length === 0 ? (
            <p style={{ color:'var(--cds-text-secondary)', fontSize:'0.875rem', padding:'0.5rem 0' }}>
              No files staged yet.
            </p>
          ) : (
            <>
              <div className="terminal-header">
                <span>tasks.jsonl</span>
                <span>{total} task{total !== 1 ? 's' : ''}</span>
              </div>
              <div className="jsonl-terminal">
                {shown.map((task, i) => (
                  <div key={i}>{colorizeTask(task)}</div>
                ))}
                {total > 20 && (
                  <span className="jl-more">… and {total - 20} more line(s) not shown</span>
                )}
              </div>

              <div style={{ marginTop:'1rem', padding:'0.75rem', background:'var(--cds-layer-02)', border:'1px solid var(--cds-border-subtle-01)' }}>
                <Checkbox
                  id="confirm-checkbox"
                  labelText="I have reviewed the task structure and it looks correct"
                  checked={confirmed}
                  disabled={jsonlBytes > JSONL_LIMIT_BYTES}
                  onChange={(_e, { checked }) => onConfirm(checked)}
                />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── JSONL Colorizer ─────────────────────────────────────────────────────────
//
// WHY dangerouslySetInnerHTML IS SAFE HERE:
// The HTML string is built entirely from:
//   1. Hard-coded class name strings (jl-key, jl-str, jl-num — no user input)
//   2. Values that come through escHtml(), which escapes &, <, >, and "
// The task objects originate from template strings + filenames, never from raw
// user-supplied HTML. There is no path for arbitrary HTML injection.
// If the template/filename source ever changes to accept HTML, revisit this.

function escHtml(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

function colorVal(v: unknown): string {
  if (typeof v === 'string')  return `<span class="jl-str">"${escHtml(v)}"</span>`
  if (typeof v === 'number')  return `<span class="jl-num">${v}</span>`
  if (typeof v === 'boolean') return `<span class="jl-num">${v}</span>`
  if (Array.isArray(v))       return '[' + v.map(colorVal).join(',') + ']'
  return escHtml(String(v))
}

function colorizeTask(task: Record<string, unknown>): React.ReactNode {
  const parts = Object.keys(task).map(k =>
    `<span class="jl-key">"${k}"</span>:${colorVal(task[k] as unknown)}`
  )
  const html = '{' + parts.join(',') + '}'
  // See safety comment above — all values are either hard-coded or escHtml()-escaped
  return <span dangerouslySetInnerHTML={{ __html: html }} />
}
