import { useEffect, useRef } from 'react'
import { Layers, Plus, X } from 'lucide-react'
import { BuildList } from './BuildList'
import type { Build } from '../types'

interface BuildDrawerProps {
  open: boolean
  builds: Build[]
  activeId: string | null
  installed: Record<string, boolean>
  activeCounts: Record<string, number>
  sourceKeys?: Set<string>
  onClose: () => void
  onSelect: (id: string) => void
  onAdd: () => void
}

export function BuildDrawer({
  open,
  builds,
  activeId,
  installed,
  activeCounts,
  sourceKeys,
  onClose,
  onSelect,
  onAdd,
}: BuildDrawerProps) {
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    closeRef.current?.focus()
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Build library">
      <button
        type="button"
        aria-label="Close library"
        onClick={onClose}
        className="absolute inset-0 animate-[fade-up_0.2s_ease-out] bg-black/55 backdrop-blur-[2px]"
      />

      <aside className="relative flex h-full w-full max-w-[400px] animate-slide-in flex-col border-l border-line bg-ink/95 p-5 shadow-2xl shadow-black/70 backdrop-blur-xl">
        <header className="flex items-start justify-between gap-3">
          <div>
            <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-fog">
              <Layers className="h-3.5 w-3.5" /> Saved builds
            </p>
            <h2 className="mt-1 font-display text-xl font-semibold tracking-tight text-mist">Switch build</h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-8 w-8 place-items-center rounded-xl border border-line bg-white/[0.03] text-fog transition-colors duration-200 hover:border-line hover:bg-white/[0.08] hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="mt-5 min-h-0 flex-1 overflow-y-auto pr-1">
          <BuildList
            builds={builds}
            activeId={activeId}
            installed={installed}
            activeCounts={activeCounts}
            sourceKeys={sourceKeys}
            onSelect={(id) => {
              onSelect(id)
              onClose()
            }}
            onAdd={onAdd}
          />
        </div>

        <button
          type="button"
          onClick={onAdd}
          className="mt-4 inline-flex items-center justify-center gap-2 rounded-xl border border-line bg-white/[0.04] px-4 py-3 text-[13px] font-semibold text-mist transition-all duration-300 hover:-translate-y-0.5 hover:border-arc/45 hover:bg-arc/10 hover:text-white"
        >
          <Plus className="h-4 w-4" /> Add another build
        </button>

        <p className="mt-3 text-center text-[11px] text-fog">Esc to close</p>
      </aside>
    </div>
  )
}
