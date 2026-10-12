'use client'

import { Button } from '@carbon/react'
import { Upload } from '@carbon/icons-react'
import type { Fleet } from '@/lib/ce'

interface Props {
  fleet: Fleet | null
  fileCount: number
  confirmed: boolean
  canSubmit: boolean
  onOpenFleet: () => void
}

export default function ActionBar({
  fleet, fileCount, confirmed, canSubmit, onOpenFleet,
}: Props) {
  return (
    <div className="action-bar">
      <div className="action-bar-stats">
        {/* Fleet */}
        <div className="ab-stat ab-stat--fleet">
          <span className="ab-stat__label">Fleet</span>
          {fleet ? (
            <span className="ab-stat__value">
              <span
                style={{
                  display: 'inline-block',
                  width: 7, height: 7,
                  borderRadius: '50%',
                  background: '#42be65',
                  marginRight: 5,
                  verticalAlign: 'middle',
                }}
              />
              {fleet.name}
              <span style={{ color: '#8d8d8d', fontWeight: 400, marginLeft: 5, fontSize: '0.6875rem' }}>
                {fleet.region}
              </span>
            </span>
          ) : (
            <button
              className="ab-stat__value ab-stat__value--dim"
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, font: 'inherit', color: '#a8a8a8', fontStyle: 'italic' }}
              onClick={onOpenFleet}
            >
              None selected
            </button>
          )}
        </div>

        {/* Files */}
        <div className="ab-stat">
          <span className="ab-stat__label">Files</span>
          <span className={`ab-stat__value ${fileCount === 0 ? 'ab-stat__value--dim' : ''}`}>
            {fileCount === 0 ? '—' : fileCount}
          </span>
        </div>

        {/* Tasks */}
        <div className="ab-stat">
          <span className="ab-stat__label">Tasks</span>
          <span className={`ab-stat__value ${fileCount === 0 ? 'ab-stat__value--dim' : ''}`}>
            {fileCount === 0 ? '—' : fileCount}
          </span>
        </div>

        {/* Confirmed */}
        <div className="ab-stat">
          <span className="ab-stat__label">Confirmed</span>
          <span className={`ab-stat__value ${confirmed ? '' : 'ab-stat__value--dim'}`}>
            {confirmed ? '✓ Yes' : '—'}
          </span>
        </div>
      </div>

      <Button
        renderIcon={Upload}
        disabled={!canSubmit}
        size="sm"
        style={{ minWidth: 160, flexShrink: 0 }}
        onClick={() => {
          // Scroll the submit section into view
          document.querySelector('.section-card:last-of-type')?.scrollIntoView({ behavior: 'smooth' })
        }}
      >
        Upload &amp; Dispatch
      </Button>
    </div>
  )
}
