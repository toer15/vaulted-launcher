import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActiveBuildCard } from './components/ActiveBuildCard'
import { AddBuildDialog } from './components/AddBuildDialog'
import { AuthScreen } from './components/AuthScreen'
import { BuildDrawer } from './components/BuildDrawer'
import { LibraryRail } from './components/LibraryRail'
import { SettingsView } from './components/SettingsView'
import { ToastStack } from './components/Toast'
import { TopBar } from './components/TopBar'
import { artKeyFor } from './lib/art'
import {
  canDownloadBuilds,
  cancelDownload,
  checkInstalledBuilds,
  closeBuildProcess,
  hasNativeBridge,
  launchBuild,
  pickBuildFolder,
  scanInstalledBuilds,
  startBackend,
  startDownload,
  subscribeBuildExit,
  subscribeDownloadProgress,
} from './lib/launch'
import {
  clearSession,
  fetchActive,
  fetchManifest,
  fetchMe,
  loadSession,
  saveSession,
  sendHeartbeat,
  signOut,
  type BuildManifest,
  type RiftSession,
} from './lib/network'
import { accentForChapter, buildFromPath } from './lib/seasons'
import defaultBuilds from './assets/builds.json'
import { buildForSeason, ensureAllSeasons, seedBuilds, sortBuilds } from './lib/sampleBuilds'
import { loadState, saveState, uid } from './lib/storage'
import type { Account, Build, BuildState, DownloadState, LaunchPhase, SeasonInfo, ToastMessage } from './types'

const PROFILE = { outfit: 'Renegade Raider', level: 87, cosmetics: 214 }
const APP_VERSION = '1.0.8'
const TOAST_TTL = 4200

export default function App() {
  const [builds, setBuilds] = useState<Build[]>(() => {
    const persisted = loadState()
    return sortBuilds(persisted && persisted.builds.length > 0 ? ensureAllSeasons(persisted.builds) : seedBuilds())
  })
  const [activeId, setActiveId] = useState<string | null>(() => loadState()?.activeId ?? null)
  const [phase, setPhase] = useState<LaunchPhase>('idle')
  const [installed, setInstalled] = useState<Record<string, boolean>>({})
  const [downloads, setDownloads] = useState<Record<string, DownloadState>>({})
  const [runningId, setRunningId] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const [view, setView] = useState<'home' | 'settings'>('home')

  const [session, setSession] = useState<RiftSession | null>(() => loadSession())
  const [manifest, setManifest] = useState<BuildManifest | null>(() => defaultBuilds as BuildManifest)
  const [sourcesStatus, setSourcesStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [sourcesError, setSourcesError] = useState<string | null>(null)
  const [activeCounts, setActiveCounts] = useState<Record<string, number>>({})
  const [scanning, setScanning] = useState(false)
  const autoScanned = useRef(false)
  const [updateState, setUpdateState] = useState<{
    state: 'idle' | 'checking' | 'current' | 'available' | 'error'
    message?: string
    url?: string
  }>({ state: 'idle' })
  const [updateReady, setUpdateReady] = useState(false)

  const native = useMemo(() => hasNativeBridge(), [])

  // silent auto-update events from main process
  useEffect(() => {
    if (!window.arc?.onUpdateAvailable) return
    const offAvail = window.arc.onUpdateAvailable((info) => {
      setUpdateState({ state: 'available', message: `v${info.version} downloading…` })
    })
    const offDone = window.arc.onUpdateDownloaded?.((info) => {
      setUpdateState({ state: 'available', message: `v${info.version} ready — restarts to install.` })
      setUpdateReady(true)
    })
    return () => { offAvail(); offDone?.() }
  }, [])

  const sourceKeys = useMemo(() => new Set(Object.keys(manifest?.seasons ?? {})), [manifest])

  const activeBuild = useMemo(
    () => builds.find((build) => build.id === activeId) ?? builds[0] ?? null,
    [builds, activeId],
  )

  const account: Account = useMemo(() => {
    const username = session?.user.username ?? 'player'
    return {
      username,
      initials: username.slice(0, 2).toUpperCase(),
      outfit: PROFILE.outfit,
      level: PROFILE.level,
      cosmetics: PROFILE.cosmetics,
    }
  }, [session])

  const activeKey = activeBuild ? artKeyFor(activeBuild.season) : null

  // validate a cached session once; a 401 sends the user back to the gate
  useEffect(() => {
    if (!session) return
    let cancelled = false
    void fetchMe(session.token)
      .then((user) => {
        if (!cancelled) setSession((current) => (current ? { ...current, user } : current))
      })
      .catch((error: unknown) => {
        if (!cancelled && (error as { status?: number }).status === 401) {
          clearSession()
          setSession(null)
        }
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const applyExtraSeasons = useCallback((next: BuildManifest) => {
    const extras = Object.entries(next.seasons)
      .filter(([, source]) => Boolean(source.chapter && source.season && source.label))
      .map(([key, source]) => {
        const chapter = Number(source.chapter)
        const season: SeasonInfo = {
          chapter,
          season: Number(source.season),
          label: String(source.label),
          short: source.short ?? `CH${chapter} · S${source.season}`,
          era: source.era ?? 'Added from the live season feed',
          accent: accentForChapter(chapter),
          known: true,
          artKey: source.artKey ?? key,
        }
        return { key, season, version: source.version ?? '' }
      })

    if (extras.length === 0) return

    setBuilds((prev) => {
      const present = new Set(prev.map((build) => artKeyFor(build.season)))
      const additions = extras
        .filter((entry) => !present.has(entry.key))
        .map((entry) => buildForSeason(entry.season, entry.version, entry.key))
      return additions.length > 0 ? sortBuilds([...prev, ...additions]) : prev
    })
  }, [])

  const refreshSources = useCallback(async () => {
    setSourcesStatus('loading')
    setSourcesError(null)
    try {
      const next = await fetchManifest()
      setManifest(next)
      applyExtraSeasons(next)
      setSourcesStatus('ready')
      return next
    } catch (error) {
      setSourcesStatus('error')
      setSourcesError(error instanceof Error ? error.message : 'Could not read the build source manifest.')
      return null
    }
  }, [applyExtraSeasons])

  useEffect(() => {
    if (!session) return
    void refreshSources()
  }, [session, refreshSources])

  // heartbeat the season being viewed, then show live counts
  useEffect(() => {
    if (!session) return
    let cancelled = false

    const poll = async () => {
      try {
        if (activeKey) await sendHeartbeat(session.token, [activeKey])
        const result = await fetchActive()
        if (!cancelled) setActiveCounts(result.counts)
      } catch {
        /* offline — keep the last counts we had */
      }
    }

    void poll()
    const timer = window.setInterval(poll, 45_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [session, activeKey])

  // keep activeId pointing at a real build as the library changes
  useEffect(() => {
    if (builds.length === 0) {
      if (activeId !== null) setActiveId(null)
      return
    }
    if (!builds.some((build) => build.id === activeId)) setActiveId(builds[0].id)
  }, [builds, activeId])

  useEffect(() => {
    saveState({ builds, activeId })
  }, [builds, activeId])

  // ask the main process which builds actually exist on disk
  useEffect(() => {
    if (!native) return
    let cancelled = false

    void checkInstalledBuilds(builds).then((result) => {
      if (!cancelled) setInstalled((prev) => ({ ...prev, ...result }))
    })

    return () => {
      cancelled = true
    }
  }, [builds, native])

  // download progress + game exit events from the main process
  useEffect(() => {
    if (!native) return

    const offProgress = subscribeDownloadProgress((progress) => {
      setDownloads((prev) => ({
        ...prev,
        [progress.id]: { percent: progress.percent, phase: progress.phase },
      }))
    })

    const offExit = subscribeBuildExit(({ id }) => {
      setRunningId((current) => (current === id ? null : current))
      setPhase((current) => (current === 'running' ? 'idle' : current))
    })

    return () => {
      offProgress()
      offExit()
    }
  }, [native])

  const pushToast = useCallback((toast: Omit<ToastMessage, 'id'>) => {
    const id = uid()
    setToasts((prev) => [...prev, { ...toast, id }])
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((item) => item.id !== id))
    }, TOAST_TTL)
  }, [])

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((item) => item.id !== id))
  }, [])

  const handleSelect = useCallback((id: string) => {
    setActiveId(id)
    setPhase('idle')
  }, [])

  const handleAdd = useCallback(
    (path: string) => {
      const duplicate = builds.find((build) => build.path.toLowerCase() === path.toLowerCase())
      if (duplicate) {
        setActiveId(duplicate.id)
        pushToast({
          tone: 'info',
          title: 'Already in your library',
          description: `${duplicate.season.label} · v${duplicate.version}`,
        })
        return
      }

      const build = buildFromPath(path, uid())

      // a season already listed in the library: link the folder to that slot
      const slot = build.season.known
        ? builds.find(
            (item) =>
              item.placeholder &&
              item.season.known &&
              item.season.chapter === build.season.chapter &&
              item.season.season === build.season.season,
          )
        : undefined

      if (slot) {
        setBuilds((prev) =>
          prev.map((item) =>
            item.id === slot.id ? { ...build, id: slot.id, addedAt: item.addedAt } : item,
          ),
        )
        setActiveId(slot.id)
        setPhase('idle')
        pushToast({
          tone: 'success',
          title: 'Build linked',
          description: `${build.season.label} · v${build.version}`,
        })
        return
      }

      setBuilds((prev) => sortBuilds([...prev, build]))
      setActiveId(build.id)
      setPhase('idle')
      pushToast({
        tone: 'success',
        title: 'Build added',
        description: build.season.known
          ? `${build.season.label} · v${build.version}`
          : `v${build.version} — no chapter mapping yet`,
      })
    },
    [builds, pushToast],
  )

  const beginDownload = useCallback(
    async (build: Build, url: string) => {
      const key = artKeyFor(build.season) ?? build.id
      setDownloads((prev) => ({ ...prev, [build.id]: { percent: 0, phase: 'downloading' } }))
      setPhase('idle')

      try {
        const result = await startDownload(build.id, key, url)
        setInstalled((prev) => ({ ...prev, [build.id]: Boolean(result.executable) }))

        if (result.executable) {
          const executable = result.executable
          const parsed = buildFromPath(result.folder, build.id)
          setBuilds((prev) =>
            prev.map((item) =>
              item.id === build.id
                ? {
                    ...item,
                    executable,
                    path: result.folder,
                    folderName: parsed.folderName,
                    version: parsed.version !== 'unknown' ? parsed.version : item.version,
                    season: parsed.season.known ? parsed.season : item.season,
                    placeholder: false,
                  }
                : item,
            ),
          )
          pushToast({
            tone: 'success',
            title: 'Download complete',
            description: `${build.season.label} is ready — press Play.`,
          })
        } else {
          pushToast({
            tone: 'info',
            title: 'Download finished',
            description:
              'No client executable found in the archive — unpack it and use Change to point VAULTED at the folder.',
          })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The build could not be downloaded.'
        if (/abort/i.test(message)) {
          pushToast({ tone: 'info', title: 'Download cancelled', description: build.season.label })
        } else {
          pushToast({ tone: 'error', title: 'Download failed', description: message })
        }
      } finally {
        setDownloads((prev) => {
          const next = { ...prev }
          delete next[build.id]
          return next
        })
      }
    },
    [pushToast],
  )

  const requestDownload = useCallback(
    (build: Build) => {
      if (!canDownloadBuilds()) {
        pushToast({ tone: 'error', title: 'Downloads need the desktop app', description: 'Run "npm run app".' })
        return
      }

      const key = artKeyFor(build.season)
      if (!key) {
        pushToast({
          tone: 'error',
          title: 'No chapter mapping',
          description: 'VAULTED cannot tell which season this build is.',
        })
        return
      }

      const source = manifest?.seasons[key]
      if (!source?.url) {
        pushToast({
          tone: 'error',
          title: 'No source for this season yet',
          description: 'Add its archive to builds.json, then Refresh sources in Settings.',
        })
        return
      }

      void beginDownload(build, source.url)
    },
    [beginDownload, manifest, pushToast],
  )

  const handlePrimary = useCallback(async () => {
    const build = activeBuild
    if (!build) return

    // running -> close the client
    if (runningId === build.id) {
      try {
        const closed = await closeBuildProcess(build.id)
        setRunningId(null)
        setPhase('idle')
        pushToast({
          tone: closed ? 'info' : 'error',
          title: closed ? 'Fortnite closed' : 'Could not close Fortnite',
          description: closed ? build.season.label : 'The process was already gone.',
        })
      } catch (error) {
        pushToast({
          tone: 'error',
          title: 'Could not close Fortnite',
          description: error instanceof Error ? error.message : 'Unknown error.',
        })
      }
      return
    }

    if (downloads[build.id] || phase === 'launching') return

    // not on this PC -> download it
    if (!installed[build.id]) {
      requestDownload(build)
      return
    }

    // installed -> launch
    setPhase('launching')
    try {
      await launchBuild(build)
      setRunningId(build.id)
      setPhase('running')
      pushToast({
        tone: 'success',
        title: 'Fortnite is starting. Have fun.',
        description: `${build.season.label} · v${build.version}`,
      })
    } catch (error) {
      setPhase('error')
      pushToast({
        tone: 'error',
        title: 'Launch failed',
        description: error instanceof Error ? error.message : 'The client could not be started.',
      })
    }
  }, [activeBuild, runningId, downloads, phase, installed, requestDownload, pushToast])

  const handlePlayOnline = useCallback(async () => {
    const build = activeBuild
    if (!build) return
    if (!installed[build.id]) {
      requestDownload(build)
      return
    }
    setPhase('launching')
    try {
      await startBackend()
      await launchBuild(build, { online: true })
      setRunningId(build.id)
      setPhase('running')
      pushToast({
        tone: 'success',
        title: 'Fortnite is starting online.',
        description: `${build.season.label} · v${build.version} — backend on 127.0.0.1:3551`,
      })
    } catch (error) {
      setPhase('error')
      pushToast({
        tone: 'error',
        title: 'Online launch failed',
        description: error instanceof Error ? error.message : 'The client could not be started.',
      })
    }
  }, [activeBuild, installed, requestDownload, pushToast])

  const handleCancelDownload = useCallback(() => {
    if (!activeBuild) return
    void cancelDownload(activeBuild.id)
  }, [activeBuild])

  // settings tab: point the selected build at a different folder
  const handleBrowseFolder = useCallback(async () => {
    const build = activeBuild
    if (!build) return

    try {
      const folder = await pickBuildFolder()
      if (!folder) return

      const next = buildFromPath(folder, build.id)
      setBuilds((prev) =>
        prev.map((item) => (item.id === build.id ? { ...next, addedAt: item.addedAt } : item)),
      )
      setPhase('idle')
      pushToast({
        tone: 'success',
        title: 'Location updated',
        description: next.season.known ? `${next.season.label} · v${next.version}` : folder,
      })
    } catch (error) {
      pushToast({
        tone: 'error',
        title: 'Could not change folder',
        description: error instanceof Error ? error.message : 'Unknown error.',
      })
    }
  }, [activeBuild, pushToast])

  const mergeScannedBuilds = useCallback((folders: string[]) => {
    if (folders.length === 0) return

    setBuilds((prev) => {
      const next = [...prev]
      let changed = false

      for (const folder of folders) {
        const incoming = buildFromPath(folder, uid())
        const alreadyLinked = next.some(
          (build) => !build.placeholder && build.path.toLowerCase() === incoming.path.toLowerCase(),
        )
        if (alreadyLinked) continue

        const slot = incoming.season.known
          ? next.findIndex(
              (build) =>
                build.placeholder &&
                build.season.known &&
                build.season.chapter === incoming.season.chapter &&
                build.season.season === incoming.season.season,
            )
          : -1

        if (slot >= 0) {
          next[slot] = { ...incoming, id: next[slot].id, addedAt: next[slot].addedAt }
        } else {
          next.push(incoming)
        }
        changed = true
      }

      return changed ? sortBuilds(next) : prev
    })
  }, [])

  const handleScanBuilds = useCallback(async () => {
    setScanning(true)
    try {
      const folders = await scanInstalledBuilds()
      if (folders.length === 0) {
        pushToast({
          tone: 'info',
          title: 'No installed builds found',
          description: 'Looked in Downloads, Desktop, Documents, C:\\Fortnite Builds and the VAULTED build folder.',
        })
        return
      }
      mergeScannedBuilds(folders)
      pushToast({
        tone: 'success',
        title: 'Scan complete',
        description: `${folders.length} build${folders.length === 1 ? '' : 's'} identified and sorted by chapter and season.`,
      })
    } finally {
      setScanning(false)
    }
  }, [mergeScannedBuilds, pushToast])

  useEffect(() => {
    if (!native || autoScanned.current) return
    autoScanned.current = true
    let cancelled = false

    void scanInstalledBuilds().then((folders) => {
      if (cancelled || folders.length === 0) return
      const known = new Set(
        builds.filter((item) => !item.placeholder).map((item) => item.path.toLowerCase()),
      )
      const fresh = folders.filter((folder) => !known.has(folder.toLowerCase()))
      if (fresh.length === 0) return

      mergeScannedBuilds(fresh)
      pushToast({
        tone: 'success',
        title: 'Builds found on this PC',
        description: `${fresh.length} installed build${fresh.length === 1 ? '' : 's'} matched to their chapter and season automatically.`,
      })
    })

    return () => {
      cancelled = true
    }
  }, [native, builds, mergeScannedBuilds, pushToast])

  const handleLogout = useCallback(async () => {
    if (!session) return
    await signOut(session.token)
    setSession(null)
    setDrawerOpen(false)
    setDialogOpen(false)
    setView('home')
  }, [session])

  const checkForUpdates = useCallback(async () => {
    if (!window.arc?.checkUpdates) return
    setUpdateState({ state: 'checking' })
    try {
      await window.arc.checkUpdates()
      // electron-updater handles download + install silently; status comes via events
      setUpdateState({ state: 'current', message: `You're on the newest version (v${APP_VERSION}).` })
    } catch {
      setUpdateState({ state: 'error', message: 'Could not reach the update feed.' })
    }
  }, [])

  // auto-check for updates once per session
  const autoCheckedUpdates = useRef(false)
  useEffect(() => {
    if (autoCheckedUpdates.current) return
    autoCheckedUpdates.current = true
    const timer = window.setTimeout(() => {
      void checkForUpdates()
    }, 4000)
    return () => window.clearTimeout(timer)
  }, [checkForUpdates])

  const activeState: BuildState = !activeBuild
    ? 'missing'
    : runningId === activeBuild.id
      ? 'running'
      : downloads[activeBuild.id]
        ? 'downloading'
        : phase === 'launching'
          ? 'launching'
          : phase === 'error'
            ? 'error'
            : installed[activeBuild.id]
              ? 'ready'
              : 'missing'

  const accent = activeBuild?.season.accent ?? { from: '#7c8cff', to: '#a855f7', glow: '#7c8cff' }

  if (!session) {
    return (
      <AuthScreen
        onAuthenticated={(next) => {
          saveSession(next)
          setSession(next)
        }}
      />
    )
  }

  return (
    <div className="relative h-screen overflow-hidden">
      {/* full-width drag handle: the frameless window can be moved from anywhere along the top */}
      <div className="app-drag fixed inset-x-0 top-0 z-30 h-8" aria-hidden />

      {/* ambient background, tinted by the selected chapter */}
      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden" aria-hidden>
        <div
          className="absolute -top-48 left-1/2 h-[560px] w-[880px] -translate-x-1/2 rounded-full opacity-25 blur-[150px] transition-colors duration-1000"
          style={{ background: accent.glow }}
        />
        <div
          className="absolute -bottom-32 right-[-6rem] h-[420px] w-[420px] rounded-full opacity-20 blur-[130px] transition-colors duration-1000"
          style={{ background: accent.from }}
        />
        <div className="absolute inset-0 grain opacity-40" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,transparent_15%,#05060a_75%)]" />
      </div>

      <div className="relative mx-auto flex h-full w-full max-w-[1720px] flex-col px-4 pb-5 pt-11 sm:px-6 sm:pb-7 sm:pt-12">
        <TopBar
          account={account}
          onLogout={() => void handleLogout()}
          season={activeBuild?.season ?? null}
          version={activeBuild?.version || null}
          buildCount={builds.length}
          native={native}
          settingsActive={view === 'settings'}
          onOpenLibrary={() => setDrawerOpen(true)}
          onOpenSettings={() => setView((current) => (current === 'settings' ? 'home' : 'settings'))}
        />

        <main className="mt-5 flex min-h-0 flex-1 flex-col overflow-y-auto pr-1 sm:mt-6">
          {view === 'settings' ? (
            <SettingsView
              build={activeBuild}
              installed={activeBuild ? Boolean(installed[activeBuild.id]) : false}
              onBack={() => setView('home')}
              onBrowseFolder={handleBrowseFolder}
              onScanBuilds={() => void handleScanBuilds()}
              scanning={scanning}
              onOpenLibrary={() => {
                setView('home')
                setDrawerOpen(true)
              }}
              accountName={account.username}
              manifest={manifest}
              sourcesStatus={sourcesStatus}
              sourcesError={sourcesError}
              onRefreshSources={() => void refreshSources()}
              appVersion={APP_VERSION}
              updateState={updateState}
              updateReady={updateReady}
              onCheckUpdates={() => void checkForUpdates()}
              onRestartToUpdate={() => void window.arc?.installUpdate?.()}
            />
          ) : (
          <div className="grid min-h-0 flex-1 items-stretch gap-4 overflow-hidden lg:grid-cols-[minmax(0,1fr)_360px] lg:grid-rows-1 xl:gap-6 2xl:grid-cols-[minmax(0,1fr)_420px]">
            <div className="animate-fade-up h-full">
              <ActiveBuildCard
                build={activeBuild}
                state={activeState}
                download={activeBuild ? downloads[activeBuild.id] ?? null : null}
                activeNow={activeKey ? Math.max(0, (activeCounts[activeKey] ?? 0) - 1) : null}
                account={account}
                sourceKeys={sourceKeys}
                servers={activeBuild ? (manifest?.seasons[artKeyFor(activeBuild.season) ?? '']?.servers ?? []) : []}
                installed={installed}
                onLogout={() => void handleLogout()}
                onPrimary={handlePrimary}
                onPlayOnline={() => void handlePlayOnline()}
                onCancelDownload={handleCancelDownload}
                onChangeBuild={() => setDrawerOpen(true)}
                onAddBuild={() => setDialogOpen(true)}
              />
            </div>

            <div className="animate-fade-up h-full [animation-delay:90ms]">
              <LibraryRail
                builds={builds}
                activeId={activeBuild?.id ?? null}
                installed={installed}
                activeCounts={activeCounts}
                sourceKeys={sourceKeys}
                onSelect={handleSelect}
                onAdd={() => setDialogOpen(true)}
              />
            </div>
          </div>
          )}
        </main>

        <footer className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-line/60 pt-4 text-[11px] text-fog/80">
          <p>VAULTED 1.0 — every season since 2017 · key art © Epic Games</p>
          <p className="font-mono">
            {builds.length} build{builds.length === 1 ? '' : 's'} indexed
          </p>
        </footer>
      </div>

      <BuildDrawer
        open={drawerOpen}
        builds={builds}
        activeId={activeBuild?.id ?? null}
        installed={installed}
        sourceKeys={sourceKeys}
        onClose={() => setDrawerOpen(false)}
        activeCounts={activeCounts}
        onSelect={handleSelect}
        onAdd={() => {
          setDrawerOpen(false)
          setDialogOpen(true)
        }}
      />

      <AddBuildDialog open={dialogOpen} onClose={() => setDialogOpen(false)} onAdd={handleAdd} />

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  )
}
