import { useEffect, useState } from 'react'
import {
  Globe,
  ArrowLeft,
  ArrowLeftRight,
  CloudDownload,
  FolderSearch,
  HardDrive,
  Info,
  Loader2,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react'
import { cx } from '../lib/cx'
import { artFor } from '../lib/art'
import { manifestUrl, type BuildManifest } from '../lib/network'
import type { Build } from '../types'

interface SettingsViewProps {
  build: Build | null
  installed: boolean
  onBack: () => void
  onBrowseFolder: () => void
  onScanBuilds: () => void
  scanning: boolean
  onOpenLibrary: () => void
  accountName: string
  manifest: BuildManifest | null
  sourcesStatus: 'idle' | 'loading' | 'ready' | 'error'
  sourcesError: string | null
  onRefreshSources: () => void
  appVersion: string
  updateState: { state: 'idle' | 'checking' | 'current' | 'available' | 'error'; message?: string; url?: string }
  updateReady?: boolean
  onCheckUpdates: () => void
  onRestartToUpdate?: () => void
}

export function SettingsView({
  build,
  installed,
  onBack,
  onBrowseFolder,
  onScanBuilds,
  scanning,
  onOpenLibrary,
  accountName,
  manifest,
  sourcesStatus,
  sourcesError,
  onRefreshSources,
  appVersion,
  updateState,
  updateReady,
  onCheckUpdates,
  onRestartToUpdate,
}: SettingsViewProps) {
  const art = build ? artFor(build.season) : null
  const [publicAddress, setPublicAddress] = useState('')
  const [publicNote, setPublicNote] = useState<string | null>(null)

  useEffect(() => {
    void window.arc?.getPublicAddress?.()
      .then((value) => setPublicAddress(value || ''))
      .catch(() => {})
  }, [])

  const savePublicAddress = async () => {
    const result = await window.arc?.setPublicAddress?.(publicAddress)
    if (!result) return
    if (!result.ok) {
      setPublicNote(result.error || 'Could not save that address.')
      return
    }
    setPublicAddress(result.value ?? '')
    setPublicNote(
      result.value
        ? `Lobbies will publish ${result.value}. Forward TCP and UDP 7777 to this PC.`
        : 'Cleared — lobbies use automatic UPnP/NAT-PMP again.',
    )
  }

  return (
    <section className="animate-fade-up rounded-3xl border border-line bg-panel/60 p-5 backdrop-blur-sm sm:p-7">
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-fog">Configuration</p>
          <h1 className="mt-1 font-display text-2xl font-bold tracking-tight text-white">Settings</h1>
          <p className="mt-1.5 max-w-lg text-[12.5px] leading-relaxed text-fog">
            Where VAULTED looks for the selected build, and where downloads are unpacked.
          </p>
        </div>
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-2 rounded-xl border border-line bg-white/[0.03] px-3 py-2 text-[12px] font-medium text-fog transition-colors duration-200 hover:border-line hover:bg-white/[0.07] hover:text-mist"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back
        </button>
      </header>

      {/* build location */}
      <section className="mt-5 overflow-hidden rounded-2xl border border-line bg-black/25">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/70 px-4 py-3">
          <h2 className="text-[12px] font-semibold uppercase tracking-[0.14em] text-mist">Build location</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onScanBuilds}
              disabled={scanning}
              className="inline-flex items-center gap-1.5 rounded-full border border-line bg-white/[0.04] px-2.5 py-1 text-[10.5px] font-semibold text-mist transition-colors hover:border-arc/45 hover:text-white disabled:opacity-60"
            >
              <FolderSearch className={cx('h-3 w-3', scanning && 'animate-pulse')} />
              {scanning ? 'Scanning…' : 'Scan this PC'}
            </button>
            {build && (
              <span
                className={cx(
                  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10.5px] font-medium',
                  installed
                    ? 'border-emerald-400/30 bg-emerald-400/[0.07] text-emerald-300'
                  : 'border-amber-400/30 bg-amber-400/[0.07] text-amber-300',
              )}
            >
              {installed ? <ShieldCheck className="h-3 w-3" /> : <TriangleAlert className="h-3 w-3" />}
              {installed ? 'Installed' : 'Not installed'}
            </span>
            )}
          </div>
        </div>

        {build ? (
          <div className="p-4">
            <div className="flex items-center gap-3">
              <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded-xl border border-white/10 bg-panel">
                {art ? (
                  <img src={art} alt="" draggable={false} className="h-full w-full object-cover" />
                ) : (
                  <span
                    className="absolute inset-0"
                    style={{ background: `linear-gradient(135deg, ${build.season.accent.from}, ${build.season.accent.to})` }}
                  />
                )}
              </span>
              <div className="min-w-0">
                <p className="truncate text-[13.5px] font-semibold text-mist">{build.season.label}</p>
                <p className="font-mono text-[11px] text-fog">{build.version ? `v${build.version}` : 'No local build'}</p>
              </div>
            </div>

            <label className="mt-4 block">
              <span className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-fog">Build folder</span>
              <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
                <code className="min-w-0 flex-1 truncate rounded-xl border border-line bg-black/45 px-3.5 py-2.5 font-mono text-[12px] text-mist/90" title={build.path}>
                  {build.path}
                </code>
                <button
                  type="button"
                  onClick={onBrowseFolder}
                  className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border border-arc/40 bg-arc/10 px-3.5 py-2.5 text-[12px] font-semibold text-mist transition-all duration-300 hover:-translate-y-0.5 hover:bg-arc/20 hover:text-white"
                >
                  <FolderSearch className="h-3.5 w-3.5" /> Browse…
                </button>
              </div>
            </label>

            <label className="mt-3 block">
              <span className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-fog">Client executable</span>
              <code className="mt-1.5 block truncate rounded-xl border border-line/70 bg-black/30 px-3.5 py-2.5 font-mono text-[11px] text-fog" title={build.executable}>
                {build.executable}
              </code>
            </label>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={onOpenLibrary}
                className="inline-flex items-center gap-2 rounded-xl border border-line bg-white/[0.03] px-3.5 py-2 text-[12px] font-medium text-mist transition-colors duration-200 hover:border-arc/40 hover:bg-white/[0.07] hover:text-white"
              >
                <ArrowLeftRight className="h-3.5 w-3.5" /> Switch build
              </button>
              <p className="text-[11px] leading-relaxed text-fog">
                VAULTED launches <span className="font-mono text-mist/80">FortniteClient-Win64-Shipping.exe</span> from this folder.
              </p>
            </div>
          </div>
        ) : (
          <div className="p-6 text-center">
            <p className="text-[12.5px] text-fog">No build selected. Add one from the library first.</p>
          </div>
        )}
      </section>

      {/* downloads */}
      <section className="mt-4 rounded-2xl border border-line bg-black/25">
        <h2 className="border-b border-line/70 px-4 py-3 text-[12px] font-semibold uppercase tracking-[0.14em] text-mist">
          Downloads
        </h2>
        <div className="flex items-start gap-3 p-4">
          <HardDrive className="mt-0.5 h-4 w-4 shrink-0 text-fog" />
          <div className="min-w-0">
            <code className="block truncate font-mono text-[11.5px] text-mist/90" title="%APPDATA%\VAULTED Launcher\builds">
              %APPDATA%\VAULTED Launcher\builds
            </code>
            <p className="mt-1 text-[11.5px] leading-relaxed text-fog">
              Season archives are downloaded here, unpacked, and scanned for the client executable.
            </p>
          </div>
        </div>
      </section>

      {/* build sources */}
      <section className="mt-4 rounded-2xl border border-line bg-black/25">
        <div className="flex items-center justify-between gap-2 border-b border-line/70 px-4 py-3">
          <h2 className="text-[12px] font-semibold uppercase tracking-[0.14em] text-mist">Build sources</h2>
          <button
            type="button"
            onClick={onRefreshSources}
            disabled={sourcesStatus === 'loading'}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white/[0.03] px-2.5 py-1.5 text-[11px] font-medium text-mist transition-colors duration-200 hover:border-arc/40 hover:bg-white/[0.08] hover:text-white disabled:cursor-progress disabled:opacity-70"
          >
            <RefreshCw className={cx('h-3 w-3', sourcesStatus === 'loading' && 'animate-spin')} /> Refresh
          </button>
        </div>
        <div className="p-4">
          <p className="text-[12px] leading-relaxed text-mist/85">
            Downloads start straight from the manifest — VAULTED never asks you to paste a link. New seasons added to the
            manifest appear in your library after a refresh.
          </p>
          <code className="mt-2 block truncate rounded-xl border border-line/70 bg-black/30 px-3 py-2 font-mono text-[11px] text-fog" title={manifestUrl()}>
            {manifestUrl()}
          </code>
          <p className="mt-2 text-[11px] leading-relaxed text-fog">
            {sourcesStatus === 'loading'
              ? 'Reading manifest…'
              : manifest
                ? `${Object.keys(manifest.seasons).length} seasons mapped${manifest.updatedAt ? ` · updated ${new Date(manifest.updatedAt).toLocaleDateString()}` : ''}`
                : 'Manifest not loaded yet.'}
          </p>
          {sourcesError && <p className="mt-2 text-[11px] leading-relaxed text-rose-300">{sourcesError}</p>}
        </div>
      </section>

      {/* online hosting */}
      <section className="mt-4 rounded-2xl border border-line bg-black/25">
        <div className="flex items-center justify-between gap-2 border-b border-line/70 px-4 py-3">
          <h2 className="text-[12px] font-semibold uppercase tracking-[0.14em] text-mist">Online hosting</h2>
          <Globe className="h-3.5 w-3.5 text-sky-300" />
        </div>
        <div className="p-4">
          <p className="text-[12px] leading-relaxed text-mist/85">
            When you host, VAULTED opens UDP and TCP 7777 on your router with UPnP/NAT-PMP and lists the lobby for every
            player. If your router has that disabled, forward 7777 to this PC and enter your public address below. A
            playit.gg tunnel address works here too.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              value={publicAddress}
              onChange={(event) => setPublicAddress(event.target.value)}
              placeholder="203.0.113.7:7777 (leave empty for automatic)"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-xl border border-line bg-black/30 px-3 py-2 text-[12.5px] text-mist outline-none transition-colors placeholder:text-fog/60 focus:border-arc/60"
            />
            <button
              type="button"
              onClick={() => void savePublicAddress()}
              className="rounded-xl border border-arc/45 bg-arc/15 px-3.5 py-2 text-[12px] font-semibold text-mist transition-colors hover:bg-arc/25 hover:text-white"
            >
              Save address
            </button>
          </div>
          {publicNote && <p className="mt-2 text-[11.5px] leading-relaxed text-emerald-300">{publicNote}</p>}
          <p className="mt-2 text-[11px] leading-relaxed text-fog">
            Your next hosted lobby shows an <span className="text-emerald-300">Internet</span> badge in Friends → Open
            lobbies once the address is reachable. Without it, friends on the same WiFi can still join.
          </p>
        </div>
      </section>

      {/* updates */}
      <section className="mt-4 rounded-2xl border border-line bg-black/25">
        <div className="flex items-center justify-between gap-2 border-b border-line/70 px-4 py-3">
          <h2 className="text-[12px] font-semibold uppercase tracking-[0.14em] text-mist">App updates</h2>
          <span className="font-mono text-[11px] text-fog">v{appVersion}</span>
        </div>
        <div className="flex items-start gap-3 p-4">
          <CloudDownload className="mt-0.5 h-4 w-4 shrink-0 text-fog" />
          <div className="min-w-0">
            <p className="text-[12px] leading-relaxed text-mist/85">
              VAULTED updates itself in the background — it checks, downloads and restarts into the new version
              automatically. No browser, no download page, nothing to click.
            </p>
            {updateState.message && (
              <p
                className={cx(
                  'mt-2 text-[11.5px] leading-relaxed',
                  updateState.state === 'available'
                    ? 'text-emerald-300'
                    : updateState.state === 'error'
                      ? 'text-rose-300'
                      : 'text-fog',
                )}
              >
                {updateState.message}
              </p>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={onCheckUpdates}
                disabled={updateState.state === 'checking'}
                className="inline-flex items-center gap-2 rounded-xl border border-line bg-white/[0.03] px-3.5 py-2 text-[12px] font-medium text-mist transition-colors duration-200 hover:border-arc/40 hover:bg-white/[0.08] hover:text-white disabled:cursor-progress disabled:opacity-70"
              >
                {updateState.state === 'checking' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                Check for updates
              </button>
              {updateReady && (
                <button
                  type="button"
                  onClick={() => onRestartToUpdate?.()}
                  className="inline-flex items-center gap-2 rounded-xl border border-amber-400/30 bg-amber-400/[0.08] px-3.5 py-2 text-[12px] font-semibold text-amber-200 transition-colors duration-200 hover:bg-amber-400/15 hover:text-white"
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Restart now
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* about */}
      <section className="mt-4 rounded-2xl border border-line bg-black/25">
        <h2 className="border-b border-line/70 px-4 py-3 text-[12px] font-semibold uppercase tracking-[0.14em] text-mist">
          About
        </h2>
        <div className="flex items-start gap-3 p-4">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-fog" />
          <div>
            <p className="text-[12px] text-mist">VAULTED {appVersion} — Fortnite Build Launcher</p>
            <p className="mt-0.5 text-[11px] text-fog">Signed in as {accountName}</p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-fog">
              Every chapter and season since 2017, mapped from build version numbers. Authentic season cover art © Epic Games.
            </p>
          </div>
        </div>
      </section>
    </section>
  )
}
