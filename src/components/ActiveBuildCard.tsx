import { useState } from 'react'
import {
  ArrowLeftRight,
  Ban,
  Check,
  ChevronDown,
  CircleCheck,
  Download,
  FolderPlus,
  FolderOpen,
  FolderSearch,
  Globe2,
  HardDrive,
  Loader2,
  LogIn,
  Pause,
  Play,
  Plus,
  ShieldCheck,
  Sparkles,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react'
import { AccountChip } from './AccountChip'
import { BuildArt } from './BuildArt'
import { artKeyFor } from '../lib/art'
import { cx } from '../lib/cx'
import { formatDownloadSize, formatSpeed } from '../lib/downloadSize'
import { lobbyPlayers } from '../lib/friends'
import {
  onlinePlayerCount,
  onlineStatusLabel,
  seasonLabelForId,
  seasonServerCount,
  type SeasonPlayMode,
} from '../lib/playMode'
import type { CommunityServer } from '../lib/network'
import type { Account, Build, BuildState, BuildVerifyReport, DownloadState, GlobalBackend } from '../types'

interface ActiveBuildCardProps {
  build: Build | null
  state: BuildState
  download: DownloadState | null
  /** shared live online state for this season */
  playMode?: SeasonPlayMode
  /** every live external server, selected season first */
  serverOptions?: CommunityServer[]
  /** live external servers matching the selected season */
  exactServerOptions?: CommunityServer[]
  /** every other live external server, grouped below the season rows */
  fallbackServerOptions?: CommunityServer[]
  /** best live server for the selected season, shown as the `Auto` entry */
  autoServer?: CommunityServer | null
  /** labelled different-season target Play uses only when the season is empty */
  fallbackServer?: CommunityServer | null
  /** live global OGFN backends that host this season */
  globalBackends?: GlobalBackend[]
  /** backend Play uses automatically when no exact server is live */
  autoGlobalBackend?: GlobalBackend | null
  /** explicitly selected global backend, if any */
  selectedGlobalBackend?: GlobalBackend | null
  /** true when the selected/auto backend already has a launch code this session */
  providerSignedIn?: boolean
  /** manually selected external server address, null = Auto */
  selectedServer?: string | null
  onSelectServer?: (address: string | null) => void
  /** probe and persist a public community ip:port for this season */
  onAddManualServer?: (address: string) => Promise<string | null>
  /** open the provider account-link dialog */
  onProviderSignIn?: (provider: GlobalBackend) => void
  /** whether a VAULTED or verified provider session is active */
  signedIn?: boolean
  /** open the in-app VAULTED sign-in modal */
  onSignIn?: () => void
  account: Account
  sourceKeys?: Set<string>
  downloadSize?: number | null
  /** detected bytes in the installed build folder */
  diskSize?: number | null
  installed?: Record<string, boolean>
  canRemove?: boolean
  canVerify?: boolean
  /** true when VAULTED downloaded this build and may delete its folder */
  managed?: boolean
  deleting?: boolean
  launchStage?: string | null
  /** persistent explanation for a failed launch or unexpected client close */
  launchError?: string | null
  /** local-host fallback: never show it as a raw crash report */
  launchErrorLocal?: boolean
  /** provider account verification URL for an actionable launch failure */
  launchVerificationUrl?: string | null
  onOpenVerification?: (url: string) => void
  onRetryLaunch?: () => void
  /** this PC's currently published lobby, if it is hosting this build */
  hostedLobby?: { address: string; port: number; public: boolean; label: string; players?: number } | null
  verify?: { phase: 'running' | 'done'; report?: BuildVerifyReport; error?: string } | null
  onVerify?: () => void
  /** optional: link a build folder that already exists on this PC */
  onLocateFolder?: () => void
  onOpenFolder?: () => void
  onLogout: () => void
  onPrimary: () => void
  onPauseDownload: () => void
  onCancelDownload: () => void
  onDelete?: () => void
  onChangeBuild: () => void
  onAddBuild: () => void
}

function formatEta(seconds: number | null | undefined): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null
  if (seconds <= 45) return 'Less than a minute left'

  const totalMinutes = Math.max(1, Math.ceil(seconds / 60))
  if (totalMinutes < 60) return `About ${totalMinutes} min left`

  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes === 0 ? `About ${hours} hr left` : `About ${hours} hr ${minutes} min left`
}

function serverPlayerLabel(server: CommunityServer): string {
  if (server.playersKnown === false) return 'players unknown'
  const players = lobbyPlayers(server)
  return `${players} player${players === 1 ? '' : 's'}`
}

function serverPingLabel(server: CommunityServer): string {
  return typeof server.pingMs === 'number' && Number.isFinite(server.pingMs)
    ? `${Math.max(0, Math.round(server.pingMs))} ms`
    : 'ping —'
}

function serverOptionLabel(server: CommunityServer): string {
  const players = lobbyPlayers(server)
  if (server.providerId === 'vaulted' || server.source === 'vaulted-relay') {
    return `${server.username || 'VAULTED'} · VAULTED ONLINE · ${players} PLAYING · ${serverPingLabel(server)}`
  }
  if (server.providerId === 'manual' || server.source === 'manual') {
    return `${server.name} · ${server.address} · SAVED IP · ${players > 0 ? `${players} playing` : 'players unknown'} · ${serverPingLabel(server)}`
  }
  return `${server.name} · ${server.providerLabel || server.providerId} · ${serverPlayerLabel(server)} · ${serverPingLabel(server)}`
}

function globalBadge(provider: GlobalBackend): string {
  return provider.mode === 'global_live' ? 'GLOBAL LIVE' : 'GLOBAL ONLINE'
}

function serverCountLabel(servers: number): string {
  return `${Math.max(0, Math.floor(servers))} ${servers === 1 ? 'server' : 'servers'}`
}

function playerCountLabel(players: number): string {
  return `${Math.max(0, Math.floor(players))} ${players === 1 ? 'player' : 'players'}`
}

function backendCounts(provider: GlobalBackend | null | undefined): {
  servers: number
  players: number
  state: 'live' | 'offline' | 'checking' | 'none'
} {
  if (!provider) return { servers: 0, players: 0, state: 'none' }
  const live = provider.live
  if (!live) return { servers: 1, players: 0, state: 'checking' }
  if (!live.online) return { servers: 0, players: 0, state: 'offline' }
  return {
    servers: Math.max(1, Math.floor(live.servers || 1)),
    players: Math.max(0, Math.floor(live.players ?? 0)),
    state: 'live',
  }
}

function backendPingLabel(provider: GlobalBackend): string {
  const ping = provider.live?.pingMs
  return typeof ping === 'number' && Number.isFinite(ping) ? `${Math.max(0, Math.round(ping))} ms` : 'ping —'
}

function globalOptionLabel(provider: GlobalBackend): string {
  const account = provider.auth === 'none' ? '' : ' · sign-in required'
  const counts = backendCounts(provider)
  const state =
    counts.state === 'offline'
      ? 'OFFLINE'
      : counts.state === 'checking'
        ? 'CHECKING LIVE STATUS'
        : globalBadge(provider)
  return `${state} · ${provider.label} · ${serverCountLabel(counts.servers)} · ${playerCountLabel(counts.players)} · ${backendPingLabel(provider)}${account}`
}

const STATE_PILL: Record<BuildState, { label: string; dot: string; text: string }> = {
  missing: { label: 'Not installed', dot: 'bg-amber-400', text: 'text-amber-300' },
  downloading: { label: 'Downloading', dot: 'bg-emerald-400', text: 'text-emerald-300' },
  paused: { label: 'Paused', dot: 'bg-amber-400', text: 'text-amber-300' },
  ready: { label: 'Ready', dot: 'bg-emerald-400', text: 'text-emerald-300' },
  launching: { label: 'Launching', dot: 'bg-amber-400', text: 'text-amber-300' },
  running: { label: 'Running', dot: 'bg-rose-400', text: 'text-rose-300' },
  error: { label: 'Failed', dot: 'bg-rose-400', text: 'text-rose-300' },
}

export function ActiveBuildCard({
  build,
  state,
  download,
  playMode,
  serverOptions,
  exactServerOptions,
  fallbackServerOptions,
  autoServer,
  fallbackServer,
  globalBackends,
  autoGlobalBackend,
  selectedGlobalBackend,
  providerSignedIn,
  selectedServer,
  onSelectServer,
  onAddManualServer,
  onProviderSignIn,
  signedIn = true,
  onSignIn,
  account,
  sourceKeys,
  downloadSize,
  diskSize,
  installed,
  canRemove,
  canVerify,
  managed,
  deleting,
  launchStage,
  launchError,
  launchErrorLocal,
  launchVerificationUrl,
  onOpenVerification,
  onRetryLaunch,
  hostedLobby,
  verify,
  onVerify,
  onLocateFolder,
  onOpenFolder,
  onLogout,
  onPrimary,
  onPauseDownload,
  onCancelDownload,
  onDelete,
  onChangeBuild,
  onAddBuild,
}: ActiveBuildCardProps) {
  const [addingServer, setAddingServer] = useState(false)
  const [serverAddress, setServerAddress] = useState('')
  const [serverBusy, setServerBusy] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

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
  const busy = state === 'launching' || state === 'downloading'
  const verificationRequired = Boolean(launchVerificationUrl)
  const pill = verificationRequired
    ? { label: 'Verification needed', dot: 'bg-amber-400', text: 'text-amber-300' }
    : launchErrorLocal
      ? { label: 'Unavailable', dot: 'bg-amber-400', text: 'text-amber-300' }
      : STATE_PILL[state]
  const isOnlineProvider = Boolean(build.onlineProvider)
  const showLocateExisting = !busy && state !== 'running' && !isOnlineProvider
  const isInstalled = Boolean(installed?.[build.id])
  const signedOut = signedIn === false
  const requiresSignIn = signedOut && ['missing', 'paused', 'ready', 'error'].includes(state)
  const signInTarget = isInstalled ? 'Play' : 'Download'

  const hasDownloadSource = Boolean(artKeyFor(season) && sourceKeys?.has(artKeyFor(season)!))
  const etaLabel = download?.phase === 'downloading' ? formatEta(download.etaSeconds) : null
  const speedLabel = download?.phase === 'downloading' ? formatSpeed(download.speedBytesPerSecond) : null
  const rateLabel = [speedLabel, etaLabel].filter(Boolean).join(' · ') || null
  const downloadSizeLabel = downloadSize ? formatDownloadSize(downloadSize) : null
  const showRemove = Boolean(canRemove && isInstalled && !busy && state !== 'running' && onDelete)
  const showVerify = Boolean(canVerify && isInstalled && !busy && state !== 'running' && onVerify)
  const showOpenFolder = Boolean(isInstalled && onOpenFolder)
  // The hero and the sidebar read the same map. The hosted fallback keeps this
  // card correct if it is rendered in isolation during a transition.
  const activeGlobalBackend = selectedGlobalBackend ?? autoGlobalBackend ?? null
  const onlineProviderLabel =
    activeGlobalBackend?.label ||
    playMode?.providerLabel ||
    build.onlineProvider?.label ||
    build.onlineProvider?.name ||
    build.providerLabel
  const onlinePlayers = onlinePlayerCount(playMode)
  const onlineServers = seasonServerCount(playMode)
  const activeGlobalBadge = activeGlobalBackend ? globalBadge(activeGlobalBackend) : 'GLOBAL ONLINE'
  const exactOptions = exactServerOptions ?? serverOptions ?? []
  const otherOptions = fallbackServerOptions ?? []
  const globalOptions = globalBackends ?? []
  const allServerOptions = [...exactOptions, ...otherOptions]
  const selectedIpServer = !selectedGlobalBackend && selectedServer
    ? allServerOptions.find((server) => server.address === selectedServer) ?? null
    : null
  const selectedBackend = selectedGlobalBackend ?? autoGlobalBackend
  const selectedBackendCounts = backendCounts(selectedBackend)
  const autoRouteBackendCounts = backendCounts(autoGlobalBackend)
  const autoOptionGlobalBackend = autoServer ? null : autoGlobalBackend ?? selectedGlobalBackend
  const autoOptionBackendCounts = autoGlobalBackend ? autoRouteBackendCounts : selectedBackendCounts
  // The hero pill follows the exact row currently selected. Auto follows the
  // real route Auto would take; only a true season-wide Auto shows the sum.
  let liveServers = onlineServers
  let livePlayers = onlinePlayers
  if (selectedGlobalBackend) {
    liveServers = selectedBackendCounts.servers
    livePlayers = selectedBackendCounts.players
  } else if (selectedServer) {
    liveServers = selectedIpServer ? 1 : 0
    livePlayers = selectedIpServer ? lobbyPlayers(selectedIpServer) : 0
  } else if (autoServer) {
    liveServers = 1
    livePlayers = lobbyPlayers(autoServer)
  } else if (activeGlobalBackend) {
    liveServers = autoRouteBackendCounts.servers
    livePlayers = autoRouteBackendCounts.players
  } else if (fallbackServer) {
    liveServers = 1
    livePlayers = lobbyPlayers(fallbackServer)
  }
  const activeBackendOffline = activeGlobalBackend?.live?.online === false
  const onlineStatus = activeBackendOffline
    ? `${activeGlobalBadge} · ${activeGlobalBackend.label} · OFFLINE`
    : onlineStatusLabel(livePlayers, liveServers)
  const lobbyCount = playMode?.lobbyCount ?? (hostedLobby?.public ? 1 : 0)
  const playerCount = playMode?.playerCount ?? (hostedLobby?.public ? Math.max(0, hostedLobby.players ?? 0) : 0)
  const communityPlayers = playMode?.communityPlayerCount ?? 0
  const communityProviderLabel = playMode?.communityProviderLabel
  const directoryProviders = playMode?.directoryProviders ?? []
  const communityDetail = [
    communityPlayers > 0
      ? `${communityProviderLabel || 'A community directory'} reports ${communityPlayers} player${communityPlayers === 1 ? '' : 's'}.`
      : '',
    directoryProviders.length > 0 ? `Directories list ${directoryProviders.join(', ')} for this season.` : '',
  ]
    .filter(Boolean)
    .join(' ')
  async function submitManualServer() {
    if (!onAddManualServer || serverBusy) return
    const address = serverAddress.trim()
    if (!address) return
    setServerBusy(true)
    setServerError(null)
    try {
      const error = await onAddManualServer(address)
      if (error) {
        setServerError(error)
        return
      }
      setAddingServer(false)
      setServerAddress('')
    } catch (error) {
      setServerError(error instanceof Error ? error.message : 'The server could not be added.')
    } finally {
      setServerBusy(false)
    }
  }

  const verifyReport = verify?.report
  const verifyIssues = verifyReport
    ? [
        ['Missing', verifyReport.issues.missing],
        ['Empty files', verifyReport.issues.empty],
        ['Unreadable', verifyReport.issues.unreadable],
        ['Leftover temp files', verifyReport.issues.temp],
        ['Corrupt PAK data', verifyReport.issues.corrupt],
        ['Runtime files', verifyReport.issues.runtime],
      ].filter((entry) => (entry[1] as string[]).length > 0)
    : []

  const statePrimary = {
    missing: hasDownloadSource
      ? {
          label: `Download ${season.label}${downloadSizeLabel ? ` · ${downloadSizeLabel}` : ''}`,
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
    paused: {
      label:
        download?.percent != null
          ? `Continue download · ${download.percent}%`
          : 'Continue download',
      icon: Download,
      background: 'linear-gradient(120deg, #fbbf24, #d97706)',
      glow: 'rgba(251,191,36,0.5)',
    },
    downloading: {
      label:
        download?.phase === 'extracting'
          ? 'Unpacking…'
          : download?.phase === 'verifying'
            ? 'Verifying checksum…'
            : download?.percent != null
            ? rateLabel
              ? `Downloading… ${download.percent}% · ${rateLabel}`
              : `Downloading… ${download.percent}%`
            : 'Downloading…',
      icon: Loader2,
      background: 'linear-gradient(120deg, #10b981, #047857)',
      glow: 'rgba(16,185,129,0.45)',
    },
    ready: {
      label: 'Play',
      icon: Play,
      background: 'linear-gradient(120deg, #34d399, #059669)',
      glow: 'rgba(16,185,129,0.55)',
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

  const primary = requiresSignIn
    ? {
        label: `Sign in to ${signInTarget}`,
        icon: LogIn,
        background: 'linear-gradient(120deg, #4b5563, #374151)',
        glow: 'rgba(75,85,99,0.35)',
      }
    : statePrimary
  const primaryBusy = busy && !requiresSignIn
  const primaryDisabled = !requiresSignIn && (busy || (state === 'missing' && !hasDownloadSource))

  const PrimaryIcon = primary.icon

  const statusText: Record<BuildState, string> = {
    missing: hasDownloadSource
      ? downloadSizeLabel
        ? `Not on this PC yet — ${downloadSizeLabel} download.`
        : 'Not on this PC yet — download it to play.'
      : 'Not on this PC, and no download source for this season.',
    paused:
      download?.percent != null
        ? `Download paused at ${download.percent}% — continue where it left off.`
        : 'Download paused — continue where it left off.',
    downloading:
      download?.phase === 'extracting'
        ? 'Unpacking the build…'
        : download?.phase === 'verifying'
          ? 'Verifying the archive checksum…'
          : 'Downloading the build…',
    ready: onlineProviderLabel
      ? activeGlobalBackend && (selectedGlobalBackend || (!autoServer && !selectedIpServer))
        ? activeBackendOffline
          ? `Ready — ${activeGlobalBackend.label} is offline. Pick another backend or server and try again.`
          : `Ready — ${activeGlobalBadge} on ${activeGlobalBackend.label}. ${serverCountLabel(liveServers)} · ${playerCountLabel(livePlayers)} live. Play queues you with real players worldwide.`
        : liveServers > 0
          ? `Ready — ${serverCountLabel(liveServers)} · ${playerCountLabel(livePlayers)} live.${autoServer ? ` Auto joins ${autoServer.name}.` : ''}`
          : fallbackServer
            ? `Ready — no live ${build.season.label} server. Play falls back to ${fallbackServer.name} (${seasonLabelForId(fallbackServer.seasonId)}).`
            : 'Ready — no real players are on live external servers for this season right now.'
      : lobbyCount > 0
        ? `Ready — ${lobbyCount} reachable VAULTED ${lobbyCount === 1 ? 'lobby' : 'lobbies'} online${playerCount > 0 ? ` · ${playerCount} player${playerCount === 1 ? '' : 's'}` : ''}. Play joins one automatically.`
        : livePlayers > 0
          ? `Ready — ${livePlayers} player${livePlayers === 1 ? '' : 's'} playing online.`
          : 'Ready — online play is ready.',
    launching: launchStage ?? 'Fortnite is starting. Have fun.',
    running: hostedLobby
      ? hostedLobby.public
        ? `Fortnite is running — your lobby is public at ${hostedLobby.address}:${hostedLobby.port}.`
        : 'Fortnite is running — your lobby is WiFi-only. Forward UDP 7777 or use a tunnel in Settings for internet play.'
      : 'Fortnite is running. Have fun.',
    error: verificationRequired
      ? 'Account verification is required before the provider will issue a launch code.'
      : launchErrorLocal
        ? 'No live external server was available — pick another server or try again.'
        : 'Could not start the client. Check the build path and try again.',
  }

  return (
    <section className="relative isolate flex h-full flex-col overflow-hidden rounded-3xl border border-line bg-panel shadow-[0_30px_80px_-40px_rgba(0,0,0,0.9)]">
      <BuildArt season={season} />

      <div className="relative flex min-h-0 flex-1 flex-col p-6 sm:p-8 xl:p-10">
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="flex min-h-full flex-col">
        {/* top row */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/35 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-mist/90 backdrop-blur">
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: season.accent.glow, boxShadow: `0 0 12px ${season.accent.glow}` }}
              />
              Season · {season.short}
            </span>
            {build.version && (
              <span className="inline-flex items-center rounded-full border border-white/10 bg-black/35 px-2.5 py-1.5 font-mono text-[10.5px] font-semibold text-mist/80 backdrop-blur">
                v{build.version}
              </span>
            )}
            {onlineProviderLabel && (
              <span
                title={`Provider: ${onlineProviderLabel}`}
                className="inline-flex items-center rounded-full border border-arc/25 bg-arc/[0.1] px-2.5 py-1.5 text-[10.5px] font-semibold text-arc backdrop-blur"
              >
                {onlineProviderLabel}
              </span>
            )}
            <span
              title={
                `${onlineStatus}${onlineProviderLabel ? ` · ${onlineProviderLabel}` : ''}.${communityDetail ? ` ${communityDetail}` : ''}`
              }
              aria-label={`Online status: ${onlineStatus}`}
              className={cx(
                'inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full border px-3 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.14em] text-emerald-200 backdrop-blur',
                livePlayers > 0
                  ? 'border-emerald-300/50 bg-emerald-400/[0.18] shadow-[0_0_26px_rgba(16,185,129,0.22)]'
                  : 'border-emerald-400/35 bg-emerald-400/[0.12] shadow-[0_0_22px_rgba(16,185,129,0.14)]',
              )}
            >
              <span
                className={cx(
                  'h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.95)]',
                  livePlayers > 0 && 'animate-pulse',
                )}
              />
              {onlineStatus}
            </span>
            {directoryProviders.length > 0 && (
              <span
                title={`External directories list ${directoryProviders.join(', ')} for this season.`}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[10.5px] text-mist/80 backdrop-blur"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-white/40" />
                Listed by {directoryProviders.join(' / ')}
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {activeGlobalBackend &&
              activeGlobalBackend.auth === 'oauth' &&
              !providerSignedIn &&
              onProviderSignIn && (
                <button
                  type="button"
                  onClick={() => {
                    if (signedOut) onSignIn?.()
                    else onProviderSignIn(activeGlobalBackend)
                  }}
                  className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/35 bg-emerald-400/[0.1] px-3 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.1em] text-emerald-200 backdrop-blur transition-colors hover:border-emerald-400/65 hover:bg-emerald-400/20 hover:text-white"
                >
                  <Globe2 className="h-3.5 w-3.5" />
                  Sign in to {activeGlobalBackend.label}
                </button>
              )}
            {signedOut ? (
              <button
                type="button"
                onClick={onSignIn}
                className="inline-flex items-center gap-2 rounded-2xl border border-emerald-400/35 bg-emerald-400/[0.1] px-3 py-2 text-[12px] font-semibold text-emerald-100 transition-colors duration-200 hover:border-emerald-400/65 hover:bg-emerald-400/15 hover:text-white"
              >
                <LogIn className="h-4 w-4" /> Sign in
              </button>
            ) : (
              <span onClick={(event) => event.stopPropagation()}>
                <AccountChip account={account} onLogout={onLogout} />
              </span>
            )}
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
          </p>

          {isInstalled && (
            <div className="mt-4 flex max-w-xl items-center gap-2 rounded-xl border border-emerald-400/20 bg-black/25 px-3 py-2 text-[10.5px] text-fog backdrop-blur">
              <HardDrive className="h-3.5 w-3.5 shrink-0 text-emerald-300" />
              <span className="shrink-0 font-mono font-semibold text-emerald-100">
                {diskSize != null ? formatDownloadSize(diskSize) : 'Detecting size…'}
              </span>
              <span className="text-fog/40">·</span>
              <span className="min-w-0 truncate font-mono text-mist/75" title={build.path}>
                {build.path}
              </span>
            </div>
          )}

          {onSelectServer && (
            <div className="mt-4 max-w-xl rounded-2xl border border-white/10 bg-black/25 px-3 py-2.5 backdrop-blur">
              <div className="flex items-center justify-between gap-3">
                <label
                  htmlFor={`server-select-${build.id}`}
                  className="text-[9.5px] font-bold uppercase tracking-[0.18em] text-fog"
                >
                  Server
                </label>
                <span
                  aria-live="polite"
                  className="inline-flex items-center gap-1.5 text-[10px] font-medium text-emerald-300/90"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]" />
                  {liveServers} {liveServers === 1 ? 'server' : 'servers'} · {livePlayers}{' '}
                  {livePlayers === 1 ? 'player' : 'players'}
                </span>
              </div>
              <div className="relative mt-1.5">
                <select
                  id={`server-select-${build.id}`}
                  value={selectedServer ?? ''}
                  onChange={(event) => onSelectServer(event.target.value || null)}
                  disabled={globalOptions.length === 0 && (!serverOptions || serverOptions.length === 0)}
                  className="w-full appearance-none rounded-xl border border-white/10 bg-[#0b131c]/90 py-2 pl-3 pr-9 text-[12px] font-medium text-mist outline-none transition-colors duration-200 hover:border-emerald-400/40 focus:border-emerald-400/60 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  <option value="" className="bg-ink text-mist">
                    {autoServer
                      ? `Auto: Best Live Server (${autoServer.name} · ${autoServer.providerLabel || autoServer.providerId} · ${serverCountLabel(1)} · ${serverPlayerLabel(autoServer)} · ${serverPingLabel(autoServer)})`
                      : autoOptionGlobalBackend
                        ? `Auto: Global Matchmaking (${autoOptionGlobalBackend.label} · ${serverCountLabel(autoOptionBackendCounts.servers)} · ${playerCountLabel(autoOptionBackendCounts.players)} · ${backendPingLabel(autoOptionGlobalBackend)})`
                        : fallbackServer
                          ? `Auto: Best Fallback (${fallbackServer.name} · ${fallbackServer.providerLabel || fallbackServer.providerId} · ${seasonLabelForId(fallbackServer.seasonId)} · ${serverPlayerLabel(fallbackServer)} · ${serverPingLabel(fallbackServer)})`
                          : 'Auto: Start a VAULTED public lobby'}
                  </option>
                  {globalOptions.length > 0 && (
                    <optgroup label="Live global backends">
                      {globalOptions.map((provider) => (
                        <option
                          key={`global-${provider.id}`}
                          value={`global:${provider.id}`}
                          className="bg-ink text-mist"
                        >
                          {globalOptionLabel(provider)}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {exactOptions.length > 0 && (
                    <optgroup label="Live servers · selected season">
                      {exactOptions.map((server) => (
                        <option
                          key={`${server.address}-${server.id}`}
                          value={server.address}
                          className="bg-ink text-mist"
                        >
                          {serverOptionLabel(server)}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {otherOptions.length > 0 && (
                    <optgroup label="Other live servers · different season">
                      {otherOptions.map((server) => (
                        <option
                          key={`${server.address}-${server.id}`}
                          value={server.address}
                          className="bg-ink text-mist"
                        >
                          {server.name} · {server.providerLabel || server.providerId} ·{' '}
                          {seasonLabelForId(server.seasonId)} · {serverPlayerLabel(server)} ·{' '}
                          {serverPingLabel(server)}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fog" />
              </div>
              <p className="mt-1.5 text-[10px] leading-relaxed text-fog/75">
                {selectedGlobalBackend
                  ? `Play connects to ${selectedGlobalBackend.name}'s live global backend. ${
                      selectedGlobalBackend.auth === 'oauth'
                        ? 'Sign in once; VAULTED requests a fresh game code automatically on every Play.'
                        : 'No account link is required.'
                    }`
                  : selectedServer
                    ? `Play joins ${selectedServer} directly. The same address is saved for ${season.label}.`
                    : autoServer
                      ? `Play joins ${autoServer.address} with Auto. Friends can pick the same VAULTED lobby to land in the same match.`
                      : activeGlobalBackend
                        ? `No exact-season IP lobby is live. Auto queues for ${activeGlobalBackend.name} global matchmaking with real players.`
                        : fallbackServer
                          ? `No live ${season.label} server — Auto uses ${fallbackServer.name} (${seasonLabelForId(fallbackServer.seasonId)}). Pick any live server below or press Play.`
                          : `No live ${season.label} server right now. Play starts a VAULTED public lobby and publishes it for other players.`}
              </p>

              {activeGlobalBackend &&
                activeGlobalBackend.auth === 'oauth' &&
                !providerSignedIn &&
                onProviderSignIn && (
                  <button
                    type="button"
                    onClick={() => {
                      if (signedOut) onSignIn?.()
                      else onProviderSignIn(activeGlobalBackend)
                    }}
                    className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-emerald-400/35 bg-emerald-400/[0.09] px-3 py-2 text-[11px] font-bold uppercase tracking-[0.08em] text-emerald-200 transition-colors duration-200 hover:border-emerald-400/65 hover:bg-emerald-400/15 hover:text-white"
                  >
                    <Globe2 className="h-3.5 w-3.5" />
                    Sign in to {activeGlobalBackend.label}
                  </button>
                )}

              {onAddManualServer && (
                <div className="mt-2 border-t border-white/10 pt-2">
                  {!addingServer ? (
                    <button
                      type="button"
                      onClick={() => {
                        setAddingServer(true)
                        setServerError(null)
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg px-1 py-1 text-[10.5px] font-semibold text-emerald-300/90 transition-colors duration-200 hover:text-emerald-200"
                    >
                      <Plus className="h-3 w-3" />
                      Add Server IP
                    </button>
                  ) : (
                    <div>
                      <div className="flex items-center gap-1.5">
                        <input
                          value={serverAddress}
                          onChange={(event) => {
                            setServerAddress(event.target.value)
                            setServerError(null)
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && !serverBusy) {
                              event.preventDefault()
                              void submitManualServer()
                            }
                          }}
                          autoFocus
                          spellCheck={false}
                          placeholder="play.example.com:7777"
                          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/50 px-2.5 py-2 font-mono text-[11px] text-mist placeholder:text-fog/45 focus:border-emerald-400/60 focus:outline-none"
                        />
                        <button
                          type="button"
                          disabled={serverBusy || !serverAddress.trim()}
                          onClick={() => void submitManualServer()}
                          className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-emerald-400/35 bg-emerald-400/10 px-2.5 py-2 text-[10.5px] font-bold text-emerald-200 transition-colors hover:bg-emerald-400/20 disabled:cursor-wait disabled:opacity-60"
                        >
                          {serverBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                          {serverBusy ? 'Probing…' : 'Add'}
                        </button>
                        <button
                          type="button"
                          disabled={serverBusy}
                          onClick={() => {
                            setAddingServer(false)
                            setServerError(null)
                          }}
                          aria-label="Cancel adding a server"
                          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-fog transition-colors hover:bg-white/10 hover:text-white"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      {serverError && <p className="mt-1.5 text-[10px] leading-relaxed text-rose-300">{serverError}</p>}
                    </div>
                  )}
                </div>
              )}
              {!selectedServer && fallbackServer && (
                <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-400/25 bg-amber-400/[0.07] px-2.5 py-2 text-[10px] leading-relaxed text-amber-100/90">
                  <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>
                    <span className="font-semibold uppercase tracking-[0.08em]">Fallback Play target</span>
                    {' · '}
                    {fallbackServer.name} ({seasonLabelForId(fallbackServer.seasonId)}) ·{' '}
                    {serverPlayerLabel(fallbackServer)}
                    {' — '}no live {season.label} server.
                  </span>
                </div>
              )}
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {hostedLobby ? (
              <span
                className={cx(
                  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10.5px] font-semibold',
                  hostedLobby.public
                    ? 'border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-100'
                    : 'border-amber-400/30 bg-amber-400/[0.08] text-amber-100',
                )}
                title={hostedLobby.public ? 'Reachable from the internet' : 'Only reachable by players on this WiFi'}
              >
                <span
                  className={cx(
                    'h-1.5 w-1.5 rounded-full',
                    hostedLobby.public ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]' : 'bg-amber-400',
                  )}
                />
                {hostedLobby.public ? 'Your lobby is public' : 'Your lobby is WiFi-only'} ·{' '}
                {hostedLobby.address}:{hostedLobby.port}
              </span>
            ) : liveServers > 0 ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/25 bg-emerald-400/[0.08] px-2.5 py-1 text-[10.5px] font-semibold text-emerald-100">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]" />
                {liveServers} live {liveServers === 1 ? 'server' : 'servers'} online
                {livePlayers > 0 ? ` · ${livePlayers} player${livePlayers === 1 ? '' : 's'}` : ''}
              </span>
            ) : null}
          </div>
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
                  {download.phase === 'paused'
                    ? 'Interrupted — your partial download is kept'
                    : download.phase === 'extracting'
                      ? 'Unpacking archive…'
                      : download.phase === 'verifying'
                        ? 'Verifying checksum…'
                        : rateLabel
                          ? `Downloading build… · ${rateLabel}`
                          : 'Downloading build…'}
                </span>
                <span className="font-mono font-semibold text-emerald-300">
                  {download.percent != null ? `${download.percent}%` : '…'}
                </span>
              </div>
            </div>
          )}

          {verify && (
            <div
              className={cx(
                'mb-3 rounded-2xl border px-3.5 py-3 text-[11.5px] leading-relaxed backdrop-blur',
                verify.phase === 'running'
                  ? 'border-arc/30 bg-arc/[0.08] text-mist'
                  : verify.error || (verifyReport && !verifyReport.verified)
                    ? 'border-rose-400/30 bg-rose-500/[0.08] text-rose-100'
                    : 'border-emerald-400/30 bg-emerald-400/[0.07] text-emerald-100',
              )}
              role="status"
              aria-live="polite"
            >
              <div className="flex items-start gap-2">
                {verify.phase === 'running' ? (
                  <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-arc" />
                ) : verify.error || (verifyReport && !verifyReport.verified) ? (
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" />
                ) : (
                  <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">
                    {verify.phase === 'running'
                      ? 'Scanning every file…'
                      : verify.error
                        ? 'Verify could not finish'
                        : verifyReport?.verified
                          ? 'All files verified — no corruption found'
                          : `${verifyReport?.issueCount ?? 0} problem${verifyReport?.issueCount === 1 ? '' : 's'} found`}
                  </p>
                  {verify.phase === 'running' ? (
                    <p className="mt-0.5 text-[10.5px] text-fog">
                      Checking executables, PAK files, empty files, the shared runtime and every folder in this install.
                    </p>
                  ) : verify.error ? (
                    <p className="mt-0.5 text-[10.5px] text-rose-200/80">{verify.error}</p>
                  ) : verifyReport ? (
                    <>
                      <p className="mt-0.5 font-mono text-[10px] text-fog">
                        {verifyReport.files.toLocaleString()} files · {formatDownloadSize(verifyReport.bytes)} ·{' '}
                        {verifyReport.paks.toLocaleString()} PAK files ·{' '}
                        {(verifyReport.elapsedMs / 1000).toFixed(1)}s
                      </p>
                      {verifyIssues.length > 0 && (
                        <div className="mt-2 max-h-28 space-y-1.5 overflow-y-auto pr-1">
                          {verifyIssues.map(([label, paths]) => (
                            <div key={String(label)}>
                              <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-rose-300">
                                {String(label)} · {(paths as string[]).length}
                              </p>
                              {(paths as string[]).slice(0, 6).map((path) => (
                                <p key={path} className="truncate font-mono text-[9.5px] text-rose-100/75" title={path}>
                                  {path}
                                </p>
                              ))}
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  ) : null}
                </div>
              </div>
            </div>
          )}

          {launchError && (
            <div
              className={cx(
                'mb-3 rounded-2xl border px-3.5 py-3 text-[11.5px] leading-relaxed backdrop-blur',
                verificationRequired
                  ? 'border-amber-400/35 bg-amber-400/[0.08] text-amber-100'
                  : launchErrorLocal
                    ? 'border-amber-400/30 bg-amber-400/[0.07] text-amber-100'
                    : 'border-rose-400/30 bg-rose-500/[0.08] text-rose-100',
              )}
              role={verificationRequired || launchErrorLocal ? 'status' : 'alert'}
            >
              <div className="flex items-start gap-2">
                <TriangleAlert
                  className={cx(
                    'mt-0.5 h-4 w-4 shrink-0',
                    verificationRequired || launchErrorLocal ? 'text-amber-300' : 'text-rose-300',
                  )}
                />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">
                    {verificationRequired
                      ? 'Account verification needed'
                      : launchErrorLocal
                        ? 'Local match unavailable'
                        : 'Why the last launch stopped'}
                  </p>
                  <p
                    className={cx(
                      'mt-1 break-words',
                      verificationRequired
                        ? 'text-[11px] leading-relaxed text-amber-100/90'
                        : launchErrorLocal
                          ? 'text-[11px] text-amber-100/85'
                          : 'max-h-40 overflow-y-auto whitespace-pre-wrap font-mono text-[9.5px] leading-relaxed text-rose-100/80',
                    )}
                  >
                    {launchError}
                  </p>
                  {verificationRequired && launchVerificationUrl && onOpenVerification && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => onOpenVerification(launchVerificationUrl)}
                        title={`Open ${launchVerificationUrl}`}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300/40 bg-amber-300/15 px-2.5 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.05em] text-amber-100 transition-colors duration-200 hover:border-amber-200/70 hover:bg-amber-300/25 hover:text-white"
                      >
                        <Globe2 className="h-3.5 w-3.5" />
                        Open {build.onlineProvider?.name || build.onlineProvider?.label || 'verification page'}
                      </button>
                      {onRetryLaunch && (
                        <button
                          type="button"
                          onClick={onRetryLaunch}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/[0.06] px-2.5 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.05em] text-mist transition-colors duration-200 hover:border-white/30 hover:bg-white/[0.12] hover:text-white"
                        >
                          <Play className="h-3.5 w-3.5" />
                          Retry launch
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 text-[12.5px]">
            {state === 'error' ? (
              <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-rose-300" />
            ) : busy ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-300" />
            ) : state === 'paused' ? (
              <Download className="h-3.5 w-3.5 shrink-0 text-amber-300" />
            ) : state === 'running' ? (
              <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-300" />
            ) : state === 'missing' ? (
              <Download className="h-3.5 w-3.5 shrink-0 text-amber-300" />
            ) : (
              <Check className="h-3.5 w-3.5 shrink-0 text-emerald-300" />
            )}
            <p className={cx('transition-colors duration-300', pill.text)}>{statusText[state]}</p>
          </div>
        </div>
      </div>
        </div>

      {/* actions stay outside the scroll area so a long error log cannot hide them */}
      <div className="relative shrink-0 pt-4">
        <div className="rounded-2xl border border-white/10 bg-ink/90 p-2 shadow-[0_36px_70px_-22px_rgba(0,0,0,0.95),0_10px_26px_-12px_rgba(0,0,0,0.85),inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-xl">
                <div className="relative flex flex-wrap items-center gap-2">
                  <div
                    className={cx(
                      'inline-flex overflow-hidden rounded-xl transition-all duration-300',
                      requiresSignIn
                        ? 'opacity-90'
                        : primaryBusy
                          ? 'opacity-85'
                          : 'hover:-translate-y-0.5 hover:brightness-110 active:translate-y-0 active:scale-[0.99]',
                    )}
                    style={{
                      background: primary.background,
                      boxShadow: primaryBusy || requiresSignIn ? undefined : `0 14px 34px -16px ${primary.glow}`,
                    }}
                  >
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        if (requiresSignIn) {
                          onSignIn?.()
                          return
                        }
                        if (primaryDisabled) return
                        onPrimary()
                      }}
                      disabled={primaryDisabled}
                      aria-disabled={requiresSignIn || primaryDisabled}
                      title={requiresSignIn ? `Sign in to ${signInTarget.toLowerCase()} ${season.label}` : undefined}
                      className={cx(
                        'group relative inline-flex items-center gap-2.5 overflow-hidden px-5 py-3 text-[13.5px] font-semibold text-white',
                        requiresSignIn ? 'cursor-pointer' : primaryBusy ? 'cursor-progress' : '',
                      )}
                    >
                      {!requiresSignIn && (
                        <span className="absolute inset-0 -translate-x-[120%] bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-700 group-hover:translate-x-[120%]" />
                      )}
                      <PrimaryIcon className={cx('h-4 w-4', primaryBusy && 'animate-spin')} />
                      <span className="relative">{primary.label}</span>
                    </button>

                  </div>

                  {showLocateExisting && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        onLocateFolder?.()
                      }}
                      aria-label={`Locate an existing install for ${season.label}`}
                      title="Locate a build folder already on this PC"
                      className="inline-flex items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] px-3 py-3 text-fog transition-colors duration-200 hover:border-arc/40 hover:bg-white/[0.08] hover:text-white"
                    >
                      <FolderSearch className="h-4 w-4" />
                    </button>
                  )}

                  {showOpenFolder && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        onOpenFolder?.()
                      }}
                      aria-label={`Open ${season.label} install folder`}
                      title="Open install folder in Windows Explorer"
                      className="inline-flex items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] p-3 text-fog transition-colors duration-200 hover:border-emerald-400/40 hover:bg-emerald-400/10 hover:text-emerald-200"
                    >
                      <FolderOpen className="h-4 w-4" />
                    </button>
                  )}

                  {state === 'downloading' && download?.phase === 'downloading' && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        onPauseDownload()
                      }}
                      aria-label={`Pause ${season.label} download`}
                      title="Pause and keep the downloaded part"
                      className="inline-flex items-center gap-2 rounded-xl border border-amber-400/35 bg-amber-400/10 px-3.5 py-3 text-[12.5px] font-semibold text-amber-200 transition-all duration-200 hover:border-amber-400/70 hover:bg-amber-400/20 hover:text-white active:scale-[0.99]"
                    >
                      <Pause className="h-3.5 w-3.5" />
                      Pause
                    </button>
                  )}

                  {state === 'downloading' && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        onCancelDownload()
                      }}
                      className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-rose-600 to-red-600 px-3.5 py-3 text-[12.5px] font-semibold text-white shadow-[0_12px_28px_-14px_rgba(244,63,94,0.85)] transition-all duration-200 hover:from-rose-500 hover:to-red-500 hover:brightness-110 active:scale-[0.99]"
                    >
                      <Ban className="h-3.5 w-3.5" />
                      {download?.phase === 'extracting' ? 'Cancel unpacking' : 'Cancel'}
                    </button>
                  )}

                  {showVerify && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        onVerify?.()
                      }}
                      disabled={verify?.phase === 'running'}
                      aria-label={`Verify ${season.label} files`}
                      title={`Check ${season.label} for corrupted or missing files`}
                      className="inline-flex items-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-400/[0.07] px-3.5 py-3 text-[12.5px] font-semibold text-emerald-200 transition-all duration-200 hover:border-emerald-400/60 hover:bg-emerald-400/15 hover:text-white disabled:cursor-wait disabled:opacity-60"
                    >
                      {verify?.phase === 'running' ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <ShieldCheck className="h-3.5 w-3.5" />
                      )}
                      {verify?.phase === 'running' ? 'Verifying…' : 'Verify files'}
                    </button>
                  )}

                  {showRemove && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        onDelete?.()
                      }}
                      disabled={deleting}
                      aria-label={`${managed ? 'Uninstall' : 'Remove'} ${season.label}`}
                      title={
                        managed
                          ? 'Uninstall this build and remove it from this PC'
                          : 'Remove from VAULTED — your folder stays on disk'
                      }
                      className="inline-flex items-center justify-center rounded-xl border border-rose-400/35 bg-rose-500/10 p-3 text-rose-200 transition-all duration-200 hover:border-rose-400/70 hover:bg-rose-500/20 hover:text-white disabled:cursor-wait disabled:opacity-60"
                    >
                      {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
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

                  <span className="ml-auto hidden items-center gap-1 pr-2 text-[10.5px] text-fog/70 sm:flex">
                    <Sparkles className="h-3 w-3 text-amber-300/70" />
                    {account.outfit}
                  </span>
                </div>
              </div>
            </div>
        </div>
    </section>
  )
}
