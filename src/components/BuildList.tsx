import { Fragment } from 'react'
import { Check, FolderOpen, FolderPlus, HardDrive, MessageCircle, Trash2 } from 'lucide-react'
import { artKeyFor, seasonImageFor } from '../lib/art'
import { cx } from '../lib/cx'
import { formatDownloadSize, formatEtaMinutes } from '../lib/downloadSize'
import {
  DEFAULT_PLAY_MODE,
  ONLINE_UNAVAILABLE_MESSAGE,
  onlineIsPlayable,
  onlineIsUnavailable,
  onlinePlayerCount,
  seasonStatusLabel,
  type SeasonPlayMode,
} from '../lib/playMode'
import type { Build, DownloadState } from '../types'

interface BuildListProps {
  builds: Build[]
  activeId: string | null
  /** buildId -> present on disk (undefined while unknown) */
  installed?: Record<string, boolean>
  /** season keys that have a download source in the manifest */
  sourceKeys?: Set<string>
  /** season key -> archive size in bytes */
  sourceSizes?: Record<string, number>
  /** install path -> detected bytes on disk */
  diskSizes?: Record<string, number>
  /** real VAULTED presence heartbeats, by season key */
  activeCounts?: Record<string, number>
  activeKey?: string | null
  /** build id -> shared live online status */
  playModes: Record<string, SeasonPlayMode>
  /** build id -> active or paused download progress */
  downloads?: Record<string, DownloadState>
  onSelect: (id: string) => void
  onAdd: () => void
  onOpenFolder?: (build: Build) => void
  onRemove?: (build: Build) => void
}

export function BuildList({
  builds,
  activeId,
  installed,
  sourceKeys,
  sourceSizes,
  diskSizes,
  playModes,
  downloads,
  onSelect,
  onAdd,
  onOpenFolder,
  onRemove,
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
    <div className="space-y-1.5 2xl:space-y-2 3xl:space-y-2.5">
      {builds.map((build, index) => {
        const active = build.id === activeId
        const art = seasonImageFor(build.season)
        const sourceKey = artKeyFor(build.season)
        const playMode = playModes[build.id] ?? DEFAULT_PLAY_MODE
        // Real-time total across every live server for this season; no local
        // presence heartbeat and no synthetic player placeholder.
        const onlinePlayers = onlinePlayerCount(playMode)
        const download = downloads?.[build.id]
        const downloadPercent =
          typeof download?.percent === 'number'
            ? Math.max(0, Math.min(100, Math.floor(download.percent)))
            : null
        const downloadEta =
          download?.phase === 'downloading' ? formatEtaMinutes(download.etaSeconds) : null
        const downloadLabel = download
          ? download.phase === 'downloading'
            ? [`Downloading${downloadPercent !== null ? ` ${downloadPercent}%` : ''}`, downloadEta]
                .filter(Boolean)
                .join(' · ')
            : download.phase === 'paused'
              ? `Paused${downloadPercent !== null ? ` · ${downloadPercent}%` : ''}`
              : download.phase === 'runtime'
                ? 'Preparing runtime…'
                : download.phase === 'extracting'
                  ? 'Unpacking…'
                  : download.phase === 'verifying'
                    ? 'Verifying…'
                    : null
          : null
        // ONLINE and launcher-backed LAUNCHER are green routes. A Discord
        // invite alone is not a live route: ONLINE UNAVAILABLE stays red.
        const isLive =
          playMode.online === true ||
          playMode.globalOnline === true ||
          playMode.externalAvailable === true
        const isChecking =
          !isLive && playMode.availability === 'global' && playMode.globalOffline !== true
        const isUnavailable = onlineIsUnavailable(playMode)
        const onlineStatus = seasonStatusLabel(playMode)
        const chapterChanged = index === 0 || builds[index - 1].season.chapter !== build.season.chapter
        const hasSource = Boolean(sourceKey && sourceKeys?.has(sourceKey))
        const sizeLabel = sourceKey && sourceSizes?.[sourceKey] ? formatDownloadSize(sourceSizes[sourceKey]) : null
        const installedNow = installed?.[build.id] === true
        const diskSize = build.path ? diskSizes?.[build.path] : undefined
        const playModeTitle = onlineStatus
        const discordGate = (build.discordGates ?? [])[0]

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
                className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl p-2 text-left 2xl:gap-3.5 2xl:p-2.5 3xl:gap-4 3xl:p-3"
              >
                <span
                  className="relative grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-xl border border-white/10 2xl:h-14 2xl:w-14 3xl:h-16 3xl:w-16"
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
                    <span className="truncate text-[13px] font-semibold text-mist 2xl:text-[14px] 3xl:text-[15.5px]">{build.season.label}</span>
                    {active && <Check className="h-3.5 w-3.5 shrink-0 text-arc" />}
                    {installedNow && (
                      <span
                        title="Installed on this PC — ready to play"
                        className="shrink-0 rounded border border-emerald-400/35 bg-emerald-400/12 px-1 py-px text-[8.5px] font-bold uppercase tracking-[0.06em] text-emerald-200"
                      >
                        Installed
                      </span>
                    )}
                    {!build.placeholder && installed?.[build.id] === false && (
                      <span
                        title="Not downloaded on this PC"
                        className="shrink-0 rounded bg-amber-400/10 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-amber-300"
                      >
                        missing
                      </span>
                    )}
                    {!installed?.[build.id] &&
                      (hasSource ? (
                        <span
                          title={
                            isLive
                              ? sizeLabel
                                ? `${sizeLabel} download`
                                : 'Download available for this season'
                              : 'Download unlocks when this season has a live online server'
                          }
                          className={cx(
                            'shrink-0 rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide',
                            isLive
                              ? 'bg-emerald-400/10 text-emerald-300'
                              : 'bg-white/5 text-fog/70',
                          )}
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
                        'inline-flex min-w-0 max-w-full flex-wrap items-center gap-1 rounded-md border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.06em]',
                        isLive
                          ? 'border-emerald-300/45 bg-emerald-400/20 text-emerald-200 shadow-[0_0_16px_rgba(16,185,129,0.18)]'
                          : isChecking
                            ? 'border-amber-400/35 bg-amber-400/[0.08] text-amber-200/90'
                            : 'border-rose-400/25 bg-rose-500/[0.08] text-rose-200/80',
                      )}
                    >
                      <span
                        className={cx(
                          'h-1.5 w-1.5 rounded-full',
                          isLive
                            ? 'bg-emerald-400 shadow-[0_0_7px_rgba(52,211,153,0.9)]'
                            : isChecking
                              ? 'bg-amber-300'
                              : 'bg-rose-400/80',
                          isLive && onlinePlayers > 0 && 'animate-pulse',
                        )}
                      />
                      {onlineStatus}
                    </span>
                    {discordGate && onlineIsPlayable(playMode) && (
                      <span
                        title={
                          discordGate.statusOnly
                            ? `${discordGate.label}: official community status`
                            : `${discordGate.label}: join the community Discord to unlock online play`
                        }
                        aria-label={
                          discordGate.statusOnly
                            ? `${discordGate.label}: official community status`
                            : `${discordGate.label} gate: online play unlocks through Discord`
                        }
                        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[#5865F2]/45 bg-[#5865F2]/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.06em] text-[#c7ccff]"
                      >
                        <MessageCircle className="h-2.5 w-2.5" />
                        ONLINE · DISCORD
                      </span>
                    )}
                    <span
                      className={cx(
                        'min-w-0 truncate font-mono text-[11px] 2xl:text-[12px] 3xl:text-[13px]',
                        downloadLabel ? 'font-semibold text-amber-200' : 'text-fog',
                      )}
                      title={downloadLabel || build.path || 'Not downloaded'}
                    >
                      {downloadLabel ?? (installed?.[build.id] ? 'Installed' : 'Not downloaded')}
                      {!downloadLabel && !build.onlineProvider && !installed?.[build.id] && hasSource && ` · ${sizeLabel ?? 'size unavailable'}`}
                    </span>
                  </span>
                  {isUnavailable && (
                    <span
                      className="mt-1 block text-[9.5px] leading-snug text-amber-200/75"
                      title={ONLINE_UNAVAILABLE_MESSAGE}
                    >
                      {ONLINE_UNAVAILABLE_MESSAGE}
                    </span>
                  )}
                  {installedNow && build.path && (
                    <span className="mt-1 flex min-w-0 items-center gap-1 text-[9px] text-fog" title={build.path}>
                      <HardDrive className="h-2.5 w-2.5 shrink-0" />
                      <span className="shrink-0 font-mono text-mist/75">
                        {diskSize !== undefined ? formatDownloadSize(diskSize) : 'calculating size…'}
                      </span>
                      <span className="text-fog/40">·</span>
                      <span className="truncate font-mono">{build.path}</span>
                    </span>
                  )}
                </span>
              </button>
              {installedNow && (onOpenFolder || onRemove) && (
                <span className="pointer-events-none absolute right-1.5 top-1.5 z-10 flex items-center gap-0.5 rounded-lg border border-white/10 bg-ink/95 p-0.5 opacity-0 shadow-lg transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
                  {onOpenFolder && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        onOpenFolder(build)
                      }}
                      aria-label={`Open ${build.season.label} install folder`}
                      title="Open install folder"
                      className="grid h-5 w-5 place-items-center rounded-md text-fog transition-colors hover:bg-white/10 hover:text-white"
                    >
                      <FolderOpen className="h-3 w-3" />
                    </button>
                  )}
                  {onRemove && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        onRemove(build)
                      }}
                      aria-label={`Remove ${build.season.label}`}
                      title="Remove / uninstall build"
                      className="grid h-5 w-5 place-items-center rounded-md text-fog transition-colors hover:bg-rose-500/20 hover:text-rose-200"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </span>
              )}
            </div>
          </Fragment>
        )
      })}
    </div>
  )
}
