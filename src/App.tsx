import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActiveBuildCard } from './components/ActiveBuildCard'
import { AddBuildDialog } from './components/AddBuildDialog'
import { AuthScreen } from './components/AuthScreen'
import { BuildDrawer } from './components/BuildDrawer'
import { FriendsView } from './components/FriendsView'
import { ItemShopView } from './components/ItemShopView'
import { LibraryRail } from './components/LibraryRail'
import { SettingsView } from './components/SettingsView'
import { ToastStack } from './components/Toast'
import { TopBar } from './components/TopBar'
import { artKeyFor } from './lib/art'
import { fetchFriends, lobbyIsFresh, type LobbyInfo } from './lib/friends'
import { lobbyIsReachable, lobbyMatchesBuild, playModesForBuilds } from './lib/playMode'
import {
  clearOnlineLobby,
  publishOnlineLobby,
  subscribeOnlineService,
  type OnlineStatus,
} from './lib/onlineService'
import { HostingStopQueue, LaunchAttemptTracker, runJoinFallback } from './lib/joinFallback'
import {
  canDownloadBuilds,
  cancelDownload,
  checkInstalledBuilds,
  closeBuildProcess,
  deleteBuild,
  detectOnlineProvider,
  hasNativeBridge,
  launchBuild,
  launchOnlineProvider,
  launchProfileBuild,
  openOnlineProviderInstaller,
  pauseDownload,
  pickBuildFolder,
  pickInstallDir,
  scanInstalledBuilds,
  startDownload,
  subscribeBuildExit,
  subscribeDownloadProgress,
  subscribeJoinFailed,
  verifyBuildFiles,
} from './lib/launch'
import {
  clearSession,
  compareVersions,
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
import { accentForChapter, buildFromPath, executableFor, folderNameOf } from './lib/seasons'
import { buildSeasonManifest, runtimeProfileFor } from './lib/manifest'
import {
  applyProfilesToBuilds,
  emptyProfiles,
  loadProfiles,
  matchBuildFromFolder,
  persistProfiles,
  pickDefaultBuildsRoot,
  profileExecutableFor,
  profileProviderLabelFor,
  profileKeyForBuild,
  withDetectedBuilds,
  withInstalledBuild,
  withoutBuildProfile,
  type DetectedBuild,
  type ProfilesFile,
} from './lib/profiles'
import { loadCloudSettings, persistCloudSettings, readLocalCloudSettings, type CloudSettings } from './lib/cloudSettings'
import { normalizeCloudUrl, resolveCloudSource, type CloudSourceMode } from './lib/cloudSource'
import defaultBuilds from './assets/builds.json'
import { buildForSeason, ensureAllSeasons, seedBuilds, sortBuilds } from './lib/sampleBuilds'
import { loadState, saveState, uid } from './lib/storage'
import { useItemShop } from './lib/useItemShop'
import { inventoryItemsFor, SHOP_CATALOG } from './lib/shop'
import type {
  Account,
  Build,
  BuildExitInfo,
  BuildState,
  BuildVerifyReport,
  DownloadState,
  LaunchPhase,
  OnlineProviderConfig,
  SeasonInfo,
  ToastMessage,
} from './types'

const PROFILE = { outfit: 'Renegade Raider', level: 87, cosmetics: 214 }
const APP_VERSION = __APP_VERSION__
const TOAST_TTL = 4200

function lobbyAddress(address: string): string {
  return String(address || '')
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .split('/')[0]
}

function lobbyTarget(address: string): { host: string; port: number } | null {
  const value = lobbyAddress(address)
  if (!value) return null
  const split = value.lastIndexOf(':')
  const host = (split > 0 ? value.slice(0, split) : value).replace(/^\[|\]$/g, '')
  const port = Number(split > 0 ? value.slice(split + 1) : '') || 7777
  return host ? { host, port } : null
}

interface VerifyJob {
  id: string
  phase: 'running' | 'done'
  report?: BuildVerifyReport
  error?: string
}

/** Only VAULTED-managed downloads can be checked against the builds root. */
function isManagedBuild(build: Build): boolean {
  return /vaulted launcher[\\/]+builds[\\/]/i.test(build.path)
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'a moment'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`
}

/** Short actionable summary of a failed build verification. */
function verificationSummary(report: BuildVerifyReport): string {
  const groups: Array<[string, string[]]> = [
    ['Runtime', report.issues.runtime],
    ['Missing', report.issues.missing],
    ['Empty', report.issues.empty],
    ['Unreadable', report.issues.unreadable],
    ['Temp files', report.issues.temp],
    ['Corrupt', report.issues.corrupt],
  ]
  const first = groups.find(([, paths]) => paths.length > 0)
  return first
    ? `${report.issueCount} problem${report.issueCount === 1 ? '' : 's'} found. ${first[0]}: ${first[1][0]}`
    : 'Build health check failed.'
}

export default function App() {
  const [builds, setBuilds] = useState<Build[]>(() => {
    const persisted = loadState()
    return sortBuilds(persisted && persisted.builds.length > 0 ? ensureAllSeasons(persisted.builds) : seedBuilds())
  })
  const buildsRef = useRef<Build[]>(builds)
  buildsRef.current = builds
  const [activeId, setActiveId] = useState<string | null>(() => loadState()?.activeId ?? null)
  const [profiles, setProfiles] = useState<ProfilesFile>(() => emptyProfiles())
  const profilesRef = useRef<ProfilesFile>(profiles)
  profilesRef.current = profiles
  const [profilesLoaded, setProfilesLoaded] = useState(false)
  const [phase, setPhase] = useState<LaunchPhase>('idle')
  const [installed, setInstalled] = useState<Record<string, boolean>>({})
  const [downloads, setDownloads] = useState<Record<string, DownloadState>>({})
  const pausedDownloadIds = useRef(new Set<string>())
  const providerPollTimers = useRef(new Map<string, number>())
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [runningId, setRunningId] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const [view, setView] = useState<'home' | 'shop' | 'settings' | 'friends'>('home')
  const [friendRequests, setFriendRequests] = useState(0)
  const [verifyJobs, setVerifyJobs] = useState<Record<string, VerifyJob>>({})
  const [launchFailure, setLaunchFailure] = useState<{ id: string; message: string } | null>(null)
  const [launchStage, setLaunchStage] = useState<string | null>(null)
  const verificationPromises = useRef(new Map<string, Promise<VerifyJob | null>>())
  const autoVerifiedIds = useRef(new Set<string>())
  // Assigned after the verifier is defined; startBuild needs the preflight but
  // is declared earlier in the component, so it reads through this ref.
  const runBuildVerificationRef = useRef<
    ((build: Build, options?: { automatic?: boolean }) => Promise<VerifyJob | null>) | null
  >(null)

  const [session, setSession] = useState<RiftSession | null>(() => loadSession())
  const [manifest, setManifest] = useState<BuildManifest | null>(() => defaultBuilds as BuildManifest)
  const [sourcesStatus, setSourcesStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [sourcesError, setSourcesError] = useState<string | null>(null)
  const [activeCounts, setActiveCounts] = useState<Record<string, number>>({})
  const [onlineLobbies, setOnlineLobbies] = useState<LobbyInfo[]>([])
  const [onlineStatus, setOnlineStatus] = useState<OnlineStatus>('checking')
  const [lanIp, setLanIp] = useState<string | null>(null)
  const [buildsRoot, setBuildsRoot] = useState<string | null>(null)
  const [cloudSettings, setCloudSettings] = useState<CloudSettings>(() => readLocalCloudSettings())
  const onlineServiceUrlRef = useRef(cloudSettings.onlineServiceUrl)
  onlineServiceUrlRef.current = cloudSettings.onlineServiceUrl
  const [cloudLoaded, setCloudLoaded] = useState(false)
  const [cloudStatus, setCloudStatus] = useState<'idle' | 'syncing' | 'connected' | 'error'>('idle')
  const [cloudError, setCloudError] = useState<string | null>(null)
  const [cloudMode, setCloudMode] = useState<CloudSourceMode | null>(null)
  const [cloudCount, setCloudCount] = useState(0)
  const cloudSyncGeneration = useRef(0)
  const [scanning, setScanning] = useState(false)
  const autoScanned = useRef(false)
  const scannedRoot = useRef('')
  const [launchAttempts] = useState(() => new LaunchAttemptTracker())
  const [hostingStops] = useState(
    () =>
      new HostingStopQueue({
        stop: () => clearOnlineLobby(onlineServiceUrlRef.current),
        isCurrent: (token) => launchAttempts.isCurrent(token),
      }),
  )
  const [updateState, setUpdateState] = useState<{
    state: 'idle' | 'checking' | 'current' | 'available' | 'error'
    message?: string
    url?: string
  }>({ state: 'idle' })
  const [updateReady, setUpdateReady] = useState(false)
  const [hostedLobby, setHostedLobby] = useState<{
    address: string
    port: number
    buildId: string
    label: string
    public: boolean
    seasonId?: string | null
  } | null>(null)

  // Link/build overlays are card-scoped in intent, even though they live at
  // the app root. Close them when the selected card, view, or library changes
  // so they cannot linger over a different build.
  useEffect(() => {
    setDialogOpen(false)
  }, [activeId, view])

  useEffect(() => {
    if (drawerOpen) setDialogOpen(false)
  }, [drawerOpen])

  // settings.json owns the cloud URL and install root. Loading it before the
  // first source sync is what makes the connection reconnect on every launch.
  useEffect(() => {
    let cancelled = false
    void loadCloudSettings()
      .then((settings) => {
        if (cancelled) return
        setCloudSettings(settings)
        if (settings.defaultInstallDir) setBuildsRoot(settings.defaultInstallDir)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setCloudLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // The first run writes the effective download folder into profiles.json so
  // both top-level defaults exist even before the player opens Settings.
  useEffect(() => {
    if (!profilesLoaded || profiles.defaultBuildsRoot || !buildsRoot) return
    const next = { ...profiles, defaultBuildsRoot: buildsRoot }
    profilesRef.current = next
    setProfiles(next)
    void persistProfiles(next).catch(() => {})
  }, [buildsRoot, profiles, profilesLoaded])

  const native = useMemo(() => hasNativeBridge(), [])

  // profiles.json owns the global executable/builds root and the season folders
  // detected on disk. Load it once before the startup scan so already-installed
  // cards are Play-ready on the first render after boot.
  useEffect(() => {
    let cancelled = false
    void loadProfiles()
      .then((loaded) => {
        if (cancelled) return
        profilesRef.current = loaded
        setProfiles(loaded)
      })
      .catch(() => {
        /* localStorage keeps the preview working */
      })
      .finally(() => {
        if (!cancelled) setProfilesLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!profilesLoaded) return
    const applied = applyProfilesToBuilds(buildsRef.current, profiles)
    if (applied.changed) {
      buildsRef.current = applied.builds
      setBuilds(applied.builds)
    }
    if (Object.keys(applied.installed).length > 0) {
      setInstalled((prev) => {
        let changed = false
        const next = { ...prev }
        for (const [id, ready] of Object.entries(applied.installed)) {
          if (ready && next[id] !== true) {
            next[id] = true
            changed = true
          }
        }
        return changed ? next : prev
      })
    }
  }, [profiles, profilesLoaded])

  useEffect(() => {
    if (!native) return
    let cancelled = false
    void window.arc
      ?.lanIp?.()
      .then((value) => {
        if (!cancelled) setLanIp(value || null)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [native])
  const shop = useItemShop({
    builds,
    installed,
    activeId,
    runningId,
    accountId: session?.user.id,
    username: session?.user.username,
    token: session?.token,
  })

  // silent auto-update events from main process
  useEffect(() => {
    if (!window.arc?.onUpdateAvailable) return
    const offAvail = window.arc.onUpdateAvailable((info) => {
      setUpdateState({ state: 'available', message: `v${info.version} available — download in Settings.` })
    })
    const offDone = window.arc.onUpdateDownloaded?.((info) => {
      setUpdateState({ state: 'available', message: `v${info.version} downloaded — restart to install.` })
      setUpdateReady(true)
    })
    const offProgress = window.arc.onUpdateProgress?.((info) => {
      setUpdateState((prev) => (prev.state === 'available' ? { ...prev, message: `Downloading update… ${info.percent}%` } : prev))
    })
    const offError = window.arc.onUpdateError?.((info) => {
      setUpdateState({ state: 'error', message: info.message || 'Update download failed.' })
    })
    return () => { offAvail(); offDone?.(); offProgress?.(); offError?.() }
  }, [])

  // Every card is driven by the same normalised manifest: id, chapter/season,
  // version, size, one-click URL, runtime profile and resolved install folder.
  const seasonManifest = useMemo(
    () => buildSeasonManifest(manifest, buildsRoot),
    [manifest, buildsRoot],
  )

  // A not-yet-downloaded card follows the configured install root. Existing
  // installs on disk keep their real folder.
  useEffect(() => {
    if (!buildsRoot) return
    setBuilds((prev) => {
      let changed = false
      const next = prev.map((build) => {
        if (!build.placeholder) return build
        const key = artKeyFor(build.season)
        const entry = key ? seasonManifest[key] : null
        if (!entry || build.path === entry.defaultInstallDir) return build
        changed = true
        return {
          ...build,
          path: entry.defaultInstallDir,
          executable: executableFor(entry.defaultInstallDir),
          folderName: 'Not downloaded',
        }
      })
      return changed ? next : prev
    })
  }, [buildsRoot, seasonManifest])

  // The bundled manifest is the source of truth for pre-mapped community
  // seasons. Attach the provider to every card so both the hero and sidebar
  // render ONLINE PLAY before any account, relay, or local build is configured.
  useEffect(() => {
    setBuilds((prev) => {
      let changed = false
      const next = prev.map((build) => {
        const key = artKeyFor(build.season)
        const provider = key ? seasonManifest[key]?.onlineProvider : undefined
        const current = build.onlineProvider
        if ((current?.id ?? null) === (provider?.id ?? null)) return build
        changed = true
        return { ...build, onlineProvider: provider }
      })
      return changed ? next : prev
    })
  }, [seasonManifest])

  useEffect(() => {
    return () => {
      for (const timer of providerPollTimers.current.values()) window.clearInterval(timer)
      providerPollTimers.current.clear()
    }
  }, [])

  const sourceKeys = useMemo(() => new Set(Object.keys(seasonManifest)), [seasonManifest])
  const onlineSeasonCount = useMemo(
    () => Object.values(seasonManifest).filter((entry) => Boolean(entry.onlineProvider)).length,
    [seasonManifest],
  )
  const readySeasonCount = useMemo(() => {
    const ready = new Set<string>()
    for (const [key, profile] of Object.entries(profiles.builds)) {
      if (profile.isInstalled) ready.add(key)
    }
    for (const [key, entry] of Object.entries(seasonManifest)) {
      if (entry.onlineProvider) ready.add(key)
    }
    return ready.size
  }, [profiles.builds, seasonManifest])

  const sourceSizes = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(seasonManifest)
          .filter(([, source]) => source.sizeBytes > 0)
          .map(([key, source]) => [key, source.sizeBytes]),
      ) as Record<string, number>,
    [seasonManifest],
  )

  const activeBuild = useMemo(
    () => builds.find((build) => build.id === activeId) ?? builds[0] ?? null,
    [builds, activeId],
  )
  const activeVerifyJob = activeBuild ? (verifyJobs[activeBuild.id] ?? null) : null
  const activeLaunchFailure = launchFailure?.id === activeBuild?.id ? launchFailure.message : null

  const account: Account = useMemo(() => {
    const username = session?.user.username ?? 'player'
    const equippedOutfit = shop.equipped.outfit
      ? SHOP_CATALOG.find((item) => item.id === shop.equipped.outfit)
      : null
    return {
      username,
      initials: username.slice(0, 2).toUpperCase(),
      outfit: equippedOutfit?.name ?? PROFILE.outfit,
      level: PROFILE.level,
      cosmetics: PROFILE.cosmetics + shop.owned.length,
    }
  }, [session, shop.equipped.outfit, shop.owned.length])

  const activeKey = activeBuild ? artKeyFor(activeBuild.season) : null

  // The featured hero and every sidebar card read the same live map. It covers
  // all 43 seasons, including builds that have not been downloaded yet.
  const playModes = useMemo(
    () => playModesForBuilds(builds, onlineLobbies, hostedLobby, lanIp, account.username),
    [account.username, builds, hostedLobby, lanIp, onlineLobbies],
  )
  const activePlayMode = activeBuild ? playModes[activeBuild.id] : undefined

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

  const refreshSources = useCallback(
    async (settingsOverride?: CloudSettings) => {
      const settings = settingsOverride ?? cloudSettings
      const cloudUrl = settings.cloudSourceUrl.trim()
      const generation = (cloudSyncGeneration.current += 1)
      setSourcesStatus('loading')
      setSourcesError(null)
      if (cloudUrl) {
        setCloudStatus('syncing')
        setCloudError(null)
      }

      try {
        let next: BuildManifest
        if (cloudUrl) {
          const resolved = await resolveCloudSource(cloudUrl)
          if (generation !== cloudSyncGeneration.current) return null
          next = resolved.manifest
          setCloudMode(resolved.mode)
          setCloudCount(resolved.count)
        } else {
          // No cloud source saved: the existing online feed and bundled manifest
          // remain the fallback for a fresh install.
          next = await fetchManifest()
          setCloudMode(null)
          setCloudCount(0)
          setCloudStatus('idle')
          setCloudError(null)
        }

        if (generation !== cloudSyncGeneration.current) return null

        // The bundled manifest carries archive sizes for offline/first-run use;
        // an older feed without them must not erase the GB labels.
        const bundled = defaultBuilds as BuildManifest
        const withSizes: BuildManifest = {
          ...next,
          seasons: Object.fromEntries(
            Object.entries(next.seasons).map(([key, source]) => [
              key,
              source.sizeBytes || source.sizeGB || !bundled.seasons[key]?.sizeBytes
                ? source
                : { ...source, sizeBytes: bundled.seasons[key].sizeBytes },
            ]),
          ),
        }
        setManifest(withSizes)
        applyExtraSeasons(withSizes)
        setSourcesStatus('ready')
        if (cloudUrl) setCloudStatus('connected')
        return next
      } catch (error) {
        if (generation !== cloudSyncGeneration.current) return null
        const message = error instanceof Error ? error.message : 'Could not read the build source manifest.'
        setSourcesStatus('error')
        setSourcesError(message)
        if (cloudUrl) {
          setCloudStatus('error')
          setCloudError(message)
        }
        return null
      }
    },
    [applyExtraSeasons, cloudSettings],
  )

  // Auto-sync on startup and whenever the persisted cloud source changes.
  useEffect(() => {
    if (!cloudLoaded) return
    void refreshSources()
  }, [cloudLoaded, refreshSources])

  // Auto-connect to the configured matchmaking service on startup. HTTP(S)
  // endpoints are polled; ws:// services push their lobby list over the socket.
  const onlineToken = session?.token ?? null
  useEffect(() => {
    if (!onlineToken) {
      setOnlineLobbies([])
      setOnlineStatus('offline')
      return
    }
    const endpoint = cloudSettings.onlineServiceUrl.trim()
    if (!endpoint) {
      setOnlineLobbies([])
      setOnlineStatus('offline')
      return
    }
    setOnlineStatus('checking')
    setOnlineLobbies([])
    return subscribeOnlineService(endpoint, (update) => {
      setOnlineLobbies(update.lobbies)
      setOnlineStatus(update.connected ? 'connected' : 'offline')
    })
  }, [cloudSettings.onlineServiceUrl, onlineToken])

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
  }, [builds, native, buildsRoot])

  // A download interrupted by a crash, quit, or network stop leaves its .part
  // plus progress metadata on disk. Surface it as a Continue download action
  // instead of making the user start the whole archive again.
  useEffect(() => {
    if (!native || !window.arc?.listInterruptedDownloads) return
    let cancelled = false
    const load = () => {
      void window.arc!
        .listInterruptedDownloads!()
        .then((items) => {
          if (cancelled) return
          setDownloads((prev) => {
            const next = { ...prev }
            const byId = new Map(builds.map((build) => [build.id, build]))
            const byKey = new Map(builds.map((build) => [artKeyFor(build.season) ?? build.id, build]))
            for (const item of items) {
              if (!item?.id) continue
              // Build ids can be regenerated; the season folder key is stable.
              const build = byId.get(item.id) ?? (item.key ? byKey.get(item.key) : undefined)
              if (!build || next[build.id]?.phase === 'downloading') continue
              next[build.id] = {
                percent: item.percent,
                etaSeconds: null,
                phase: 'paused',
                received: item.received,
                total: item.total,
                url: item.url,
                sha256: item.sha256,
              }
            }
            return next
          })
        })
        .catch(() => {
          /* interrupted-download discovery is best effort */
        })
    }
    load()
    // The first render can win the race with the native bridge on a cold
    // start; one quiet retry makes the Continue button reliable.
    const retry = window.setTimeout(load, 1200)

    return () => {
      cancelled = true
      window.clearTimeout(retry)
    }
  }, [builds, native, buildsRoot])

  // download progress + game exit events from the main process
  useEffect(() => {
    if (!native) return

    const offProgress = subscribeDownloadProgress((progress) => {
      setDownloads((prev) => ({
        ...prev,
        [progress.id]: {
          ...prev[progress.id],
          percent: progress.percent,
          etaSeconds: progress.etaSeconds ?? null,
          speedBytesPerSecond: progress.bytesPerSecond ?? null,
          url: progress.url ?? prev[progress.id]?.url,
          phase: progress.phase,
          received: progress.received,
          total: progress.total,
        },
      }))
    })

    const offExit = subscribeBuildExit((exit: BuildExitInfo) => {
      const { id } = exit
      setRunningId((current) => (current === id ? null : current))
      setLaunchStage(null)

      if (exit.expected) {
        setPhase((current) => (current === 'running' || current === 'launching' ? 'idle' : current))
        setLaunchFailure((current) => (current?.id === id ? null : current))
        return
      }

      const detail = [`Fortnite closed after ${formatDuration(exit.durationMs)}.`]
      if (exit.reason === 'injector-failed' && exit.code) {
        detail.push(`The injector exited with code ${exit.code}.`)
      }
      if (exit.log) {
        detail.push(`Last client log:\n${exit.log}`)
      } else {
        detail.push(
          'No client log was written before it closed. The build may have crashed during startup; run Verify files to check the install.',
        )
      }
      setLaunchFailure({ id, message: detail.join('\n\n') })
      setPhase('error')
    })

    const offStatus = window.arc?.onLaunchStatus?.(({ message }) => {
      setLaunchStage(message)
    })

    return () => {
      offProgress()
      offExit()
      offStatus?.()
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

  const saveProfilesState = useCallback(
    async (next: ProfilesFile) => {
      profilesRef.current = next
      setProfiles(next)
      try {
        const saved = await persistProfiles(next)
        profilesRef.current = saved
        setProfiles(saved)
        return saved
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not save profiles.json.'
        pushToast({ tone: 'error', title: 'Could not save build profiles', description: message })
        throw error
      }
    },
    [pushToast],
  )

  const rememberInstalledBuild = useCallback(
    (build: Build, folder = build.path) => {
      if (!folder) return
      void saveProfilesState(withInstalledBuild(profilesRef.current, build, folder)).catch(() => {})
    },
    [saveProfilesState],
  )

  const forgetBuildProfile = useCallback(
    (build: Build) => {
      const next = withoutBuildProfile(profilesRef.current, build)
      if (next === profilesRef.current) return
      void saveProfilesState(next).catch(() => {})
    },
    [saveProfilesState],
  )

  /** Merges scan results into profiles.json and the 43 season cards at once. */
  const applyDetectedFolders = useCallback(
    (folders: string[]): DetectedBuild[] => {
      const best = new Map<string, DetectedBuild>()
      for (const folder of folders) {
        const match = matchBuildFromFolder(folder, buildsRef.current, seasonManifest)
        if (!match) continue
        const current = best.get(match.key)
        if (
          !current ||
          match.score > current.score ||
          (match.score === current.score && match.folder.length < current.folder.length)
        ) {
          best.set(match.key, match)
        }
      }
      if (best.size === 0) return []

      const detections = [...best.values()]
      const nextProfiles = withDetectedBuilds(profilesRef.current, detections)
      void saveProfilesState(nextProfiles).catch(() => {})

      const byKey = new Map(detections.map((detection) => [detection.key, detection]))
      let changed = false
      const nextBuilds = buildsRef.current.map((build) => {
        const detection = byKey.get(profileKeyForBuild(build))
        if (!detection) return build
        const profile = nextProfiles.builds[detection.key]
        const executable =
          profile?.executablePath || nextProfiles.defaultExecutablePath || executableFor(detection.folder)
        const providerLabel = profileProviderLabelFor(detection.build, nextProfiles)
        const version = detection.version || build.version
        const folderName = folderNameOf(detection.folder)
        if (
          build.path === detection.folder &&
          build.executable === executable &&
          (build.providerLabel ?? '') === providerLabel &&
          !build.placeholder &&
          build.version === version &&
          build.folderName === folderName
        ) {
          return build
        }
        changed = true
        return {
          ...build,
          path: detection.folder,
          executable,
          providerLabel,
          placeholder: false,
          version,
          folderName,
        }
      })

      if (changed) {
        buildsRef.current = nextBuilds
        setBuilds(nextBuilds)
      }
      setInstalled((prev) => {
        let changedInstalled = false
        const next = { ...prev }
        for (const detection of detections) {
          if (next[detection.build.id] !== true) {
            next[detection.build.id] = true
            changedInstalled = true
          }
        }
        return changedInstalled ? next : prev
      })

      return detections
    },
    [saveProfilesState, seasonManifest],
  )

  const scanExistingBuilds = useCallback(
    async (options: { quiet?: boolean; rootOverride?: string } = {}) => {
      if (!native) {
        if (!options.quiet) {
          pushToast({
            tone: 'error',
            title: 'Scanning needs the desktop app',
            description: 'Run "npm run app".',
          })
        }
        return 0
      }

      setScanning(true)
      try {
        const override = options.rootOverride?.trim()
        const roots = override
          ? [override]
          : Array.from(
              new Set(
                [
                  profilesRef.current.defaultBuildsRoot || buildsRoot || '',
                  buildsRoot || '',
                  ...Object.values(seasonManifest).map((entry) => entry.defaultInstallDir),
                ]
                  .map((root) => root.trim())
                  .filter(Boolean),
              ),
            )
        const folders = await scanInstalledBuilds(roots)
        const detections = applyDetectedFolders(folders)

        if (!options.quiet) {
          if (detections.length === 0) {
            pushToast({
              tone: 'info',
              title: 'No installed builds found',
              description: override
                ? `No season build folders matched inside ${override}.`
                : 'Checked the builds root, the 43 manifest install folders, and the usual Downloads/Fortnite folders.',
            })
          } else {
            pushToast({
              tone: 'success',
              title: 'Existing builds are ready',
              description: `${detections.length} season${detections.length === 1 ? '' : 's'} detected and saved to profiles.json.`,
            })
          }
        }
        return detections.length
      } finally {
        setScanning(false)
      }
    },
    [applyDetectedFolders, buildsRoot, native, pushToast, seasonManifest],
  )

  const handlePickDefaultBuildsRoot = useCallback(async () => {
    let picked: string | null
    try {
      picked = await pickDefaultBuildsRoot()
    } catch (error) {
      pushToast({
        tone: 'error',
        title: 'Could not open the folder picker',
        description: error instanceof Error ? error.message : 'Unknown error.',
      })
      return null
    }
    if (!picked) return null

    try {
      await saveProfilesState({ ...profilesRef.current, defaultBuildsRoot: picked })
      return picked
    } catch {
      return null
    }
  }, [pushToast, saveProfilesState])

  const handlePickCloudInstallDir = useCallback(async () => {
    try {
      return await pickInstallDir()
    } catch (error) {
      pushToast({
        tone: 'error',
        title: 'Could not open the folder picker',
        description: error instanceof Error ? error.message : 'Unknown error.',
      })
      return null
    }
  }, [pushToast])

  const handleConnectCloud = useCallback(
    async (rawUrl: string, installDir: string) => {
      setCloudStatus('syncing')
      setCloudError(null)
      try {
        const normalized = normalizeCloudUrl(rawUrl)
        // Validate before replacing a working saved source. The effect below
        // performs the final sync with the persisted settings.
        await resolveCloudSource(normalized)
        const saved = await persistCloudSettings({
          cloudSourceUrl: normalized,
          onlineServiceUrl: cloudSettings.onlineServiceUrl,
          defaultInstallDir: installDir,
          hostPublicLobby: cloudSettings.hostPublicLobby,
        })
        setCloudSettings(saved)
        setBuildsRoot(saved.defaultInstallDir)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not connect to that cloud source.'
        setCloudStatus('error')
        setCloudError(message)
        setSourcesError(message)
        pushToast({ tone: 'error', title: 'Cloud connection failed', description: message })
      }
    },
    [cloudSettings, pushToast],
  )

  const handleResetCloud = useCallback(async () => {
    setCloudStatus('syncing')
    setCloudError(null)
    try {
      const saved = await persistCloudSettings({
        cloudSourceUrl: '',
        onlineServiceUrl: cloudSettings.onlineServiceUrl,
        defaultInstallDir: '',
        hostPublicLobby: cloudSettings.hostPublicLobby,
      })
      setCloudSettings(saved)
      setBuildsRoot(saved.defaultInstallDir)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not reset the cloud source.'
      setCloudStatus('error')
      setCloudError(message)
      pushToast({ tone: 'error', title: 'Cloud reset failed', description: message })
    }
  }, [cloudSettings, pushToast])

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

      if (!build.season.known) {
        pushToast({
          tone: 'error',
          title: 'Could not identify that build',
          description: 'The folder name does not contain a Fortnite version VAULTED recognises.',
        })
        return
      }

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
        const linked = { ...build, id: slot.id, addedAt: slot.addedAt }
        setBuilds((prev) =>
          prev.map((item) =>
            item.id === slot.id ? linked : item,
          ),
        )
        rememberInstalledBuild(linked, path)
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
      rememberInstalledBuild(build, path)
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
    [builds, pushToast, rememberInstalledBuild],
  )

  // The only manual step left: point a card at a build already on disk.
  const handleLocateExistingFolder = useCallback(async () => {
    try {
      const folder = await pickBuildFolder()
      if (!folder) return
      handleAdd(folder)
    } catch (error) {
      pushToast({
        tone: 'error',
        title: 'Could not open the folder picker',
        description: error instanceof Error ? error.message : 'Unknown error.',
      })
    }
  }, [handleAdd, pushToast])

  const beginDownload = useCallback(
    async (build: Build, url: string, sha256?: string, fallbackUrl?: string) => {
      const key = artKeyFor(build.season) ?? build.id
      pausedDownloadIds.current.delete(build.id)
      autoVerifiedIds.current.delete(build.id)
      setVerifyJobs((prev) => {
        const next = { ...prev }
        delete next[build.id]
        return next
      })
      setLaunchFailure((current) => (current?.id === build.id ? null : current))
      setDownloads((prev) => ({
        ...prev,
        [build.id]: {
          ...prev[build.id],
          percent: prev[build.id]?.percent ?? 0,
          phase: 'downloading',
          etaSeconds: null,
          speedBytesPerSecond: null,
          url,
          fallbackUrl,
          sha256: sha256 ?? null,
        },
      }))
      setPhase('idle')

      try {
        const result = await startDownload(build.id, key, url, sha256, fallbackUrl)
        setInstalled((prev) => ({ ...prev, [build.id]: Boolean(result.executable) }))

        if (result.executable) {
          const executable = result.executable
          const parsed = buildFromPath(result.folder, build.id)
          const downloaded: Build = {
            ...build,
            executable,
            path: result.folder,
            folderName: parsed.folderName,
            version: parsed.version !== 'unknown' ? parsed.version : build.version,
            season: parsed.season.known ? parsed.season : build.season,
            placeholder: false,
          }
          setBuilds((prev) =>
            prev.map((item) =>
              item.id === build.id ? { ...downloaded, addedAt: item.addedAt } : item,
            ),
          )
          rememberInstalledBuild(downloaded, result.folder)
          pushToast({
            tone: 'success',
            title: 'Download complete',
            description: `${build.season.label} is ready — press Play.`,
          })
        } else {
          pushToast({
            tone: 'info',
            title: 'Download finished — files kept',
            description:
              result.reason === 'mobile'
                ? `This source contains a mobile build (iOS/Android), not a Windows client. The download was kept at ${result.filePath}.`
                : `The archive was downloaded and unpacked, but no Windows client was found. Nothing was deleted — the files are in ${result.folder}.`,
          })
        }
      } catch (error) {
        if (pausedDownloadIds.current.has(build.id)) {
          // Pause already aborted this request on purpose; keep the entry so
          // the primary button becomes Continue download.
          return
        }
        const message = error instanceof Error ? error.message : 'The build could not be downloaded.'
        if (/abort|cancel/i.test(message)) {
          pushToast({ tone: 'info', title: 'Download cancelled', description: build.season.label })
        } else {
          pushToast({ tone: 'error', title: 'Download failed', description: message })
        }
      } finally {
        const paused = pausedDownloadIds.current.delete(build.id)
        setDownloads((prev) => {
          const next = { ...prev }
          if (paused && next[build.id]) {
            next[build.id] = { ...next[build.id], phase: 'paused', etaSeconds: null }
          } else {
            delete next[build.id]
          }
          return next
        })
      }
    },
    [pushToast, rememberInstalledBuild],
  )

  const requestDownload = useCallback(
    (build: Build) => {
      if (!canDownloadBuilds()) {
        pushToast({ tone: 'error', title: 'Downloads need the desktop app', description: 'Run "npm run app".' })
        return
      }

      // Continue must use the source that produced the bytes already on disk,
      // even when the manifest has since changed.
      const paused = downloads[build.id]?.phase === 'paused' ? downloads[build.id] : null
      if (paused?.url) {
        void beginDownload(build, paused.url, paused.sha256 ?? undefined, paused.fallbackUrl)
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

      const source = seasonManifest[key]
      if (!source?.downloadUrl) {
        pushToast({
          tone: 'error',
          title: 'No source for this season yet',
          description: 'Add its archive to builds.json, then Refresh sources in Settings.',
        })
        return
      }

      void beginDownload(build, source.downloadUrl, source.sha256, source.fallbackDownloadUrl)
    },
    [beginDownload, downloads, pushToast, seasonManifest],
  )

  /**
   * Zero-setup community flow: detect the provider's installed launcher, open
   * its official installer when missing, then keep checking in the background
   * and launch it as soon as Windows finishes the install.
   */
  const startOnlineProvider = useCallback(
    async (build: Build, provider: OnlineProviderConfig) => {
      if (!window.arc?.launchOnlineProvider) {
        pushToast({
          tone: 'error',
          title: 'Online community clients need the desktop app',
          description: 'Run "npm run app".',
        })
        return
      }

      const providerLabel = provider.label || provider.name
      const launchProvider = async () => {
        const attemptToken = launchAttempts.start(build.id, 'host')
        setPhase('launching')
        setLaunchStage(`Starting ${providerLabel}…`)
        try {
          const result = await launchOnlineProvider(build, provider)
          if (!result.launched) throw new Error(`${providerLabel} is not installed yet.`)
          const applied = launchAttempts.commitIfCurrent(attemptToken, () => {
            setRunningId(build.id)
            setPhase('running')
            setLaunchStage(null)
            setLaunchFailure(null)
            setHostedLobby(null)
            shop.sets.recordLaunch(build.id)
            pushToast({
              tone: 'success',
              title: `${providerLabel} is starting`,
              description: `${build.season.label} opens directly in ${providerLabel}.`,
            })
          })
          if (!applied) return
        } catch (error) {
          launchAttempts.commitIfCurrent(attemptToken, () => {
            const message = error instanceof Error ? error.message : `${providerLabel} could not be started.`
            setLaunchFailure({ id: build.id, message })
            setPhase('error')
            setLaunchStage(null)
            pushToast({ tone: 'error', title: `${providerLabel} launch failed`, description: message })
          })
        }
      }

      const detected = await detectOnlineProvider(provider.id)
      if (detected.installed) {
        await launchProvider()
        return
      }

      if (providerPollTimers.current.has(build.id)) {
        pushToast({
          tone: 'info',
          title: `Waiting for ${providerLabel}`,
          description: 'Finish the official installer — the season will link automatically.',
        })
        return
      }

      const installer = await openOnlineProviderInstaller(provider)
      if (!installer.opened) {
        pushToast({
          tone: 'error',
          title: `Could not open the ${providerLabel} installer`,
          description: installer.error || 'Check your connection and try again.',
        })
        return
      }

      pushToast({
        tone: 'info',
        title: `Install ${providerLabel}`,
        description: `${build.season.label} will start automatically as soon as the official client is ready.`,
      })

      const startedAt = Date.now()
      let attempts = 0
      const timer = window.setInterval(() => {
        attempts += 1
        if (Date.now() - startedAt > 20 * 60 * 1000 || attempts > 300) {
          window.clearInterval(timer)
          providerPollTimers.current.delete(build.id)
          return
        }
        void detectOnlineProvider(provider.id).then((next) => {
          if (!next.installed) return
          window.clearInterval(timer)
          providerPollTimers.current.delete(build.id)
          pushToast({
            tone: 'success',
            title: `${providerLabel} detected`,
            description: `Linking ${build.season.label} and starting the client…`,
          })
          void launchProvider()
        })
      }, 4000)
      providerPollTimers.current.set(build.id, timer)
    },
    [launchAttempts, pushToast, shop.sets],
  )

  const startBuild = useCallback(
    async (build: Build, join?: { host: string; port: number }, options: { forceHost?: boolean } = {}) => {
      if (!options.forceHost && phase === 'launching') return
      // A paused entry is an invitation to resume, not an active download.
      if (!options.forceHost && downloads[build.id] && downloads[build.id].phase !== 'paused') return

      if (!options.forceHost && runningId === build.id) {
        pushToast({ tone: 'info', title: 'Already running', description: `${build.season.label} is open now.` })
        return
      }
      if (!options.forceHost && runningId) {
        pushToast({
          tone: 'info',
          title: 'Close the running build first',
          description: 'Only one Fortnite client can run at a time.',
        })
        return
      }

      // A pre-mapped community season runs through its trusted provider even
      // when no VAULTED archive is installed on this PC. The provider owns the
      // game files and server, so never ask the player to browse for an exe.
      if (build.onlineProvider) {
        await startOnlineProvider(build, build.onlineProvider)
        return
      }

      // not on this PC -> download it
      if (!installed[build.id]) {
        requestDownload(build)
        return
      }

      setLaunchFailure((current) => (current?.id === build.id ? null : current))

      // A global or per-card executable is an external launcher. Start it with
      // this season's build folder as the target instead of running VAULTED's
      // Fortnite injector/private-server flow.
      const profileExecutable = profileExecutableFor(build, profiles)
      if (profileExecutable) {
        const attemptToken = launchAttempts.start(build.id, 'host')
        setPhase('launching')
        setLaunchStage(`Starting ${build.season.label}…`)
        try {
          await launchProfileBuild(build, profileExecutable)
          const applied = launchAttempts.commitIfCurrent(attemptToken, () => {
            setRunningId(build.id)
            setPhase('running')
            setLaunchStage(null)
            setLaunchFailure(null)
            setHostedLobby(null)
            shop.sets.recordLaunch(build.id)
            pushToast({
              tone: 'success',
              title: 'Launcher is starting',
              description: `${build.season.label} · ${build.path}`,
            })
          })
          if (!applied) return
        } catch (error) {
          launchAttempts.commitIfCurrent(attemptToken, () => {
            const message = error instanceof Error ? error.message : 'The launcher could not be started.'
            setLaunchFailure({ id: build.id, message })
            setPhase('error')
            setLaunchStage(null)
            pushToast({ tone: 'error', title: 'Launch failed', description: message })
          })
        }
        return
      }

      // Installed downloads get a full automatic preflight. If the files or
      // the shared runtime are broken, explain that instead of handing the
      // client an install that is guaranteed to fail or close immediately.
      if (isManagedBuild(build)) {
        setPhase('launching')
        setLaunchStage('Checking build files before launch…')
        const verify = runBuildVerificationRef.current
        const check = verify ? await verify(build, { automatic: true }) : null
        const report = check?.report
        if (report && !report.verified) {
          const message = verificationSummary(report)
          setLaunchFailure({ id: build.id, message })
          setPhase('error')
          setLaunchStage(null)
          pushToast({
            tone: 'error',
            title: 'Build health check failed',
            description: message,
          })
          return
        }
        if (check?.error) {
          setLaunchStage('Health check unavailable — starting Fortnite…')
        }
      }

      // Installed -> join a live public lobby from the configured source for
      // this exact season when one is listed, otherwise host the season. The
      // source is authoritative, so Play never silently joins a different
      // directory or relay while the card reads LOCAL PLAY.
      let target = join
      let autoJoin = false
      if (!target && session && !options.forceHost) {
        // The configured matchmaking feed is authoritative for ONLINE PLAY.
        const listed = onlineLobbies.find(
          (lobby) =>
            lobby.public &&
            lobbyIsFresh(lobby) &&
            lobbyIsReachable(lobby, lanIp) &&
            lobby.username !== session.user.username &&
            lobbyMatchesBuild(lobby, build),
        )
        if (listed) {
          const parsed = lobbyTarget(listed.address)
          if (parsed) {
            target = parsed
            autoJoin = true
          }
        }
      }
      let attemptToken = launchAttempts.start(build.id, target ? 'join' : 'host')
      setPhase('launching')
      setLaunchStage(
        target
          ? autoJoin
            ? 'Joining a public lobby…'
            : 'Connecting to a live lobby…'
          : 'Preparing the private server…',
      )
      const sourceKey = artKeyFor(build.season)
      const runtimeProfile =
        (sourceKey ? seasonManifest[sourceKey]?.runtimeProfile : undefined) ??
        runtimeProfileFor(build.season.chapter, build.version)

      try {
        const launch = (joinTarget?: { host: string; port: number }, fallbackToHost = false) =>
          launchBuild(
            build,
            session?.user.username,
            {
              items: inventoryItemsFor(shop.owned),
              equipped: shop.equipped,
            },
            joinTarget,
            fallbackToHost,
            runtimeProfile,
          )

        let launched: Awaited<ReturnType<typeof launchBuild>>
        try {
          launched = await launch(target, autoJoin)
        } catch (error) {
          // A fallback may already have taken over this launch. Never let the
          // failed attempt report an error or start a second host.
          if (!launchAttempts.isCurrent(attemptToken)) return
          // A relay lobby can be listed while its host is already closing. Do
          // not leave Play stuck on that error: retry the same season locally
          // and publish the replacement lobby. Explicit friend joins keep their
          // normal error so the player is not silently redirected.
          if (!autoJoin || !target) throw error
          autoJoin = false
          target = undefined
          attemptToken = launchAttempts.start(build.id, 'host')
          setLaunchStage('Lobby closed — starting your own lobby…')
          pushToast({
            tone: 'info',
            title: 'That lobby closed',
            description: `Starting ${build.season.label} and listing your lobby instead.`,
          })
          launched = await launch()
        }
        // The initial join can resolve after its post-launch failure fallback
        // has started. Run the entire running-state update through the real
        // production guard: if the fallback has claimed the attempt, none of
        // this (including the hosting stop) may execute.
        const applied = launchAttempts.commitIfCurrent(attemptToken, () => {
          setRunningId(build.id)
          setPhase('running')
          setLaunchStage(null)
          setLaunchFailure((current) => (current?.id === build.id ? null : current))
          shop.sets.recordLaunch(build.id)
          if (target) {
            setHostedLobby(null)
            // Queue with the launch token: if the join-failed fallback claims
            // this attempt before the microtask runs, the stale join never
            // sends a stop. If it already sent one, the fallback awaits it.
            void hostingStops.stopFor(attemptToken)
          } else {
            void (async () => {
              if (!cloudSettings.hostPublicLobby || !cloudSettings.onlineServiceUrl.trim()) return
              try {
                const endpoint = await window.arc?.publicAddress?.()
                if (!endpoint) return
                setHostedLobby({
                  address: endpoint.address,
                  port: endpoint.port,
                  buildId: build.id,
                  label: build.season.label,
                  public: endpoint.public,
                  seasonId: artKeyFor(build.season),
                })
              } catch {
                /* friends can still join by IP if the relay is offline */
              }
            })()
          }
          pushToast({
            tone: launched.privateServer === false ? 'info' : 'success',
            title: target
              ? `Joining ${target.host}`
              : launched.privateServer === false
                ? 'Opening the lobby only'
                : 'Fortnite is starting. Have fun.',
            description: target
              ? `${build.season.label} · your client is pointed at ${target.host}:${target.port}`
              : launched.privateServer === false
                ? `${build.season.label} · no match server available for this build — no queue was started.`
                : cloudSettings.hostPublicLobby && cloudSettings.onlineServiceUrl.trim()
                  ? `${build.season.label} · v${build.version} · your lobby is listed for everyone in Open lobbies.`
                  : `${build.season.label} · v${build.version} · local match started on this PC.`,
          })
        })
        if (!applied) return
      } catch (error) {
        launchAttempts.commitIfCurrent(attemptToken, () => {
          const message = error instanceof Error ? error.message : 'The client could not be started.'
          setLaunchFailure({ id: build.id, message })
          setPhase('error')
          setLaunchStage(null)
          pushToast({
            tone: 'error',
            title: 'Launch failed',
            description: message,
          })
        })
      }
    },
    [
      downloads,
      launchAttempts,
      hostingStops,
      phase,
      installed,
      requestDownload,
      startOnlineProvider,
      pushToast,
      runningId,
      lanIp,
      onlineLobbies,
      profiles,
      cloudSettings.hostPublicLobby,
      cloudSettings.onlineServiceUrl,
      session?.user.username,
      shop.sets,
      shop.owned,
      shop.equipped,
      seasonManifest,
    ],
  )

  // A public-lobby join can resolve successfully at the process level and then
  // fail once Fortnite tries to connect. Main watches the client log after the
  // launch; this turns that failure into a fresh local host instead of leaving
  // the Play card stuck on "running". Explicit friend joins never send this.
  const handleJoinFailure = useCallback(
    async (payload: { id?: string; host: string; port: number; reason: string }) => {
      if (!payload.id) return
      if (runningId && runningId !== payload.id) return
      const build = builds.find((item) => item.id === payload.id)
      if (!build) return

      // This is the real production fallback. The coordinator claims the
      // current automatic-join attempt synchronously, so duplicate failures are
      // ignored and the original launch completion becomes stale.
      await runJoinFallback(launchAttempts, payload, {
        closeFailedClient: () => closeBuildProcess(build.id),
        prepareHost: async () => {
          setLaunchStage(`Could not join ${payload.host} — starting your own lobby…`)
          setRunningId(null)
          setPhase('idle')
          setHostedLobby(null)
          // Wait for any stop queued by the failed join before publishing the
          // replacement host. This makes the original launch unable to clear
          // the fallback lobby later in the network round trip.
          await hostingStops.stopFor()
        },
        announce: () => {
          pushToast({
            tone: 'info',
            title: payload.reason === 'timeout' ? 'That lobby did not respond' : 'That lobby closed',
            description: `Starting ${build.season.label} and listing your lobby instead.`,
          })
        },
        startHost: () => startBuild(build, undefined, { forceHost: true }),
      })
    },
    [builds, hostingStops, launchAttempts, pushToast, runningId, startBuild],
  )

  useEffect(() => {
    if (!native) return
    return subscribeJoinFailed((payload) => {
      void handleJoinFailure(payload)
    })
  }, [handleJoinFailure, native])

  const handlePrimary = useCallback(async () => {
    const build = activeBuild
    if (!build) return

    // running -> close the client
    if (runningId === build.id) {
      try {
        const closed = await closeBuildProcess(build.id)
        setRunningId(null)
        setPhase('idle')
        setLaunchFailure((current) => (current?.id === build.id ? null : current))
        void clearOnlineLobby(onlineServiceUrlRef.current).catch(() => {})
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

    await startBuild(build)
  }, [activeBuild, downloads, phase, pushToast, runningId, startBuild])

  const handlePlayChallengeBuild = useCallback(
    (buildId: string) => {
      const build = builds.find((candidate) => candidate.id === buildId)
      if (!build) return
      setActiveId(build.id)
      setView('home')

      if (runningId === build.id) {
        pushToast({ tone: 'info', title: 'Already running', description: `${build.season.label} is open now.` })
        return
      }
      if (runningId && runningId !== build.id) {
        pushToast({
          tone: 'info',
          title: 'Close the running build first',
          description: 'Only one Fortnite client can run at a time.',
        })
        return
      }

      void startBuild(build)
    },
    [builds, pushToast, runningId, startBuild],
  )

  // Keep the lobby listed while the host is up; the relay drops entries it has
  // not heard from for two minutes.
  useEffect(() => {
    if (!hostedLobby || !cloudSettings.hostPublicLobby) return
    const endpoint = cloudSettings.onlineServiceUrl.trim()
    if (!endpoint) return
    let closed = false
    const address = `${hostedLobby.address}:${hostedLobby.port}`
    const publish = async () => {
      if (closed) return
      try {
        // One source, one registration: the configured relay gets the host;
        // no other lobby directory is updated behind the player's back.
        await publishOnlineLobby(endpoint, {
          address,
          buildId: hostedLobby.buildId,
          label: hostedLobby.label,
          public: hostedLobby.public,
          seasonId: hostedLobby.seasonId ?? null,
          players: 1,
        })
      } catch {
        /* keep hosting; the next heartbeat retries the same source */
      }
    }
    publish()
    const timer = window.setInterval(() => void publish(), 10_000)
    return () => {
      closed = true
      window.clearInterval(timer)
    }
  }, [cloudSettings.hostPublicLobby, cloudSettings.onlineServiceUrl, hostedLobby])

  // A router can finish booting or receive UPnP later than the launch. Keep
  // trying the public mapping while the lobby is only visible on the LAN; once
  // it succeeds, republish the same lobby as an internet lobby automatically.
  useEffect(() => {
    if (!native || !hostedLobby || hostedLobby.public || !cloudSettings.hostPublicLobby) return
    let cancelled = false
    const timer = window.setInterval(async () => {
      if (cancelled) return
      try {
        const endpoint = await window.arc?.publicAddress?.()
        if (cancelled || !endpoint?.public) return
        setHostedLobby((current) => {
          if (!current || current.public) return current
          return {
            ...current,
            address: endpoint.address,
            port: endpoint.port,
            public: true,
          }
        })
        pushToast({
          tone: 'success',
          title: 'Lobby is now public',
          description: `${hostedLobby.label} can be joined over the internet.`,
        })
      } catch {
        /* keep the LAN lobby listed and try again */
      }
    }, 30_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [cloudSettings.hostPublicLobby, hostedLobby, native, pushToast])

  useEffect(() => {
    if (!runningId) setHostedLobby(null)
  }, [runningId])

  const handleJoinFriend = useCallback(
    (address: string, buildId: string | null, label: string | null) => {
      const build =
        builds.find((candidate) => candidate.id === buildId) ??
        (label ? builds.find((candidate) => candidate.season.label.toLowerCase() === label.toLowerCase()) : undefined) ??
        activeBuild
      if (!build) {
        pushToast({
          tone: 'info',
          title: 'Pick a build first',
          description: 'Choose the chapter and season you want to play, then press Join again.',
        })
        return
      }
      if (!installed[build.id]) {
        setActiveId(build.id)
        setView('home')
        pushToast({
          tone: 'info',
          title: `Download ${build.season.label} first`,
          description: 'That lobby runs a build this PC has not downloaded yet — press Start to get it.',
        })
        return
      }
      if (runningId && runningId !== build.id) {
        pushToast({
          tone: 'info',
          title: 'Close the running build first',
          description: 'Only one Fortnite client can run at a time.',
        })
        return
      }
      const parsed = lobbyTarget(address)
      if (!parsed) return
      setActiveId(build.id)
      setView('home')
      void startBuild(build, parsed)
    },
    [activeBuild, builds, installed, pushToast, runningId, startBuild],
  )

  const handleCancelDownload = useCallback(() => {
    if (!activeBuild) return
    void cancelDownload(activeBuild.id)
  }, [activeBuild])

  const handlePauseDownload = useCallback(async () => {
    const build = activeBuild
    if (!build || !downloads[build.id] || downloads[build.id].phase !== 'downloading') return

    pausedDownloadIds.current.add(build.id)
    try {
      const paused = await pauseDownload(build.id)
      if (!paused) {
        pausedDownloadIds.current.delete(build.id)
        return
      }
      setDownloads((prev) => {
        const current = prev[build.id]
        if (!current) return prev
        return { ...prev, [build.id]: { ...current, phase: 'paused', etaSeconds: null } }
      })
      pushToast({
        tone: 'info',
        title: 'Download paused',
        description: `${build.season.label} is saved — press Continue download to keep going.`,
      })
    } catch (error) {
      pausedDownloadIds.current.delete(build.id)
      pushToast({
        tone: 'error',
        title: 'Could not pause download',
        description: error instanceof Error ? error.message : 'Try again.',
      })
    }
  }, [activeBuild, downloads, pushToast])

  const runBuildVerification = useCallback(
    (build: Build, options: { automatic?: boolean } = {}): Promise<VerifyJob | null> => {
      if (!installed[build.id] || !isManagedBuild(build) || profileExecutableFor(build, profiles)) {
        return Promise.resolve(null)
      }

      // Play and the automatic scan can race. One shared promise means one
      // scan, and both callers wait for the same result.
      const existing = verificationPromises.current.get(build.id)
      if (existing) return existing

      const promise = (async (): Promise<VerifyJob | null> => {
        setVerifyJobs((prev) => ({ ...prev, [build.id]: { id: build.id, phase: 'running' } }))
        try {
          const report = await verifyBuildFiles(build.id, build.path, build.executable)
          if (report.running) {
            setVerifyJobs((prev) => {
              const next = { ...prev }
              delete next[build.id]
              return next
            })
            if (!options.automatic) {
              pushToast({
                tone: 'info',
                title: 'Close Fortnite first',
                description: 'Verify files needs the client closed so every file can be read.',
              })
            }
            return null
          }

          const job: VerifyJob = { id: build.id, phase: 'done', report }
          setVerifyJobs((prev) => ({ ...prev, [build.id]: job }))
          if (!options.automatic) {
            pushToast(
              report.verified
                ? {
                    tone: 'success',
                    title: 'All files verified',
                    description: `${report.files.toLocaleString()} files checked · no corruption found.`,
                  }
                : {
                    tone: 'error',
                    title: 'Verification found problems',
                    description: verificationSummary(report),
                  },
            )
          }
          return job
        } catch (error) {
          const message = error instanceof Error ? error.message : 'The build could not be verified.'
          const job: VerifyJob = { id: build.id, phase: 'done', error: message }
          setVerifyJobs((prev) => ({ ...prev, [build.id]: job }))
          if (!options.automatic) {
            pushToast({ tone: 'error', title: 'Verify failed', description: message })
          }
          return job
        }
      })()

      verificationPromises.current.set(build.id, promise)
      void promise.finally(() => {
        if (verificationPromises.current.get(build.id) === promise) {
          verificationPromises.current.delete(build.id)
        }
      })
      return promise
    },
    [installed, profiles, pushToast],
  )
  runBuildVerificationRef.current = runBuildVerification

  // Every downloaded build is checked automatically, once per app session.
  // Scans run one at a time so startup does not hammer the disk.
  useEffect(() => {
    if (!native) return
    let cancelled = false
    const pending = builds.filter(
      (build) =>
        installed[build.id] &&
        isManagedBuild(build) &&
        !profileExecutableFor(build, profiles) &&
        !autoVerifiedIds.current.has(build.id),
    )
    if (pending.length === 0) return

    void (async () => {
      for (const build of pending) {
        if (cancelled) return
        autoVerifiedIds.current.add(build.id)
        await runBuildVerification(build, { automatic: true })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [builds, installed, native, profiles, runBuildVerification])

  // A new download or a delete must be eligible for a fresh automatic check.
  useEffect(() => {
    for (const id of autoVerifiedIds.current) {
      if (!installed[id]) autoVerifiedIds.current.delete(id)
    }
  }, [installed])

  const handleVerifyBuild = useCallback(() => {
    const build = activeBuild
    if (!build || !installed[build.id]) return
    if (!isManagedBuild(build) || profileExecutableFor(build, profiles)) {
      pushToast({
        tone: 'info',
        title: 'Verify is for VAULTED downloads',
        description: 'Builds launched through a custom or global executable are checked by that launcher.',
      })
      return
    }
    void runBuildVerification(build)
  }, [activeBuild, installed, profiles, pushToast, runBuildVerification])

  const handleDeleteBuild = useCallback(async () => {
    const build = activeBuild
    if (!build || !installed[build.id] || deletingId) return
    if (!window.confirm(`Delete ${build.season.label} from this PC?\n\nThis removes the downloaded build and its archive.`)) return

    setDeletingId(build.id)
    try {
      const result = await deleteBuild(build.id, build.path)
      if (!result.deleted) {
        pushToast({
          tone: 'error',
          title: result.running ? 'Close the build first' : 'Could not delete this build',
          description: result.running
            ? 'The client is still running. Close it, then try again.'
            : 'Only builds downloaded by VAULTED can be deleted from disk.',
        })
        return
      }

      setInstalled((prev) => ({ ...prev, [build.id]: false }))
      forgetBuildProfile(build)
      setBuilds((prev) =>
        prev.map((item) =>
          item.id === build.id
            ? { ...item, providerLabel: '', placeholder: true, executable: '', path: '', folderName: 'Not downloaded' }
            : item,
        ),
      )
      setPhase('idle')
      setVerifyJobs((prev) => {
        const next = { ...prev }
        delete next[build.id]
        return next
      })
      setLaunchFailure((current) => (current?.id === build.id ? null : current))
      pushToast({
        tone: 'success',
        title: 'Build deleted',
        description: `${build.season.label} and its archive were removed from this PC.`,
      })
    } catch (error) {
      pushToast({
        tone: 'error',
        title: 'Could not delete this build',
        description: error instanceof Error ? error.message : 'Unknown error.',
      })
    } finally {
      setDeletingId(null)
    }
  }, [activeBuild, deletingId, forgetBuildProfile, installed, pushToast])

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
      rememberInstalledBuild(next, folder)
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
  }, [activeBuild, pushToast, rememberInstalledBuild])

  // Scan automatically on startup and whenever the configured builds root
  // changes, so a player never has to open and configure all 43 cards by hand.
  useEffect(() => {
    if (!native || !profilesLoaded) return

    const root = profiles.defaultBuildsRoot.trim()
    if (root) {
      const key = root.toLowerCase()
      if (scannedRoot.current === key) return
      scannedRoot.current = key
      void scanExistingBuilds({ quiet: true, rootOverride: root })
        .then((count) => {
          pushToast({
            tone: count > 0 ? 'success' : 'info',
            title: count > 0 ? 'Builds folder scanned' : 'Builds folder saved',
            description:
              count > 0
                ? `${count} season${count === 1 ? '' : 's'} matched and ready to play.`
                : 'No season folders matched yet — add version-named folders and scan again.',
          })
        })
        .catch(() => {
          scannedRoot.current = ''
        })
      return
    }

    if (autoScanned.current) return
    autoScanned.current = true

    // Do not cancel this result in StrictMode's development cleanup: the
    // cleanup would otherwise discard the only automatic scan on startup.
    void scanExistingBuilds({ quiet: true }).then((count) => {
      if (count === 0) return
      pushToast({
        tone: 'success',
        title: 'Builds found on this PC',
        description: `${count} installed season${count === 1 ? '' : 's'} detected and ready to play.`,
      })
    })
  }, [native, profilesLoaded, profiles.defaultBuildsRoot, pushToast, scanExistingBuilds])

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
      const result = await window.arc.checkUpdates()
      const currentVersion = result?.currentVersion || APP_VERSION
      if (result?.version && compareVersions(result.version, currentVersion) > 0) {
        setUpdateState({ state: 'available', message: `v${result.version} available — download in Settings.` })
      } else {
        setUpdateState({ state: 'current', message: `You're on the newest version (v${currentVersion}).` })
      }
    } catch {
      setUpdateState({ state: 'error', message: 'Could not reach the update feed.' })
    }
  }, [])

  const downloadUpdate = useCallback(async () => {
    if (!window.arc?.downloadUpdate) return
    setUpdateState({ state: 'available', message: 'Downloading update…' })
    try {
      const result = await window.arc.downloadUpdate()
      if (!result?.ok) {
        setUpdateState({ state: 'error', message: result?.error || 'Update download failed.' })
      }
    } catch (error) {
      setUpdateState({ state: 'error', message: error instanceof Error ? error.message : 'Update download failed.' })
    }
  }, [])

  // the main process checks on launch and every 30 minutes, then installs

  const activeState: BuildState = !activeBuild
    ? 'missing'
    : runningId === activeBuild.id
      ? 'running'
      : downloads[activeBuild.id]?.phase === 'paused'
        ? 'paused'
        : downloads[activeBuild.id]
          ? 'downloading'
        : phase === 'launching'
          ? 'launching'
          : phase === 'error'
            ? 'error'
            : activeBuild.onlineProvider || installed[activeBuild.id]
              ? 'ready'
              : 'missing'

  const accent = activeBuild?.season.accent ?? { from: '#7c8cff', to: '#a855f7', glow: '#7c8cff' }
  const activeDownloadSize = activeKey ? (seasonManifest[activeKey]?.sizeBytes ?? null) : null
  const settingsBuild =
    activeBuild && installed[activeBuild.id]
      ? {
          ...activeBuild,
          executable: profileExecutableFor(activeBuild, profiles) || activeBuild.executable,
          providerLabel: profileProviderLabelFor(activeBuild, profiles),
        }
      : activeBuild
  const canDeleteActive = Boolean(
    activeBuild &&
      installed[activeBuild.id] &&
      /vaulted launcher[\\/]+builds[\\/]/i.test(activeBuild.path),
  )

  useEffect(() => {
    if (!session) return
    let cancelled = false
    const refresh = () => {
      fetchFriends()
        .then((summary) => {
          if (!cancelled) setFriendRequests(summary.incoming.length)
        })
        .catch(() => {})
    }
    refresh()
    const timer = window.setInterval(refresh, 15000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [session, account.username])

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
          onlineStatus={onlineStatus}
          communityOnline={onlineSeasonCount}
          settingsActive={view === 'settings'}
          shopActive={view === 'shop'}
          friendsActive={view === 'friends'}
          friendRequests={friendRequests}
          onOpenLibrary={() => setDrawerOpen(true)}
          onOpenSettings={() => setView((current) => (current === 'settings' ? 'home' : 'settings'))}
          onOpenShop={() => setView((current) => (current === 'shop' ? 'home' : 'shop'))}
          onOpenFriends={() => setView((current) => (current === 'friends' ? 'home' : 'friends'))}
        />

        <main className="mt-5 flex min-h-0 flex-1 flex-col overflow-y-auto pr-1 sm:mt-6">
          {view === 'settings' ? (
            <SettingsView
              build={settingsBuild}
              installed={activeBuild ? Boolean(installed[activeBuild.id]) : false}
              onBack={() => setView('home')}
              onBrowseFolder={handleBrowseFolder}
              onScanBuilds={() => {
                const root = profiles.defaultBuildsRoot || buildsRoot || ''
                void scanExistingBuilds(root ? { rootOverride: root } : {})
              }}
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
              cloudSourceUrl={cloudSettings.cloudSourceUrl}
              cloudInstallDir={cloudSettings.defaultInstallDir}
              cloudStatus={cloudStatus}
              cloudError={cloudError}
              cloudMode={cloudMode}
              cloudSyncCount={cloudCount}
              downloadsRoot={buildsRoot}
              onConnectCloud={handleConnectCloud}
              onResetCloud={handleResetCloud}
              onPickInstallDir={handlePickCloudInstallDir}
              defaultBuildsRoot={profiles.defaultBuildsRoot || buildsRoot || ''}
              detectedBuildCount={readySeasonCount}
              onPickDefaultBuildsRoot={handlePickDefaultBuildsRoot}
              appVersion={APP_VERSION}
              updateState={updateState}
              updateReady={updateReady}
              onCheckUpdates={() => void checkForUpdates()}
              onDownloadUpdate={() => void downloadUpdate()}
              onRestartToUpdate={() => void window.arc?.installUpdate?.()}
            />
          ) : view === 'friends' ? (
            <FriendsView
              username={account.username}
              onBack={() => setView('home')}
              onSummary={(summary) => setFriendRequests(summary?.incoming.length ?? 0)}
              onJoin={handleJoinFriend}
            />
          ) : view === 'shop' ? (
            <ItemShopView
              shop={shop.shop}
              catalogCount={shop.catalogCount}
              vbucks={shop.vbucks}
              owned={shop.owned}
              equipped={shop.equipped}
              progress={shop.progress}
              challengeBuild={shop.challengeBuild}
              builds={builds}
              installed={installed}
              onChallengeBuild={shop.sets.challengeBuild}
              onClaim={shop.sets.claimTask}
              onPurchase={shop.sets.purchase}
              onEquip={shop.sets.equip}
              onPlayBuild={handlePlayChallengeBuild}
              pushToast={pushToast}
            />
          ) : (
          <div className="grid min-h-0 flex-1 items-stretch gap-4 overflow-hidden lg:grid-cols-[minmax(0,1fr)_360px] lg:grid-rows-1 xl:gap-6 2xl:grid-cols-[minmax(0,1fr)_420px]">
            <div className="animate-fade-up h-full">
              <ActiveBuildCard
                key={`${activeBuild?.id ?? 'no-active-build'}:${drawerOpen ? 'library' : 'card'}`}
                build={activeBuild}
                state={activeState}
                download={activeBuild ? downloads[activeBuild.id] ?? null : null}
                activeNow={activeKey ? Math.max(0, (activeCounts[activeKey] ?? 0) - 1) : null}
                playMode={activePlayMode}
                account={account}
                sourceKeys={sourceKeys}
                downloadSize={activeDownloadSize}
                installed={installed}
                canDelete={canDeleteActive}
                deleting={deletingId === activeBuild?.id}
                launchStage={launchStage}
                launchError={activeLaunchFailure}
                hostedLobby={activeBuild && hostedLobby?.buildId === activeBuild.id ? hostedLobby : null}
                verify={activeVerifyJob}
                onVerify={handleVerifyBuild}
                onLocateFolder={() => void handleLocateExistingFolder()}
                onLogout={() => void handleLogout()}
                onPrimary={handlePrimary}
                onPauseDownload={() => void handlePauseDownload()}
                onCancelDownload={handleCancelDownload}
                onDelete={handleDeleteBuild}
                onChangeBuild={() => setDrawerOpen(true)}
                onAddBuild={() => setDialogOpen(true)}
              />
            </div>

            <div className="animate-fade-up h-full [animation-delay:90ms]">
              <LibraryRail
                builds={builds}
                activeId={activeBuild?.id ?? null}
                installed={installed}
                sourceKeys={sourceKeys}
                sourceSizes={sourceSizes}
                activeCounts={activeCounts}
                activeKey={activeKey}
                playModes={playModes}
                onSelect={handleSelect}
                onAdd={() => setDialogOpen(true)}
              />
            </div>
          </div>
          )}
        </main>

        <footer className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-line/60 pt-4 text-[11px] text-fog/80">
          <p>VAULTED v{APP_VERSION} — every season since 2017 · season art © Epic Games</p>
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
        sourceSizes={sourceSizes}
        activeCounts={activeCounts}
        activeKey={activeKey}
        playModes={playModes}
        onClose={() => setDrawerOpen(false)}
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
