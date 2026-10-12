import { fetchFleets } from './actions'
import DispatcherApp from '@/components/DispatcherApp'
import ApiDebugPanel from '@/components/ApiDebugPanel'
import type { Fleet } from '@/lib/ce'
import { isDemoMode, isDebugMode } from '@/lib/ce'

// Always render at request time so DEMO_MODE and IBMCLOUD_API_KEY are read live
export const dynamic = 'force-dynamic'

/** Wrap fetchFleets with a timeout so a slow/unreachable CE API never hangs the page render. */
async function fetchFleetsWithTimeout(ms = 15_000): Promise<Fleet[]> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Fleet list timed out after ${ms / 1000}s`)), ms)
  )
  return Promise.race([fetchFleets(), timeout])
}

export default async function HomePage() {
  let fleets: Fleet[] = []
  let fetchError: string | null = null
  const demoMode  = isDemoMode()
  const debugMode = isDebugMode()

  try {
    fleets = await fetchFleetsWithTimeout()
  } catch (err: unknown) {
    fetchError = err instanceof Error ? err.message : 'Failed to load fleets'
  }

  return (
    <>
      <DispatcherApp initialFleets={fleets} fetchError={fetchError} demoMode={demoMode} />
      <ApiDebugPanel enabled={debugMode} />
    </>
  )
}
