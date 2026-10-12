/**
 * lib/jsonl.ts — JSONL generation
 *
 * Pure functions: no server imports. Safe to import in both Server Components and
 * client-side browser code (via Next.js tree-shaking).
 */

export interface Template {
  id: string
  name: string
  idx: string
  cmds: string[]
  args: string[]
}

export interface StagedFile {
  /** Full relative path as provided by the browser, e.g. "folder/subdir/file.pdf".
   *  For flat file picks this is just the basename. */
  name: string
  /** Path portion of the COS key that follows the prefix (storePrefix + userSubPrefix).
   *  Kept separately so the key can be rebuilt when the prefix changes without
   *  losing the "include/strip top-level folder" choice made at staging time. */
  keyPath: string
  /** Full COS object key (storePrefix + userSubPrefix + keyPath), computed
   *  at staging time by FilesSection and stored here so all consumers agree. */
  cosKey: string
  /** The PDS store prefix that is the mount root for this file (e.g. "input/").
   *  relPath = cosKey.slice(storePrefix.length) — what the container sees after the mount. */
  storePrefix: string
  size: number       // bytes
  sizeLabel: string  // human-readable e.g. "1.2 MB"
}

export interface TaskContext {
  fname: string      // basename only (filename.ext)
  stem: string       // filename without extension
  ext: string        // extension without dot
  prefix: string     // full COS key prefix (everything before the filename)
  cosPath: string    // full COS key (equals StagedFile.cosKey)
  /** Path relative to the mount root = cosKey minus the store's cosPrefix.
   *  Use this after a {{mount.X}} placeholder so the container path resolves
   *  correctly: {{mount.X}}/{{relPath}} = mountPath + subPrefix + relativePath */
  relPath: string
  taskIdx: number
  mounts: Array<{ mountPath: string; storeName: string }>
}

/**
 * Expand all {{placeholder}} tokens in a template string.
 *
 * Single pass with a replacer function, so (a) `$&`/`$1` sequences in file names are
 * never interpreted as replacement patterns and (b) a file name that itself looks like
 * `{{stem}}` is not expanded a second time. Unknown placeholders are left untouched.
 */
export function expandPh(tpl: string, ctx: TaskContext): string {
  const values: Record<string, string> = {
    filename: ctx.fname,
    stem:     ctx.stem,
    ext:      ctx.ext,
    prefix:   ctx.prefix,
    cosPath:  ctx.cosPath,
    relPath:  ctx.relPath,
    index:    String(ctx.taskIdx).padStart(5, '0'),
  }
  return String(tpl).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, name: string) => {
    if (Object.prototype.hasOwnProperty.call(values, name)) return values[name]
    if (name.startsWith('mount.')) {
      const store = name.slice('mount.'.length)
      const mount = ctx.mounts.find(m => m.storeName === store)
      if (mount) return mount.mountPath
    }
    return match
  })
}

/** Build task objects from a template + file list. Returns an array of plain objects.
 *  Each StagedFile must carry a pre-computed `cosKey` — buildTasks reads it directly. */
export function buildTasks(
  template: Pick<Template, 'idx' | 'cmds' | 'args'>,
  files: StagedFile[],
  mounts: Array<{ mountPath: string; storeName: string }>
): Record<string, unknown>[] {
  return files.map((file, taskIdx) => {
    const fname = file.cosKey.split('/').pop() ?? file.name
    const dotIdx = fname.lastIndexOf('.')
    const stem = dotIdx > 0 ? fname.slice(0, dotIdx) : fname
    const ext  = dotIdx > 0 ? fname.slice(dotIdx + 1) : ''
    // prefix = everything in the COS key before the bare filename
    const prefix = file.cosKey.slice(0, file.cosKey.length - fname.length)
    // relPath = what the container sees after the mount root (store prefix stripped)
    const relPath = file.storePrefix && file.cosKey.startsWith(file.storePrefix)
      ? file.cosKey.slice(file.storePrefix.length)
      : file.cosKey
    const ctx: TaskContext = {
      fname, stem, ext,
      prefix,
      cosPath: file.cosKey,
      relPath,
      taskIdx,
      mounts,
    }
    const task: Record<string, unknown> = {}
    const idx = template.idx ? expandPh(template.idx, ctx) : ''
    if (idx)                task.idx  = idx
    // Blank rows left over in the template editor must not become empty-string commands
    const cmds = template.cmds.filter(c => c.trim() !== '')
    if (cmds.length)        task.cmds = cmds.map(c => expandPh(c, ctx))
    if (template.args.length) task.args = template.args.map(a => expandPh(a, ctx))
    return task
  })
}

/** Serialize task objects to a JSONL string. */
export function tasksToJsonl(tasks: Record<string, unknown>[]): string {
  return tasks.map(t => JSON.stringify(t)).join('\n')
}

/** Human-readable file size. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024)               return `${bytes} B`
  if (bytes < 1024 * 1024)        return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
