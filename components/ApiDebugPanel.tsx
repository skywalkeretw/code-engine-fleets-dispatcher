'use client'

/**
 * ApiDebugPanel — slide-in sidebar showing every outbound API call
 * made by the server (CE + COS + IAM) with the exact curl equivalent.
 *
 * Active when DEMO_MODE=true or ENABLE_DEBUG=true.
 * Not shown on mobile (hidden via CSS below md breakpoint).
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import type { ApiLogEntry } from '@/lib/apilog'

interface Props {
  /** Passed from server so the panel knows it's enabled without an extra fetch */
  enabled: boolean
}

const SERVICE_COLORS: Record<string, string> = {
  IAM: '#f1c21b',
  CE:  '#78a9ff',
  COS: '#42be65',
}

export default function ApiDebugPanel({ enabled }: Props) {
  const [open, setOpen]         = useState(false)
  const [entries, setEntries]   = useState<ApiLogEntry[]>([])
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [filter, setFilter]     = useState<'ALL' | 'IAM' | 'CE' | 'COS'>('ALL')
  // Track highest id seen so incremental polls only fetch new entries
  const lastIdRef = useRef(0)

  const fetchEntries = useCallback(async () => {
    try {
      const url = lastIdRef.current > 0
        ? `/api/apilog?after_id=${lastIdRef.current}`
        : '/api/apilog'
      const res = await fetch(url)
      if (!res.ok) return
      const fresh: ApiLogEntry[] = await res.json()
      if (fresh.length > 0) {
        lastIdRef.current = fresh[fresh.length - 1].id
        setEntries(prev => [...prev, ...fresh].slice(-200))
      }
    } catch { /* ignore network errors */ }
  }, []) // stable — no dependency on entries state

  useEffect(() => {
    if (!enabled) return
    // Immediate fetch on mount, then poll every 2 s
    fetchEntries()
    const timer = setInterval(fetchEntries, 2000)
    return () => clearInterval(timer)
  }, [enabled, fetchEntries])

  if (!enabled) return null

  const visible = filter === 'ALL' ? entries : entries.filter(e => e.service === filter)

  function toggleExpand(id: number) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text).catch(() => {})
  }

  const panelWidth = 480

  return (
    <>
      {/* Toggle tab — hidden on mobile */}
      <button
        onClick={() => setOpen(o => !o)}
        title={open ? 'Close API debug panel' : 'Open API debug panel'}
        style={{
          position: 'fixed',
          top: '50%',
          right: open ? panelWidth : 0,
          transform: 'translateY(-50%)',
          zIndex: 9000,
          background: '#262626',
          color: '#f4f4f4',
          border: '1px solid #525252',
          borderRight: open ? '1px solid #525252' : 'none',
          borderRadius: '4px 0 0 4px',
          padding: '10px 6px',
          cursor: 'pointer',
          writingMode: 'vertical-rl',
          fontSize: '0.6875rem',
          letterSpacing: '0.05em',
          transition: 'right 0.25s',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
        className="debug-panel-tab"
      >
        <span style={{ fontSize: '0.75rem' }}>⚙</span>
        API Log
        {entries.length > 0 && (
          <span style={{
            background: '#0f62fe', color: '#fff',
            borderRadius: 10, padding: '1px 5px',
            fontSize: '0.625rem', writingMode: 'horizontal-tb',
          }}>
            {entries.length}
          </span>
        )}
      </button>

      {/* Panel */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          right: open ? 0 : -panelWidth,
          width: panelWidth,
          height: '100vh',
          zIndex: 8900,
          background: '#161616',
          borderLeft: '1px solid #393939',
          display: 'flex',
          flexDirection: 'column',
          transition: 'right 0.25s',
          fontFamily: "'IBM Plex Mono', monospace",
        }}
        className="debug-panel"
      >
        {/* Header */}
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #393939', background: '#262626', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ color: '#f4f4f4', fontWeight: 700, fontSize: '0.875rem' }}>
              ⚙ API Debug Log
            </span>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: '0.6875rem', color: '#8d8d8d' }}>{visible.length} call{visible.length !== 1 ? 's' : ''}</span>
              <button
                onClick={() => setEntries([])}
                style={{ background: 'none', border: '1px solid #525252', color: '#a8a8a8', cursor: 'pointer', padding: '2px 8px', fontSize: '0.6875rem', borderRadius: 2 }}
              >
                Clear
              </button>
            </div>
          </div>

          {/* Service filter */}
          <div style={{ display: 'flex', gap: 4 }}>
            {(['ALL', 'IAM', 'CE', 'COS'] as const).map(svc => (
              <button
                key={svc}
                onClick={() => setFilter(svc)}
                style={{
                  background: filter === svc ? (SERVICE_COLORS[svc] ?? '#525252') : '#393939',
                  color: filter === svc ? '#161616' : '#a8a8a8',
                  border: 'none', cursor: 'pointer',
                  padding: '2px 10px', fontSize: '0.6875rem',
                  borderRadius: 2, fontFamily: 'inherit', fontWeight: 600,
                }}
              >
                {svc}
              </button>
            ))}
          </div>
        </div>

        {/* Entries */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          {visible.length === 0 && (
            <p style={{ color: '#6f6f6f', fontSize: '0.75rem', padding: '1rem', textAlign: 'center' }}>
              {entries.length === 0
                ? 'No API calls recorded yet.\nCalls appear here as the app makes requests.'
                : 'No calls matching filter.'}
            </p>
          )}
          {[...visible].reverse().map(entry => {
            const isOpen = expanded.has(entry.id)
            const color  = SERVICE_COLORS[entry.service] ?? '#f4f4f4'
            const ts     = new Date(entry.ts).toISOString().slice(11, 23)
            return (
              <div key={entry.id} style={{ borderBottom: '1px solid #262626' }}>
                <button
                  onClick={() => toggleExpand(entry.id)}
                  style={{
                    width: '100%', background: 'none', border: 'none',
                    cursor: 'pointer', padding: '6px 12px',
                    textAlign: 'left', display: 'flex', alignItems: 'flex-start', gap: 8,
                  }}
                >
                  <span style={{
                    background: color, color: '#161616',
                    fontSize: '0.5625rem', fontWeight: 700,
                    padding: '1px 5px', borderRadius: 2, flexShrink: 0, marginTop: 1,
                  }}>
                    {entry.service}
                  </span>
                  <span style={{
                    background: entry.method === 'POST' ? '#6929c4' : '#393939',
                    color: '#f4f4f4',
                    fontSize: '0.5625rem', fontWeight: 700,
                    padding: '1px 5px', borderRadius: 2, flexShrink: 0, marginTop: 1,
                  }}>
                    {entry.method}
                  </span>
                  <span style={{ flex: 1, color: '#c6c6c6', fontSize: '0.6875rem', lineHeight: 1.4, wordBreak: 'break-all' }}>
                    {entry.label}
                  </span>
                  <span style={{ color: '#525252', fontSize: '0.5625rem', flexShrink: 0, marginTop: 1 }}>
                    {ts}
                  </span>
                  <span style={{ color: '#525252', fontSize: '0.75rem', flexShrink: 0 }}>
                    {isOpen ? '▲' : '▼'}
                  </span>
                </button>

                {isOpen && (
                  <div style={{ padding: '0 12px 10px', position: 'relative' }}>
                    {/* URL */}
                    <div style={{ fontSize: '0.5625rem', color: '#8d8d8d', marginBottom: 4, wordBreak: 'break-all' }}>
                      {entry.url}
                    </div>
                    {/* curl command */}
                    <pre style={{
                      background: '#0a0a0a', color: '#42be65',
                      fontSize: '0.625rem', lineHeight: 1.6,
                      padding: '8px 10px', margin: 0, overflowX: 'auto',
                      border: '1px solid #393939', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                    }}>
                      {entry.curl}
                    </pre>
                    <button
                      onClick={() => copyToClipboard(entry.curl)}
                      title="Copy curl to clipboard"
                      style={{
                        position: 'absolute', top: 28, right: 16,
                        background: '#262626', border: '1px solid #525252',
                        color: '#a8a8a8', cursor: 'pointer',
                        padding: '2px 6px', fontSize: '0.5625rem', borderRadius: 2,
                      }}
                    >
                      Copy
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* Footer */}
        <div style={{ padding: '8px 12px', borderTop: '1px solid #393939', background: '#262626', flexShrink: 0 }}>
          <p style={{ fontSize: '0.5625rem', color: '#6f6f6f', margin: 0, lineHeight: 1.5 }}>
            Active: DEMO_MODE or ENABLE_DEBUG=true · Max 200 entries · Polls every 2s
          </p>
          <p style={{ fontSize: '0.5625rem', color: '#525252', margin: '2px 0 0', lineHeight: 1.4 }}>
            TOKEN=$({'curl -X POST "https://iam.cloud.ibm.com/identity/token" \\\n  -d "apikey=$IBMCLOUD_API_KEY" ...'})
          </p>
        </div>
      </div>
    </>
  )
}
