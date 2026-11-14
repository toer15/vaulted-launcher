import { useEffect, useRef, useState, type DragEvent } from 'react'
import { ArrowRight, FolderOpen, FolderSearch, Sparkles, X } from 'lucide-react'
import { cx } from '../lib/cx'
import { hasNativeBridge, pickBuildFolder } from '../lib/launch'
import { buildFromPath } from '../lib/seasons'
import type { Build } from '../types'

interface AddBuildDialogProps {
  open: boolean
  onClose: () => void
  onAdd: (path: string) => void
}

function cleanPath(value: string): string {
  return value.trim().replace(/^["']|["']$/g, '')
}

export function AddBuildDialog({ open, onClose, onAdd }: AddBuildDialogProps) {
  const [value, setValue] = useState('')
  const [dragging, setDragging] = useState(false)
  const [browseError, setBrowseError] = useState<string | null>(null)
  const native = hasNativeBridge()
  const inputRef = useRef<HTMLInputElement>(null)
  const pathRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setValue('')
    setDragging(false)
    const id = window.setTimeout(() => pathRef.current?.focus(), 60)

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.clearTimeout(id)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onClose])

  // set webkitdirectory imperatively so TS stays happy and Chromium honours it
  useEffect(() => {
    inputRef.current?.setAttribute('webkitdirectory', '')
    inputRef.current?.setAttribute('directory', '')
  }, [open])

  if (!open) return null

  const path = cleanPath(value)
  const preview: Build | null = path ? buildFromPath(path, 'preview') : null
  const canAdd = Boolean(preview && preview.version !== 'unknown')

  const submit = () => {
    if (!canAdd || !path) return
    onAdd(path)
    onClose()
  }

  const browse = async () => {
    // desktop shell: real OS folder dialog returning the absolute path
    if (!native) {
      inputRef.current?.click()
      return
    }
    setBrowseError(null)
    try {
      const folder = await pickBuildFolder()
      if (folder) setValue(folder)
    } catch (error) {
      setBrowseError(error instanceof Error ? error.message : 'Could not open the folder picker.')
    }
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)

    const item = event.dataTransfer.items?.[0]
    const entry = item?.webkitGetAsEntry?.()
    const dropped = entry?.name ?? event.dataTransfer.files?.[0]?.name
    if (dropped) setValue(dropped)
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-modal="true" aria-label="Add build">
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-[3px]"
      />

      <div className="relative w-full max-w-[540px] animate-scale-in overflow-hidden rounded-3xl border border-line bg-ink shadow-2xl shadow-black/70">
        <div className="pointer-events-none absolute -top-24 left-1/3 h-56 w-56 rounded-full bg-arc/20 blur-3xl" aria-hidden />

        <header className="relative flex items-start justify-between gap-3 p-6 pb-0">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-fog">Add a build</p>
            <h2 className="mt-1 font-display text-xl font-semibold tracking-tight text-mist">Point VAULTED at a folder</h2>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-fog">
              Drop the build folder or paste its path — the chapter is detected automatically.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-xl border border-line bg-white/[0.03] text-fog transition-colors duration-200 hover:bg-white/[0.08] hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="relative p-6">
          <div
            onDragOver={(event) => {
              event.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            className={cx(
              'flex flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-8 text-center transition-all duration-300',
              dragging ? 'border-arc/70 bg-arc/10' : 'border-line bg-white/[0.02] hover:border-line/80',
            )}
          >
            <span
              className={cx(
                'grid h-11 w-11 place-items-center rounded-xl border border-line bg-panel text-fog transition-colors duration-300',
                dragging && 'border-arc/50 text-arc',
              )}
            >
              <FolderSearch className="h-5 w-5" />
            </span>
            <p className="mt-3 text-[13px] font-medium text-mist">
              {dragging ? 'Drop to read the folder' : 'Drag a build folder here'}
            </p>
            <p className="mt-1 text-[11.5px] text-fog">or</p>
            <button
              type="button"
              onClick={() => void browse()}
              className="mt-2 inline-flex items-center gap-2 rounded-xl border border-line bg-white/[0.04] px-3.5 py-2 text-[12px] font-semibold text-mist transition-all duration-300 hover:border-arc/45 hover:bg-white/[0.08] hover:text-white"
            >
              <FolderOpen className="h-3.5 w-3.5" /> Browse folders
            </button>
            <input
              ref={inputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0] as (File & { webkitRelativePath?: string }) | undefined
                const top = file?.webkitRelativePath?.split('/')[0]
                if (top) setValue(top)
                event.target.value = ''
              }}
            />
          </div>

          <label className="mt-4 block">
            <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-fog">Folder path</span>
            <input
              ref={pathRef}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submit()
              }}
              spellCheck={false}
              placeholder="C:\Users\name\Downloads\3.6-CL-15538114"
              className="mt-1.5 w-full rounded-xl border border-line bg-black/40 px-3.5 py-2.5 font-mono text-[12.5px] text-mist placeholder:text-fog/50 transition-colors duration-200 focus:border-arc/60 focus:outline-none"
            />
          </label>

          <div
            className={cx(
              'mt-3 flex items-center gap-2.5 rounded-xl border px-3 py-2.5 transition-colors duration-300',
              preview && canAdd
                ? 'border-emerald-400/25 bg-emerald-400/[0.06]'
                : 'border-line bg-white/[0.02]',
            )}
            aria-live="polite"
          >
            <Sparkles className={cx('h-3.5 w-3.5 shrink-0', canAdd ? 'text-emerald-300' : 'text-fog')} />
            {preview && canAdd ? (
              <p className="text-[12px] text-mist">
                Detected <span className="font-semibold text-white">{preview.season.label}</span>
                <span className="mx-1.5 text-fog/50">·</span>
                <span className="font-mono text-[11.5px] text-mist/80">v{preview.version}</span>
              </p>
            ) : (
              <p className="text-[12px] text-fog">
                {path ? 'No version like 3.6 or 12.41 in that path.' : 'Version is read from the folder name.'}
              </p>
            )}
          </div>

          {browseError && <p className="mt-2 text-[11px] leading-relaxed text-rose-300">{browseError}</p>}

          <p className="mt-3 text-[11px] leading-relaxed text-fog/80">
            {native
              ? 'The desktop app passes the full absolute path — no typing needed.'
              : 'Browser preview can only see the folder name. Run the desktop app for real absolute paths.'}
          </p>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-line/70 bg-black/20 px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl px-4 py-2.5 text-[13px] font-medium text-fog transition-colors duration-200 hover:text-mist"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canAdd}
            className={cx(
              'inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-[13px] font-semibold transition-all duration-300',
              canAdd
                ? 'bg-white text-void hover:-translate-y-0.5 hover:bg-mist active:translate-y-0'
                : 'cursor-not-allowed bg-white/10 text-fog/60',
            )}
          >
            Add build <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </footer>
      </div>
    </div>
  )
}
