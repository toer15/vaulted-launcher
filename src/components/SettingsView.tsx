import { useEffect, useState } from 'react'
import {
  ArrowLeft,
  ArrowLeftRight,
  Check,
  Cloud,
  CloudDownload,
  FolderSearch,
  HardDrive,
  Info,
  Link2,
  Loader2,
  RefreshCw,
  RotateCcw,
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
  onLinkExistingFolder: () => void
  scanning: boolean
  onOpenLibrary: () => void
  accountName: string
  manifest: BuildManifest | null
  sourcesStatus: 'idle' | 'loading' | 'ready' | 'error'
  sourcesError: string | null
  onRefreshSources: () => void
  cloudSourceUrl: string
  cloudInstallDir: string
  cloudStatus: 'idle' | 'syncing' | 'connected' | 'error'
  cloudError: string | null
  cloudMode: 'manifest' | 'bucket' | null
  cloudSyncCount: number
  downloadsRoot: string | null
  onConnectCloud: (url: string, installDir: string) => Promise<void>
  onResetCloud: () => Promise<void>
  onPickInstallDir: () => Promise<string | null>
  defaultBuildsRoot: string
  detectedBuildCount: number
  onPickDefaultBuildsRoot: () => Promise<string | null>
  appVersion: string
  updateState: { state: 'idle' | 'checking' | 'current' | 'available' | 'error'; message?: string; url?: string }
  updateReady?: boolean
  onCheckUpdates: () => void
  onDownloadUpdate?: () => void
  onRestartToUpdate?: () => void
}

export function SettingsView({
  build,
  installed,
  onBack,
  onBrowseFolder,
  onScanBuilds,
  onLinkExistingFolder,
  scanning,
  onOpenLibrary,
  accountName,
  manifest,
  sourcesStatus,
  sourcesError,
  onRefreshSources,
  cloudSourceUrl,
  cloudInstallDir,
  cloudStatus,
  cloudError,
  cloudMode,
  cloudSyncCount,
  downloadsRoot,
  onConnectCloud,
  onResetCloud,
  onPickInstallDir,
  defaultBuildsRoot,
  detectedBuildCount,
  onPickDefaultBuildsRoot,
  appVersion,
  updateState,
  updateReady,
  onCheckUpdates,
  onDownloadUpdate,
  onRestartToUpdate,
}: SettingsViewProps) {
  const art = build ? artFor(build.season) : null
  const activeSource = cloudSourceUrl || manifestUrl()
  const [cloudUrl, setCloudUrl] = useState(cloudSourceUrl)
  const [cloudDir, setCloudDir] = useState(cloudInstallDir)
  const connecting = cloudStatus === 'syncing'

  useEffect(() => {
    setCloudUrl(cloudSourceUrl)
  }, [cloudSourceUrl])

  useEffect(() => {
    setCloudDir(cloudInstallDir)
  }, [cloudInstallDir])

  const pickCloudInstallDir = async () => {
    const picked = await onPickInstallDir()
    if (picked) setCloudDir(picked)
  }

  return (
    <section className="animate-fade-up rounded-3xl border border-line bg-panel/60 p-5 backdrop-blur-sm sm:p-7">
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-fog">Configuration</p>
          <h1 className="mt-1 font-display text-2xl font-bold tracking-tight text-white">Settings</h1>
          <p className="mt-1.5 max-w-lg text-[12.5px] leading-relaxed text-fog">
            Where VAULTED downloads builds, which cloud source feeds all 43 cards, and how online matches are found.
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
            {build && (
              <span
                                className={cx(
                  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10.5px] font-medium',
                  installed
                    ? 'border-emerald-400/30 bg-emerald-400/[0.07] text-emerald-300'
                    : 'border-amber-400/30 bg-amber-400/[0.07] text-amber-300',
                )}
              >
                {installed ? (
                  <ShieldCheck className="h-3 w-3" />
                ) : (
                  <TriangleAlert className="h-3 w-3" />
                )}
                {installed ? 'Installed' : 'Not installed'}
              </span>
            )}
          </div>
        </div>

        <div className="border-b border-line/70 p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[12px] font-semibold text-mist">Download defaults</p>
              <p className="mt-1 text-[11px] leading-relaxed text-fog">
                Seasons with a live online server download here, then Play launches straight in. Other builds use this root and launch locally.
              </p>
            </div>
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-emerald-400/25 bg-emerald-400/[0.06] px-2.5 py-1 text-[10px] font-semibold text-emerald-300">
              <ShieldCheck className="h-3 w-3" />
              {detectedBuildCount} / 43 seasons installed
            </span>
          </div>

          <label className="mt-3 block">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-fog">
              Default builds root
            </span>
            <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
              <code
                className="min-w-0 flex-1 truncate rounded-xl border border-line bg-black/45 px-3.5 py-2.5 font-mono text-[11.5px] text-mist/90"
                title={defaultBuildsRoot || undefined}
              >
                {defaultBuildsRoot || 'Not set — using the download install directory'}
              </code>
              <button
                type="button"
                onClick={() => void onPickDefaultBuildsRoot()}
                className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border border-line bg-white/[0.03] px-3.5 py-2.5 text-[12px] font-medium text-mist transition-colors duration-200 hover:border-arc/40 hover:bg-white/[0.08] hover:text-white"
              >
                <FolderSearch className="h-3.5 w-3.5" /> Browse…
              </button>
            </div>
          </label>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onScanBuilds}
              disabled={scanning || !defaultBuildsRoot}
              className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-400/35 bg-emerald-400/[0.08] px-3 py-2 text-[11.5px] font-semibold text-emerald-200 transition-colors hover:border-emerald-400/60 hover:bg-emerald-400/15 hover:text-white disabled:cursor-not-allowed disabled:opacity-55"
            >
              <FolderSearch className={cx('h-3.5 w-3.5', scanning && 'animate-pulse')} />
              {scanning ? 'Scanning builds folder…' : 'Scan Builds Folder'}
            </button>
            <button
              type="button"
              onClick={onLinkExistingFolder}
              className="inline-flex items-center gap-1.5 rounded-xl border border-arc/40 bg-arc/10 px-3 py-2 text-[11.5px] font-semibold text-mist transition-colors hover:border-arc/70 hover:bg-arc/20 hover:text-white"
            >
              <FolderSearch className="h-3.5 w-3.5" />
              Link Existing Folder
            </button>
            <span className="text-[10.5px] text-fog">
              Matches subfolders by season ID, version or CL number.
            </span>
          </div>

          <p className="mt-2 text-[10.5px] leading-relaxed text-fog">
            Saved in <span className="font-mono text-mist/80">profiles.json</span>. Existing folders are matched by
            season ID, version, or CL on startup.
          </p>
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
                {build.onlineProvider ? (
                  `Online play is bundled for this season. Play connects to a live server when one is available.`
                ) : (
                  <>
                    VAULTED launches{' '}
                    <span className="font-mono text-mist/80">FortniteClient-Win64-Shipping.exe</span> from this folder.
                  </>
                )}
              </p>
            </div>
          </div>
        ) : (
          <div className="p-6 text-center">
            <p className="text-[12.5px] text-fog">No build selected. Add one from the library first.</p>
          </div>
        )}
      </section>

      {/* cloud storage source */}
      <section className="mt-4 overflow-hidden rounded-2xl border border-line bg-black/25">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/70 px-4 py-3">
          <div className="flex items-center gap-2">
            <Cloud className="h-3.5 w-3.5 text-emerald-300" />
            <h2 className="text-[12px] font-semibold uppercase tracking-[0.14em] text-mist">
              Cloud storage &amp; content source
            </h2>
          </div>
          <span
            className={cx(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10.5px] font-semibold',
              cloudStatus === 'connected'
                ? 'border-emerald-400/30 bg-emerald-400/[0.08] text-emerald-300'
                : cloudStatus === 'syncing'
                  ? 'border-sky-400/30 bg-sky-400/[0.08] text-sky-300'
                  : cloudStatus === 'error'
                    ? 'border-rose-400/30 bg-rose-400/[0.08] text-rose-300'
                    : 'border-line bg-white/[0.03] text-fog',
            )}
          >
            {cloudStatus === 'connected' ? (
              <Check className="h-3 w-3" />
            ) : cloudStatus === 'syncing' ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : cloudStatus === 'error' ? (
              <TriangleAlert className="h-3 w-3" />
            ) : (
              <Cloud className="h-3 w-3" />
            )}
            {cloudStatus === 'connected'
              ? `Connected — ${cloudSyncCount} builds synced`
              : cloudStatus === 'syncing'
                ? 'Syncing…'
                : cloudStatus === 'error'
                  ? 'Connection failed'
                  : 'Not connected'}
          </span>
        </div>
        <div className="p-4">
          <p className="text-[12px] leading-relaxed text-mist/85">
            Paste one URL to feed all 43 season cards. A{' '}
            <span className="font-mono text-mist">manifest.json</span> maps each season directly; a raw bucket base
            resolves <span className="font-mono text-mist">{'{base}/{season.id}.zip'}</span> with a version.zip fallback.
          </p>

          <label className="mt-3 block">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-fog">
              Cloud storage / manifest URL
            </span>
            <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
              <input
                value={cloudUrl}
                onChange={(event) => setCloudUrl(event.target.value)}
                placeholder="https://pub-xxxx.r2.dev or https://example.com/manifest.json"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-xl border border-line bg-black/30 px-3.5 py-2.5 font-mono text-[11.5px] text-mist outline-none transition-colors placeholder:text-fog/50 focus:border-emerald-400/60"
              />
              <button
                type="button"
                onClick={() => void onConnectCloud(cloudUrl.trim(), cloudDir.trim())}
                disabled={connecting || !cloudUrl.trim()}
                className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border border-emerald-400/35 bg-emerald-400/[0.1] px-4 py-2.5 text-[12px] font-semibold text-emerald-200 transition-all duration-200 hover:border-emerald-400/60 hover:bg-emerald-400/15 hover:text-white disabled:cursor-not-allowed disabled:opacity-55"
              >
                {connecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
                Connect &amp; Sync
              </button>
            </div>
          </label>

          <label className="mt-3 block">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-fog">
              Default install directory
            </span>
            <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
              <input
                value={cloudDir}
                onChange={(event) => setCloudDir(event.target.value)}
                placeholder="Choose a folder for downloaded builds"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-xl border border-line bg-black/30 px-3.5 py-2.5 font-mono text-[11.5px] text-mist outline-none transition-colors placeholder:text-fog/50 focus:border-arc/60"
              />
              <button
                type="button"
                onClick={() => void pickCloudInstallDir()}
                className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border border-line bg-white/[0.03] px-3.5 py-2.5 text-[12px] font-medium text-mist transition-colors duration-200 hover:border-arc/40 hover:bg-white/[0.08] hover:text-white"
              >
                <FolderSearch className="h-3.5 w-3.5" /> Browse…
              </button>
            </div>
          </label>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] leading-relaxed text-fog">
              {cloudStatus === 'connected'
                ? cloudMode === 'bucket'
                  ? 'Direct bucket mode — season IDs map to archive filenames.'
                  : 'Manifest mode — every season URL came from the cloud manifest.'
                : cloudError ||
                  'Saved in settings.json and reconnected automatically on every launch.'}
            </p>
            <button
              type="button"
              onClick={() => void onResetCloud()}
              disabled={connecting}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white/[0.03] px-3 py-1.5 text-[11px] font-medium text-fog transition-colors duration-200 hover:border-rose-400/35 hover:text-rose-200 disabled:opacity-55"
            >
              <RotateCcw className="h-3 w-3" /> Reset to Default
            </button>
          </div>
          {cloudStatus === 'error' && cloudError && (
            <p className="mt-2 rounded-xl border border-rose-400/25 bg-rose-400/[0.05] px-3 py-2 text-[11px] leading-relaxed text-rose-200">
              {cloudError}
            </p>
          )}
        </div>
      </section>

      {/* downloads */}
      <section className="mt-4 rounded-2xl border border-line bg-black/25">
        <h2 className="border-b border-line/70 px-4 py-3 text-[12px] font-semibold uppercase tracking-[0.14em] text-mist">
          Downloads
        </h2>
        <div className="flex items-start gap-3 p-4">
          <HardDrive className="mt-0.5 h-4 w-4 shrink-0 text-fog" />
          <div className="min-w-0">
            <code
              className="block truncate font-mono text-[11.5px] text-mist/90"
              title={downloadsRoot || '%APPDATA%\\VAULTED Launcher\\builds'}
            >
              {downloadsRoot || '%APPDATA%\\VAULTED Launcher\\builds'}
            </code>
            <p className="mt-1 text-[11.5px] leading-relaxed text-fog">
              Season archives are downloaded into <span className="font-mono text-mist/80">{'{Default install directory}\\{season.id}'}</span>, unpacked, and scanned for the client executable.
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
            All 43 cards read this source automatically. A cloud source takes precedence; without one, VAULTED uses
            the built-in manifest and its bundled archive URLs.
          </p>
          <code
            className="mt-2 block truncate rounded-xl border border-line/70 bg-black/30 px-3 py-2 font-mono text-[11px] text-fog"
            title={activeSource}
          >
            {activeSource}
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
              {updateState.state === 'available' && !updateReady && (
                <button
                  type="button"
                  onClick={() => onDownloadUpdate?.()}
                  className="inline-flex items-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-400/[0.08] px-3.5 py-2 text-[12px] font-semibold text-emerald-200 transition-colors duration-200 hover:bg-emerald-400/15 hover:text-white"
                >
                  <CloudDownload className="h-3.5 w-3.5" /> Download update
                </button>
              )}
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
