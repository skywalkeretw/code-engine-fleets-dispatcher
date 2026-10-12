'use client'

/**
 * DispatcherApp — root client component for the Fleets Dispatcher.
 *
 * State management is split into focused custom hooks:
 *   - useSectionState: which accordion sections are open
 *
 * Workflow:
 *   1. Fleet selected (FleetModal) → sections unlock
 *   2. Template configured (TemplateSection)
 *   3. Files staged (FilesSection) — supports adding more files to an in-progress batch
 *   4. JSONL previewed and confirmed (PreviewSection)
 *   5. Upload + dispatch triggered (SubmitSection)
 *   6. "Dispatch another batch" resets back to step 2 (fleet stays selected)
 */

import { useState, useCallback, useMemo, useEffect } from 'react'
import {
  Header, HeaderName, HeaderGlobalBar, HeaderGlobalAction,
  InlineNotification, Tooltip,
} from '@carbon/react'
import { Renew } from '@carbon/icons-react'
import type { Fleet, PersistentDataStore } from '@/lib/ce'
import type { Template, StagedFile } from '@/lib/jsonl'
import FleetGate from './FleetGate'
import FleetModal from './FleetModal'
import FleetSection from './FleetSection'
import TemplateSection from './TemplateSection'
import FilesSection from './FilesSection'
import PreviewSection from './PreviewSection'
import SubmitSection from './SubmitSection'
import ActionBar from './ActionBar'
import OnboardingBanner from './OnboardingBanner'
import { FileStoreProvider } from './FileContext'
import { fetchPersistentDataStores } from '@/app/actions'

// ── Custom hook: section open/closed state ─────────────────────────────────────

interface SectionState {
  fleet: boolean
  template: boolean
  files: boolean
  preview: boolean
  submit: boolean
}

function useSectionState(initial: SectionState) {
  const [state, setState] = useState<SectionState>(initial)

  const toggle = useCallback((id: keyof SectionState) =>
    setState(prev => ({ ...prev, [id]: !prev[id] })), [])

  const open = useCallback((id: keyof SectionState) =>
    setState(prev => ({ ...prev, [id]: true })), [])

  const reset = useCallback((next: SectionState) => setState(next), [])

  return { state, toggle, open, reset }
}

// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  initialFleets: Fleet[]
  fetchError: string | null
  demoMode: boolean
}

export default function DispatcherApp({ initialFleets, fetchError, demoMode }: Props) {
  // ── Fleet ──
  const [fleets]          = useState<Fleet[]>(initialFleets)
  const [fleet, setFleet] = useState<Fleet | null>(null)
  const [fleetModalOpen, setFleetModalOpen] = useState(false)

  // ── Persistent data stores (fetched when fleet changes) ──
  const [stores, setStores] = useState<PersistentDataStore[]>([])
  const [selectedBucket, setSelectedBucket] = useState<string>('')

  useEffect(() => {
    if (!fleet) return
    setStores([])
    setSelectedBucket('')
    fetchPersistentDataStores(fleet).then(s => {
      setStores(s)
      if (s.length > 0) setSelectedBucket(s[0].bucketName)
    }).catch(() => {})
  }, [fleet?.id])  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Template ──
  const [template, setTemplate] = useState<Template>({
    id: '', name: '', idx: '', cmds: [], args: [],
  })

  // ── Files ──
  const [files, setFiles]                     = useState<StagedFile[]>([])
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set())
  /** Sub-prefix appended within the selected store (e.g. "batch1/") */
  const [subPrefix, setSubPrefix]             = useState('')

  // ── Confirmation ──
  const [confirmed, setConfirmed] = useState(false)

  // ── Sections ──
  const sections = useSectionState({
    fleet: true, template: true, files: true, preview: false, submit: false,
  })

  // ── Event handlers ──────────────────────────────────────────────────────

  const handleTemplateChange = useCallback((t: Template) => {
    setTemplate(t); setConfirmed(false)
  }, [])

  const openSection = sections.open

  const handleFilesChange = useCallback((f: StagedFile[]) => {
    setFiles(f); setConfirmed(false)
    if (f.length > 0) openSection('preview')
  }, [openSection])

  const handleSelectionChange = useCallback((s: Set<number>) => {
    setSelectedIndices(s); setConfirmed(false)
  }, [])

  const handleSubPrefixChange = useCallback((p: string) => {
    setSubPrefix(p); setConfirmed(false)
  }, [])

  const handleConfirm = useCallback((v: boolean) => {
    setConfirmed(v)
    if (v) openSection('submit')
  }, [openSection])

  const handleFleetSelect = useCallback((f: Fleet) => {
    setFleet(f); setFleetModalOpen(false); setConfirmed(false)
  }, [])

  /**
   * "Add more files" — merges new files into the existing list, keeping the
   * current template and fleet. All newly added files are selected by default.
   * This allows a user to build up a larger batch across multiple browse/drop actions,
   * or to add a second folder after reviewing the first.
   */
  const handleAddMoreFiles = useCallback((newFiles: StagedFile[], newIndices: Set<number>) => {
    // Separate (pure) updaters — never call one setState from inside another's updater
    setFiles(prev => [...prev, ...newFiles])
    setSelectedIndices(prevSel => {
      const next = new Set(prevSel)
      for (const i of newIndices) next.add(i)
      return next
    })
    setConfirmed(false)
    openSection('preview')
  }, [openSection])

  /**
   * Full reset after a completed dispatch.
   * Keeps the fleet selected — the user can immediately start another batch.
   */
  const resetSections = sections.reset

  const handleReset = useCallback(() => {
    setFiles([])
    setSelectedIndices(new Set())
    setConfirmed(false)
    setSubPrefix('')
    setTemplate({ id:'', name:'', idx:'', cmds:[], args:[] })
    resetSections({ fleet:true, template:true, files:true, preview:false, submit:false })
  }, [resetSections])

  // ── Derived values ────────────────────────────────────────────────────────

  const selectedFiles = useMemo<StagedFile[]>(() =>
    files.filter((_, i) => selectedIndices.has(i)),
    [files, selectedIndices]
  )

  /** Full COS prefix in effect = storePrefix + normSubPrefix (mirrors FilesSection logic) */
  const effectiveCosPrefix = useMemo(() => {
    const sp = stores.find(s => s.bucketName === selectedBucket)?.cosPrefix ?? ''
    const ns = subPrefix.replace(/^\/+/, '')
    const norm = !ns ? '' : ns.endsWith('/') ? ns : ns + '/'
    return sp + norm
  }, [stores, selectedBucket, subPrefix])

  const canSubmit = !!fleet && selectedFiles.length > 0 && confirmed

  // ─────────────────────────────────────────────────────────────────────────

  return (
    <FileStoreProvider>
      <>
        {/* ── Header ── */}
        <Header aria-label="Fleets Dispatcher">
          <HeaderName prefix="IBM Code Engine">Fleets Dispatcher</HeaderName>
          <HeaderGlobalBar>
            {fleet ? (
              <HeaderGlobalAction
                aria-label={`Fleet: ${fleet.name} (${fleet.region}) — click to change`}
                onClick={() => setFleetModalOpen(true)}
                tooltipAlignment="end"
              >
                <span style={{ display:'flex', alignItems:'center', gap:6, fontSize:13, color:'#fff', padding:'0 8px' }}>
                  <span style={{ width:8, height:8, borderRadius:'50%', background:'#42be65', flexShrink:0, display:'inline-block' }} />
                  {fleet.name}
                  <span style={{ color:'#8d8d8d', fontSize:11 }}>{fleet.region}</span>
                  <Renew size={16} />
                </span>
              </HeaderGlobalAction>
            ) : (
              <HeaderGlobalAction
                aria-label="Select a fleet"
                onClick={() => setFleetModalOpen(true)}
                tooltipAlignment="end"
              >
                <span style={{ fontSize:13, color:'#a8a8a8', padding:'0 8px', fontStyle:'italic' }}>
                  Select a fleet…
                </span>
              </HeaderGlobalAction>
            )}
          </HeaderGlobalBar>
        </Header>

        {/* ── Fleet gate ── */}
        <FleetGate visible={!fleet} onSelectFleet={() => setFleetModalOpen(true)} error={demoMode ? null : fetchError} />

        {/* ── Fleet picker modal ── */}
        <FleetModal
          open={fleetModalOpen}
          fleets={fleets}
          error={demoMode ? null : fetchError}
          currentFleet={fleet}
          onClose={fleet ? () => setFleetModalOpen(false) : undefined}
          onSelect={handleFleetSelect}
        />

        {/* ── Main content ── */}
        {fleet && (
          <div className="page-content">
            {/* Onboarding banner — shown on first visit, dismissible */}
            <OnboardingBanner />

            {demoMode && (
              <InlineNotification
                kind="info"
                title="Demo mode"
                subtitle="Running with a synthetic fleet. No IBM Cloud credentials required — uploads and dispatches are simulated."
                style={{ marginBottom: '1rem' }}
              />
            )}
            {fetchError && !demoMode && (
              <InlineNotification
                kind="warning"
                title="Fleet list may be incomplete:"
                subtitle={fetchError}
                style={{ marginBottom: '1rem' }}
              />
            )}

            <h1 style={{ fontSize:'1.625rem', fontWeight:300, marginBottom:'0.25rem' }}>
              Dispatch a Batch Workload
            </h1>
            <p style={{ fontSize:'0.875rem', color:'var(--cds-text-secondary)', marginBottom:'1.5rem' }}>
              Configure your task template, stage files, review the JSONL, then upload &amp; dispatch.
            </p>

            {/* 0 — Fleet */}
            <FleetSection
              fleet={fleet}
              stores={stores}
              selectedBucket={selectedBucket}
              subPrefix={subPrefix}
              open={sections.state.fleet}
              onToggle={() => sections.toggle('fleet')}
              onChangeFleet={() => setFleetModalOpen(true)}
            />

            {/* 1 — Template */}
            <TemplateSection
              fleet={fleet}
              template={template}
              onChange={handleTemplateChange}
              open={sections.state.template}
              onToggle={() => sections.toggle('template')}
            />

            {/* 2 — Files */}
            <FilesSection
              files={files}
              stores={stores}
              selectedBucket={selectedBucket}
              subPrefix={subPrefix}
              selectedIndices={selectedIndices}
              onFilesChange={handleFilesChange}
              onSelectionChange={handleSelectionChange}
              onBucketChange={setSelectedBucket}
              onSubPrefixChange={handleSubPrefixChange}
              onAddMoreFiles={handleAddMoreFiles}
              open={sections.state.files}
              onToggle={() => sections.toggle('files')}
            />

            {/* 3 — JSONL Preview */}
            <PreviewSection
              fleet={fleet}
              template={template}
              files={selectedFiles}
              cosPrefix={effectiveCosPrefix}
              confirmed={confirmed}
              onConfirm={handleConfirm}
              open={sections.state.preview}
              onToggle={() => sections.toggle('preview')}
            />

            {/* 4 — Submit */}
            {confirmed && (
              <SubmitSection
                fleet={fleet}
                template={template}
                files={selectedFiles}
                bucket={selectedBucket}
                demoMode={demoMode}
                open={sections.state.submit}
                onToggle={() => sections.toggle('submit')}
                onReset={handleReset}
              />
            )}
          </div>
        )}

        {/* ── Sticky action bar ── */}
        <ActionBar
          fleet={fleet}
          fileCount={selectedFiles.length}
          confirmed={confirmed}
          canSubmit={canSubmit}
          onOpenFleet={() => setFleetModalOpen(true)}
        />
      </>
    </FileStoreProvider>
  )
}
