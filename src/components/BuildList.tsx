import { Fragment } from 'react'
import { Check, FolderPlus } from 'lucide-react'
import { artKeyFor, seasonImageFor } from '../lib/art'
import { cx } from '../lib/cx'
import { formatDownloadSize } from '../lib/downloadSize'
import { LOCAL_PLAY_MODE, type SeasonPlayMode } from '../lib/playMode'
import type { Build } from '../types'

interface BuildListProps {
  builds: Build[]
  activeId: string | null
  /** buildId -> present on disk (undefined while unknown) */
  installed?: Record<string, boolean>
  /** season keys that have a download source in the manifest */
  sourceKeys?: Set<string>
  /** season key -> archive size in bytes */
  sourceSizes?: Record<string, number>
  /** real VAULTED presence heartbeats, by season key */
  activeCounts?: Record<string, number>
  activeKey?: string | null
  /** build id -> shared live ONLINE PLAY / LOCAL PLAY status */
  playModes: Record<string, SeasonPlayMode>
  onSelect: (id: string) => void
  onAdd: () => void
}

export function BuildList({
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
}: BuildListProps) {
  if (builds.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-line px-4 py-10 text-center">
        <FolderPlus className="mx-auto h-5 w-5 text-fog" />
        <p className="mt-3 text-[13px] font-medium text-mist">Your library is empty</p>
        <p className="mt-1 text-[12px] leading-relaxed text-fog">Add a build folder to get started.</p>
        <button
          type="button"
          onClick={onAdd}
          className="mt-4 rounded-lg bg-white px-3.5 py-2 text-[12px] font-semibold text-void transition-transform duration-300 hover:-translate-y-0.5"
        >
          Add build
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      {builds.map((build, index) => {
        const active = build.id === activeId
        const art = seasonImageFor(build.season)
        const sourceKey = artKeyFor(build.season)
        const playMode = playModes[build.id] ?? LOCAL_PLAY_MODE
        const onlineProviderLabel = playMode.providerLabel
        const playingCount = Math.max(
          0,
          (sourceKey ? activeCounts?.[sourceKey] ?? 0 : 0) - (activeKey && activeKey === sourceKey ? 1 : 0),
        )
        const chapterChanged = index === 0 || builds[index - 1].season.chapter !== build.season.chapter
        const hasSource = Boolean(sourceKey && sourceKeys?.has(sourceKey))
        const sizeLabel = sourceKey && sourceSizes?.[sourceKey] ? formatDownloadSize(sourceSizes[sourceKey]) : null
        const playModeTitle = onlineProviderLabel
          ? `${onlineProviderLabel} hosts this season — Play opens it automatically.${playMode.lobbyCount > 0 ? ` ${playMode.lobbyCount} VAULTED ${playMode.lobbyCount === 1 ? 'lobby' : 'lobbies'} also listed.` : ''}`
          : playMode.online
            ? `${playMode.lobbyCount} live public VAULTED ${playMode.lobbyCount === 1 ? 'lobby' : 'lobbies'} · ${playMode.playerCount} player${playMode.playerCount === 1 ? '' : 's'} — Play joins one automatically.`
            : playingCount
            ? `${playingCount} other VAULTED player${playingCount === 1 ? '' : 's'} active here, but no public lobby is live. Play starts a match on this PC.`
            : 'No public lobby is live for this season. Play starts a match on this PC.'

        return (
          <Fragment key={build.id}>
            {chapterChanged && (
              <div className="flex items-center gap-2 px-1 pb-1 pt-3 first:pt-0">
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fog/70">
                  {build.season.known ? `Chapter ${build.season.chapter}` : 'Unmapped'}
                </span>
                <span className="h-px flex-1 bg-line/50" />
              </div>
            )}

            <div
              className={cx(
                'group relative flex items-center gap-1 rounded-2xl border transition-colors duration-200',
                active
                  ? 'border-arc/45 bg-panel-hi shadow-[0_10px_30px_-18px_rgba(124,140,255,0.8)]'
                  : 'border-transparent hover:border-line hover:bg-white/[0.03]',
              )}
            >
              <button
                type="button"
                onClick={() => onSelect(build.id)}
                aria-current={active ? 'true' : undefined}
                className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl p-2 text-left"
              >
                <span
                  className="relative grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-xl border border-white/10"
                  style={{
                    background: `linear-gradient(135deg, ${build.season.accent.from}40, ${build.season.accent.to}26)`,
                  }}
                >
                  {art ? (
                    <img src={art} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" />
                  ) : (
                    <span className="absolute inset-0 opacity-30 grain" aria-hidden />
                  )}
                  <span className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/10 to-transparent" />
                  {build.version && (
                    <span className="relative rounded bg-black/75 px-1 py-px font-mono text-[9px] font-semibold leading-tight text-white">
                      {build.version}
                    </span>
                  )}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-semibold text-mist">{build.season.label}</span>
                    {active && <Check className="h-3.5 w-3.5 shrink-0 text-arc" />}
                    {!build.placeholder && installed?.[build.id] === false && !build.onlineProvider && (
                      <span
                        title="Not downloaded on this PC"
                        className="shrink-0 rounded bg-amber-400/10 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-amber-300"
                      >
                        missing
                      </span>
                    )}
                    {!installed?.[build.id] && !build.onlineProvider &&
                      (hasSource ? (
                        <span
                          title={sizeLabel ? `${sizeLabel} download` : 'Download available for this season'}
                          className="shrink-0 rounded bg-emerald-400/10 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-emerald-300"
                        >
                          {sizeLabel ?? 'downloadable'}
                        </span>
                      ) : (
                        <span
                          title="No download source for this season"
                          className="shrink-0 rounded bg-white/5 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-fog/70"
                        >
                          no download
                        </span>
                      ))}
                  </span>
                  <span className="mt-1 flex min-w-0 items-center gap-1.5">
                    <span
                      title={playModeTitle}
                      aria-label={playModeTitle}
                      className={cx(
                        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.06em]',
                        playMode.online
                          ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
                          : 'border-slate-400/15 bg-slate-400/[0.06] text-slate-400',
                      )}
                    >
                      <span
                        className={cx(
                          'h-1.5 w-1.5 rounded-full',
                          playMode.online
                            ? 'bg-emerald-400 shadow-[0_0_7px_rgba(52,211,153,0.9)]'
                            : 'bg-slate-500',
                        )}
                      />
                      {playMode.label}
                      {playMode.online && onlineProviderLabel && (
                        <span className="text-emerald-200/80">· {onlineProviderLabel}</span>
                      )}
                      {playMode.online && playMode.playerCount > 0 && (
                        <span className="text-emerald-200/80">
                          · {playMode.playerCount} {playMode.playerCount === 1 ? 'player' : 'players'}
                        </span>
                      )}
                    </span>
                    <span className="min-w-0 truncate font-mono text-[11px] text-fog" title={build.path || 'Not downloaded'}>
                      {build.onlineProvider
                        ? `via ${build.onlineProvider.label || build.onlineProvider.name}`
                        : build.folderName}
                      {!build.onlineProvider && !installed?.[build.id] && hasSource && ` · ${sizeLabel ?? 'size unavailable'}`}
                    </span>
                  </span>
                </span>
              </button>
            </div>
          </Fragment>
        )
      })}
    </div>
  )
}
