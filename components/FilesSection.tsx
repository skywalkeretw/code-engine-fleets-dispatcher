'use client'

/**
 * FilesSection — stage local files for upload, manage COS destination.
 *
 * COS key construction (per file):
 *   storePrefix (from matching PDS)  +  userSubPrefix  +  relativeFilePath
 *
 * Bucket selector: shows unique COS bucket names derived from the PDS list.
 * Multiple PDS stores can share the same bucket — they are deduplicated.
 * The first PDS whose bucketName matches the selected bucket provides the
 * cosPrefix and hmacSecretName used for uploads.
 *
 * Extension filter: Carbon FilterableMultiSelect of common extensions, an
 * include/exclude switch, and a small input for unlisted extensions.
 *
 * Folder upload: webkitRelativePath preserves full directory hierarchy.
 * autoDirPrefix toggle controls whether the top-level folder name is included.
 */

import { useState, useCallback, useRef, useMemo, useEffect } from 'react'
import {
  Button, TextInput, Checkbox, Toggle, InlineNotification, Select, SelectItem,
  FilterableMultiSelect, RadioButtonGroup, RadioButton,
} from '@carbon/react'
import type { StagedFile } from '@/lib/jsonl'
import type { PersistentDataStore } from '@/lib/ce'
import { formatBytes } from '@/lib/jsonl'
import { useFileStore } from './FileContext'

const PAGE_SIZE = 25

// ── Extension preset groups ─────────────────────────────────────────────────

const EXT_GROUPS: { label: string; exts: string[] }[] = [
  { label: 'Video',    exts: ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v'] },
  { label: 'Audio',    exts: ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a'] },
  { label: 'Image',    exts: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.tiff', '.bmp'] },
  { label: 'Document', exts: ['.pdf', '.docx', '.xlsx', '.pptx', '.txt', '.csv'] },
  { label: 'Data',     exts: ['.json', '.jsonl', '.parquet', '.csv', '.xml', '.yaml'] },
  { label: 'Archive',  exts: ['.zip', '.tar', '.gz', '.bz2', '.7z'] },
  { label: 'Code',     exts: ['.py', '.js', '.ts', '.go', '.java', '.sh'] },
]

// ── ExtFilter sub-component ─────────────────────────────────────────────────
// Carbon FilterableMultiSelect (type-to-search, checkbox list, selected-count tag)
// plus an include/exclude switch and a small input for extensions not in the list.

interface ExtItem { id: string; label: string }

const PRESET_EXTS: string[] = Array.from(new Set(EXT_GROUPS.flatMap(g => g.exts)))

interface ExtFilterProps {
  mode: 'include' | 'exclude'
  selected: Set<string>
  onModeChange: (m: 'include' | 'exclude') => void
  onSelectedChange: (s: Set<string>) => void
}

function ExtFilter({ mode, selected, onModeChange, onSelectedChange }: ExtFilterProps) {
  const [customInput, setCustomInput] = useState('')

  // Options = presets + any custom extension the user has added (so it stays selectable)
  const items = useMemo<ExtItem[]>(() => {
    const all = new Set(PRESET_EXTS)
    for (const e of selected) all.add(e)
    return [...all].map(e => ({ id: e, label: e }))
  }, [selected])

  const selectedItems = useMemo(() => items.filter(i => selected.has(i.id)), [items, selected])

  function addCustom() {
    const exts = customInput
      .split(/[\s,]+/)
      .map(e => e.trim().toLowerCase())
      .filter(Boolean)
      .map(e => (e.startsWith('.') ? e : `.${e}`))
    if (exts.length === 0) return
    const next = new Set(selected)
    exts.forEach(e => next.add(e))
    onSelectedChange(next)
    setCustomInput('')
  }

  return (
    <div style={{ maxWidth: 560 }}>
      <RadioButtonGroup
        legendText="Extension filter"
        name="ext-filter-mode"
        orientation="horizontal"
        valueSelected={mode}
        onChange={(v) => onModeChange(v as 'include' | 'exclude')}
        style={{ marginBottom: '0.5rem' }}
      >
        <RadioButton id="ext-mode-include" labelText="Include only" value="include" />
        <RadioButton id="ext-mode-exclude" labelText="Exclude" value="exclude" />
      </RadioButtonGroup>

      <FilterableMultiSelect
        id="ext-filter"
        titleText="Extensions"
        hideLabel
        helperText={
          selected.size === 0
            ? 'No filter — all files are staged. Pick extensions to restrict the batch.'
            : mode === 'include'
              ? 'Only files with these extensions are staged.'
              : 'Files with these extensions are skipped.'
        }
        placeholder="Search or pick extensions…"
        items={items}
        itemToString={(item: ExtItem | null) => item?.label ?? ''}
        selectedItems={selectedItems}
        onChange={({ selectedItems: sel }: { selectedItems: ExtItem[] }) =>
          onSelectedChange(new Set(sel.map(i => i.id)))
        }
        selectionFeedback="top-after-reopen"
        size="md"
      />

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginTop: '0.5rem' }}>
        <div style={{ flex: 1 }}>
          <TextInput
            id="ext-custom-input"
            labelText="Add custom extensions"
            helperText="e.g. .heic, .raw, .nef"
            size="sm"
            value={customInput}
            onChange={e => setCustomInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCustom() } }}
            placeholder=".heic, .raw …"
          />
        </div>
        <Button kind="secondary" size="sm" onClick={addCustom} style={{ flexShrink: 0 }}>
          Add
        </Button>
        {selected.size > 0 && (
          <Button kind="ghost" size="sm" onClick={() => onSelectedChange(new Set())} style={{ flexShrink: 0 }}>
            Clear all
          </Button>
        )}
      </div>
    </div>
  )
}

// ── Props ───────────────────────────────────────────────────────────────────

interface Props {
  files: StagedFile[]
  stores: PersistentDataStore[]
  /** Selected COS bucket name (empty = none selected) */
  selectedBucket: string
  /** Sub-prefix appended after the store's cosPrefix — user-editable */
  subPrefix: string
  /** Indices into `files` that are currently checked — parent controls this */
  selectedIndices: Set<number>
  onFilesChange: (files: StagedFile[]) => void
  onSelectionChange: (selected: Set<number>) => void
  onBucketChange: (bucket: string) => void
  onSubPrefixChange: (prefix: string) => void
  /** Called when user explicitly wants to add more files to an existing batch */
  onAddMoreFiles?: (newFiles: StagedFile[], newIndices: Set<number>) => void
  open: boolean
  onToggle: () => void
}

// ── Main component ──────────────────────────────────────────────────────────

export default function FilesSection({
  files, stores, selectedBucket, subPrefix, selectedIndices,
  onFilesChange, onSelectionChange,
  onBucketChange, onSubPrefixChange,
  onAddMoreFiles,
  open, onToggle,
}: Props) {
  const fileInputRef   = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging]           = useState(false)
  const [filter, setFilter]               = useState('')
  const [page, setPage]                   = useState(0)
  const [autoDirPrefix, setAutoDirPrefix] = useState(true)

  // Extension filter state (lifted out of ExtFilter so processFileList can read it)
  const [extMode, setExtMode]           = useState<'include' | 'exclude'>('include')
  const [selectedExts, setSelectedExts] = useState<Set<string>>(new Set())

  const fileStore = useFileStore()

  // ── Bucket deduplication ────────────────────────────────────────────────────

  const uniqueBuckets = useMemo<string[]>(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const s of stores) {
      if (!seen.has(s.bucketName)) { seen.add(s.bucketName); out.push(s.bucketName) }
    }
    return out
  }, [stores])

  const selectedStore = useMemo<PersistentDataStore | null>(
    () => stores.find(s => s.bucketName === selectedBucket) ?? null,
    [stores, selectedBucket]
  )

  // ── Derived prefix ──────────────────────────────────────────────────────────

  const storePrefix: string = selectedStore?.cosPrefix ?? ''

  const normSubPrefix = useMemo(() => {
    const s = subPrefix.replace(/^\/+/, '')
    if (!s) return ''
    return s.endsWith('/') ? s : s + '/'
  }, [subPrefix])

  const fullPrefix = storePrefix + normSubPrefix

  // ── Extension filter ────────────────────────────────────────────────────────

  function isAllowed(filename: string): boolean {
    if (selectedExts.size === 0) return true
    const dot = filename.lastIndexOf('.')
    const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : ''
    const matches = selectedExts.has(ext)
    return extMode === 'include' ? matches : !matches
  }

  // ── COS key computation ─────────────────────────────────────────────────────

  /** Path part of the COS key (everything after the store prefix + sub-prefix). */
  function keyPathFor(f: File): string {
    const wkp = (f as File & { webkitRelativePath: string }).webkitRelativePath
    if (!wkp) return f.name
    if (autoDirPrefix) return wkp
    const slash = wkp.indexOf('/')
    return slash >= 0 ? wkp.slice(slash + 1) : wkp
  }

  function toStaged(f: File): StagedFile {
    const keyPath = keyPathFor(f)
    return {
      name: relKeyFor(f),
      keyPath,
      cosKey: fullPrefix + keyPath,
      storePrefix,
      size: f.size,
      sizeLabel: formatBytes(f.size),
    }
  }

  function relKeyFor(f: File): string {
    return (f as File & { webkitRelativePath: string }).webkitRelativePath || f.name
  }

  // ── File ingestion ──────────────────────────────────────────────────────────

  const processFileList = useCallback((rawFiles: File[], addMode = false) => {
    if (rawFiles.length === 0) return

    const filtered = selectedExts.size > 0
      ? rawFiles.filter(f => isAllowed(f.name))
      : rawFiles

    if (filtered.length === 0) return

    if (addMode && onAddMoreFiles) {
      fileStore.addFiles(filtered, relKeyFor)
      const offset = files.length
      const newStaged = filtered.map(toStaged)
      onAddMoreFiles(newStaged, new Set(newStaged.map((_, i) => offset + i)))
    } else {
      fileStore.setFiles(filtered, relKeyFor)
      const staged = filtered.map(toStaged)
      onFilesChange(staged)
      onSelectionChange(new Set(staged.map((_, i) => i)))
      setFilter('')
      setPage(0)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedExts, extMode, autoDirPrefix, fullPrefix, storePrefix, files.length, onFilesChange, onSelectionChange, onAddMoreFiles, fileStore])

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragging(false)
    // The drop zone says "Drop more files here" once files are staged, so merge
    if (e.dataTransfer.files.length) processFileList(Array.from(e.dataTransfer.files), files.length > 0)
  }

  // ── Recompute COS keys when prefix changes ──────────────────────────────────
  // Rebuilt from keyPath (not name) so the "include/strip top folder" choice made
  // when each file was staged is preserved.

  const recomputedFiles = useMemo<StagedFile[]>(() => {
    if (files.length === 0) return files
    return files.map(f => ({ ...f, cosKey: fullPrefix + f.keyPath, storePrefix }))
  }, [files, fullPrefix, storePrefix])

  // Push recomputed keys up to the parent whenever the prefix changes
  // (an effect — calling the parent's setState during render is not allowed).
  const lastSyncedPrefix = useRef(`${storePrefix}|${fullPrefix}`)
  useEffect(() => {
    const marker = `${storePrefix}|${fullPrefix}`
    if (lastSyncedPrefix.current === marker) return
    lastSyncedPrefix.current = marker
    if (files.length > 0) onFilesChange(recomputedFiles)
  }, [storePrefix, fullPrefix, files.length, recomputedFiles, onFilesChange])

  // ── Remove a single file ────────────────────────────────────────────────────

  function removeFile(globalIdx: number) {
    const removed = recomputedFiles[globalIdx]
    fileStore.removeFile(removed.name)
    const next = recomputedFiles.filter((_, i) => i !== globalIdx)
    const nextSelected = new Set<number>()
    for (const idx of selectedIndices) {
      if (idx < globalIdx) nextSelected.add(idx)
      else if (idx > globalIdx) nextSelected.add(idx - 1)
    }
    onFilesChange(next)
    onSelectionChange(nextSelected)
  }

  // ── Filter / pagination ─────────────────────────────────────────────────────

  const filteredItems = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return recomputedFiles.map((f, i) => ({ f, globalIdx: i }))
    return recomputedFiles
      .map((f, i) => ({ f, globalIdx: i }))
      .filter(({ f }) => (f.name.split('/').pop() ?? f.name).toLowerCase().includes(q))
  }, [recomputedFiles, filter])

  const totalPages = Math.max(1, Math.ceil(filteredItems.length / PAGE_SIZE))
  const safePage   = Math.min(page, totalPages - 1)
  const pageItems  = filteredItems.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)

  // ── Selection helpers ───────────────────────────────────────────────────────

  const filteredGlobalIndices = useMemo(() => new Set(filteredItems.map(x => x.globalIdx)), [filteredItems])

  const filteredSelectedCount = useMemo(() => {
    let n = 0
    for (const idx of filteredGlobalIndices) if (selectedIndices.has(idx)) n++
    return n
  }, [filteredGlobalIndices, selectedIndices])

  const allFilteredSelected  = filteredGlobalIndices.size > 0 && filteredSelectedCount === filteredGlobalIndices.size
  const someFilteredSelected = filteredSelectedCount > 0 && !allFilteredSelected

  function toggleFilteredAll(checked: boolean) {
    const next = new Set(selectedIndices)
    for (const idx of filteredGlobalIndices) checked ? next.add(idx) : next.delete(idx)
    onSelectionChange(next)
  }

  function toggleOne(globalIdx: number, checked: boolean) {
    const next = new Set(selectedIndices)
    checked ? next.add(globalIdx) : next.delete(globalIdx)
    onSelectionChange(next)
  }

  // ── Summaries ───────────────────────────────────────────────────────────────

  const selectedCount = selectedIndices.size
  const totalBytes    = recomputedFiles.reduce((s, f) => s + f.size, 0)
  const meta = recomputedFiles.length === 0
    ? 'No files staged'
    : `${recomputedFiles.length} staged · ${selectedCount} selected · ${formatBytes(totalBytes)}`

  const hasFiles = recomputedFiles.length > 0

  // ── Shared table styles ─────────────────────────────────────────────────────

  const th: React.CSSProperties = {
    background: 'var(--cds-layer-02)',
    padding: '7px 10px',
    textAlign: 'left',
    fontSize: '0.6875rem',
    fontWeight: 700,
    borderBottom: '1px solid var(--cds-border-subtle-01)',
    whiteSpace: 'nowrap',
  }
  const td: React.CSSProperties = {
    padding: '5px 10px',
    borderBottom: '1px solid var(--cds-border-subtle-01)',
    fontSize: '0.8125rem',
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className={`section-card ${open ? 'section-card--open' : ''}`}>
      <button className="section-header" onClick={onToggle} type="button">
        <div className="section-num"><span>2</span></div>
        <div className="section-title">Files</div>
        <div className="section-meta">{meta}</div>
        <span className="section-arrow">▼</span>
      </button>

      {open && (
        <div className="section-body">

          {/* ── COS destination ──────────────────────────────────────────────── */}
          <p style={{ fontSize:'0.75rem', fontWeight:600, color:'var(--cds-text-secondary)', marginBottom:'0.5rem', textTransform:'uppercase', letterSpacing:'0.5px' }}>
            COS destination
          </p>

          {/* Bucket selector */}
          <div style={{ maxWidth: 520, marginBottom: '0.75rem' }}>
            {stores.length > 0 ? (
              <Select
                id="cos-bucket-select"
                labelText="COS bucket"
                helperText={
                  selectedStore
                    ? `Store prefix: "${selectedStore.cosPrefix || '(none)'}" · HMAC secret: ${selectedStore.hmacSecretName}`
                    : 'Select which COS bucket to upload files into.'
                }
                value={selectedBucket}
                onChange={e => onBucketChange(e.target.value)}
                size="md"
              >
                {!selectedBucket && <SelectItem value="" text="— Select a bucket —" />}
                {uniqueBuckets.map(b => (
                  <SelectItem key={b} value={b} text={b} />
                ))}
              </Select>
            ) : (
              <p style={{ fontSize:'0.8125rem', color:'var(--cds-text-secondary)', padding:'0.5rem 0' }}>
                No COS buckets found — make sure a fleet with persistent data stores is selected.
              </p>
            )}
          </div>

          {/* Sub-prefix */}
          <div style={{ maxWidth: 520, marginBottom: '0.5rem' }}>
            <TextInput
              id="cos-sub-prefix"
              labelText="Sub-prefix within bucket (optional)"
              helperText={
                <>
                  Appended after the store&apos;s prefix. Leave empty to upload at the store root.{' '}
                  Example: <code style={{ background:'#e0e0e0', padding:'1px 4px' }}>batch1/</code>
                  {selectedStore && (
                    <>
                      {' '}→ COS key prefix:{' '}
                      <code style={{ background:'#e0e0e0', padding:'1px 4px' }}>{fullPrefix || '(bucket root)'}</code>
                    </>
                  )}
                </>
              }
              value={subPrefix}
              onChange={e => onSubPrefixChange(e.target.value)}
              size="md"
              placeholder="e.g. batch1/ (or leave empty)"
            />
          </div>

          {/* Full prefix preview */}
          {fullPrefix && (
            <div style={{ marginBottom:'0.875rem', padding:'0.375rem 0.75rem', background:'var(--cds-layer-02)', border:'1px solid var(--cds-border-subtle-01)', fontSize:'0.8125rem', fontFamily:'monospace' }}>
              COS key prefix: <strong>{fullPrefix}</strong>
              <span style={{ color:'var(--cds-text-secondary)', fontSize:'0.75rem', fontFamily:'inherit', marginLeft:8 }}>
                (store prefix <code>{storePrefix || '""'}</code> + sub-prefix <code>{normSubPrefix || '""'}</code>)
              </span>
            </div>
          )}

          {/* Auto-dir-prefix toggle */}
          <div style={{ marginBottom: '0.875rem' }}>
            <Toggle
              id="auto-dir-prefix"
              labelText="Include top-level folder name in COS key when browsing a folder"
              labelA="Off — strip top folder"
              labelB="On — include top folder"
              toggled={autoDirPrefix}
              onToggle={v => setAutoDirPrefix(v)}
              size="sm"
            />
          </div>

          <hr style={{ border:'none', borderTop:'1px solid var(--cds-border-subtle-01)', margin:'0.75rem 0 0.875rem' }} />

          {/* ── Extension filter (dropdown widget) ───────────────────────────── */}
          <div style={{ marginBottom: '1rem' }}>
            <ExtFilter
              mode={extMode}
              selected={selectedExts}
              onModeChange={setExtMode}
              onSelectedChange={setSelectedExts}
            />
          </div>

          <hr style={{ border:'none', borderTop:'1px solid var(--cds-border-subtle-01)', margin:'0.25rem 0 1rem' }} />

          {/* ── Drop zone ──────────────────────────────────────────────────────── */}
          <div
            style={{
              border: `2px dashed ${dragging ? 'var(--cds-interactive)' : 'var(--cds-border-strong-01)'}`,
              padding: '2rem 1.5rem',
              textAlign: 'center',
              background: dragging ? '#edf5ff' : 'var(--cds-layer-02)',
              transition: 'border-color 0.15s, background 0.15s',
              marginBottom: '1rem',
            }}
            onDragOver={e => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
          >
            <div style={{ fontSize:'1.5rem', marginBottom:'0.375rem' }}>⬆</div>
            <p style={{ fontSize:'0.9375rem', marginBottom:'0.25rem' }}>
              <strong>{hasFiles ? 'Drop more files here' : 'Drag and drop files here'}</strong>
            </p>
            <p style={{ fontSize:'0.8125rem', color:'var(--cds-text-secondary)', marginBottom:'0.625rem' }}>
              Any file type · each file = one JSONL task line
              {selectedExts.size > 0 && (
                <> · <strong style={{ color: extMode === 'include' ? '#0043ce' : '#a2191f' }}>
                  {extMode === 'include' ? 'Include only' : 'Exclude'}: {[...selectedExts].join(', ')}
                </strong></>
              )}
            </p>
            <div style={{ display:'flex', gap:'0.5rem', justifyContent:'center', flexWrap:'wrap' }}>
              <Button kind="secondary" size="sm" onClick={() => fileInputRef.current?.click()}>
                {hasFiles ? 'Add files…' : 'Browse files'}
              </Button>
              <Button kind="tertiary" size="sm" onClick={() => folderInputRef.current?.click()}>
                {hasFiles ? 'Add folder…' : 'Browse folder'}
              </Button>
            </div>
            <input
              ref={fileInputRef}
              type="file" multiple style={{ display:'none' }}
              onChange={e => e.target.files && processFileList(Array.from(e.target.files), hasFiles)}
            />
            <input
              ref={folderInputRef}
              type="file" style={{ display:'none' }}
              {...{ webkitdirectory: '', directory: '' }}
              onChange={e => e.target.files && processFileList(Array.from(e.target.files), hasFiles)}
            />
          </div>

          {/* ── File table ───────────────────────────────────────────────────── */}
          {hasFiles && (
            <>
              {/* Toolbar */}
              <div style={{ display:'flex', gap:'0.5rem', alignItems:'flex-end', flexWrap:'wrap', marginBottom:'0.625rem' }}>
                <div style={{ flex:'1 1 200px', minWidth:180 }}>
                  <TextInput
                    id="file-filter"
                    labelText=""
                    hideLabel
                    value={filter}
                    onChange={e => { setFilter(e.target.value); setPage(0) }}
                    placeholder="Search filenames…"
                    size="sm"
                  />
                </div>
                {filter && (
                  <Button kind="ghost" size="sm" onClick={() => { setFilter(''); setPage(0) }}>
                    Clear search
                  </Button>
                )}
                <span style={{ fontSize:'0.75rem', color:'var(--cds-text-secondary)', alignSelf:'center', marginLeft:'auto' }}>
                  {filter
                    ? `${filteredItems.length} match${filteredItems.length !== 1 ? 'es' : ''} · ${selectedCount} selected`
                    : `${recomputedFiles.length} file${recomputedFiles.length !== 1 ? 's' : ''} · ${selectedCount} selected · ${formatBytes(totalBytes)}`
                  }
                </span>
                <Button kind="ghost" size="sm" onClick={() => {
                  fileStore.clear()
                  onFilesChange([])
                  onSelectionChange(new Set())
                  setFilter('')
                  setPage(0)
                }}>
                  Clear all
                </Button>
              </div>

              {/* Duplicate COS key warning */}
              {(() => {
                const seen = new Set<string>()
                const dupes = new Set<string>()
                for (const f of recomputedFiles) {
                  if (seen.has(f.cosKey)) dupes.add(f.cosKey)
                  else seen.add(f.cosKey)
                }
                return dupes.size > 0 ? (
                  <InlineNotification
                    kind="warning"
                    title="Duplicate COS keys detected:"
                    subtitle={`${[...dupes].slice(0,2).join(', ')}${dupes.size > 2 ? ` and ${dupes.size - 2} more` : ''} — the last file with each key will overwrite earlier ones in COS.`}
                    style={{ marginBottom:'0.75rem' }}
                  />
                ) : null
              })()}

              <div style={{ overflowX: 'auto' }}>
                <table style={{ width:'100%', borderCollapse:'collapse' }}>
                  <thead>
                    <tr>
                      <th style={{ ...th, width: 36, paddingRight: 4 }}>
                        <Checkbox
                          id="select-all-filtered"
                          labelText=""
                          hideLabel
                          checked={allFilteredSelected}
                          indeterminate={someFilteredSelected}
                          onChange={(_e, { checked }) => toggleFilteredAll(checked)}
                        />
                      </th>
                      <th style={{ ...th, width: 42 }}>#</th>
                      <th style={th}>Filename</th>
                      <th style={th}>Size</th>
                      <th style={th}>COS key</th>
                      <th style={{ ...th, width: 36 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageItems.map(({ f, globalIdx }) => {
                      const fname = f.name.split('/').pop() ?? f.name
                      const isSelected = selectedIndices.has(globalIdx)
                      return (
                        <tr
                          key={globalIdx}
                          style={{
                            borderBottom: '1px solid var(--cds-border-subtle-01)',
                            background: isSelected ? undefined : 'var(--cds-layer-02)',
                            opacity: isSelected ? 1 : 0.5,
                          }}
                        >
                          <td style={{ ...td, width: 36, paddingRight: 4 }}>
                            <Checkbox
                              id={`file-sel-${globalIdx}`}
                              labelText=""
                              hideLabel
                              checked={isSelected}
                              onChange={(_e, { checked }) => toggleOne(globalIdx, checked)}
                            />
                          </td>
                          <td style={{ ...td, color:'var(--cds-text-secondary)', fontFamily:'monospace', width:42 }}>
                            {globalIdx + 1}
                          </td>
                          <td style={{ ...td, fontFamily:'monospace' }}>{fname}</td>
                          <td style={{ ...td, color:'var(--cds-text-secondary)', whiteSpace:'nowrap' }}>{f.sizeLabel}</td>
                          <td style={{ ...td, fontFamily:'monospace', fontSize:'0.6875rem', color:'var(--cds-text-secondary)', wordBreak:'break-all' }}>
                            {f.cosKey}
                          </td>
                          <td style={{ ...td, width: 36, padding:'4px 4px' }}>
                            <button
                              title="Remove file"
                              onClick={() => removeFile(globalIdx)}
                              style={{
                                background:'none', border:'none', cursor:'pointer',
                                color:'var(--cds-text-secondary)', fontSize:'0.875rem',
                                padding:'2px 4px', lineHeight:1,
                              }}
                            >
                              ✕
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                    {filteredItems.length === 0 && (
                      <tr>
                        <td colSpan={6} style={{ ...td, color:'var(--cds-text-secondary)', textAlign:'center', padding:'1rem' }}>
                          No files match &ldquo;{filter}&rdquo;
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div style={{ display:'flex', alignItems:'center', gap:'0.5rem', marginTop:'0.5rem', fontSize:'0.8125rem', color:'var(--cds-text-secondary)' }}>
                  <Button kind="ghost" size="sm" disabled={safePage === 0}
                    onClick={() => setPage(p => Math.max(0, p - 1))}>‹ Prev</Button>
                  <span>Page {safePage + 1} of {totalPages} ({filteredItems.length} file{filteredItems.length !== 1 ? 's' : ''})</span>
                  <Button kind="ghost" size="sm" disabled={safePage >= totalPages - 1}
                    onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}>Next ›</Button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
