'use client'

import { useMemo } from 'react'
import { Button, Tag, Tooltip } from '@carbon/react'
import type { Fleet, PersistentDataStore } from '@/lib/ce'

interface Props {
  fleet: Fleet
  /** PDS list already fetched by DispatcherApp (avoids duplicate fetches) */
  stores: PersistentDataStore[]
  /** Selected COS bucket name (empty = none) */
  selectedBucket: string
  /** Sub-prefix the user typed in FilesSection */
  subPrefix: string
  open: boolean
  onToggle: () => void
  onChangeFleet: () => void
}

export default function FleetSection({ fleet, stores, selectedBucket, subPrefix, open, onToggle, onChangeFleet }: Props) {
  // Build a lookup from storeName → PDS
  const storeMap = useMemo(() => new Map(stores.map(s => [s.name, s])), [stores])

  /** First PDS whose bucketName matches the selected bucket */
  const selectedStore = useMemo(
    () => stores.find(s => s.bucketName === selectedBucket) ?? null,
    [stores, selectedBucket]
  )

  /** Full COS key prefix in effect (mirrors FilesSection logic) */
  const fullPrefix = useMemo(() => {
    const sp = selectedStore?.cosPrefix ?? ''
    const ns = subPrefix.replace(/^\/+/, '')
    const norm = !ns ? '' : ns.endsWith('/') ? ns : ns + '/'
    return sp + norm
  }, [selectedStore, subPrefix])

  return (
    <div className={`section-card ${open ? 'section-card--open' : ''}`}>
      <button className="section-header" onClick={onToggle} type="button">
        <div className="section-num section-num--done">✓</div>
        <div className="section-title">Fleet</div>
        <div className="section-meta">{fleet.name} · {fleet.region}</div>
        <span className="section-arrow">▼</span>
      </button>

      {open && (
        <div className="section-body">
          {/* Fleet info bar */}
          <div style={{ display:'flex', flexWrap:'wrap', gap:'1rem', background:'var(--cds-layer-02)', padding:'0.625rem 0.875rem', border:'1px solid var(--cds-border-subtle-01)', marginBottom:'1.25rem' }}>
            {[
              { label: 'Fleet',   value: fleet.name, tooltip: 'The name of the IBM Code Engine Serverless Fleet that will process your tasks.' },
              { label: 'Project', value: fleet.projectName, tooltip: 'The IBM Code Engine project this fleet belongs to.' },
              { label: 'Region',  value: fleet.region, tooltip: 'IBM Cloud region where this fleet is deployed.' },
              { label: 'Task State Store', value: fleet.taskStateStore, tooltip: 'IBM COS bucket used internally by the fleet to track task status and results.' },
            ].map(({ label, value, tooltip }) => (
              <div key={label} style={{ display:'flex', flexDirection:'column', gap:2 }}>
                <Tooltip label={tooltip} align="bottom">
                  <span style={{ fontSize:'0.6875rem', color:'var(--cds-text-helper)', textTransform:'uppercase', letterSpacing:'0.5px', borderBottom:'1px dotted var(--cds-text-helper)', cursor:'help' }}>
                    {label}
                  </span>
                </Tooltip>
                <span style={{ fontSize:'0.8125rem', fontWeight:600, fontFamily:'IBM Plex Mono, monospace' }}>{value}</span>
              </div>
            ))}
          </div>

          {/* Mount reference table */}
          <p style={{ fontSize:'0.75rem', fontWeight:600, color:'var(--cds-text-secondary)', marginBottom:'0.5rem', textTransform:'uppercase', letterSpacing:'0.5px' }}>
            Persistent data store mounts
          </p>

          <p style={{ fontSize:'0.8125rem', color:'var(--cds-text-secondary)', marginBottom:'0.75rem', lineHeight:1.6 }}>
            Files are uploaded to COS using the store prefix + your sub-prefix (configured in the Files section).
            The container mount strips the store prefix — so the path inside the container is:<br />
            <code style={{ background:'#e0e0e0', padding:'1px 6px' }}>mountPath + subPrefix + filename</code>
            <br />
            {(() => {
              const mount0 = fleet.mounts[0]
              const pds0   = mount0 ? storeMap.get(mount0.storeName) : null
              const sp     = pds0?.cosPrefix ?? ''
              const ns     = subPrefix.replace(/^\/+/, '')
              const norm   = !ns ? '' : ns.endsWith('/') ? ns : ns + '/'
              const cosKey = sp + norm + 'doc.pdf'
              // Container path = mountPath + (everything after storePrefix) = mountPath + norm + filename
              const containerPath = `${mount0?.mountPath ?? '/mnt/input'}/${norm}doc.pdf`
              return (
                <>
                  <strong>Example:</strong> COS key{' '}
                  <code style={{ background:'#e0e0e0', padding:'1px 4px' }}>{cosKey}</code>
                  {sp && (
                    <> (store prefix <code style={{ background:'#e0e0e0', padding:'1px 4px' }}>{sp}</code> is the mount root — stripped)</>
                  )}
                  {' '}→ container path{' '}
                  <code style={{ background:'#e0e0e0', padding:'1px 4px' }}>{containerPath}</code>
                </>
              )
            })()}
          </p>

          {fleet.mounts.length > 0 ? (
            <div style={{ overflowX:'auto' }}>
              <table className="mount-table">
                <thead>
                  <tr>
                    <th>Store name</th>
                    <th>Mount path</th>
                    <th><code style={{ fontSize:'0.6875rem' }}>{'{{mount.X}}'}</code> placeholder</th>
                    <th>COS bucket</th>
                    <th>Bucket region</th>
                    <th>Store prefix</th>
                    <th className="col-example">Example container path<br /><span style={{ fontWeight:400 }}>(mount + <em>your</em> prefix + filename)</span></th>
                  </tr>
                </thead>
                <tbody>
                  {fleet.mounts.map(m => {
                    const pds = storeMap.get(m.storeName)
                    return (
                      <tr key={m.storeName}>
                        <td><strong>{m.storeName}</strong></td>
                        <td>{m.mountPath}</td>
                        <td><code>{`{{mount.${m.storeName}}}`}</code></td>
                        <td>{pds?.bucketName ?? <span style={{ color:'var(--cds-text-helper)' }}>—</span>}</td>
                        <td>{pds?.bucketRegion ?? <span style={{ color:'var(--cds-text-helper)' }}>—</span>}</td>
                        <td>
                          {pds?.cosPrefix
                            ? <code>{pds.cosPrefix}</code>
                            : <span style={{ color:'var(--cds-text-helper)', fontSize:'0.75rem' }}>none</span>
                          }
                        </td>
                        <td className="col-example">
                          {(() => {
                            const pds = storeMap.get(m.storeName)
                            const sp  = pds?.cosPrefix ?? ''
                            const ns  = subPrefix.replace(/^\/+/, '')
                            const norm = !ns ? '' : ns.endsWith('/') ? ns : ns + '/'
                            return <code>{m.mountPath}/{norm}doc.pdf</code>
                          })()}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p style={{ fontSize:'0.875rem', color:'var(--cds-text-secondary)' }}>
              No persistent data store mounts configured on this fleet.
            </p>
          )}

          {/* COS object path note */}
          {fleet.mounts.length > 0 && (
            <div style={{ marginTop:'0.875rem', padding:'0.625rem 0.875rem', background:'var(--cds-layer-02)', border:'1px solid var(--cds-border-subtle-01)', fontSize:'0.8125rem', lineHeight:1.6 }}>
              <strong>How the store prefix works</strong><br />
              COS key = <code style={{ background:'#e0e0e0', padding:'1px 4px' }}>storePrefix + subPrefix + relativePath</code>
              <br />
              The mount root maps to the store prefix — the container only sees what comes after it.
              {fullPrefix && (
                <><br />
                  Current effective prefix: <code style={{ background:'#e0e0e0', padding:'1px 4px' }}>{fullPrefix}</code>
                </>
              )}
            </div>
          )}

          <div style={{ marginTop:'1rem', display:'flex', gap:'0.5rem', alignItems:'center', flexWrap:'wrap' }}>
            <Button kind="ghost" size="sm" onClick={onChangeFleet}>Change fleet…</Button>
            <Tooltip
              label={fleet.status === 'standby'
                ? 'Standby: the fleet is idle and ready to accept new tasks immediately.'
                : fleet.status === 'running'
                  ? 'Running: the fleet is currently processing tasks. New tasks can still be added.'
                  : `Fleet status: ${fleet.status}`}
              align="right"
            >
              <span>
                <Tag type={fleet.status === 'standby' ? 'green' : fleet.status === 'running' ? 'blue' : 'gray'}>
                  {fleet.status}
                </Tag>
              </span>
            </Tooltip>
          </div>
        </div>
      )}
    </div>
  )
}
