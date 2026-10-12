'use client'
import { Button, InlineNotification } from '@carbon/react'

interface Props {
  visible: boolean
  onSelectFleet: () => void
  /** Set when the fleet list could not be loaded (otherwise the user just sees "no fleets"). */
  error?: string | null
}

export default function FleetGate({ visible, onSelectFleet, error }: Props) {
  if (!visible) return null
  return (
    <div className="fleet-gate">
      <div className="fleet-gate__icon">🚢</div>
      <h2 className="fleet-gate__title">Select a Fleet to Begin</h2>
      <p className="fleet-gate__sub">
        Choose which IBM Code Engine standby fleet will run your batch workload.
        All configuration options unlock once a fleet is selected.
      </p>
      {error && (
        <InlineNotification
          kind="error"
          title="Could not load fleets:"
          subtitle={error}
          hideCloseButton
          lowContrast
        />
      )}
      <Button onClick={onSelectFleet} size="lg">Select a fleet…</Button>
    </div>
  )
}
