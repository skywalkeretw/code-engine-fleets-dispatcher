'use client'

/**
 * FileContext — the single source of truth for File objects in the browser.
 *
 * FilesSection populates this store when files are staged.
 * SubmitSection reads from it during upload.
 *
 * No window globals are used — all file access goes through this context.
 */

import { createContext, useContext, useRef, useCallback } from 'react'

type FileMap = Map<string, File>

interface FileContextValue {
  /** Replace the entire store with a new set of files. */
  setFiles: (files: File[], getKey: (f: File) => string) => void
  /** Merge new files into the existing store (for "add more" flows). */
  addFiles: (files: File[], getKey: (f: File) => string) => void
  /** Look up a staged File by its key (webkitRelativePath or name). */
  getFile: (key: string) => File | undefined
  /** Remove a single file by key. */
  removeFile: (key: string) => void
  /** Clear all staged files. */
  clear: () => void
}

const FileContext = createContext<FileContextValue | null>(null)

export function FileStoreProvider({ children }: { children: React.ReactNode }) {
  const mapRef = useRef<FileMap>(new Map())

  const setFiles = useCallback((files: File[], getKey: (f: File) => string) => {
    mapRef.current = new Map(files.map(f => [getKey(f), f]))
  }, [])

  const addFiles = useCallback((files: File[], getKey: (f: File) => string) => {
    for (const f of files) mapRef.current.set(getKey(f), f)
  }, [])

  const getFile    = useCallback((key: string) => mapRef.current.get(key), [])
  const removeFile = useCallback((key: string) => { mapRef.current.delete(key) }, [])
  const clear      = useCallback(() => { mapRef.current.clear() }, [])

  return (
    <FileContext.Provider value={{ setFiles, addFiles, getFile, removeFile, clear }}>
      {children}
    </FileContext.Provider>
  )
}

export function useFileStore(): FileContextValue {
  const ctx = useContext(FileContext)
  if (!ctx) throw new Error('useFileStore must be used inside <FileStoreProvider>')
  return ctx
}
