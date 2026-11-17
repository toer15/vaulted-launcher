import { LayoutGrid, LockKeyhole, LogIn, Radio, Settings2, Sparkles, Store, Users } from 'lucide-react'
import brandIcon from '../assets/brand-icon.png'
import { AccountChip } from './AccountChip'
import { WindowControls } from './WindowControls'
import { Wordmark } from './Wordmark'
import { cx } from '../lib/cx'
import { hasWindowControls } from '../lib/launch'
import type { OnlineStatus } from '../lib/onlineService'
import type { Account, SeasonInfo } from '../types'

interface TopBarProps {
  account: Account
  season: SeasonInfo | null
  version: string | null
  buildCount: number
  onlineStatus: OnlineStatus
  /** seasons with a hosted global backend that is currently online */
  communityOnline?: number
  /** provider-only identity: global play works, VAULTED socials are gated */
  providerOnly?: boolean
  /** a VAULTED or verified provider session is active */
  signedIn?: boolean
  settingsActive: boolean
  shopActive: boolean
  friendsActive: boolean
  friendRequests: number
  onOpenLibrary: () => void
  onOpenSettings: () => void
  onOpenShop: () => void
  onOpenFriends: () => void
  onSignIn: () => void
  onLogout: () => void
}

export function TopBar({
  account,
  season,
  version,
  buildCount,
  onlineStatus,
  communityOnline,
  providerOnly = false,
  signedIn = true,
  settingsActive,
  shopActive,
  friendsActive,
  friendRequests,
  onOpenLibrary,
  onOpenSettings,
  onOpenShop,
  onOpenFriends,
  onSignIn,
  onLogout,
}: TopBarProps) {
  const friendsLocked = providerOnly || !signedIn

  return (
    <header className="app-drag flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <span className="relative grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-2xl bg-panel shadow-lg shadow-arc/30">
          <img src={brandIcon} alt="VAULTED" draggable={false} className="h-full w-full object-cover" />
          <span className="absolute inset-0 rounded-2xl ring-1 ring-inset ring-white/25" />
        </span>

        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <Wordmark className="text-[18px]" accent={false} />
            <span className="hidden text-[11px] font-medium tracking-wide text-fog sm:inline">
              Fortnite Build Launcher
            </span>
          </div>
          <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-fog">
            <Sparkles className="h-3 w-3 text-amber-300/80" />
            {season ? season.label : 'No build selected'}
            {version && (
              <>
                <span className="text-fog/40">·</span>
                <span className="font-mono text-[10.5px]">v{version}</span>
              </>
            )}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span
          className={cx(
            'hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10.5px] font-medium md:inline-flex',
            !signedIn
              ? 'border-amber-400/25 bg-amber-400/[0.06] text-amber-200/90'
              : providerOnly || onlineStatus === 'connected' || (communityOnline ?? 0) > 0
                ? 'border-emerald-400/30 bg-emerald-400/[0.07] text-emerald-300'
                : onlineStatus === 'checking'
                  ? 'border-sky-400/30 bg-sky-400/[0.07] text-sky-300'
                  : 'border-amber-400/25 bg-amber-400/[0.06] text-amber-200/90',
          )}
          title={
            !signedIn
              ? 'Sign in to unlock Download and Play across every season.'
              : providerOnly
                ? 'Global online matchmaking ready. Friends and the VAULTED relay are gated.'
                : onlineStatus === 'connected'
                ? 'Matchmaking service connected'
                : (communityOnline ?? 0) > 0
                  ? `${communityOnline} seasons have a live online server`
                  : onlineStatus === 'checking'
                    ? 'Checking the online server…'
                    : 'Online server unreachable — local play only'
          }
        >
          <Radio className="h-3 w-3" />
          {!signedIn
            ? 'Sign in required'
            : providerOnly
              ? 'Global play'
              : onlineStatus === 'connected'
              ? 'Online'
              : (communityOnline ?? 0) > 0
                ? 'Online'
                : onlineStatus === 'checking'
                  ? 'Checking online…'
                  : 'Offline — Local Play only'}
        </span>

        <button
          type="button"
          onClick={onOpenShop}
          aria-pressed={shopActive}
          title="Item Shop"
          className={cx(
            'app-no-drag inline-flex items-center gap-2 rounded-xl border px-2.5 py-2 text-[12px] font-medium transition-all duration-300',
            shopActive
              ? 'border-[#e2b85a]/50 bg-[#e2b85a]/15 text-[#ffe8a8]'
              : 'border-line bg-panel/70 text-fog hover:border-[#e2b85a]/45 hover:bg-panel-hi hover:text-mist',
          )}
        >
          <Store className="h-4 w-4" />
          <span className="hidden sm:inline">Item Shop</span>
        </button>

        <button
          type="button"
          onClick={onOpenFriends}
          aria-pressed={friendsActive && !friendsLocked}
          disabled={friendsLocked}
          title={
            providerOnly
              ? 'Friends and the VAULTED relay need a VAULTED account. Global online play is still ready.'
              : !signedIn
                ? 'Sign in to use Friends and the VAULTED relay.'
                : 'Friends'
          }
          className={cx(
            'app-no-drag inline-flex items-center gap-2 rounded-xl border px-2.5 py-2 text-[12px] font-medium transition-all duration-300',
            friendsLocked
              ? 'cursor-not-allowed border-line/70 bg-panel/40 text-fog/50'
              : friendsActive
                ? 'border-arc/50 bg-arc/15 text-white'
                : 'border-line bg-panel/70 text-fog hover:border-arc/45 hover:bg-panel-hi hover:text-mist',
          )}
        >
          <span className="relative">
            {friendsLocked ? <LockKeyhole className="h-4 w-4" /> : <Users className="h-4 w-4" />}
            {!friendsLocked && friendRequests > 0 && (
              <span className="absolute -right-2 -top-2 grid h-4 min-w-4 place-items-center rounded-full bg-rose-500 px-1 text-[9px] font-bold text-white">
                {friendRequests}
              </span>
            )}
          </span>
          <span className="hidden sm:inline">Friends</span>
        </button>

        <button
          type="button"
          onClick={onOpenSettings}
          aria-pressed={settingsActive}
          title="Settings"
          className={cx(
            'app-no-drag inline-flex items-center gap-2 rounded-xl border px-2.5 py-2 text-[12px] font-medium transition-all duration-300',
            settingsActive
              ? 'border-arc/50 bg-arc/15 text-white'
              : 'border-line bg-panel/70 text-fog hover:border-arc/45 hover:bg-panel-hi hover:text-mist',
          )}
        >
          <Settings2 className="h-4 w-4" />
          <span className="hidden sm:inline">Settings</span>
        </button>

        <button
          type="button"
          onClick={onOpenLibrary}
          className="app-no-drag group inline-flex items-center gap-2 rounded-xl border border-line bg-panel/70 px-2.5 py-2 text-[12px] font-medium text-fog transition-all duration-300 hover:border-arc/45 hover:bg-panel-hi hover:text-mist"
          aria-label={`Open build library, ${buildCount} builds`}
        >
          <LayoutGrid className="h-4 w-4" />
          <span className="hidden sm:inline">Library</span>
          <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-mist">
            {buildCount}
          </span>
        </button>

        <div className="app-no-drag">
          {signedIn ? (
            <AccountChip account={account} onLogout={onLogout} />
          ) : (
            <button
              type="button"
              onClick={onSignIn}
              className="inline-flex items-center gap-2 rounded-2xl border border-emerald-400/35 bg-emerald-400/[0.1] px-3.5 py-2 text-[12px] font-semibold text-emerald-100 transition-colors duration-200 hover:border-emerald-400/65 hover:bg-emerald-400/15 hover:text-white"
            >
              <LogIn className="h-4 w-4" /> Sign in
            </button>
          )}
        </div>

        {hasWindowControls() && <WindowControls />}
      </div>
    </header>
  )
}
