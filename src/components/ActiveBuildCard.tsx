import {
  ArrowLeftRight,
  Ban,
  Check,
  Download,
  FolderPlus,
  Globe,
  Loader2,
  Play,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  X,
} from 'lucide-react'
import { AccountChip } from './AccountChip'
import { BuildArt } from './BuildArt'
import { artKeyFor } from '../lib/art'
import { cx } from '../lib/cx'
import type { Account, Build, BuildState, DownloadState } from '../types'

interface ActiveBuildCardProps {
  build: Build | null
  state: BuildState
  download: DownloadState | null
  /** players with this season open right now (null while unknown) */
  activeNow?: number | null
  account: Account
  sourceKeys?: Set<string>
  servers?: Array<{ name: string; url: string }>
  onLogout: () => void
  onPrimary: () => void
  onCancelDownload: () => void
  onChangeBuild: () => void
  onAddBuild: () => void
}

const STATE_PILL: Record<BuildState, { label: string; dot: string; text: string }> = {
  missing: { label: 'Not installed', dot: 'bg-amber-400', text: 'text-amber-300' },
  downloading: { label: 'Downloading', dot: 'bg-emerald-400', text: 'text-emerald-300' },
  ready: { label: 'Ready', dot: 'bg-emerald-400', text: 'text-emerald-300' },
  launching: { label: 'Launching', dot: 'bg-amber-400', text: 'text-amber-300' },
  running: { label: 'Running', dot: 'bg-rose-400', text: 'text-rose-300' },
  error: { label: 'Failed', dot: 'bg-rose-400', text: 'text-rose-300' },
}

export function ActiveBuildCard({
  build,
  state,
  download,
  activeNow,
  account,
  sourceKeys,
  servers,
  onLogout,
  onPrimary,
  onCancelDownload,
  onChangeBuild,
  onAddBuild,
}: ActiveBuildCardProps) {
  if (!build) {
    return (
      <section className="relative flex min-h-[460px] flex-col items-center justify-center overflow-hidden rounded-3xl border border-dashed border-line bg-panel/50 px-8 py-16 text-center">
        <div className="absolute inset-0 opacity-40 grain" aria-hidden />
        <span className="grid h-14 w-14 place-items-center rounded-2xl border border-line bg-panel-hi text-fog">
          <FolderPlus className="h-6 w-6" />
        </span>
        <h2 className="mt-5 font-display text-2xl font-semibold tracking-tight text-mist">No build selected</h2>
        <p className="mt-2 max-w-sm text-sm leading-relaxed text-fog">
          Drop in a downloaded build folder — like <span className="font-mono text-mist/90">3.6-CL-15538114</span> — and
          VAULTED works out the chapter and season for you.
        </p>
        <button
          type="button"
          onClick={onAddBuild}
          className="mt-6 inline-flex items-center gap-2 rounded-xl bg-white px-5 py-2.5 text-sm font-semibold text-void transition-transform duration-300 hover:-translate-y-0.5 hover:bg-mist active:translate-y-0"
        >
          <FolderPlus className="h-4 w-4" /> Add your first build
        </button>
      </section>
    )
  }

  const { season } = build
  const pill = STATE_PILL[state]
  const busy = state === 'launching' || state === 'downloading'

  const hasDownloadSource = Boolean(artKeyFor(season) && sourceKeys?.has(artKeyFor(season)!))

  const primary = {
    missing: hasDownloadSource
      ? {
          label: `Download ${season.label}`,
          icon: Download,
          background: 'linear-gradient(120deg, #34d399, #059669)',
          glow: 'rgba(16,185,129,0.55)',
        }
      : {
          label: 'No download available',
          icon: Ban,
          background: 'linear-gradient(120deg, #64748b, #334155)',
          glow: 'rgba(100,116,139,0.45)',
        },
    downloading: {
      label: download?.percent != null ? `Downloading… ${download.percent}%` : 'Downloading…',
      icon: Loader2,
      background: 'linear-gradient(120deg, #10b981, #047857)',
      glow: 'rgba(16,185,129,0.45)',
    },
    ready: {
      label: 'Play',
      icon: Play,
      background: 'linear-gradient(120deg, #7c8cff, #a855f7)',
      glow: 'rgba(124,140,255,0.6)',
    },
    launching: {
      label: 'Starting…',
      icon: Loader2,
      background: 'linear-gradient(120deg, #7c8cff, #a855f7)',
      glow: 'rgba(124,140,255,0.45)',
    },
    running: {
      label: 'Close',
      icon: X,
      background: 'linear-gradient(120deg, #f43f5e, #b91c1c)',
      glow: 'rgba(244,63,94,0.55)',
    },
    error: {
      label: 'Try again',
      icon: TriangleAlert,
      background: 'linear-gradient(120deg, #fbbf24, #d97706)',
      glow: 'rgba(251,191,36,0.45)',
    },
  }[state]

  const PrimaryIcon = primary.icon

  const statusText: Record<BuildState, string> = {
    missing: hasDownloadSource
      ? 'Not on this PC yet — download it to play.'
      : 'Not on this PC, and no download source for this season.',
    downloading: download?.phase === 'extracting' ? 'Unpacking the build…' : 'Downloading the build…',
    ready: 'Ready when you are — client installed.',
    launching: 'Fortnite is starting. Have fun.',
    running: 'Fortnite is running. Have fun.',
    error: 'Could not start the client. Check the build path and try again.',
  }

  return (
    <section className="relative isolate flex h-full flex-col overflow-hidden rounded-3xl border border-line bg-panel shadow-[0_30px_80px_-40px_rgba(0,0,0,0.9)]">
      <BuildArt season={season} />

      <div className="relative flex min-h-[460px] flex-1 flex-col p-6 sm:p-8 xl:min-h-[540px] xl:p-10">
        {/* top row */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/35 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-mist/90 backdrop-blur">
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: season.accent.glow, boxShadow: `0 0 12px ${season.accent.glow}` }}
            />
            {season.short}
          </span>

          <div className="flex flex-wrap items-center gap-2">
            {activeNow != null && activeNow > 0 && (
              <span
                title="Players with this season open right now"
                className="inline-flex items-center gap-2 rounded-full border border-emerald-400/25 bg-emerald-400/[0.08] px-3 py-1.5 text-[11px] font-medium text-emerald-200 backdrop-blur"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.9)]" />
                {activeNow} playing now
              </span>
            )}
            <span onClick={(event) => event.stopPropagation()}>
              <AccountChip account={account} onLogout={onLogout} />
            </span>
            <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/35 px-3 py-1.5 text-[11px] font-medium text-mist/90 backdrop-blur">
              <span className={cx('h-1.5 w-1.5 rounded-full', pill.dot, busy && 'animate-pulse')} />
              {pill.label}
            </span>
          </div>
        </div>

        {/* headline */}
        <div className="mt-8 sm:mt-10">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-fog">Fortnite</p>
          <h1 className="mt-2 font-display text-[2.6rem] font-bold leading-[1.02] tracking-[-0.03em] text-white sm:text-6xl xl:text-7xl">
            {season.label}
          </h1>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-mist/70">
            {season.era}
            {build.version && (
              <>
                <span className="mx-1.5 text-fog/40">·</span>
                <span className="font-mono text-[13px] text-mist/90">v{build.version}</span>
              </>
            )}
          </p>
        </div>

        {/* bottom: progress, status, action dock */}
        <div className="relative mt-auto pt-6">
          {download && (
            <div className="mb-3">
              <div className="h-2.5 w-full overflow-hidden rounded-full border border-white/[0.06] bg-black/50">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-emerald-300 shadow-[0_0_18px_rgba(52,211,153,0.65)] transition-[width] duration-300 ease-out"
                  style={{ width: `${download.percent ?? 18}%` }}
                />
              </div>
              <div className="mt-1.5 flex items-center justify-between text-[11px]">
                <span className="text-fog">
                  {download.phase === 'extracting' ? 'Unpacking archive…' : 'Downloading build…'}
                </span>
                <span className="font-mono font-semibold text-emerald-300">
                  {download.percent != null ? `${download.percent}%` : '…'}
                </span>
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 text-[12.5px]">
            {state === 'error' ? (
              <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-rose-300" />
            ) : busy ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-300" />
            ) : state === 'running' ? (
              <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-300" />
            ) : state === 'missing' ? (
              <Download className="h-3.5 w-3.5 shrink-0 text-amber-300" />
            ) : (
              <Check className="h-3.5 w-3.5 shrink-0 text-emerald-300" />
            )}
            <p className={cx('transition-colors duration-300', pill.text)}>{statusText[state]}</p>
          </div>

          {/* actions are always on screen — no click-to-reveal */}
          <div className="mt-4">
            <div className="rounded-2xl border border-white/10 bg-ink/90 p-2 shadow-[0_36px_70px_-22px_rgba(0,0,0,0.95),0_10px_26px_-12px_rgba(0,0,0,0.85),inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-xl">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      if (!busy && !(state === 'missing' && !hasDownloadSource)) onPrimary()
                    }}
                    disabled={busy || (state === 'missing' && !hasDownloadSource)}
                    className={cx(
                      'group relative inline-flex items-center gap-2.5 overflow-hidden rounded-xl px-5 py-3 text-[13.5px] font-semibold text-white transition-all duration-300',
                      busy
                        ? 'cursor-progress opacity-85'
                        : 'hover:-translate-y-0.5 hover:brightness-110 active:translate-y-0 active:scale-[0.99]',
                    )}
                    style={{
                      background: primary.background,
                      boxShadow: busy ? undefined : `0 14px 34px -16px ${primary.glow}`,
                    }}
                  >
                    <span className="absolute inset-0 -translate-x-[120%] bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-700 group-hover:translate-x-[120%]" />
                    <PrimaryIcon className={cx('h-4 w-4', busy && 'animate-spin')} />
                    <span className="relative">{primary.label}</span>
                  </button>

                  {state === 'downloading' && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        onCancelDownload()
                      }}
                      className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-3 text-[12.5px] font-medium text-fog transition-colors duration-200 hover:border-rose-400/40 hover:bg-rose-500/10 hover:text-rose-200"
                    >
                      <Ban className="h-3.5 w-3.5" /> Cancel
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      onChangeBuild()
                    }}
                    className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-3 text-[12.5px] font-medium text-mist transition-colors duration-200 hover:border-arc/40 hover:bg-white/[0.08] hover:text-white"
                  >
                    <ArrowLeftRight className="h-3.5 w-3.5" /> Change build
                  </button>

                  {servers && servers.length > 0 && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        const url = servers[0].url
                        if (window.arc?.openExternal) window.arc.openExternal(url)
                        else window.open(url, '_blank')
                      }}
                      className="inline-flex items-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-400/[0.08] px-3.5 py-3 text-[12.5px] font-medium text-emerald-200 transition-colors duration-200 hover:bg-emerald-400/15 hover:text-white"
                    >
                      <Globe className="h-3.5 w-3.5" /> Play online
                    </button>
                  )}

                  <span className="ml-auto hidden items-center gap-1 pr-2 text-[10.5px] text-fog/70 sm:flex">
                    <Sparkles className="h-3 w-3 text-amber-300/70" />
                    {account.outfit}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
    </section>
  )
}
