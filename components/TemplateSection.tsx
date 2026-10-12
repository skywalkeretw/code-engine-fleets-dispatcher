'use client'

import { useRef } from 'react'
import { Button, Select, SelectItem, TextInput } from '@carbon/react'
import type { Fleet } from '@/lib/ce'
import type { Template } from '@/lib/jsonl'

// ── Built-in presets ─────────────────────────────────────────────────────────
// Store-name placeholders use the literal strings INPUT_STORE and OUTPUT_STORE.
// When a preset is loaded, substituteStoreNames() replaces them with the actual
// mount store names from the selected fleet.

const PLACEHOLDER_IN  = 'INPUT_STORE'
const PLACEHOLDER_OUT = 'OUTPUT_STORE'

const BUILTIN_PRESETS: Template[] = [
  {
    id: '__empty', name: 'Empty template',
    idx: '', cmds: [], args: [],
  },
  {
    id: '__docling', name: 'Docling — PDF to Markdown',
    idx: '{{filename}}',
    cmds: ['docling'],
    args: [
      '--num-threads', '12',
      `{{mount.${PLACEHOLDER_IN}}}/{{relPath}}`,
      '--output',
      `{{mount.${PLACEHOLDER_OUT}}}/{{stem}}.md`,
    ],
  },
  {
    id: '__wordcount', name: 'Word Count (wc)',
    idx: '',
    cmds: ['/bin/bash'],
    args: ['-c', `wc {{mount.${PLACEHOLDER_IN}}}/{{relPath}} > {{mount.${PLACEHOLDER_OUT}}}/wordcount_{{filename}}`],
  },
  {
    id: '__inferencing', name: 'Batch LLM Inferencing',
    idx: '{{filename}}',
    cmds: ['python'],
    args: [
      'app.py',
      '--input',  `{{mount.${PLACEHOLDER_IN}}}/{{relPath}}`,
      '--output', `{{mount.${PLACEHOLDER_OUT}}}/{{stem}}_result.json`,
    ],
  },
]

/**
 * Replace PLACEHOLDER_IN / PLACEHOLDER_OUT in a preset's args/cmds with the
 * actual store names from the currently selected fleet.
 * Uses the first mount as "input" and the second as "output".
 * Falls back to the placeholder string if the fleet has fewer mounts than needed.
 */
function substituteStoreNames(preset: Template, fleet: Fleet): Template {
  const inName  = fleet.mounts[0]?.storeName ?? PLACEHOLDER_IN
  const outName = fleet.mounts[1]?.storeName ?? (fleet.mounts[0]?.storeName ?? PLACEHOLDER_OUT)

  const sub = (s: string) =>
    s.replace(new RegExp(PLACEHOLDER_IN, 'g'), inName)
     .replace(new RegExp(PLACEHOLDER_OUT, 'g'), outName)

  return {
    ...preset,
    idx:  sub(preset.idx),
    cmds: preset.cmds.map(sub),
    args: preset.args.map(sub),
  }
}

interface Props {
  fleet: Fleet
  template: Template
  onChange: (t: Template) => void
  open: boolean
  onToggle: () => void
}

export default function TemplateSection({ fleet, template, onChange, open, onToggle }: Props) {
  const meta = buildMeta(template)

  function applyPreset(id: string) {
    const found = BUILTIN_PRESETS.find(p => p.id === id)
    if (!found) return
    // Substitute real fleet store names before surfacing to the user
    onChange(substituteStoreNames(found, fleet))
  }

  const handleIdxChange  = (v: string)      => onChange({ ...template, idx: v })
  const handleCmdsChange = (cmds: string[]) => onChange({ ...template, cmds })
  const handleArgsChange = (args: string[]) => onChange({ ...template, args })

  return (
    <div className={`section-card ${open ? 'section-card--open' : ''}`}>
      <button className="section-header" onClick={onToggle} type="button">
        <div className="section-num"><span>1</span></div>
        <div className="section-title">Task Template</div>
        <div className="section-meta">{meta}</div>
        <span className="section-arrow">▼</span>
      </button>

      {open && (
        <div className="section-body">
          {/* Preset picker */}
          <div style={{ maxWidth: 360, marginBottom: '1rem' }}>
            <Select
              id="template-preset"
              labelText="Load a preset"
              helperText="Store names are automatically substituted from the selected fleet's mounts."
              value=""
              onChange={e => applyPreset(e.target.value)}
              size="md"
            >
              <SelectItem value="" text="— Choose a preset —" />
              {BUILTIN_PRESETS.filter(p => p.id !== '__empty').map(p => (
                <SelectItem key={p.id} value={p.id} text={p.name} />
              ))}
              <SelectItem value="__empty" text="Clear / start from scratch" />
            </Select>
          </div>

          <p style={{ fontSize:'0.8125rem', color:'var(--cds-text-secondary)', marginBottom:'0.75rem', lineHeight:1.5 }}>
            Each JSONL line has up to three optional fields: <strong>idx</strong> (task identifier),{' '}
            <strong>cmds</strong> (executable + subcommands), <strong>args</strong> (arguments).
            Use <code style={{ background:'#e0e0e0', padding:'1px 5px' }}>{'{{placeholder}}'}</code> tokens.
            Drag <strong>⠿</strong> to reorder rows.
          </p>

          {/* Placeholder chips */}
          <PlaceholderChips fleet={fleet} />

          <hr style={{ border:'none', borderTop:'1px solid var(--cds-border-subtle-01)', margin:'1rem 0' }} />

          {/* idx */}
          <div style={{ marginBottom:'1rem' }}>
            <TextInput
              id="tpl-idx"
              labelText="idx"
              helperText="Optional task identifier. Supports placeholders. Leave empty to omit."
              value={template.idx}
              onChange={e => handleIdxChange(e.target.value)}
              placeholder="e.g. {{filename}} or task-{{index}}"
              size="md"
            />
          </div>

          {/* cmds */}
          <div style={{ marginBottom:'1rem' }}>
            <p style={{ fontSize:'0.75rem', fontWeight:600, marginBottom:'0.25rem' }}>cmds</p>
            <p style={{ fontSize:'0.6875rem', color:'var(--cds-text-helper)', marginBottom:'0.5rem' }}>
              Executable and fixed sub-commands. Drag ⠿ to reorder.
            </p>
            <SortableList items={template.cmds} onChange={handleCmdsChange} placeholder="e.g. python" id="cmds" />
            <Button kind="ghost" size="sm" onClick={() => handleCmdsChange([...template.cmds, ''])}>
              + Add cmd entry
            </Button>
          </div>

          {/* args */}
          <div>
            <p style={{ fontSize:'0.75rem', fontWeight:600, marginBottom:'0.25rem' }}>args</p>
            <p style={{ fontSize:'0.6875rem', color:'var(--cds-text-helper)', marginBottom:'0.5rem' }}>
              One argument per row. Drag ⠿ to reorder. Supports placeholders.
            </p>
            <SortableList items={template.args} onChange={handleArgsChange} placeholder="value or {{placeholder}}" id="args" />
            <Button kind="ghost" size="sm" onClick={() => handleArgsChange([...template.args, ''])}>
              + Add arg entry
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Placeholder chips ─────────────────────────────────────────────────────────

function PlaceholderChips({ fleet }: { fleet: Fleet }) {
  const staticChips = ['{{filename}}', '{{stem}}', '{{ext}}', '{{relPath}}', '{{cosPath}}', '{{prefix}}', '{{index}}']
  const mountChips  = fleet.mounts.map(m => `{{mount.${m.storeName}}}`)

  function copy(ph: string) {
    navigator.clipboard.writeText(ph).catch(() => {})
  }

  return (
    <div>
      <p style={{ fontSize:'0.75rem', fontWeight:600, color:'var(--cds-text-secondary)', marginBottom:'0.375rem' }}>
        Available placeholders — click to copy
      </p>
      <div className="ph-chips">
        {staticChips.map(ph => (
          <button
            key={ph}
            type="button"
            className="ph-chip"
            onClick={() => copy(ph)}
            title={
              ph === '{{relPath}}'
                ? 'Path the container sees after the mount root (storePrefix stripped). Use as: {{mount.X}}/{{relPath}}'
                : ph === '{{cosPath}}'
                  ? 'Full COS object key including store prefix. Use for COS API calls, not for container paths.'
                  : ph
            }
          >
            {ph}
          </button>
        ))}
        {mountChips.map((ph, i) => (
          <button
            key={ph}
            type="button"
            className="ph-chip ph-chip--mount"
            onClick={() => copy(ph)}
            title={`resolves to container path: ${fleet.mounts[i].mountPath}`}
          >
            {ph}
          </button>
        ))}
        {fleet.mounts.length === 0 && (
          <span className="ph-chip-tip">← no mounts configured on this fleet</span>
        )}
      </div>
    </div>
  )
}

// ── Sortable drag-and-drop list ───────────────────────────────────────────────
// Uses Carbon TextInput for each row — this ensures consistent styling,
// accessible labels, and compatibility with Carbon's form validation system.

interface SortableListProps {
  id: string
  items: string[]
  onChange: (items: string[]) => void
  placeholder: string
}

function SortableList({ id, items, onChange, placeholder }: SortableListProps) {
  const dragIdx   = useRef<number | null>(null)
  const touchStart = useRef<{ idx: number; y: number } | null>(null)

  function handleDrop(targetIdx: number) {
    if (dragIdx.current === null || dragIdx.current === targetIdx) return
    const next = [...items]
    const [moved] = next.splice(dragIdx.current, 1)
    next.splice(targetIdx, 0, moved)
    onChange(next)
    dragIdx.current = null
  }

  return (
    <div style={{ marginBottom: 4 }}>
      {items.map((val, i) => (
        <div
          key={i}
          className="sort-row"
          draggable
          onDragStart={() => { dragIdx.current = i }}
          onDragOver={e => e.preventDefault()}
          onDrop={() => handleDrop(i)}
          onTouchStart={e => { touchStart.current = { idx: i, y: e.touches[0].clientY } }}
          onTouchEnd={e => {
            if (!touchStart.current) return
            const dy = e.changedTouches[0].clientY - touchStart.current.y
            const step = dy > 20 ? 1 : dy < -20 ? -1 : 0
            if (step) {
              const next = [...items]
              const newIdx = Math.max(0, Math.min(next.length - 1, i + step))
              const [moved] = next.splice(i, 1)
              next.splice(newIdx, 0, moved)
              onChange(next)
            }
            touchStart.current = null
          }}
        >
          <span className="drag-handle" title="Drag to reorder">⠿</span>
          {/* Carbon TextInput — maintains design system consistency and accessibility */}
          <div style={{ flex: 1 }}>
            <TextInput
              id={`${id}-item-${i}`}
              labelText=""
              hideLabel
              size="sm"
              value={val}
              placeholder={placeholder}
              onChange={e => {
                const next = [...items]; next[i] = e.target.value; onChange(next)
              }}
            />
          </div>
          <Button
            kind="ghost" size="sm" hasIconOnly iconDescription="Remove"
            renderIcon={() => <span>✕</span>}
            onClick={() => onChange(items.filter((_, idx) => idx !== i))}
            style={{ minWidth:32, padding:0, flexShrink:0 }}
          />
        </div>
      ))}
    </div>
  )
}

function buildMeta(t: Template): string {
  const parts: string[] = []
  if (t.idx)         parts.push(`idx: "${t.idx.slice(0,24)}${t.idx.length>24?'…':''}"`)
  if (t.cmds.length) parts.push(`cmds: [${t.cmds.slice(0,2).map(c=>`"${c}"`).join(', ')}${t.cmds.length>2?', …':''}]`)
  if (t.args.length) parts.push(`${t.args.length} arg${t.args.length!==1?'s':''}`)
  return parts.length ? parts.join(' · ') : 'Empty — define idx · cmds · args'
}
