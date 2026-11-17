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
  MessageCircle,
  Pause,
  Play,
  Server,
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
  seasonServerCount,
  seasonStatusLabel,
  type SeasonPlayMode,
} from '../lib/playMode'
import type { CommunityServer } from '../lib/network'
import type {
  Account,
  Build,
  BuildState,
  BuildVerifyReport,
  DiscordGate,
  DownloadState,
  GlobalBackend,
} from '../types'

interface ActiveBuildCardProps {
  build: Build | null
  state: BuildState
  download: DownloadState | null
  /** shared live online state for this season */
  playMode?: SeasonPlayMode
  /** best live server for the selected season, used only for native status */
  autoServer?: CommunityServer | null
  /** backend Play uses automatically when no exact server is live */
  autoGlobalBackend?: GlobalBackend | null
  /** live external servers for this exact season */
  serverOptions?: CommunityServer[]
  /** explicitly selected external server address, null = Auto */
  selectedServer?: string | null
  onSelectServer?: (address: string | null) => void
  /** whether a VAULTED or verified provider session is active */
  signedIn?: boolean
  /** open the in-app VAULTED sign-in modal */
  onSignIn?: () => void
  /** this season's active backend needs an online account link */
  accountAuthRequired?: boolean
  /** the hosted provider already has an encrypted session */
  accountSignedIn?: boolean
  /** open the generic account connection prompt */
  onConnectAccount?: () => void
  /** Discord community that unlocks online play for this season */
  discordGate?: DiscordGate | null
  /** the community invite has been verified on this PC */
  discordGateVerified?: boolean
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
  /** provider account verification is required before online play */
  launchVerificationUrl?: string | null
  /** provider build.verify rejected the installed files */
  buildVerificationRequired?: boolean
  /** exact live version the repair will install, e.g. "6.21" */
  liveBuildVersion?: string | null
  /** one-click download/repair to the provider's live manifest */
  onUpdateLiveBuild?: () => void
  onRetryLaunch?: () => void
  /** this PC's currently published lobby, if it is hosting this build */
  hostedLobby?: { address: string; port: number; public: boolean; label: string; players?: number } | null
  verify?: {
    phase: 'running' | 'done'
    report?: BuildVerifyReport
    error?: string
    step?: 'game' | 'repair' | 'routing' | 'session' | 'done'
    label?: string
    progress?: number
  } | null
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

function statusToneFor(
  health: ServerHealth | null,
  playMode: SeasonPlayMode | undefined,
): 'up' | 'down' | 'checking' | 'muted' {
  if (health?.state === 'down') return 'down'
  if (health?.state === 'checking') return 'checking'
  if (health?.state === 'link') return 'muted'
  if (health?.state === 'up' || playMode?.online || playMode?.globalOnline) return 'up'
  if (playMode?.availability === 'launcher' || playMode?.availability === 'directory') return 'muted'
  return 'down'
}

function serverCountLabel(servers: number): string {
  return `${Math.max(0, Math.floor(servers))} ${servers === 1 ? 'server' : 'servers'}`
}

function playerCountLabel(players: number): string {
  return `${Math.max(0, Math.floor(players))} ${players === 1 ? 'player' : 'players'}`
}

function compactCount(value: number): string {
  const count = Math.max(0, Math.floor(value))
  return count >= 1000
    ? new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(count)
    : String(count)
}

function communityCountLabel(players: number): string {
  return `${compactCount(players)} online`
}

type ServerHealthState = 'up' | 'down' | 'checking' | 'link'

interface ServerHealth {
  state: ServerHealthState
  /** label for an external launcher/community link with no live health status */
  linkLabel?: string
  players?: number
  communityPlayers?: number
  populationSource?: 'provider' | 'discord' | 'directory'
  populationLabel?: string
  servers?: number
  pingMs?: number
  reason?: string
  checkedAt?: string
}

function healthForBackend(provider: GlobalBackend | null | undefined): ServerHealth {
  if (!provider?.live) return { state: 'checking' }
  return {
    state: provider.live.online ? 'up' : 'down',
    players: provider.live.players,
    communityPlayers: provider.live.communityPlayers,
    populationSource: provider.live.populationSource,
    populationLabel: provider.live.populationLabel,
    servers: provider.live.servers,
    pingMs: provider.live.pingMs,
    reason: provider.live.reason,
    checkedAt: provider.live.checkedAt,
  }
}

function healthForServer(server: CommunityServer | null | undefined): ServerHealth {
  if (!server) return { state: 'checking' }
  const savedOnline = (server as CommunityServer & { online?: boolean }).online
  return {
    state: savedOnline === false || server.public === false ? 'down' : 'up',
    players: server.playersKnown === false ? undefined : lobbyPlayers(server),
    servers: 1,
    pingMs: server.pingMs,
    reason: savedOnline === false ? 'Saved server is marked offline.' : undefined,
  }
}

function healthCheckedLabel(health: ServerHealth): string {
  if (!health.checkedAt) return ''
  const checked = new Date(health.checkedAt)
  if (Number.isNaN(checked.getTime())) return ''
  return `checked ${checked.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })}`
}

function healthTitle(health: ServerHealth): string {
  return [
    health.state === 'up'
        ? 'Server up'
        : health.state === 'down'
          ? 'Server down'
          : 'Checking server health',
    health.populationSource === 'discord' && health.communityPlayers !== undefined
      ? `Community ${communityCountLabel(health.communityPlayers)} — not in-game players`
      : undefined,
    health.reason,
    healthCheckedLabel(health),
  ]
    .filter(Boolean)
    .join(' · ')
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
  autoServer,
  autoGlobalBackend,
  serverOptions = [],
  selectedServer = null,
  onSelectServer,
  signedIn = true,
  onSignIn,
  accountAuthRequired = false,
  accountSignedIn = false,
  onConnectAccount,
  discordGate,
  discordGateVerified = false,
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
  buildVerificationRequired,
  liveBuildVersion,
  onUpdateLiveBuild,
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
  const buildUpdateRequired = Boolean(buildVerificationRequired && onUpdateLiveBuild)
  const pill = verificationRequired
    ? { label: 'Verification needed', dot: 'bg-amber-400', text: 'text-amber-300' }
    : buildUpdateRequired
      ? { label: 'Build update needed', dot: 'bg-amber-400', text: 'text-amber-300' }
      : launchErrorLocal
        ? { label: 'Unavailable', dot: 'bg-amber-400', text: 'text-amber-300' }
        : STATE_PILL[state]
  const isOnlineProvider = Boolean(build.onlineProvider)
  const showLocateExisting = !busy && state !== 'running' && !isOnlineProvider
  const isInstalled = Boolean(installed?.[build.id])
  const signedOut = signedIn === false
  const requiresSignIn =
    signedOut && ['missing', 'paused', 'ready', 'error'].includes(state)
  // Only offer the account prompt for an installed season. A missing build
  // still uses the normal Download path, then asks for the account before Play.
  const accountConnectRequired = Boolean(
    accountAuthRequired &&
      accountSignedIn === false &&
      isInstalled &&
      ['ready', 'error'].includes(state) &&
      !busy,
  )
  // A Discord gate only changes the Play action once the build is actually
  // ready. Download, pause and resume keep their normal install language.
  const discordLocked = Boolean(
    discordGate &&
      !discordGateVerified &&
      isInstalled &&
      ['ready', 'error'].includes(state) &&
      !busy,
  )
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
  const activeGlobalBackend = autoGlobalBackend ?? null
  const onlinePlayers = onlinePlayerCount(playMode)
  const onlineServers = seasonServerCount(playMode)
  // The hero, every sidebar card, and the selector all report the same
  // season-wide total; picking one row changes the route, not the count.
  const liveServers = onlineServers
  const livePlayers = onlinePlayers
  const selectedServerOption = selectedServer
    ? serverOptions.find((server) => server.address === selectedServer) ?? null
    : null
  const serverBadge = liveServers > 0
    ? `ONLINE · ${liveServers} ${liveServers === 1 ? 'SERVER' : 'SERVERS'}`
    : 'OFFLINE'
  const activeBackendHealth = healthForBackend(activeGlobalBackend)
  const activeBackendOffline = activeBackendHealth.state === 'down'
  const heroHealth: ServerHealth | null = autoServer
    ? healthForServer(autoServer)
    : activeGlobalBackend
      ? activeBackendHealth
      : null
  const heroCommunity =
    heroHealth?.communityPlayers !== undefined
      ? communityCountLabel(heroHealth.communityPlayers)
      : ''
  const activePopulationLabel = livePlayers > 0 ? playerCountLabel(livePlayers) : ''
  const activePopulationDetail = activePopulationLabel ? ` · ${activePopulationLabel}` : ''
  const onlineStatus = heroHealth
    ? heroHealth.state === 'up'
      ? onlineStatusLabel(onlinePlayers, onlineServers)
      : heroHealth.state === 'down'
        ? 'OFFLINE'
        : 'CHECKING'
    : seasonStatusLabel(playMode)
  const statusTone = statusToneFor(heroHealth, playMode)
  const heroStatusTitle = heroHealth ? healthTitle(heroHealth) : onlineStatus
  const lobbyCount = playMode?.lobbyCount ?? (hostedLobby?.public ? 1 : 0)

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

  const primary = accountConnectRequired
    ? {
        label: 'Connect online account',
        icon: ShieldCheck,
        background: 'linear-gradient(120deg, #7c8cff, #4752c4)',
        glow: 'rgba(124,140,255,0.55)',
      }
    : discordLocked
      ? {
          label: 'Join Discord to Play',
          icon: MessageCircle,
          background: 'linear-gradient(120deg, #5865F2, #4752c4)',
          glow: 'rgba(88,101,242,0.55)',
        }
    : requiresSignIn
      ? {
          label: `Sign in to ${signInTarget}`,
          icon: LogIn,
          background: 'linear-gradient(120deg, #4b5563, #374151)',
          glow: 'rgba(75,85,99,0.35)',
        }
      : statePrimary
  const primaryBusy = busy && !requiresSignIn && !accountConnectRequired
  const primaryDisabled =
    !requiresSignIn &&
    !accountConnectRequired &&
    (busy || (state === 'missing' && !hasDownloadSource))

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
    ready:
      discordLocked
        ? `Ready — join ${discordGate?.label || 'the community Discord'} to unlock online play.`
        : playMode?.availability === 'launcher' && !playMode?.online
        ? 'Ready — online play is available. Play connects automatically to a live server.'
        : playMode?.availability === 'unsupported' && !playMode?.online
          ? 'Ready — no live server is reporting for this season right now.'
          : playMode?.availability === 'directory' && !playMode?.online
            ? 'Ready — online play is available. Play connects automatically to a live server.'
            : activeGlobalBackend
              ? activeBackendHealth.state === 'checking'
                ? 'Ready — checking online status before launch.'
                : activeBackendOffline
                  ? 'Ready — this season is offline right now. Try again later.'
                  : `Ready — ${serverCountLabel(liveServers)}${activePopulationDetail}. Play connects automatically.`
              : liveServers > 0
                ? `Ready — ${serverCountLabel(liveServers)}${activePopulationDetail}. Play connects automatically.`
                : lobbyCount > 0
                  ? `Ready — online play is available. Play joins a server automatically.`
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
      ? 'Account verification is required before online play can start.'
      : launchErrorLocal
        ? 'No live server was available — try again shortly.'
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
            <span
              title={heroStatusTitle}
              aria-label={`Server status: ${onlineStatus}`}
              className={cx(
                'inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full border px-3 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.14em] backdrop-blur',
                statusTone === 'down'
                  ? 'border-rose-400/55 bg-rose-500/[0.18] text-rose-200 shadow-[0_0_26px_rgba(244,63,94,0.22)]'
                  : statusTone === 'checking'
                    ? 'border-amber-400/40 bg-amber-400/[0.1] text-amber-200'
                    : statusTone === 'muted'
                      ? 'border-white/15 bg-white/[0.04] text-mist/70'
                      : 'border-emerald-300/50 bg-emerald-400/[0.15] text-emerald-200 shadow-[0_0_26px_rgba(16,185,129,0.2)]',
              )}
            >
              <span
                className={cx(
                  'h-2 w-2 rounded-full',
                  statusTone === 'down'
                    ? 'bg-rose-400 shadow-[0_0_10px_rgba(251,113,133,0.95)]'
                    : statusTone === 'checking'
                      ? 'bg-amber-300'
                      : statusTone === 'muted'
                        ? 'bg-slate-400'
                        : 'bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.95)]',
                  statusTone === 'up' && livePlayers > 0 && 'animate-pulse',
                )}
              />
              {onlineStatus}
            </span>
            {heroCommunity && (
              <span
                title={`Community ${heroCommunity} — live community presence, not in-game players.`}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-arc/25 bg-arc/[0.08] px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-arc/90 backdrop-blur"
              >
                <Globe2 className="h-3 w-3" />
                Community · {heroCommunity}
              </span>
            )}
            {discordGate && (
              <span
                title={`${discordGate.label}: online play unlocks through the community Discord.`}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[#5865F2]/40 bg-[#5865F2]/15 px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-[0.1em] text-[#c7ccff] backdrop-blur"
              >
                <MessageCircle className="h-3 w-3" />
                ONLINE · DISCORD
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
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
            <details className="group relative mt-4 max-w-xl">
              <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl border border-white/10 bg-black/25 px-3 py-2 text-[10.5px] text-fog backdrop-blur transition-colors duration-200 hover:border-emerald-400/35 [&::-webkit-details-marker]:hidden">
                <Server className="h-3.5 w-3.5 shrink-0 text-emerald-300" />
                <span className="min-w-0 flex-1 truncate font-semibold text-mist">
                  {selectedServerOption ? selectedServerOption.address : 'Auto · best live server'}
                </span>
                <span
                  className={cx(
                    'inline-flex shrink-0 items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.06em]',
                    liveServers > 0
                      ? 'border-emerald-300/45 bg-emerald-400/20 text-emerald-200'
                      : 'border-rose-400/25 bg-rose-500/[0.08] text-rose-200/80',
                  )}
                >
                  <span
                    className={cx(
                      'h-1.5 w-1.5 rounded-full',
                      liveServers > 0 ? 'bg-emerald-400 shadow-[0_0_7px_rgba(52,211,153,0.9)]' : 'bg-rose-400/80',
                    )}
                  />
                  {serverBadge}
                </span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-fog transition-transform duration-200 group-open:rotate-180" />
              </summary>
              <div className="absolute inset-x-0 z-40 mt-2 max-h-72 overflow-y-auto rounded-xl border border-line bg-[#0b131c] p-1.5 shadow-2xl shadow-black/70">
                <button
                  type="button"
                  onClick={(event) => {
                    onSelectServer(null)
                    event.currentTarget.closest('details')?.removeAttribute('open')
                  }}
                  className={cx(
                    'flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors',
                    !selectedServer ? 'bg-emerald-400/[0.09]' : 'hover:bg-white/[0.05]',
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11.5px] font-semibold text-mist">
                      Auto · best live server
                    </span>
                    <span className="mt-0.5 block text-[9.5px] text-fog/80">
                      {serverBadge} · Play connects automatically
                    </span>
                  </span>
                </button>
                {serverOptions.length > 0 && (
                  <>
                    <p className="px-2.5 pb-1 pt-2 text-[8.5px] font-bold uppercase tracking-[0.16em] text-fog/60">
                      Live servers · this season
                    </p>
                    {serverOptions.map((server, index) => (
                      <button
                        key={`${server.address}-${server.id}`}
                        type="button"
                        onClick={(event) => {
                          onSelectServer(server.address)
                          event.currentTarget.closest('details')?.removeAttribute('open')
                        }}
                        className={cx(
                          'flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors',
                          selectedServer === server.address
                            ? 'bg-emerald-400/[0.09]'
                            : 'hover:bg-white/[0.05]',
                        )}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[11.5px] font-semibold text-mist">
                            Live server {index + 1}
                          </span>
                          <span className="mt-0.5 block truncate text-[9.5px] text-fog/80">
                            {server.address}
                            {server.playersKnown === false
                              ? ''
                              : ` · ${lobbyPlayers(server)} player${lobbyPlayers(server) === 1 ? '' : 's'}`}
                          </span>
                        </span>
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-emerald-300/35 bg-emerald-400/15 px-1.5 py-0.5 text-[8.5px] font-bold uppercase tracking-[0.06em] text-emerald-200">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                          ONLINE · 1 SERVER
                        </span>
                      </button>
                    ))}
                  </>
                )}
              </div>
            </details>
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
                      ? verify.label || 'Checking game files…'
                      : verify.error
                        ? verify.label || 'Verify could not finish'
                        : verifyReport?.verified
                          ? verify.label || 'All files verified — no corruption found'
                          : `${verifyReport?.issueCount ?? 0} problem${verifyReport?.issueCount === 1 ? '' : 's'} found`}
                  </p>
                  {verify.phase === 'running' ? (
                    <>
                      <p className="mt-0.5 text-[10.5px] text-fog">
                        {verify.step === 'game'
                          ? 'Checking required executables, PAK/UCAS/UTOC content and manifests.'
                          : verify.step === 'repair'
                            ? 'Downloading only missing or corrupted chunks from the live provider manifest.'
                            : verify.step === 'routing'
                              ? 'Verifying the redirect DLL, SSL bypass, exchange patch and VaultedInjector.'
                              : 'Rotating the encrypted account token before online play.'}
                      </p>
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/40">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-arc to-emerald-400 transition-all duration-300"
                          style={{ width: `${Math.max(4, Math.min(100, verify.progress ?? 8))}%` }}
                        />
                      </div>
                    </>
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
                verificationRequired || buildUpdateRequired
                  ? 'border-amber-400/35 bg-amber-400/[0.08] text-amber-100'
                  : launchErrorLocal
                    ? 'border-amber-400/30 bg-amber-400/[0.07] text-amber-100'
                    : 'border-rose-400/30 bg-rose-500/[0.08] text-rose-100',
              )}
              role={verificationRequired || buildUpdateRequired || launchErrorLocal ? 'status' : 'alert'}
            >
              <div className="flex items-start gap-2">
                <TriangleAlert
                  className={cx(
                    'mt-0.5 h-4 w-4 shrink-0',
                    verificationRequired || buildUpdateRequired || launchErrorLocal
                      ? 'text-amber-300'
                      : 'text-rose-300',
                  )}
                />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">
                    {verificationRequired
                      ? 'Account verification needed'
                      : buildUpdateRequired
                        ? 'Build files need updating'
                        : launchErrorLocal
                          ? 'Local match unavailable'
                          : 'Why the last launch stopped'}
                  </p>
                  <p
                    className={cx(
                      'mt-1 break-words',
                      verificationRequired || buildUpdateRequired
                        ? 'text-[11px] leading-relaxed text-amber-100/90'
                        : launchErrorLocal
                          ? 'text-[11px] text-amber-100/85'
                          : 'max-h-40 overflow-y-auto whitespace-pre-wrap font-mono text-[9.5px] leading-relaxed text-rose-100/80',
                    )}
                  >
                    {launchError}
                  </p>
                  {buildUpdateRequired && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => onUpdateLiveBuild?.()}
                        title="Download or repair the exact live build files, then launch"
                        className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300/40 bg-amber-300/15 px-2.5 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.05em] text-amber-100 transition-colors duration-200 hover:border-amber-200/70 hover:bg-amber-300/25 hover:text-white"
                      >
                        <Download className="h-3.5 w-3.5" />
                        Update Live Build{liveBuildVersion ? ` (${liveBuildVersion})` : ''}
                      </button>
                    </div>
                  )}
                  {verificationRequired && onRetryLaunch && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={onRetryLaunch}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/[0.06] px-2.5 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.05em] text-mist transition-colors duration-200 hover:border-white/30 hover:bg-white/[0.12] hover:text-white"
                      >
                        <Play className="h-3.5 w-3.5" />
                        Retry launch
                      </button>
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
                      requiresSignIn && !accountConnectRequired
                        ? 'opacity-90'
                        : primaryBusy
                          ? 'opacity-85'
                          : 'hover:-translate-y-0.5 hover:brightness-110 active:translate-y-0 active:scale-[0.99]',
                    )}
                    style={{
                      background: primary.background,
                      boxShadow:
                        primaryBusy || (requiresSignIn && !accountConnectRequired)
                          ? undefined
                          : `0 14px 34px -16px ${primary.glow}`,
                    }}
                  >
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        if (accountConnectRequired) {
                          onConnectAccount?.()
                          return
                        }
                        if (requiresSignIn) {
                          onSignIn?.()
                          return
                        }
                        if (primaryDisabled) return
                        onPrimary()
                      }}
                      disabled={primaryDisabled}
                      aria-disabled={requiresSignIn || accountConnectRequired || primaryDisabled}
                      title={
                        accountConnectRequired
                          ? 'Connect an online account to play this season'
                          : requiresSignIn
                            ? `Sign in to ${signInTarget.toLowerCase()} ${season.label}`
                            : undefined
                      }
                      className={cx(
                        'group relative inline-flex items-center gap-2.5 overflow-hidden px-5 py-3 text-[13.5px] font-semibold text-white',
                        requiresSignIn || accountConnectRequired
                          ? 'cursor-pointer'
                          : primaryBusy
                            ? 'cursor-progress'
                            : '',
                      )}
                    >
                      {!requiresSignIn && !accountConnectRequired && (
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
                      aria-label={`Verify and repair ${season.label} files`}
                      title={`Scan ${season.label}, then automatically repair files, online routing, DLLs and the account session`}
                      className="inline-flex items-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-400/[0.07] px-3.5 py-3 text-[12.5px] font-semibold text-emerald-200 transition-all duration-200 hover:border-emerald-400/60 hover:bg-emerald-400/15 hover:text-white disabled:cursor-wait disabled:opacity-60"
                    >
                      {verify?.phase === 'running' ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <ShieldCheck className="h-3.5 w-3.5" />
                      )}
                      {verify?.phase === 'running' ? 'Repairing…' : 'Verify & Repair'}
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
