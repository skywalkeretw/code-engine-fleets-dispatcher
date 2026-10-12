'use client'

import { useState, useMemo } from 'react'
import {
  Modal, Search, Select, SelectItem, Tag, InlineNotification,
} from '@carbon/react'
import type { Fleet } from '@/lib/ce'

interface Props {
  open: boolean
  fleets: Fleet[]
  /** Error from loading the fleet list, if any */
  error?: string | null
  currentFleet: Fleet | null
  onClose?: () => void
  onSelect: (fleet: Fleet) => void
}

export default function FleetModal({ open, fleets, error, currentFleet, onClose, onSelect }: Props) {
  const [query, setQuery]     = useState('')
  const [project, setProject] = useState('')
  const [region, setRegion]   = useState('')
  const [pending, setPending] = useState<Fleet | null>(null)

  // Auto-select when there is exactly one fleet and none is pending yet
  const autoFleet = fleets.length === 1 && !pending ? fleets[0] : null
  const effectivePending = pending ?? autoFleet

  // Unique project + region lists
  const projects = useMemo(() =>
    Array.from(new Set(fleets.map(f => f.projectName))).sort(), [fleets])
  const regions = useMemo(() =>
    Array.from(new Set(fleets.map(f => f.region))).sort(), [fleets])

  const filtered = useMemo(() => fleets.filter(f => {
    const q = query.toLowerCase()
    return (
      (!q       || f.name.toLowerCase().includes(q)) &&
      (!project || f.projectName === project) &&
      (!region  || f.region === region)
    )
  }), [fleets, query, project, region])

  const standby  = filtered.filter(f => f.status === 'standby')
  const others   = filtered.filter(f => f.status !== 'standby')
  const ordered  = [...standby, ...others]

  function handleConfirm() {
    if (effectivePending) onSelect(effectivePending)
  }

  return (
    <Modal
      open={open}
      modalHeading="Select Standby Fleet"
      primaryButtonText="Select Fleet"
      secondaryButtonText={onClose ? 'Cancel' : undefined}
      primaryButtonDisabled={!effectivePending}
      onRequestSubmit={handleConfirm}
      onRequestClose={onClose ?? (() => {})}
      onSecondarySubmit={onClose}
      size="lg"
    >
      <p style={{ fontSize:'0.875rem', color:'var(--cds-text-secondary)', marginBottom:'1rem' }}>
        IBM Code Engine — {fleets.length} fleet{fleets.length !== 1 ? 's' : ''} found
      </p>

      {error && (
        <InlineNotification
          kind="error"
          title="Could not load fleets:"
          subtitle={error}
          hideCloseButton
          lowContrast
          style={{ marginBottom: '1rem', maxWidth: '100%' }}
        />
      )}

      {/* Filters */}
      <div style={{ display:'flex', gap:'0.5rem', flexWrap:'wrap', marginBottom:'1rem' }}>
        <div style={{ flex:2, minWidth:200 }}>
          <Search
            labelText="Search fleets"
            placeholder="Search by name…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            size="md"
          />
        </div>
        <div style={{ flex:1, minWidth:160 }}>
          <Select
            id="project-filter"
            labelText="Project"
            value={project}
            onChange={e => setProject(e.target.value)}
            size="md"
          >
            <SelectItem value="" text="All projects" />
            {projects.map(p => <SelectItem key={p} value={p} text={p} />)}
          </Select>
        </div>
        <div style={{ flex:1, minWidth:120 }}>
          <Select
            id="region-filter"
            labelText="Region"
            value={region}
            onChange={e => setRegion(e.target.value)}
            size="md"
          >
            <SelectItem value="" text="All regions" />
            {regions.map(r => <SelectItem key={r} value={r} text={r} />)}
          </Select>
        </div>
      </div>

      {/* Fleet list */}
      <div style={{ maxHeight:'50vh', overflowY:'auto' }}>
        {ordered.length === 0 && (
          <p style={{ padding:'2rem', textAlign:'center', color:'var(--cds-text-secondary)' }}>
            No fleets match your filters
          </p>
        )}
        {ordered.map(fleet => {
          const isCurrent  = currentFleet?.id === fleet.id
          const isPending  = effectivePending?.id === fleet.id
          const isStandby  = fleet.status === 'standby'
          return (
            <div
              key={fleet.id}
              onClick={() => setPending(fleet)}
              style={{
                padding: '0.75rem 1rem',
                border: `1px solid ${isPending ? 'var(--cds-interactive)' : 'var(--cds-border-subtle-01)'}`,
                background: isPending ? '#edf5ff' : 'var(--cds-layer-01)',
                marginBottom: 6,
                cursor: 'pointer',
                transition: 'border-color 0.12s, background 0.12s',
              }}
            >
              <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:8 }}>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontWeight:600, fontSize:'0.9375rem', marginBottom:2 }}>
                    {fleet.name}
                    {isCurrent && (
                      <Tag type="green" size="sm" style={{ marginLeft:8 }}>current</Tag>
                    )}
                  </div>
                  <div style={{ fontSize:'0.75rem', color:'var(--cds-text-secondary)', marginBottom:4 }}>
                    {fleet.projectName}
                  </div>
                  {fleet.mounts.length > 0 && (
                    <div style={{ fontSize:'0.6875rem', color:'var(--cds-text-helper)', fontFamily:'IBM Plex Mono, monospace' }}>
                      {fleet.mounts.map(m => `${m.mountPath} ← ${m.storeName}`).join(' · ')}
                    </div>
                  )}
                </div>
                <div style={{ display:'flex', gap:4, flexShrink:0, flexWrap:'wrap', justifyContent:'flex-end' }}>
                  <Tag type={isStandby ? 'green' : 'gray'} size="sm">{fleet.status}</Tag>
                  <Tag type="blue" size="sm">{fleet.region}</Tag>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </Modal>
  )
}
