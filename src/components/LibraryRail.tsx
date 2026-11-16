import { useMemo, useState } from 'react'
import { FolderPlus, HardDrive, Plus, Radio } from 'lucide-react'
import { BuildList } from './BuildList'
import { artKeyFor } from '../lib/art'
import { cx } from '../lib/cx'
import { onlinePlayerCount, type SeasonPlayMode } from '../lib/playMode'
import type { Build } from '../types'

type LibraryFilter = 'all' | 'installed' | 'active'

interface LibraryRailProps {
  builds: Build[]
  activeId: string | null
  installed: Record<string, boolean>
  sourceKeys?: Set<string>
  sourceSizes?: Record<string, number>
  diskSizes?: Record<string, number>
  activeCounts?: Record<string, number>
  activeKey?: string | null
  playModes: Record<string, SeasonPlayMode>
  onSelect: (id: string) => void
  onAdd: () => void
  onLinkExisting: () => void
  onOpenFolder?: (build: Build) => void
  onRemove?: (build: Build) => void
}

export function LibraryRail({
  builds,
  activeId,
  installed,
  sourceKeys,
  sourceSizes,
  diskSizes,
  activeCounts,
  activeKey,
  playModes,
  onSelect,
  onAdd,
  onLinkExisting,
  onOpenFolder,
  onRemove,
}: LibraryRailProps) {
  const [filter, setFilter] = useState<LibraryFilter>('all')
  const installedBuilds = useMemo(
    () => builds.filter((build) => installed[build.id] === true),
    [builds, installed],
  )
  const activeBuilds = useMemo(
    () =>
      builds.filter((build) => {
        const seasonKey = artKeyFor(build.season)
        const localPresence = seasonKey && activeKey === seasonKey ? 1 : 0
        const activeNow = Math.max(0, (seasonKey ? activeCounts?.[seasonKey] ?? 0 : 0) - localPresence)
        return onlinePlayerCount(playModes[build.id], activeNow) > 0
      }),
    [activeCounts, activeKey, builds, playModes],
  )
  const visibleBuilds =
    filter === 'installed' ? installedBuilds : filter === 'active' ? activeBuilds : builds

  const tabClass = (selected: boolean, activeTone = false) =>
    cx(
      'flex min-h-[42px] flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1.5 text-[9px] font-semibold uppercase leading-[1.15] tracking-[0.035em] transition-colors duration-200',
      selected
        ? activeTone
          ? 'bg-emerald-400/15 text-emerald-200'
          : 'bg-white/[0.09] text-white'
        : 'text-fog hover:bg-white/[0.04] hover:text-mist',
    )

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

      <div
        role="group"
        aria-label="Library filter"
        className="mt-3 grid grid-cols-3 gap-1 rounded-xl border border-line/70 bg-black/20 p-1"
      >
        <button
          type="button"
          aria-pressed={filter === 'all'}
          aria-label={`All Seasons (${builds.length})`}
          onClick={() => setFilter('all')}
          className={tabClass(filter === 'all')}
        >
          <span>All Seasons</span>
          <span className="font-mono text-[8.5px] opacity-70">({builds.length})</span>
        </button>
        <button
          type="button"
          aria-pressed={filter === 'installed'}
          aria-label={`Installed (${installedBuilds.length})`}
          onClick={() => setFilter('installed')}
          className={tabClass(filter === 'installed')}
        >
          <span className="flex items-center gap-1">
            <HardDrive className="h-2.5 w-2.5" />
            Installed
          </span>
          <span className="font-mono text-[8.5px] opacity-70">({installedBuilds.length})</span>
        </button>
        <button
          type="button"
          aria-pressed={filter === 'active'}
          onClick={() => setFilter('active')}
          className={tabClass(filter === 'active', true)}
        >
          {activeBuilds.length > 0 && (
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_7px_rgba(52,211,153,0.9)]" />
          )}
          <span className="flex flex-col">
            <span>Active Players</span>
            <span>Now</span>
          </span>
        </button>
      </div>

      {filter === 'installed' && installedBuilds.length > 0 && (
        <button
          type="button"
          onClick={onLinkExisting}
          className="mt-2 inline-flex items-center justify-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-400/[0.07] px-3 py-2 text-[10.5px] font-semibold text-emerald-200 transition-colors duration-200 hover:border-emerald-400/60 hover:bg-emerald-400/15 hover:text-white"
        >
          <FolderPlus className="h-3.5 w-3.5" />
          Link Existing Folder
        </button>
      )}

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1">
        {filter === 'installed' && visibleBuilds.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-line px-4 py-8 text-center">
            <HardDrive className="mx-auto h-5 w-5 text-emerald-300/80" />
            <p className="mt-3 text-[13px] font-medium text-mist">No installed seasons yet</p>
            <p className="mt-1 text-[12px] leading-relaxed text-fog">
              Download a season or point VAULTED at a folder you already have. No re-download needed.
            </p>
            <button
              type="button"
              onClick={onLinkExisting}
              className="mt-4 inline-flex items-center gap-2 rounded-lg bg-white px-3.5 py-2 text-[12px] font-semibold text-void transition-transform duration-300 hover:-translate-y-0.5"
            >
              <FolderPlus className="h-3.5 w-3.5" />
              Link Existing Folder
            </button>
          </div>
        ) : filter === 'active' && visibleBuilds.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-line px-4 py-10 text-center">
            <Radio className="mx-auto h-5 w-5 text-emerald-300/80" />
            <p className="mt-3 text-[13px] font-medium text-mist">No active players right now</p>
            <p className="mt-1 text-[12px] leading-relaxed text-fog">
              Every season still supports online play. Switch back to all seasons to pick one and host a lobby.
            </p>
            <button
              type="button"
              onClick={() => setFilter('all')}
              className="mt-4 rounded-lg border border-line bg-white/[0.04] px-3.5 py-2 text-[12px] font-semibold text-mist transition-colors duration-200 hover:border-arc/45 hover:bg-arc/10 hover:text-white"
            >
              Show all seasons
            </button>
          </div>
        ) : (
          <BuildList
            builds={visibleBuilds}
            activeId={activeId}
            installed={installed}
            sourceKeys={sourceKeys}
            sourceSizes={sourceSizes}
            diskSizes={diskSizes}
            activeCounts={activeCounts}
            activeKey={activeKey}
            playModes={playModes}
            onSelect={onSelect}
            onAdd={onAdd}
            onOpenFolder={onOpenFolder}
            onRemove={onRemove}
          />
        )}
      </div>

      <footer className="mt-4 rounded-xl border border-line/70 bg-black/20 px-3 py-2.5 text-[10.5px] leading-relaxed text-fog">
        <p className="flex items-start gap-2">
          <HardDrive className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Every chapter and season. <span className="text-emerald-300">Installed</span> = on this PC and ready to
            play. <span className="text-emerald-300">ONLINE READY</span> = Play joins the healthiest public server
            through the bundled runtime, or hosts locally if none are up.
          </span>
        </p>
      </footer>
    </aside>
  )
}
