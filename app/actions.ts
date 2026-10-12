'use server'

// NOTE: every export from a 'use server' file becomes a publicly callable HTTP
// endpoint. Only the three functions the UI actually uses are exported here.

import { listAllFleets, addTasksToFleet, listPersistentDataStores } from '@/lib/ce'
import { tasksToJsonl, buildTasks } from '@/lib/jsonl'
import type { Fleet, PersistentDataStore } from '@/lib/ce'
import type { Template, StagedFile } from '@/lib/jsonl'

// ── Fleet listing ──────────────────────────────────────────────────────────

export async function fetchFleets(): Promise<Fleet[]> {
  return listAllFleets()
}

// ── Persistent data stores (for FleetSection mount table) ──────────────────

export async function fetchPersistentDataStores(
  fleet: Fleet
): Promise<PersistentDataStore[]> {
  try {
    return await listPersistentDataStores(fleet.projectId, fleet.region)
  } catch {
    return []
  }
}

// ── Dispatch ───────────────────────────────────────────────────────────────

export interface DispatchPayload {
  fleet: Fleet
  template: Pick<Template, 'idx' | 'cmds' | 'args'>
  files: StagedFile[]
}

export interface DispatchResult {
  fleetName: string
  taskCount: number
  monitorCmd: string
}

export async function dispatchFleet(payload: DispatchPayload): Promise<DispatchResult> {
  const { fleet, template, files } = payload
  if (files.length === 0) throw new Error('No files to dispatch')

  const tasks = buildTasks(template, files, fleet.mounts)
  const jsonl = tasksToJsonl(tasks)
  const result = await addTasksToFleet(fleet, jsonl)
  return {
    fleetName: result.fleetName,
    taskCount: result.taskCount,
    monitorCmd: `ibmcloud ce fleet task list --fleet-id ${fleet.id}`,
  }
}
