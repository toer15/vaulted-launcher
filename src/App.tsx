import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActiveBuildCard } from './components/ActiveBuildCard'
import { AddBuildDialog } from './components/AddBuildDialog'
import { ConnectAccountModal } from './components/ConnectAccountModal'
import { SignInModal } from './components/SignInModal'
import { BuildDrawer } from './components/BuildDrawer'
import { FriendsView } from './components/FriendsView'
import { ItemShopView } from './components/ItemShopView'
import { LibraryRail } from './components/LibraryRail'
import { SettingsView } from './components/SettingsView'
import { ToastStack } from './components/Toast'
import { TopBar } from './components/TopBar'
import { artKeyFor } from './lib/art'
import { fetchFriends, type LobbyInfo } from './lib/friends'
import {
  mergeLobbies,
  playModesForBuilds,
  providerCanAutoRoute,
  providerMatches,
  routeExternalServer,
  seasonLabelForId,
} from './lib/playMode'
import {
  clearOnlineLobby,
  publishOnlineLobby,
  subscribeOnlineService,
  type OnlineStatus,
} from './lib/onlineService'
import { LaunchAttemptTracker } from './lib/joinFallback'
import {
  canDownloadBuilds,
  cancelDownload,
  checkInstalledBuilds,
  closeBuildProcess,
  deleteBuild,
  getBuildSize,
  hasNativeBridge,
  launchBuild,
  launchOnlineProvider,
  openBuildFolder,
  pauseDownload,
  pickBuildFolder,
  pickExistingBuildFolder,
  pickInstallDir,
  scanInstalledBuilds,
  startDownload,
  syncProviderBuild,
  subscribeBuildExit,
  subscribeDownloadProgress,
  subscribeJoinFailed,
  verifyBuildFiles,
} from './lib/launch'
import { clearSession as clearNetworkSession } from './lib/network'
import {
  clearSession,
  compareVersions,
  fetchActive,
  fetchCommunityDirectory,
  fetchManifest,
  fetchMe,
  fetchProviderLiveStatuses,
  loadSession,
  normalizeProviderId,
  saveSession,
  sendHeartbeat,
  signOut,
  type BuildManifest,
  type CommunityDirectoryEntry,
  type CommunityProviderStatus,
  type CommunityServer,
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
import {
  parseProviderAccountIssue,
  parseProviderBuildIssue,
  type ProviderBuildIssue,
} from './lib/providerErrors'
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
  GlobalBackend,
  LaunchPhase,
  ProviderAuthStatus,
  ProviderBuild,
  ProviderLiveStatus,
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

const PROVIDER_BRAND_PATTERN = /\b(?:Project Era|EZFN Hybrid|EZFN|Stellar|Retrac|Reboot|Neo|Eon|Hydro|Interloop|Crystal|Echo|ARC|Era)\b/gi

function nativeMessage(message: string): string {
  return message.replace(PROVIDER_BRAND_PATTERN, 'online service')
}

const MANUAL_SERVERS_KEY = 'vaulted.manualServers.v1'

interface ManualServerRecord {
  host: string
  port: number
  name: string
  seasonId: string
  addedAt: number
  pingMs?: number
  /** last 10-second reachability probe; a failed probe removes the row */
  online?: boolean
  lastSeen?: number
}

function readManualServers(): Record<string, ManualServerRecord[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(MANUAL_SERVERS_KEY) || '{}') as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const result: Record<string, ManualServerRecord[]> = {}
    for (const [seasonId, entries] of Object.entries(raw as Record<string, unknown>)) {
      if (!/^ch\d{1,2}(?:-s\d{1,2}|-remix|-mini\d+)$/.test(seasonId) || !Array.isArray(entries)) continue
      const valid = entries
        .filter((entry): entry is ManualServerRecord => {
          if (!entry || typeof entry !== 'object') return false
          const candidate = entry as Partial<ManualServerRecord>
          return (
            typeof candidate.host === 'string' &&
            /^[A-Za-z0-9.-]{1,253}$/.test(candidate.host) &&
            Number.isInteger(candidate.port) &&
            (candidate.port ?? 0) > 0 &&
            (candidate.port ?? 0) <= 65535
          )
        })
        .slice(0, 50)
      if (valid.length > 0) result[seasonId] = valid
    }
    return result
  } catch {
    return {}
  }
}

function saveManualServers(value: Record<string, ManualServerRecord[]>): void {
  try {
    localStorage.setItem(MANUAL_SERVERS_KEY, JSON.stringify(value))
  } catch {
    /* storage disabled */
  }
}

function manualServerOptions(
  entries: Record<string, ManualServerRecord[]>,
): CommunityServer[] {
  const servers: CommunityServer[] = []
  for (const [seasonId, records] of Object.entries(entries)) {
    for (const record of records) {
      servers.push({
        id: `manual:${seasonId}:${record.host}:${record.port}`,
        name: record.name || record.host,
        username: 'saved',
        address: `${record.host}:${record.port}`,
        host: record.host,
        port: record.port,
        buildId: seasonId,
        seasonId,
        label: null,
        public: record.online !== false,
        updated: new Date(record.lastSeen ?? record.addedAt).toISOString(),
        freshForMs: 0,
        playersKnown: false,
        pingMs: record.pingMs,
        providerId: 'manual',
        providerLabel: 'Saved IP',
        source: 'manual',
        sourceLabel: 'Saved IP',
        external: true,
      })
    }
  }
  return servers
}

function relayServer(lobby: LobbyInfo): CommunityServer | null {
  const target = lobbyTarget(lobby.address)
  if (!target) return null
  return {
    ...lobby,
    id: `relay:${lobby.address}`,
    name: lobby.label || `${lobby.username || 'VAULTED'} lobby`,
    host: target.host,
    port: target.port,
    providerId: 'vaulted',
    providerLabel: 'VAULTED',
    source: 'vaulted-relay',
    sourceLabel: 'VAULTED Public',
    external: false,
  }
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

function initialsFor(name: string): string {
  const parts = String(name || '')
    .trim()
    .split(/[\s_.-]+/)
    .filter(Boolean)
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase()
  return (parts[0] || 'VA').slice(0, 2).toUpperCase()
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

interface AccountPrompt {
  build: Build
  provider: GlobalBackend
  server?: {
    host: string
    port: number
    name?: string
    seasonId?: string | null
    fallback?: boolean
  }
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
  const [diskSizes, setDiskSizes] = useState<Record<string, number>>({})
  const requestedDiskSizes = useRef(new Set<string>())
  const [downloads, setDownloads] = useState<Record<string, DownloadState>>({})
  const pausedDownloadIds = useRef(new Set<string>())
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [runningId, setRunningId] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const [view, setView] = useState<'home' | 'shop' | 'settings' | 'friends'>('home')
  const [friendRequests, setFriendRequests] = useState(0)
  const [verifyJobs, setVerifyJobs] = useState<Record<string, VerifyJob>>({})
  const [launchFailure, setLaunchFailure] = useState<{
    id: string
    message: string
    local?: boolean
    verificationUrl?: string
    providerId?: string
    /** Era's game-file integrity rejection, including its live build version */
    buildIssue?: ProviderBuildIssue
  } | null>(null)
  const [launchStage, setLaunchStage] = useState<string | null>(null)
  const localSessionRef = useRef<string | null>(null)
  // Play can await a fresh directory scan; this prevents a double-click from
  // starting a second launch while the first scan is still in flight.
  const communityDiscoveryInFlight = useRef(false)
  const verificationPromises = useRef(new Map<string, Promise<VerifyJob | null>>())
  const autoVerifiedIds = useRef(new Set<string>())
  // Assigned after startBuild is defined; the one-click live-build repair
  // finishes in an effect once its download state has cleared.
  const startBuildRef = useRef<
    | ((
        build: Build,
        join?: { host: string; port: number },
        options?: { promptOnEmpty?: boolean; forceProviderId?: string },
      ) => Promise<void>)
    | null
  >(null)
  const pendingProviderLaunchRef = useRef<{
    build: Build
    forceProviderId?: string
  } | null>(null)
  // Assigned after the verifier is defined; startBuild needs the preflight but
  // is declared earlier in the component, so it reads through this ref.
  const runBuildVerificationRef = useRef<
    ((build: Build, options?: { automatic?: boolean }) => Promise<VerifyJob | null>) | null
  >(null)

  const [session, setSession] = useState<RiftSession | null>(() => loadSession())
  const providerOnly = Boolean(session?.providerOnly)
  const [manifest, setManifest] = useState<BuildManifest | null>(() => defaultBuilds as BuildManifest)
  const [sourcesStatus, setSourcesStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [sourcesError, setSourcesError] = useState<string | null>(null)
  const [activeCounts, setActiveCounts] = useState<Record<string, number>>({})
  const [onlineLobbies, setOnlineLobbies] = useState<LobbyInfo[]>([])
  const [communityServers, setCommunityServers] = useState<CommunityServer[]>([])
  const [providerCatalog, setProviderCatalog] = useState<GlobalBackend[]>([])
  const [providerLiveStatus, setProviderLiveStatus] = useState<Record<string, ProviderLiveStatus>>({})
  const [communityStatuses, setCommunityStatuses] = useState<CommunityProviderStatus[]>([])
  const [providerBuilds, setProviderBuilds] = useState<Record<string, ProviderBuild[]>>({})
  const [manualServers, setManualServers] = useState<Record<string, ManualServerRecord[]>>(() =>
    readManualServers(),
  )
  // OAuth sessions are encrypted on disk by Electron main; the renderer only
  // receives a signed-in flag and display name.
  const [providerAuthStatus, setProviderAuthStatus] = useState<Record<string, ProviderAuthStatus>>({})
  const providerAuthRef = useRef<Record<string, ProviderAuthStatus>>({})
  providerAuthRef.current = providerAuthStatus
  const [signInOpen, setSignInOpen] = useState(false)
  // A hosted season that needs an account link opens this native prompt before
  // Play. The actual sign-in page stays in VAULTED's own secure BrowserWindow.
  const [accountPrompt, setAccountPrompt] = useState<AccountPrompt | null>(null)
  const [accountBusy, setAccountBusy] = useState(false)
  const [accountError, setAccountError] = useState<string | null>(null)
  const accountPromptRef = useRef(false)
  // Holds the Play that opened the account prompt until the provider session
  // has rendered into app state. The resume then re-enters startBuild instead
  // of bypassing VAULTED's sign-in and managed-build preflight gates.
  const accountResumeRef = useRef<AccountPrompt | null>(null)
  // Directory rows and status-only rows report different servers, so their
  // players are summed per provider. A real directory count wins over the
  // public Discord fallback, which is never treated as in-game population.
  const directoryProviderPopulations = useMemo(() => {
    const totals = new Map<string, number>()
    for (const status of communityStatuses) {
      if (status.online === false || status.players === undefined) continue
      const providerId = normalizeProviderId(status.providerId)
      if (!providerId) continue
      totals.set(providerId, (totals.get(providerId) ?? 0) + status.players)
    }
    for (const server of communityServers) {
      if (server.playersKnown === false || server.players === undefined) continue
      const providerId = normalizeProviderId(server.providerId)
      if (!providerId) continue
      totals.set(providerId, (totals.get(providerId) ?? 0) + server.players)
    }
    return totals
  }, [communityServers, communityStatuses])
  const providerLiveStatusWithDirectories = useMemo(() => {
    if (directoryProviderPopulations.size === 0) return providerLiveStatus
    const next = { ...providerLiveStatus }
    for (const [providerId, players] of directoryProviderPopulations) {
      const current = next[providerId]
      if (!current?.online || players <= 0) continue
      next[providerId] = {
        ...current,
        players,
        communityPlayers: undefined,
        populationSource: 'directory',
        populationLabel: undefined,
      }
    }
    return next
  }, [directoryProviderPopulations, providerLiveStatus])
  const nativeProviders = useMemo(
    () =>
      providerCatalog
        .filter((provider) => provider.mode !== 'external')
        .map((provider) => ({
          ...provider,
          live: providerLiveStatusWithDirectories[provider.id],
        })),
    [providerCatalog, providerLiveStatusWithDirectories],
  )
  const verifiedOAuthProviders = useMemo(
    () =>
      providerCatalog
        .filter(
          (provider) => provider.global && provider.auth !== 'none' && provider.mode === 'global_live',
        )
        .map((provider) => {
          const discovered =
            provider.dynamicSeasons && providerAuthStatus[provider.id]?.signedIn
              ? providerBuilds[provider.id] ?? []
              : []
          const supportedSeasons = Array.from(
            new Set([...provider.supportedSeasons, ...discovered.map((build) => build.seasonId)]),
          )
          return { ...provider, supportedSeasons, live: providerLiveStatusWithDirectories[provider.id] }
        }),
    [providerAuthStatus, providerBuilds, providerCatalog, providerLiveStatusWithDirectories],
  )
  const providerVerified = useMemo(
    () => verifiedOAuthProviders.some((provider) => providerAuthStatus[provider.id]?.signedIn),
    [providerAuthStatus, verifiedOAuthProviders],
  )
  const signedIn = Boolean(session) || providerVerified
  // Per-season manual choice from the hero server dropdown. A missing entry
  // means the external router's automatic best live server.
  const [serverSelections] = useState<Record<string, string>>({})
  const [communityDirectories, setCommunityDirectories] = useState<CommunityDirectoryEntry[]>([])
  const [onlineStatus, setOnlineStatus] = useState<OnlineStatus>('checking')
  const [lanIp, setLanIp] = useState<string | null>(null)
  const [buildsRoot, setBuildsRoot] = useState<string | null>(null)
  const [cloudSettings, setCloudSettings] = useState<CloudSettings>(() => readLocalCloudSettings())
  const onlineServiceUrlRef = useRef(cloudSettings.onlineServiceUrl)
  onlineServiceUrlRef.current = cloudSettings.onlineServiceUrl
  const [cloudLoaded, setCloudLoaded] = useState(false)
  const manualServersRef = useRef(manualServers)
  manualServersRef.current = manualServers
  const [cloudStatus, setCloudStatus] = useState<'idle' | 'syncing' | 'connected' | 'error'>('idle')
  const [cloudError, setCloudError] = useState<string | null>(null)
  const [cloudMode, setCloudMode] = useState<CloudSourceMode | null>(null)
  const [cloudCount, setCloudCount] = useState(0)
  const cloudSyncGeneration = useRef(0)
  const [scanning, setScanning] = useState(false)
  const autoScanned = useRef(false)
  const scannedRoot = useRef('')
  const [launchAttempts] = useState(() => new LaunchAttemptTracker())
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
    /** live players currently connected, including spawned bots */
    players?: number
    /** false for a private host that should not be published */
    publish?: boolean
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
    token: providerOnly ? undefined : session?.token,
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
  // render an online status before any account, relay, or local build is configured.
  useEffect(() => {
    setBuilds((prev) => {
      let changed = false
      const next = prev.map((build) => {
        const key = artKeyFor(build.season)
        const entry = key ? seasonManifest[key] : undefined
        const provider = entry?.onlineProvider
        const providers = entry?.onlineProviders ?? (provider ? [provider] : undefined)
        const current = build.onlineProvider
        const currentIds = (build.onlineProviders ?? (current ? [current] : [])).map((item) => item.id).join('|')
        const nextIds = (providers ?? (provider ? [provider] : [])).map((item) => item.id).join('|')
        if ((current?.id ?? null) === (provider?.id ?? null) && currentIds === nextIds) return build
        changed = true
        return { ...build, onlineProvider: provider, onlineProviders: providers }
      })
      return changed ? next : prev
    })
  }, [seasonManifest])

  const sourceKeys = useMemo(() => new Set(Object.keys(seasonManifest)), [seasonManifest])
  const onlineSeasonCount = useMemo(() => {
    const seasons = new Set<string>()
    for (const provider of nativeProviders) {
      if (!providerCanAutoRoute(provider, provider.live)) continue
      for (const season of provider.supportedSeasons) seasons.add(season)
    }
    return seasons.size
  }, [nativeProviders])
  const readySeasonCount = useMemo(
    () => Object.values(profiles.builds).filter((profile) => profile.isInstalled).length,
    [profiles.builds],
  )

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
  const activeLaunchFailureLocal = launchFailure?.id === activeBuild?.id && launchFailure.local === true
  const activeLaunchVerificationUrl =
    launchFailure?.id === activeBuild?.id ? launchFailure.verificationUrl ?? null : null
  const activeBuildIssue =
    launchFailure?.id === activeBuild?.id ? launchFailure.buildIssue ?? null : null

  const providerIdentity = useMemo(() => {
    const providersSignedIn = verifiedOAuthProviders.filter(
      (provider) => providerAuthStatus[provider.id]?.signedIn,
    )
    const preferred =
      providersSignedIn.find((provider) => provider.id === activeBuild?.onlineProvider?.id) ??
      providersSignedIn[0]
    if (!preferred) return null
    const status = providerAuthStatus[preferred.id]
    return {
      id: preferred.id,
      label: preferred.label,
      displayName: status?.displayName || null,
      avatarUrl: status?.avatarUrl || null,
    }
  }, [activeBuild?.onlineProvider?.id, providerAuthStatus, verifiedOAuthProviders])

  const account: Account = useMemo(() => {
    const username = providerIdentity?.displayName || session?.user.username || 'player'
    const equippedOutfit = shop.equipped.outfit
      ? SHOP_CATALOG.find((item) => item.id === shop.equipped.outfit)
      : null
    return {
      username,
      initials: initialsFor(username),
      outfit: equippedOutfit?.name ?? PROFILE.outfit,
      level: PROFILE.level,
      cosmetics: PROFILE.cosmetics + shop.owned.length,
      avatarUrl: providerIdentity?.avatarUrl || session?.user.avatarUrl || null,
      providerLabel: providerIdentity?.label || session?.user.providerLabel || null,
      providerOnly,
    }
  }, [providerIdentity, providerOnly, session, shop.equipped.outfit, shop.owned.length])

  const activeKey = activeBuild ? artKeyFor(activeBuild.season) : null

  // The featured hero and every sidebar card read the same live map. It covers
  // all 43 seasons, including builds that have not been downloaded yet.
  // Public directory results and relay echoes describe the same host often;
  // merge them by address so the card keeps the fullest count and lowest ping.
  const manualLobbies = useMemo(() => manualServerOptions(manualServers), [manualServers])
  const relayLobbies = useMemo(
    () => onlineLobbies.map(relayServer).filter((server): server is CommunityServer => Boolean(server)),
    [onlineLobbies],
  )
  const serverCatalog = useMemo(
    () => mergeLobbies([...communityServers, ...relayLobbies, ...manualLobbies]) as CommunityServer[],
    [communityServers, manualLobbies, relayLobbies],
  )
  const discoverableLobbies = useMemo(
    () => mergeLobbies([...serverCatalog, ...onlineLobbies]),
    [onlineLobbies, serverCatalog],
  )

  const playModes = useMemo(
    () =>
      playModesForBuilds(
        builds,
        discoverableLobbies,
        hostedLobby,
        lanIp,
        account.username,
        communityStatuses,
        communityDirectories,
        nativeProviders,
      ),
    [
      account.username,
      builds,
      communityDirectories,
      communityStatuses,
      discoverableLobbies,
      hostedLobby,
      lanIp,
      nativeProviders,
    ],
  )
  const activePlayMode = activeBuild ? playModes[activeBuild.id] : undefined

  // The hero dropdown and Play read one route: exact-season relay/manual rows
  // first, then external directories. A different-season external server is
  // only a fallback when no global backend or exact lobby is available.
  const activeServerRoute = useMemo(
    () => (activeBuild ? routeExternalServer(activeBuild, serverCatalog) : null),
    [activeBuild, serverCatalog],
  )
  const activeGlobalBackends = useMemo(() => {
    if (!activeKey) return []
    return nativeProviders.filter((provider) => provider.supportedSeasons.includes(activeKey))
  }, [activeKey, nativeProviders])
  const selectedServerValue = activeBuild ? serverSelections[activeBuild.id] : undefined
  const healthyAutoProviders = activeGlobalBackends.filter(
    (provider) =>
      providerCanAutoRoute(provider, provider.live, activeServerRoute?.exactServer) &&
      (provider.auth === 'none' ||
        provider.auth === 'oauth' ||
        provider.auth === 'deeplink' ||
        provider.auth === 'embedded_web'),
  )
  const autoGlobalBackend =
    activeBuild && !selectedServerValue && !activeServerRoute?.exactServer
      ? healthyAutoProviders.find((provider) => provider.id === activeBuild.onlineProvider?.id) ??
        healthyAutoProviders[0] ??
        null
      : null
  // The card offers the generic account connection for any hosted backend
  // that needs an account. Local `auth: "none"` engines never show it, and a
  // signed-in provider hides it automatically.
  const activeAccountBackend = useMemo(() => {
    const matched = activeBuild?.onlineProvider?.id
      ? nativeProviders.find((provider) => provider.id === activeBuild.onlineProvider?.id)
      : null
    const provider = matched ?? autoGlobalBackend
    return provider && provider.auth !== 'none' ? provider : null
  }, [activeBuild?.onlineProvider?.id, autoGlobalBackend, nativeProviders])
  const activeAccountSignedIn = Boolean(
    activeAccountBackend &&
      (providerAuthStatus[activeAccountBackend.id]?.signedIn ||
        normalizeProviderId(session?.user.providerId) === activeAccountBackend.id),
  )
  // validate a cached session once; a 401 sends the user back to the gate
  useEffect(() => {
    // A native provider session is authenticated by Electron's encrypted store;
    // the relay API has no account token to validate for it.
    if (!session || providerOnly) return
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
  const onlineToken = session && !providerOnly ? session.token : null

  useEffect(() => {
    if (!window.arc?.providerCatalog) return
    let cancelled = false
    void window.arc
      .providerCatalog()
      .then((providers) => {
        if (!cancelled && Array.isArray(providers)) setProviderCatalog(providers)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const refreshProviderAuthStatus = useCallback(async () => {
    if (!window.arc?.providerAuth?.status) return
    try {
      const statuses = await window.arc.providerAuth.status()
      if (!statuses || typeof statuses !== 'object') return
      providerAuthRef.current = statuses
      setProviderAuthStatus(statuses)
    } catch {
      /* the sign-in button will report a real error if authentication is unavailable */
    }
  }, [])

  const refreshProviderLiveStatus = useCallback(async () => {
    if (!window.arc?.providerLiveStatus) return
    try {
      setProviderLiveStatus(await fetchProviderLiveStatuses())
    } catch {
      /* keep the last good backend sample */
    }
  }, [])

  // Backend health/population is refreshed while VAULTED is open. The server
  // dropdown and hero badge read this map; a selected change refreshes it below.
  useEffect(() => {
    if (!window.arc?.providerLiveStatus) return
    let cancelled = false
    let timer = 0
    const poll = async () => {
      await refreshProviderLiveStatus()
      if (!cancelled) timer = window.setTimeout(() => void poll(), 10_000)
    }
    void poll()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [refreshProviderLiveStatus])

  useEffect(() => {
    void refreshProviderAuthStatus()
  }, [refreshProviderAuthStatus])

  // Era publishes its live build list per account. Merge those season keys
  // into the catalog only after the provider is signed in; the renderer never
  // gets the token, manifest or any provider URL.
  const dynamicProviderIds = useMemo(
    () =>
      providerCatalog
        .filter((provider) => provider.dynamicSeasons && provider.auth === 'oauth' && provider.mode === 'global_live')
        .map((provider) => provider.id),
    [providerCatalog],
  )
  const signedDynamicProviderKey = dynamicProviderIds
    .filter((providerId) => providerAuthStatus[providerId]?.signedIn)
    .join('|')
  useEffect(() => {
    if (!signedDynamicProviderKey) {
      setProviderBuilds({})
      return
    }
    if (!window.arc?.providerBuilds) return
    let cancelled = false
    const providerIds = signedDynamicProviderKey.split('|')
    void Promise.all(
      providerIds.map(async (providerId) => {
        try {
          const builds = await window.arc!.providerBuilds!(providerId)
          return [providerId, Array.isArray(builds) ? builds : []] as const
        } catch {
          return [providerId, []] as const
        }
      }),
    ).then((entries) => {
      if (!cancelled) setProviderBuilds(Object.fromEntries(entries))
    })
    return () => {
      cancelled = true
    }
  }, [signedDynamicProviderKey])

  // Switching seasons or a dropdown row is a user-visible selection change:
  // refresh immediately instead of waiting for the next 10-second tick.
  useEffect(() => {
    void refreshProviderLiveStatus()
  }, [activeKey, selectedServerValue, refreshProviderLiveStatus])

  // Saved custom IPs are not directories; probe them on the same 10-second
  // cadence so an offline row disappears and a live row keeps a fresh ping.
  useEffect(() => {
    if (!native || !window.arc?.probeServer) return
    let cancelled = false
    let timer = 0
    const poll = async () => {
      const targets = new Map<string, ManualServerRecord>()
      for (const records of Object.values(manualServersRef.current)) {
        for (const record of records) {
          targets.set(`${record.host.toLowerCase()}:${record.port}`, record)
        }
      }
      if (targets.size > 0) {
        const probes = await Promise.all(
          [...targets.values()].map(async (record) => {
            try {
              const result = await window.arc!.probeServer!({ host: record.host, port: record.port })
              return [
                `${record.host.toLowerCase()}:${record.port}`,
                { online: result?.reachable === true, pingMs: result?.pingMs },
              ] as const
            } catch {
              return [`${record.host.toLowerCase()}:${record.port}`, { online: false, pingMs: undefined }] as const
            }
          }),
        )
        if (!cancelled) {
          const byAddress = new Map(probes)
          setManualServers((prev) => {
            let changed = false
            const next: Record<string, ManualServerRecord[]> = {}
            for (const [seasonId, records] of Object.entries(prev)) {
              next[seasonId] = records.map((record) => {
                const probe = byAddress.get(`${record.host.toLowerCase()}:${record.port}`)
                if (!probe) return record
                const online = probe.online
                const pingMs = probe.pingMs
                if (record.online === online && record.pingMs === pingMs) return record
                changed = true
                return {
                  ...record,
                  online,
                  pingMs,
                  ...(online ? { lastSeen: Date.now() } : {}),
                }
              })
            }
            return changed ? next : prev
          })
        }
      }
      if (!cancelled) timer = window.setTimeout(() => void poll(), 10_000)
    }
    void poll()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [native])

  // A provider login applies to every catalog season mapped to that provider.
  // Main broadcasts the provider-wide status so no other season asks again.
  useEffect(() => {
    const subscribe = window.arc?.providerAuth?.onProviderAuthChanged
    if (!subscribe) return
    return subscribe((status) => {
      const providerId = normalizeProviderId(status?.providerId)
      if (!providerId) return
      const next = {
        ...providerAuthRef.current,
        [providerId]: { ...status, providerId },
      }
      providerAuthRef.current = next
      setProviderAuthStatus(next)
    })
  }, [])

  useEffect(() => {
    saveManualServers(manualServers)
  }, [manualServers])

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

  // Public community directories are queried in the main process (no CORS or
  // mixed-content restriction) so every card can show live lobby and player
  // counts even when a provider has no VAULTED relay presence.
  useEffect(() => {
    let cancelled = false
    let timer = 0
    const poll = async () => {
      // Refresh every 10 seconds and bypass the failure cooldown so the counts
      // on every card are the directories' current populations, not a cache.
      // Public endpoints are polled even without a VAULTED token; the relay
      // endpoint simply skips account auth when no token exists.
      const directory = await fetchCommunityDirectory({ token: onlineToken, force: true })
      if (!cancelled) {
        setCommunityServers(directory.servers)
        setCommunityStatuses(directory.statuses)
        setCommunityDirectories(directory.directories)
      }
      if (!cancelled) timer = window.setTimeout(() => void poll(), 10_000)
    }
    void poll()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [onlineToken, activeKey, selectedServerValue])

  // heartbeat the season being viewed, then show live counts
  useEffect(() => {
    if (!session || providerOnly) return
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

  // Detected install sizes are read on demand and cached by path. Walking a
  // 20 GB build can take a moment, so the active card is measured first and
  // the sidebar fills in as each folder finishes.
  useEffect(() => {
    if (!native || !window.arc?.buildSize) return
    const pending = builds
      .filter((build) => installed[build.id] === true && build.path)
      .sort((a, b) => Number(b.id === activeId) - Number(a.id === activeId))

    const load = async () => {
      for (const build of pending) {
        if (requestedDiskSizes.current.has(build.path)) continue
        requestedDiskSizes.current.add(build.path)
        const bytes = await getBuildSize(build.path)
        if (bytes === null) {
          requestedDiskSizes.current.delete(build.path)
          continue
        }
        setDiskSizes((prev) => (prev[build.path] === bytes ? prev : { ...prev, [build.path]: bytes }))
      }
    }

    void load()
  }, [activeId, builds, installed, native])

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
      const wasLocalSession = localSessionRef.current === id
      if (wasLocalSession) localSessionRef.current = null
      setRunningId((current) => (current === id ? null : current))
      setLaunchStage(null)

      // A zero-code client exit is a normal close (including the window-close
      // guard), not a failed launch. Only surface unexpected crashes.
      if (exit.expected || exit.reason === 'client-closed') {
        setPhase((current) => (current === 'running' || current === 'launching' ? 'idle' : current))
        setLaunchFailure((current) => (current?.id === id ? null : current))
        return
      }

      if (wasLocalSession) {
        // The host was ready and the player client still exited before a match.
        // Keep the retry path, but do not surface a raw crash log or imply that
        // the player needs to debug their install.
        setLaunchFailure({
          id,
          local: true,
          message: 'This build closed before its local match started. Try again, or choose another installed build.',
        })
        setPhase('error')
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
    }, toast.ttlMs ?? TOAST_TTL)
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
  const handleLinkExistingFolder = useCallback(async () => {
    try {
      const picked = await pickExistingBuildFolder()
      if (!picked) return
      if (!picked.ok) {
        pushToast({
          tone: 'error',
          title: 'No Fortnite client in that folder',
          description: picked.error,
        })
        return
      }

      const folder = picked.folder
      const duplicate = buildsRef.current.find(
        (build) => build.path && build.path.toLowerCase() === folder.toLowerCase(),
      )
      if (duplicate) {
        setActiveId(duplicate.id)
        pushToast({
          tone: 'info',
          title: 'Already linked',
          description: `${duplicate.season.label} is already using that folder.`,
        })
        return
      }

      // Match the picked folder to the existing 43-season card first. The
      // path parser is a fallback for builds with an unusual folder name.
      const detected = matchBuildFromFolder(folder, buildsRef.current, seasonManifest)
      const parsed = buildFromPath(folder, uid())
      const match =
        detected?.build ??
        buildsRef.current.find(
          (build) =>
            build.season.known &&
            parsed.season.known &&
            build.season.chapter === parsed.season.chapter &&
            build.season.season === parsed.season.season,
        )
      if (!match && !parsed.season.known) {
        pushToast({
          tone: 'error',
          title: 'Could not identify that build',
          description: 'The folder name does not contain a Fortnite version VAULTED recognises.',
        })
        return
      }

      const base = match ?? parsed
      const linked: Build = {
        ...base,
        id: base.id,
        path: folder,
        executable: picked.executable,
        placeholder: false,
        folderName: folderNameOf(folder),
        version: detected?.version || parsed.version || base.version,
      }

      if (match) {
        setBuilds((prev) =>
          prev.map((item) =>
            item.id === match.id ? { ...linked, addedAt: item.addedAt } : item,
          ),
        )
      } else {
        setBuilds((prev) => sortBuilds([...prev, linked]))
      }
      setInstalled((prev) => ({ ...prev, [linked.id]: true }))
      requestedDiskSizes.current.delete(folder)
      rememberInstalledBuild(linked, folder)
      setActiveId(linked.id)
      setPhase('idle')
      pushToast({
        tone: 'success',
        title: 'Existing folder linked',
        description: `${linked.season.label} is installed and ready to play.`,
      })
    } catch (error) {
      pushToast({
        tone: 'error',
        title: 'Could not open the folder picker',
        description: error instanceof Error ? error.message : 'Unknown error.',
      })
    }
  }, [pushToast, rememberInstalledBuild, seasonManifest])

  const beginDownload = useCallback(
    async (
      build: Build,
      url: string,
      sha256?: string,
      fallbackUrl?: string,
      options: {
        repair?: boolean
        launchAfter?: boolean
        forceProviderId?: string
        preferredFolder?: string
        buildVersion?: string
        providerId?: string
        seasonId?: string
        buildId?: string
        validateProvider?: boolean
      } = {},
    ) => {
      const key = artKeyFor(build.season) ?? build.id
      pendingProviderLaunchRef.current = null
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
          providerBuild: undefined,
          repair: options.repair === true,
          launchAfter: options.launchAfter === true,
          forceProviderId: options.forceProviderId,
          preferredFolder: options.preferredFolder,
          buildVersion: options.buildVersion,
          providerId: options.providerId,
          seasonId: options.seasonId,
          buildId: options.buildId,
          validateProvider: options.validateProvider,
        },
      }))
      setPhase('idle')
      if (options.launchAfter) setLaunchStage(`Updating ${build.season.label} to the live build…`)

      try {
        const result = await startDownload(build.id, key, url, sha256, fallbackUrl, {
          repair: options.repair,
          preferredFolder: options.preferredFolder,
          providerId: options.providerId,
          seasonId: options.seasonId,
          buildId: options.buildId,
          validateProvider: options.validateProvider,
        })
        setInstalled((prev) => ({ ...prev, [build.id]: Boolean(result.executable) }))

        if (result.executable) {
          const executable = result.executable
          const parsed = buildFromPath(result.folder, build.id)
          const downloaded: Build = {
            ...build,
            executable,
            path: result.folder,
            folderName: parsed.folderName,
            version:
              options.buildVersion ??
              (parsed.version !== 'unknown' ? parsed.version : build.version),
            season: parsed.season.known ? parsed.season : build.season,
            placeholder: false,
          }
          setBuilds((prev) =>
            prev.map((item) =>
              item.id === build.id ? { ...downloaded, addedAt: item.addedAt } : item,
            ),
          )
          rememberInstalledBuild(downloaded, result.folder)
          if (options.launchAfter) {
            pendingProviderLaunchRef.current = {
              build: downloaded,
              forceProviderId: options.forceProviderId,
            }
          }
          pushToast({
            tone: 'success',
            title: options.launchAfter
              ? `Updated to the live ${downloaded.version} build`
              : 'Download complete',
            description: options.launchAfter
              ? `${build.season.label} now matches the live build — signing in and launching…`
              : `${build.season.label} is ready — press Play.`,
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
        setLaunchStage(null)
        if (pausedDownloadIds.current.has(build.id)) {
          // Pause already aborted this request on purpose; keep the entry so
          // the primary button becomes Continue download.
          return
        }
        const message = nativeMessage(error instanceof Error ? error.message : 'The build could not be downloaded.')
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

  const beginProviderSync = useCallback(
    async (
      build: Build,
      options: {
        providerId?: string
        seasonId?: string
        buildId?: string
        launchAfter?: boolean
      } = {},
    ) => {
      const providerId = options.providerId || build.onlineProvider?.id
      const seasonId = options.seasonId || artKeyFor(build.season) || build.id
      const key = artKeyFor(build.season) ?? build.id
      if (!providerId) {
        pushToast({
          tone: 'error',
          title: 'No online build for this season',
          description: 'VAULTED has no downloadable online build mapped to this card.',
        })
        return
      }
      if (!window.arc?.syncProviderBuild) {
        pushToast({
          tone: 'error',
          title: 'Build updates need the desktop app',
          description: 'Run "npm run app".',
        })
        return
      }

      pausedDownloadIds.current.delete(build.id)
      autoVerifiedIds.current.delete(build.id)
      pendingProviderLaunchRef.current = null
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
          url: undefined,
          fallbackUrl: undefined,
          sha256: null,
          providerBuild: {
            providerId,
            seasonId,
            ...(options.buildId ? { buildId: options.buildId } : {}),
          },
        },
      }))
      setPhase('idle')
      setLaunchStage(`Updating ${build.season.label} to the live build…`)

      try {
        const result = await syncProviderBuild({
          id: build.id,
          key,
          providerId,
          seasonId,
          ...(options.buildId ? { buildId: options.buildId } : {}),
        })
        const synced: Build = {
          ...build,
          executable: result.executable,
          path: result.folder,
          folderName: result.buildName || build.folderName,
          version: result.buildVersion || build.version,
          placeholder: false,
        }
        setBuilds((prev) =>
          prev.map((item) =>
            item.id === build.id ? { ...synced, addedAt: item.addedAt } : item,
          ),
        )
        setInstalled((prev) => ({ ...prev, [build.id]: true }))
        requestedDiskSizes.current.delete(result.folder)
        setDiskSizes((prev) => ({ ...prev, [result.folder]: result.totalBytes }))
        setActiveId(build.id)
        rememberInstalledBuild(synced, result.folder)
        pushToast({
          tone: 'success',
          title: result.buildVersion
            ? `Updated to the live ${result.buildVersion} build`
            : 'Live build updated',
          description: `${build.season.label} is up to date — launching…`,
        })
        if (options.launchAfter) {
          pendingProviderLaunchRef.current = { build: synced, forceProviderId: providerId }
        } else {
          setLaunchStage(null)
        }
      } catch (error) {
        setLaunchStage(null)
        if (pausedDownloadIds.current.has(build.id)) return
        const message = nativeMessage(error instanceof Error ? error.message : 'The live build could not be downloaded.')
        if (/abort|cancel/i.test(message)) {
          pushToast({ tone: 'info', title: 'Update cancelled', description: build.season.label })
        } else {
          pushToast({ tone: 'error', title: 'Live build update failed', description: message })
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
    (build: Build, options: { launchAfter?: boolean } = {}) => {
      const launchAfter = options.launchAfter === true
      if (!canDownloadBuilds()) {
        pushToast({ tone: 'error', title: 'Downloads need the desktop app', description: 'Run "npm run app".' })
        return
      }

      // Continue must use the source that produced the bytes already on disk,
      // even when the manifest has since changed.
      const paused = downloads[build.id]?.phase === 'paused' ? downloads[build.id] : null
      if (paused?.providerBuild) {
        void beginProviderSync(build, { ...paused.providerBuild, launchAfter })
        return
      }
      if (paused?.url) {
        void beginDownload(build, paused.url, paused.sha256 ?? undefined, paused.fallbackUrl, {
          repair: paused.repair,
          launchAfter: launchAfter || paused.launchAfter === true,
          forceProviderId: paused.forceProviderId,
          preferredFolder: paused.preferredFolder,
          buildVersion: paused.buildVersion,
          providerId: paused.providerId,
          seasonId: paused.seasonId,
          buildId: paused.buildId,
          validateProvider: paused.validateProvider,
        })
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
      if (source?.downloadUrl) {
        void beginDownload(build, source.downloadUrl, source.sha256, source.fallbackDownloadUrl, {
          // A provider-mapped season may have an old nested client on disk;
          // its bundled archive is the exact repair source, not a second copy.
          launchAfter,
          repair: Boolean(source.providerBuild),
          preferredFolder: source.providerBuild ? source.buildVersion || undefined : undefined,
          buildVersion: source.providerBuild ? source.buildVersion || undefined : undefined,
          providerId: source.providerBuild?.providerId,
          seasonId: source.providerBuild?.seasonId || key,
          buildId: source.providerBuild?.buildId,
          validateProvider: Boolean(source.providerBuild?.buildId),
        })
        return
      }
      if (source?.providerBuild) {
        void beginProviderSync(build, { ...source.providerBuild, launchAfter })
        return
      }
      pushToast({
        tone: 'error',
        title: 'No source for this season yet',
        description: 'Add its archive to builds.json, then Refresh sources in Settings.',
      })
    },
    [beginDownload, beginProviderSync, downloads, pushToast, seasonManifest],
  )

  /** One-click repair to the exact live provider build, then Play. */
  const handleUpdateLiveBuild = useCallback(() => {
    const build = activeBuild
    if (!build) return
    const seasonId = artKeyFor(build.season) ?? build.id
    const source = seasonManifest[seasonId]
    const providerId = activeBuildIssue?.providerId || build.onlineProvider?.id
    if (!providerId) {
      pushToast({
        tone: 'error',
        title: 'No online build for this season',
        description: 'VAULTED could not find the online build mapped to this season.',
      })
      return
    }
    // Prefer VAULTED's existing archive downloader for the provider's exact
    // public build. The repair flag lets it replace a season that is already
    // installed, and the preferred folder keeps an old nested 6.31 client from
    // being detected after the 6.21 archive is unpacked beside it.
    if (source?.downloadUrl) {
      void beginDownload(build, source.downloadUrl, source.sha256, source.fallbackDownloadUrl, {
        repair: true,
        launchAfter: true,
        forceProviderId: providerId,
        preferredFolder: source.buildVersion || undefined,
        buildVersion: source.buildVersion || undefined,
        providerId,
        seasonId,
        buildId: activeBuildIssue?.buildId || source.providerBuild?.buildId,
        validateProvider: Boolean(activeBuildIssue?.buildId || source.providerBuild?.buildId),
      })
      return
    }
    void beginProviderSync(build, {
      providerId,
      seasonId,
      buildId: activeBuildIssue?.buildId || source?.providerBuild?.buildId,
      launchAfter: true,
    })
  }, [activeBuild, activeBuildIssue, beginDownload, beginProviderSync, pushToast, seasonManifest])

  /** Show the generic account prompt and remember the Play that should resume. */
  const openAccountPrompt = useCallback(
    (
      build: Build,
      provider: GlobalBackend,
      server?: {
        host: string
        port: number
        name?: string
        seasonId?: string | null
        fallback?: boolean
      },
    ) => {
      accountPromptRef.current = true
      setAccountError(null)
      // The launch has not started yet; clear any prior launching state so the
      // resumed Play is not rejected by startBuild's phase guard.
      setPhase('idle')
      setLaunchStage(null)
      setAccountPrompt({ build, provider, server })
    },
    [],
  )

  /**
   * Run the ordinary managed-build health check before any Play route hands the
   * build to a provider. This is shared by the direct and provider paths so an
   * account resume cannot skip it.
   */
  const runManagedPreflight = useCallback(
    async (build: Build): Promise<boolean> => {
      if (!isManagedBuild(build)) return true
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
        return false
      }
      if (check?.error) {
        setLaunchStage('Health check unavailable — starting Fortnite…')
      }
      return true
    },
    [pushToast],
  )

  /** Launch a downloaded season directly through its bundled provider profile. */
  const startOnlineProvider = useCallback(
    async (
      build: Build,
      provider: GlobalBackend,
      server?: {
        host: string
        port: number
        name?: string
        seasonId?: string | null
        /** true when this target belongs to a different season */
        fallback?: boolean
      },
    ): Promise<boolean> => {
      if (!window.arc?.launchOnlineProvider) {
        pushToast({
          tone: 'error',
          title: 'Online play needs the desktop app',
          description: 'Run "npm run app".',
        })
        return false
      }

      // External launchers stay catalogued for routing, but VAULTED never
      // navigates the player away from the app to a third-party site.
      if (provider.mode === 'external' || provider.external) {
        pushToast({
          tone: 'info',
          title: 'Online play is not available for this season yet',
          description: 'Download the build or choose another season that is online.',
        })
        return false
      }

      const localLauncher = provider.global !== true
      if (!localLauncher && !['oauth', 'deeplink', 'embedded_web'].includes(provider.auth)) {
        pushToast({
          tone: 'info',
          title: 'Sign-in required',
          description: 'Sign in to VAULTED to play this season online.',
        })
        return false
      }
      if (!localLauncher) {
        let oauthSignedIn = Boolean(
          providerAuthRef.current[provider.id]?.signedIn ||
            normalizeProviderId(session?.user.providerId) === provider.id,
        )
        if (!oauthSignedIn) {
          // A provider session may already exist in the encrypted main-process
          // store while the renderer is still starting. Refresh once before
          // asking the player to link the same provider again.
          await refreshProviderAuthStatus()
          oauthSignedIn = Boolean(
            providerAuthRef.current[provider.id]?.signedIn ||
              normalizeProviderId(session?.user.providerId) === provider.id,
          )
        }
        if (!oauthSignedIn) {
          // Every hosted account mode goes through one native prompt. It runs
          // in VAULTED's secure window and then resumes through startBuild so
          // the normal sign-in and managed-preflight gates still apply.
          openAccountPrompt(build, provider, server)
          return false
        }

        // After Discord OAuth succeeds, the account link is the launch
        // authorization. Let the live exchange run instead of reporting a
        // pre-auth "not ready" state.
        const discordAuthorized = provider.discordAuth === true && oauthSignedIn
        if (provider.launchHandshakePending && !discordAuthorized) {
          pushToast({
            tone: 'info',
            title: 'Online play is not ready yet',
            description: 'This season is still connecting. Try again shortly.',
          })
          return false
        }
      }

      const attemptToken = launchAttempts.start(build.id, server ? 'join' : 'host')
      setPhase('launching')
      setLaunchStage('Preparing online play…')
      try {
        const prepared = await window.arc.providerPrepare?.(provider.id)
        if (prepared && !prepared.ok) {
          throw new Error('Online files could not be prepared.')
        }
        setLaunchStage(
          server
            ? server.fallback
              ? `No live ${build.season.label} server — joining ${server.name || server.host}…`
              : 'Joining a public server…'
            : `Starting ${build.season.label} online…`,
        )
        const result = await launchOnlineProvider(build, provider, server)
        if (!result.launched) throw new Error('Online play could not be started.')
        const applied = launchAttempts.commitIfCurrent(attemptToken, () => {
          setRunningId(build.id)
          setPhase('running')
          setLaunchStage(null)
          setLaunchFailure(null)
          setHostedLobby(null)
          shop.sets.recordLaunch(build.id)
          pushToast({
            tone: 'success',
            title: server ? 'Joining a server' : 'Starting online play',
            description: server
              ? server.fallback
                ? `No live ${build.season.label} server — ${server.name || server.host} is a ${seasonLabelForId(server.seasonId)} server.`
                : `${build.season.label} · connecting to ${server.host}:${server.port}`
              : `${build.season.label} is starting online.`,
          })
        })
        // A stale attempt must not trigger the caller's local fallback: another
        // launch already owns this client.
        return applied || result.launched
      } catch (error) {
        launchAttempts.commitIfCurrent(attemptToken, () => {
          const parsedBuildIssue = parseProviderBuildIssue(error)
          const buildIssue = parsedBuildIssue?.issue
          const parsedIssue = parseProviderAccountIssue(error)
          const providerIssue = parsedIssue?.issue
          const message = nativeMessage(
            parsedBuildIssue?.message ||
              parsedIssue?.message ||
              (error instanceof Error ? error.message : 'Online play could not be started.'),
          )
          const verificationUrl =
            providerIssue?.verificationRequired === true
              ? providerIssue.verificationUrl
              : undefined
          setLaunchFailure({
            id: build.id,
            message,
            providerId: provider.id,
            ...(verificationUrl ? { verificationUrl } : {}),
            ...(buildIssue ? { buildIssue } : {}),
          })
          setPhase('error')
          setLaunchStage(null)
          pushToast({
            tone: 'error',
            title: buildIssue
              ? 'Build files need updating'
              : providerIssue?.verificationRequired === true
                ? 'Verification needed'
                : providerIssue
                  ? 'Account needs attention'
                  : 'Launch failed',
            description: message,
          })
        })
        return false
      }
    },
    [
      launchAttempts,
      openAccountPrompt,
      pushToast,
      refreshProviderAuthStatus,
      session?.user.providerId,
      shop.sets,
    ],
  )

  const handleAccountContinue = useCallback(async () => {
    const pending = accountPrompt
    if (!pending || accountBusy) return
    const login = window.arc?.providerAuth?.login
    if (!login) {
      setAccountError('Online account connection needs the desktop app. Run "npm run app".')
      return
    }
    setAccountBusy(true)
    setAccountError(null)
    try {
      // Discord is the preferred method where the backend supports it; other
      // hosted providers use their configured OAuth or embedded flow.
      const status = await login(
        pending.provider.id,
        pending.provider.discordAuth === true ? 'discord' : undefined,
      )
      if (!status?.signedIn) {
        throw new Error('The online account was not connected. Try again.')
      }
      const next = {
        ...providerAuthRef.current,
        [pending.provider.id]: { ...status, providerId: pending.provider.id },
      }
      providerAuthRef.current = next
      setProviderAuthStatus(next)
      accountResumeRef.current = pending
      setAccountPrompt(null)
      accountPromptRef.current = false
      // The resume effect below waits for the signed-in provider to render,
      // then runs the ordinary Play path (sign-in gate + managed preflight).
    } catch (error) {
      accountResumeRef.current = null
      setAccountError(
        nativeMessage(error instanceof Error ? error.message : 'Account connection failed.'),
      )
    } finally {
      setAccountBusy(false)
    }
  }, [accountBusy, accountPrompt])

  const handleAccountCancel = useCallback(() => {
    if (accountBusy) return
    accountResumeRef.current = null
    setAccountPrompt(null)
    setAccountError(null)
    accountPromptRef.current = false
  }, [accountBusy])

  /** Re-scan every configured external directory immediately before Play. */
  const refreshCommunityServers = useCallback(async (): Promise<CommunityServer[]> => {
    const directory = await fetchCommunityDirectory({ token: onlineToken, force: true })
    setCommunityServers(directory.servers)
    setCommunityStatuses(directory.statuses)
    setCommunityDirectories(directory.directories)
    return directory.servers
  }, [onlineToken])

  const startBuild = useCallback(
    async (
      build: Build,
      join?: { host: string; port: number },
      options: { promptOnEmpty?: boolean; forceProviderId?: string } = {},
    ) => {
      const selectedValue = !join ? serverSelections[build.id] : undefined
      const externalChoice = selectedValue?.startsWith('global:')
        ? providerCatalog.find(
            (provider) =>
              provider.mode === 'external' &&
              `global:${provider.id}` === selectedValue,
          ) ?? null
        : null
      // External launcher/community links do not need a VAULTED account or a
      // locally installed build: the provider handles its own sign-in/install.
      if (externalChoice) {
        await startOnlineProvider(build, externalChoice)
        return
      }
      if (!signedIn) {
        setSignInOpen(true)
        return
      }
      if (phase === 'launching') return
      // A paused entry is an invitation to resume, not an active download.
      if (downloads[build.id] && downloads[build.id].phase !== 'paused') return
      // A partially installed build still reports as installed. Resume the
      // saved transfer before the normal Play/provider routing runs.
      if (downloads[build.id]?.phase === 'paused') {
        requestDownload(build, { launchAfter: true })
        return
      }

      if (runningId === build.id) {
        pushToast({ tone: 'info', title: 'Already running', description: `${build.season.label} is open now.` })
        return
      }
      if (runningId) {
        pushToast({
          tone: 'info',
          title: 'Close the running build first',
          description: 'Only one Fortnite client can run at a time.',
        })
        return
      }

      // Downloaded seasons launch directly through their provider. Uninstalled
      // cards stay on the existing Download → Play path.
      if (!installed[build.id]) {
        requestDownload(build, { launchAfter: true })
        return
      }

      localSessionRef.current = null
      setLaunchFailure((current) => (current?.id === build.id ? null : current))

      // providerAuthRef is updated before the account-resume effect runs, so
      // this reads the provider that just signed in without waiting for the
      // state render that invoked this Play.
      const providerIsSignedIn = (provider: GlobalBackend) =>
        provider.auth === 'none' ||
        Boolean(providerAuthRef.current[provider.id]?.signedIn) ||
        Boolean(providerAuthStatus[provider.id]?.signedIn) ||
        (provider.auth === 'oauth' &&
          normalizeProviderId(session?.user.providerId) === provider.id)

      // A provider repair must re-run the live exchange immediately after the
      // archive is installed. Do not let the normal community-server selection
      // route this click away from Era and leave Play without a launch code.
      const forcedProvider = options.forceProviderId
        ? verifiedOAuthProviders.find((provider) => provider.id === options.forceProviderId) ??
          providerCatalog.find((provider) => provider.id === options.forceProviderId) ??
          null
        : null
      if (forcedProvider) {
        if (
          !forcedProvider.external &&
          forcedProvider.mode !== 'external' &&
          providerIsSignedIn(forcedProvider) &&
          !(await runManagedPreflight(build))
        ) {
          return
        }
        const started = await startOnlineProvider(build, forcedProvider)
        if (started) return
        if (accountPromptRef.current) return
        setLaunchStage(null)
        setLaunchFailure((current) =>
          current?.id === build.id
            ? current
            : {
                id: build.id,
                message: 'Online play could not start. Check the build and try Play again.',
              },
        )
        setPhase('error')
        return
      }

      // Refresh backend health at click time, then discover the live server
      // directory. The background poll is only a cache; Auto must not launch a
      // backend that was healthy a minute ago but is down right now.
      let liveStatuses: Record<string, ProviderLiveStatus> | null = null
      if (!join) {
        setLaunchStage('Checking live servers…')
        try {
          liveStatuses = (await window.arc?.providerLiveStatus?.()) ?? null
        } catch {
          /* fall back to the last known provider health */
        }
      }

      // Play always consults the live community directories before choosing a
      // destination. The 20-second background poll is only a cache; this scan
      // makes the click itself check Reboot/Eon/Era/EZFN/Neo/Stellar/Retrac
      // (and any other configured endpoint) instead of acting on stale rows.
      let availableCommunityServers = communityServers
      if (!join) {
        if (communityDiscoveryInFlight.current) return
        communityDiscoveryInFlight.current = true
        setLaunchStage('Checking live servers…')
        try {
          availableCommunityServers = await refreshCommunityServers()
        } catch {
          /* keep the last good scan only when the scan itself fails */
        } finally {
          communityDiscoveryInFlight.current = false
        }
      }

      // One route for relay/manual/external rows. Exact-season rows win; a
      // different-season external row is only a fallback when no global backend
      // is configured for this season.
      const allAvailable = mergeLobbies([
        ...availableCommunityServers,
        ...relayLobbies,
        ...manualLobbies,
      ]) as CommunityServer[]
      const route = routeExternalServer(build, allAvailable)
      const selection = !join ? serverSelections[build.id] : undefined
      const seasonKey = artKeyFor(build.season)
      const globalOptions = seasonKey
        ? nativeProviders.filter((provider) => provider.supportedSeasons.includes(seasonKey))
        : []
      const selectedGlobal = selection?.startsWith('global:')
        ? globalOptions.find((provider) => `global:${provider.id}` === selection) ?? null
        : null
      const selectedIp = selection && !selection.startsWith('global:') ? selection : null
      const preferredIp = selectedIp
        ? allAvailable.find((server) => server.address === selectedIp)
        : undefined
      const providerIsAutoRoutable = (provider: GlobalBackend) =>
        providerCanAutoRoute(
          provider,
          liveStatuses?.[provider.id] ?? provider.live,
          route.exactServer,
        )
      const providerCanRoute = (provider: GlobalBackend) =>
        providerIsSignedIn(provider) ||
        provider.auth === 'oauth' ||
        provider.auth === 'deeplink' ||
        provider.auth === 'embedded_web'
      const autoGlobal =
        globalOptions.find(
          (provider) =>
            providerIsSignedIn(provider) &&
            providerIsAutoRoutable(provider) &&
            provider.id === build.onlineProvider?.id,
        ) ??
        globalOptions.find(
          (provider) =>
            providerCanRoute(provider) &&
            providerIsAutoRoutable(provider) &&
            provider.id === build.onlineProvider?.id,
        ) ??
        globalOptions.find(
          (provider) => providerIsSignedIn(provider) && providerIsAutoRoutable(provider),
        ) ??
        globalOptions.find(
          (provider) => providerCanRoute(provider) && providerIsAutoRoutable(provider),
        ) ??
        null
      const chosen = join
        ? null
        : selectedGlobal
          ? null
          : preferredIp ?? (selectedIp ? null : route.exactServer)
      const target = join ?? (selectedIp ? lobbyTarget(selectedIp) : chosen ? lobbyTarget(chosen.address) : null)
      const chosenIsFallback = Boolean(
        chosen && route.exactOptions.every((server) => server.address !== chosen.address),
      )
      const fallbackNote =
        !join && chosenIsFallback && chosen
          ? `No live ${build.season.label} server — ${chosen.name} is a ${seasonLabelForId(chosen.seasonId)} server.`
          : null
      const globalTarget =
        selectedGlobal?.mode === 'external' ? selectedGlobal : target ? null : selectedGlobal ?? autoGlobal

      // A season without a hosted backend still has a bundled launcher. When a
      // matching live server is selected, start the client through that
      // launcher's redirect profile instead of the generic VAULTED runtime.
      const localLauncher =
        !globalTarget && !selectedGlobal && build.onlineProvider
          ? providerCatalog.find(
              (provider) =>
                provider.id === build.onlineProvider?.id &&
                provider.global !== true &&
                provider.auth === 'none',
            ) ?? null
          : null
      const localServer =
        localLauncher && target && (!chosen || providerMatches(chosen.providerId, localLauncher.id))
          ? {
              ...target,
              name: chosen?.name || (join ? 'Friend lobby' : 'Live server'),
              seasonId: chosen?.seasonId ?? seasonKey,
              fallback: Boolean(fallbackNote),
            }
          : null
      const providerTarget = globalTarget ?? (localServer ? localLauncher : null)

      if (providerTarget) {
        // Do not run a full file scan before asking an unsigned player to
        // connect. Once the account is linked, the resumed Play reaches this
        // branch with a signed-in provider and runs the preflight normally.
        if (providerIsSignedIn(providerTarget) && !(await runManagedPreflight(build))) return
        const started = await startOnlineProvider(
          build,
          providerTarget,
          localServer ??
            (chosen
              ? {
                  ...target!,
                  name: chosen.name,
                  seasonId: chosen.seasonId,
                  fallback: Boolean(fallbackNote),
                }
              : undefined),
        )
        if (started) return
        if (accountPromptRef.current) return
        setLaunchStage(null)
        setLaunchFailure((current) =>
          current?.id === build.id
            ? current
            : {
                id: build.id,
                message: 'Online play could not connect. Try again shortly.',
              },
        )
        setPhase('error')
        return
      }

      // Live-only Play: do not silently start a local lobby when no backend or
      // community server is available. That is the one failure mode this client
      // should surface instead of hiding.
      if (!target) {
        const message = `No live ${build.season.label} server is online right now. Try again shortly.`
        setLaunchFailure({ id: build.id, message })
        setPhase('error')
        setLaunchStage(null)
        pushToast({
          tone: 'error',
          title: 'No live server available',
          description: message,
        })
        return
      }

      setLaunchFailure((current) => (current?.id === build.id ? null : current))

      // Installed downloads get a full automatic preflight. If the files or
      // the shared runtime are broken, explain that instead of handing the
      // client an install that is guaranteed to fail or close immediately.
      if (!(await runManagedPreflight(build))) return

      const attemptToken = launchAttempts.start(build.id, 'join')
      setPhase('launching')
      setLaunchStage(chosen ? `Joining ${chosen.name}…` : 'Joining a live external server…')
      const sourceKey = artKeyFor(build.season)
      const runtimeProfile =
        (sourceKey ? seasonManifest[sourceKey]?.runtimeProfile : undefined) ??
        runtimeProfileFor(build.season.chapter, build.version)

      try {
        await launchBuild(
          build,
          session?.user.username,
          {
            items: inventoryItemsFor(shop.owned),
            equipped: shop.equipped,
          },
          target,
          false,
          runtimeProfile,
          { botFill: false },
        )

        const applied = launchAttempts.commitIfCurrent(attemptToken, () => {
          localSessionRef.current = null
          setRunningId(build.id)
          setPhase('running')
          setLaunchStage(null)
          setLaunchFailure((current) => (current?.id === build.id ? null : current))
          shop.sets.recordLaunch(build.id)
          setHostedLobby(null)
          pushToast({
            tone: 'success',
            title: fallbackNote
              ? `Joining ${chosen?.name || target?.host} (fallback)`
              : `Joining ${chosen?.name || target?.host}`,
            description:
              fallbackNote ??
              `${build.season.label} · your client is pointed at ${target?.host}:${target?.port}.`,
          })
        })
        if (!applied) return
      } catch (error) {
        localSessionRef.current = null
        launchAttempts.commitIfCurrent(attemptToken, () => {
          const message = nativeMessage(
            error instanceof Error ? error.message : 'The client could not be started.',
          )
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
      phase,
      installed,
      requestDownload,
      runManagedPreflight,
      startOnlineProvider,
      pushToast,
      runningId,
      lanIp,
      communityServers,
      relayLobbies,
      manualLobbies,
      verifiedOAuthProviders,
      nativeProviders,
      providerCatalog,
      providerAuthStatus,
      refreshCommunityServers,
      signedIn,
      builds,
      account.username,
      serverSelections,
      seasonManifest,
      session?.user.username,
      session?.user.providerId,
      providerOnly,
      shop.sets,
      shop.owned,
      shop.equipped,
    ],
  )

  useEffect(() => {
    startBuildRef.current = startBuild
  }, [startBuild])

  // Resume the Play that opened the account prompt only after the updated
  // provider session has rendered. startBuild then applies the normal VAULTED
  // sign-in gate, download checks, and managed-build preflight.
  useEffect(() => {
    const pending = accountResumeRef.current
    if (!pending || accountBusy) return
    const signedIn =
      Boolean(providerAuthRef.current[pending.provider.id]?.signedIn) ||
      normalizeProviderId(session?.user.providerId) === pending.provider.id
    if (!signedIn) return
    accountResumeRef.current = null
    void startBuildRef.current?.(
      pending.build,
      pending.server ? { host: pending.server.host, port: pending.server.port } : undefined,
    )
  }, [accountBusy, providerAuthStatus, session?.user.providerId])

  // The provider sync clears its DownloadState in a finally block. Wait for
  // that render before launching, otherwise startBuild would still see the
  // active download and return without starting the freshly repaired build.
  useEffect(() => {
    const pending = pendingProviderLaunchRef.current
    if (!pending) return
    if (downloads[pending.build.id] || !installed[pending.build.id]) return
    pendingProviderLaunchRef.current = null
    void startBuildRef.current?.(pending.build, undefined, {
      promptOnEmpty: true,
      forceProviderId: pending.forceProviderId,
    })
  }, [downloads, installed])

  // A public-lobby join can resolve successfully at the process level and then
  // fail once Fortnite tries to connect. Main watches the client log after the
  // launch; this closes the doomed client and points the player back at the
  // server dropdown instead of starting a server on this PC.
  const handleJoinFailure = useCallback(
    async (payload: { id?: string; host: string; port: number; reason: string }) => {
      if (!payload.id) return
      if (runningId && runningId !== payload.id) return
      const build = builds.find((item) => item.id === payload.id)
      if (!build) return

      await closeBuildProcess(build.id).catch(() => false)
      setRunningId(null)
      setPhase('error')
      setLaunchStage(null)
      setHostedLobby(null)
      setLaunchFailure({
        id: build.id,
        message: `${payload.reason === 'timeout' ? 'That server did not respond' : 'That server closed'} (${payload.host}). Pick another live server and try again.`,
      })
      pushToast({
        tone: 'info',
        title: payload.reason === 'timeout' ? 'That server did not respond' : 'That server closed',
        description: `Choose another live server for ${build.season.label} and press Play again.`,
      })
    },
    [builds, pushToast, runningId],
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
        if (!providerOnly) void clearOnlineLobby(onlineServiceUrlRef.current).catch(() => {})
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

    await startBuild(build, undefined, { promptOnEmpty: true })
  }, [activeBuild, downloads, phase, providerOnly, pushToast, runningId, signedIn, startBuild])

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

      void startBuild(build, undefined, { promptOnEmpty: true })
    },
    [builds, pushToast, runningId, startBuild],
  )

  // Keep the lobby listed while the host is up; the relay drops entries it has
  // not heard from for two minutes.
  useEffect(() => {
    if (providerOnly || !hostedLobby || hostedLobby.publish === false) return
    const endpoint = cloudSettings.onlineServiceUrl.trim()
    if (!endpoint) return
    let closed = false
    const address = `${hostedLobby.address}:${hostedLobby.port}`
    const publish = async () => {
      if (closed) return
      try {
        // The injected server mirrors its live population every second. Publish
        // that count (host + bots + joiners) instead of a permanent "1".
        const status = window.arc?.sessionStatus
          ? await window.arc.sessionStatus().catch(() => null)
          : null
        // The host itself is a real player even before the server DLL has
        // reported its first population sample.
        const players = Math.max(1, Math.floor(status?.players ?? hostedLobby.players ?? 1))
        if (hostedLobby.players !== players) {
          setHostedLobby((current) =>
            current && current.address === hostedLobby.address && current.port === hostedLobby.port
              ? { ...current, players }
              : current,
          )
        }
        // One source, one registration: the configured relay gets the host;
        // no other lobby directory is updated behind the player's back.
        await publishOnlineLobby(endpoint, {
          address,
          buildId: hostedLobby.buildId,
          label: hostedLobby.label,
          public: hostedLobby.public,
          seasonId: hostedLobby.seasonId ?? null,
          players,
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
  }, [cloudSettings.onlineServiceUrl, hostedLobby, providerOnly])

  // A router can finish booting or receive UPnP later than the launch. Keep
  // trying the public mapping while the lobby is only visible on the LAN; once
  // it succeeds, republish the same lobby as an internet lobby automatically.
  useEffect(() => {
    if (!native || !hostedLobby || hostedLobby.public || hostedLobby.publish === false) return
    let cancelled = false
    let announced = false
    const refresh = async () => {
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
        if (!announced) {
          announced = true
          pushToast({
            tone: 'success',
            title: 'Lobby is now public',
            description: `${hostedLobby.label} can be joined over the internet.`,
          })
        }
      } catch {
        /* keep the LAN lobby listed and try again */
      }
    }
    // Try once immediately; the launch-time mapping may have raced the router.
    void refresh()
    const timer = window.setInterval(() => void refresh(), 30_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [hostedLobby, native, pushToast])

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
          const message = nativeMessage(
            error instanceof Error ? error.message : 'The build could not be verified.',
          )
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

  const handleDeleteBuild = useCallback(async (target?: Build) => {
    const build = target ?? activeBuild
    if (!build || !installed[build.id] || deletingId) return
    const managed = isManagedBuild(build)
    const prompt = managed
      ? `Uninstall ${build.season.label} from this PC?\n\nThis permanently deletes the downloaded build and its archive from:\n${build.path}`
      : `Remove ${build.season.label} from VAULTED?\n\nYour existing folder will not be deleted:\n${build.path}`
    if (!window.confirm(prompt)) return

    setDeletingId(build.id)
    try {
      if (managed) {
        const result = await deleteBuild(build.id, build.path)
        if (!result.deleted) {
          pushToast({
            tone: 'error',
            title: result.running ? 'Close the build first' : 'Could not delete this build',
            description: result.running
              ? 'The client is still running. Close it, then try again.'
              : 'VAULTED could not remove that downloaded build folder.',
          })
          return
        }
      }

      setInstalled((prev) => ({ ...prev, [build.id]: false }))
      forgetBuildProfile(build)
      requestedDiskSizes.current.delete(build.path)
      setDiskSizes((prev) => {
        if (!build.path || prev[build.path] === undefined) return prev
        const next = { ...prev }
        delete next[build.path]
        return next
      })
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
        title: managed ? 'Build uninstalled' : 'Removed from VAULTED',
        description: managed
          ? `${build.season.label} and its archive were removed from this PC.`
          : `${build.season.label} was unlinked. Your folder at ${build.path} was not deleted.`,
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

  const handleOpenBuildFolder = useCallback(async (target?: Build) => {
    const folder = target?.path ?? activeBuild?.path
    if (!folder) return
    const result = await openBuildFolder(folder)
    if (!result.ok) {
      pushToast({
        tone: 'error',
        title: 'Could not open that folder',
        description: result.error || 'The install folder may have been moved or deleted.',
      })
    }
  }, [activeBuild?.path, pushToast])

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

  const handleSignInAuthenticated = useCallback(
    (next: RiftSession) => {
      const providerId = normalizeProviderId(next.user.providerId)
      const normalized = providerId
        ? { ...next, user: { ...next.user, providerId } }
        : next
      saveSession(normalized)
      setSession(normalized)
      setSignInOpen(false)
      if (providerId) {
        const previous = providerAuthRef.current[providerId]
        const nextStatuses = {
          ...providerAuthRef.current,
          [providerId]: {
            providerId,
            signedIn: true,
            displayName: normalized.user.username,
            avatarUrl: normalized.user.avatarUrl ?? previous?.avatarUrl ?? null,
            accountId: previous?.accountId ?? null,
            expiresAt: previous?.expiresAt ?? null,
          },
        }
        providerAuthRef.current = nextStatuses
        setProviderAuthStatus(nextStatuses)
        void refreshProviderAuthStatus()
      }
      pushToast({
        tone: 'success',
        title: 'Signed in',
        description: 'Download and Play are unlocked across every season.',
      })
    },
    [pushToast, refreshProviderAuthStatus],
  )

  const handleOpenFriends = useCallback(() => {
    if (!signedIn) {
      setSignInOpen(true)
      return
    }
    if (providerOnly) {
      pushToast({
        tone: 'info',
        title: 'VAULTED account needed',
        description:
          'Friends and the VAULTED relay need a VAULTED account. Global online play is still ready.',
      })
      return
    }
    setView((current) => (current === 'friends' ? 'home' : 'friends'))
  }, [providerOnly, pushToast, signedIn])

  const handleLogout = useCallback(async () => {
    const providerIds = new Set(
      providerCatalog
        .filter(
          (provider) =>
            provider.auth === 'oauth' &&
            (providerAuthStatus[provider.id]?.signedIn || provider.id === session?.user.providerId),
        )
        .map((provider) => provider.id),
    )
    const logout = window.arc?.providerAuth?.logout
    if (logout) {
      await Promise.all([...providerIds].map((providerId) => logout(providerId).catch(() => undefined)))
    }
    if (session) {
      if (providerOnly) clearNetworkSession()
      else await signOut(session.token)
    }
    setSession(null)
    setSignInOpen(false)
    setDrawerOpen(false)
    setDialogOpen(false)
    setView('home')
    if (providerIds.size > 0) void refreshProviderAuthStatus()
  }, [
    providerAuthStatus,
    providerCatalog,
    providerOnly,
    refreshProviderAuthStatus,
    session,
  ])

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
          : phase === 'error' && activeLaunchFailure
            ? 'error'
            : installed[activeBuild.id]
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
  const canVerifyActive = Boolean(
    activeBuild &&
      installed[activeBuild.id] &&
      /vaulted launcher[\\/]+builds[\\/]/i.test(activeBuild.path),
  )
  const canRemoveActive = Boolean(activeBuild && installed[activeBuild.id])

  useEffect(() => {
    if (!session || providerOnly) return
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
          onlineStatus={onlineStatus}
          communityOnline={onlineSeasonCount}
          providerOnly={providerOnly}
          signedIn={signedIn}
          settingsActive={view === 'settings'}
          shopActive={view === 'shop'}
          friendsActive={view === 'friends'}
          friendRequests={friendRequests}
          onOpenLibrary={() => setDrawerOpen(true)}
          onOpenSettings={() => setView((current) => (current === 'settings' ? 'home' : 'settings'))}
          onOpenShop={() => setView((current) => (current === 'shop' ? 'home' : 'shop'))}
          onOpenFriends={handleOpenFriends}
          onSignIn={() => setSignInOpen(true)}
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
              onLinkExistingFolder={() => void handleLinkExistingFolder()}
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
          ) : view === 'friends' && providerOnly ? (
            <section className="m-auto w-full max-w-xl rounded-3xl border border-amber-400/20 bg-ink/80 p-8 text-center shadow-2xl shadow-black/40">
              <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-amber-300">Online account</p>
              <h2 className="mt-3 font-display text-2xl font-semibold tracking-tight text-white">
                Friends and relay stay gated.
              </h2>
              <p className="mx-auto mt-3 max-w-md text-[12.5px] leading-relaxed text-fog">
                You are signed in and global online play is ready. Friends and the VAULTED relay need a VAULTED
                account; VAULTED will not ask for a separate username or password here.
              </p>
              <button
                type="button"
                onClick={() => setView('home')}
                className="mt-6 rounded-xl border border-line bg-white/[0.04] px-4 py-2.5 text-[12px] font-semibold text-mist transition-colors hover:bg-white/[0.08]"
              >
                Back to seasons
              </button>
            </section>
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
                playMode={activePlayMode}
                autoServer={activeServerRoute?.exactServer ?? null}
                autoGlobalBackend={autoGlobalBackend}
                signedIn={signedIn}
                onSignIn={() => setSignInOpen(true)}
                accountAuthRequired={Boolean(
                  activeBuild && installed[activeBuild.id] && activeAccountBackend,
                )}
                accountSignedIn={activeAccountSignedIn}
                onConnectAccount={() => {
                  if (activeBuild && activeAccountBackend) {
                    openAccountPrompt(activeBuild, activeAccountBackend)
                  }
                }}
                account={account}
                sourceKeys={sourceKeys}
                downloadSize={activeDownloadSize}
                diskSize={activeBuild ? diskSizes[activeBuild.path] ?? null : null}
                installed={installed}
                canRemove={canRemoveActive}
                canVerify={canVerifyActive}
                managed={canVerifyActive}
                deleting={deletingId === activeBuild?.id}
                launchStage={launchStage}
                launchError={activeLaunchFailure}
                launchErrorLocal={activeLaunchFailureLocal}
                launchVerificationUrl={activeLaunchVerificationUrl}
                buildVerificationRequired={Boolean(activeBuildIssue)}
                liveBuildVersion={
                  activeBuildIssue?.buildVersion ??
                  (activeKey ? seasonManifest[activeKey]?.buildVersion ?? null : null)
                }
                onUpdateLiveBuild={handleUpdateLiveBuild}
                onRetryLaunch={() => void handlePrimary()}
                hostedLobby={activeBuild && hostedLobby?.buildId === activeBuild.id ? hostedLobby : null}
                verify={activeVerifyJob}
                onVerify={handleVerifyBuild}
                onLocateFolder={() => void handleLinkExistingFolder()}
                onOpenFolder={() => void handleOpenBuildFolder()}
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
                diskSizes={diskSizes}
                activeCounts={activeCounts}
                activeKey={activeKey}
                playModes={playModes}
                downloads={downloads}
                onSelect={handleSelect}
                onAdd={() => setDialogOpen(true)}
                onLinkExisting={() => void handleLinkExistingFolder()}
                onOpenFolder={(build) => void handleOpenBuildFolder(build)}
                onRemove={(build) => void handleDeleteBuild(build)}
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
        diskSizes={diskSizes}
        activeCounts={activeCounts}
        activeKey={activeKey}
        playModes={playModes}
        downloads={downloads}
        onClose={() => setDrawerOpen(false)}
        onSelect={handleSelect}
        onAdd={() => {
          setDrawerOpen(false)
          setDialogOpen(true)
        }}
        onOpenFolder={(build) => void handleOpenBuildFolder(build)}
        onRemove={(build) => void handleDeleteBuild(build)}
      />

      <AddBuildDialog open={dialogOpen} onClose={() => setDialogOpen(false)} onAdd={handleAdd} />

      <SignInModal
        open={signInOpen}
        onClose={() => {
          setSignInOpen(false)
            }}
        onAuthenticated={handleSignInAuthenticated}
      />

      <ConnectAccountModal
        open={Boolean(accountPrompt)}
        busy={accountBusy}
        error={accountError}
        onClose={handleAccountCancel}
        onContinue={() => void handleAccountContinue()}
      />

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  )
}
