import { HardDrive, Plus } from 'lucide-react'
import { BuildList } from './BuildList'
import type { SeasonPlayMode } from '../lib/playMode'
import type { Build } from '../types'

interface LibraryRailProps {
  builds: Build[]
  activeId: string | null
  installed: Record<string, boolean>
  sourceKeys?: Set<string>
  sourceSizes?: Record<string, number>
  activeCounts?: Record<string, number>
  activeKey?: string | null
  playModes: Record<string, SeasonPlayMode>
  onSelect: (id: string) => void
  onAdd: () => void
}

export function LibraryRail({
  builds,
  activeId,
  installed,
  sourceKeys,
  sourceSizes,
  activeCounts,
  activeKey,
  playModes,
  onSelect,
  onAdd,
}: LibraryRailProps) {
  return (
    <aside className="flex h-full flex-col rounded-3xl border border-line bg-panel/60 p-4 backdrop-blur-sm">
      <header className="flex items-center justify-between gap-2 px-1">
        <div className="flex items-center gap-2">
          <h2 className="font-display text-[13px] font-semibold uppercase tracking-[0.16em] text-mist">Library</h2>
          <span className="rounded-md border border-line bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-fog">
            {builds.length}
          </span>
        </div>
        <button
          type="button"
          onClick={onAdd}
          aria-label="Add build"
          className="grid h-8 w-8 place-items-center rounded-xl border border-line bg-white/[0.03] text-fog transition-all duration-300 hover:border-arc/50 hover:bg-arc/10 hover:text-white"
        >
          <Plus className="h-4 w-4" />
        </button>
      </header>

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1">
        <BuildList
          builds={builds}
          activeId={activeId}
          installed={installed}
          sourceKeys={sourceKeys}
          sourceSizes={sourceSizes}
          activeCounts={activeCounts}
          activeKey={activeKey}
          playModes={playModes}
          onSelect={onSelect}
          onAdd={onAdd}
        />
      </div>

      <footer className="mt-4 rounded-xl border border-line/70 bg-black/20 px-3 py-2.5 text-[10.5px] leading-relaxed text-fog">
        <p className="flex items-start gap-2">
          <HardDrive className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>Every chapter and season. <span className="text-emerald-300">ONLINE PLAY</span> = a community provider is pre-mapped, and Play opens it automatically. <span className="text-mist">LOCAL PLAY</span> = Play starts a match on this PC.</span>
        </p>
      </footer>
    </aside>
  )
}
