import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, ExternalLink, Loader2, MessageCircle, ShieldCheck, X } from 'lucide-react'
import { cx } from '../lib/cx'
import { hasDiscordGateBeenOpened, markDiscordGateOpened } from '../lib/discordGates'
import { openDiscordInvite } from '../lib/launch'
import type { DiscordGate } from '../types'
import { CommunityLauncherPanel } from './CommunityLauncherPanel'

interface DiscordGateModalProps {
  gate: DiscordGate | null
  busy: boolean
  error?: string | null
  /** the community invite is already verified, so Step 2 is unlocked */
  verified?: boolean
  onClose: () => void
  onCopyInvite: () => void
  onVerify: () => void
  /** a launcher was scanned, installed and recorded for this community */
  onLauncherImported?: (providerId: string) => void
}

/**
 * Native VAULTED gate for a community Discord. Sign-in, verification state,
 * redirect-DLL preparation and the game launch all stay inside VAULTED. The
 * invite can be opened in the player's Discord app or copied by hand.
 *
 * The primary button is a two-state flow: Open Discord Server first, then
 * Verify once the player has been handed to the server.
 */
export function DiscordGateModal({
  gate,
  busy,
  error,
  verified = false,
  onClose,
  onCopyInvite,
  onVerify,
  onLauncherImported,
}: DiscordGateModalProps) {
  const [serverOpened, setServerOpened] = useState(false)
  const [opening, setOpening] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)

  useEffect(() => {
    if (!gate) return
    // A community the player already opened keeps the Verify state across
    // modal opens, so Step 1 never asks them to join twice.
    setServerOpened(hasDiscordGateBeenOpened(gate))
    setOpenError(null)
  }, [gate])

  useEffect(() => {
    if (!gate) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [busy, gate, onClose])

  if (!gate) return null

  const projectLabel = gate.label.replace(/ Discord$/i, '')

  const handleOpenServer = async () => {
    setOpening(true)
    setOpenError(null)
    try {
      const opened = await openDiscordInvite(gate.inviteUrl)
      if (!opened) {
        throw new Error(
          'VAULTED could not open Discord on this PC. Copy the invite below and paste it into Discord.',
        )
      }
      markDiscordGateOpened(gate)
      setServerOpened(true)
    } catch (openFailure) {
      setOpenError(
        openFailure instanceof Error
          ? openFailure.message
          : 'Discord could not be opened. Copy the invite below instead.',
      )
    } finally {
      setOpening(false)
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[96] grid place-items-center overflow-y-auto bg-[#02070c]/90 px-4 py-6 backdrop-blur-md"
      onMouseDown={(event) => {
        if (!busy && event.target === event.currentTarget) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="discord-gate-title"
    >
      <div
        className="animate-scale-in relative w-full max-w-[500px] overflow-hidden rounded-3xl border border-line bg-ink shadow-[0_40px_120px_-30px_rgba(0,0,0,0.95)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div
          className="pointer-events-none absolute -top-28 left-1/2 h-64 w-64 -translate-x-1/2 rounded-full bg-[#5865F2]/20 blur-3xl"
          aria-hidden
        />
        <div
          className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-[#5865F2] via-[#7983f5] to-emerald-400"
          aria-hidden
        />

        <header className="relative flex items-start justify-between gap-3 p-6 pb-0">
          <div>
            <p className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#aeb4ff]">
              <MessageCircle className="h-3.5 w-3.5" />
              Community unlock
            </p>
            <h2
              id="discord-gate-title"
              className="mt-2 font-display text-2xl font-black uppercase tracking-[0.03em] text-mist"
            >
              {verified
                ? 'Step 2 — Add the Community Launcher'
                : 'Step 1 — Join Discord & Download Their Launcher'}
            </h2>
            <p className="mt-2 text-[12.5px] leading-relaxed text-fog">
              <span className="font-semibold text-mist">{gate.label}</span>{' '}
              {verified
                ? 'is verified, so Install Season is unlocked. Press Done below to continue on the season card; adding its launcher here is only needed if you have not imported one yet.'
                : 'hosts this season on its own servers. Join the community, download its launcher, then bring that file back here.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close Discord verification"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-xl border border-line bg-white/[0.03] text-fog transition-colors duration-200 hover:bg-white/[0.08] hover:text-white disabled:cursor-wait disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="relative p-6">
          <div className="rounded-2xl border border-[#5865F2]/30 bg-[#5865F2]/[0.09] p-3.5">
            <div className="flex items-start gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-[#5865F2]/35 bg-[#5865F2]/15 text-[#c7ccff]">
                <ShieldCheck className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="text-[12.5px] font-semibold text-mist">
                  No third-party launcher opens
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-fog">
                  VAULTED opens the verified invite in your Discord app, then checks the server's own
                  guild before it unlocks the season. Your Discord password is never requested by
                  VAULTED.
                </p>
              </div>
            </div>
          </div>

          <ol className="mt-4 space-y-2 text-[11.5px] text-fog">
            <li className="flex items-center gap-2">
              <span className="grid h-5 w-5 place-items-center rounded-full border border-white/10 bg-white/[0.04] text-[9px] font-bold text-mist">
                1
              </span>
              Press <span className="font-semibold text-mist">Open Discord Server</span> to join{' '}
              {projectLabel}, or copy the invite below as a fallback.
            </li>
            <li className="flex items-center gap-2">
              <span className="grid h-5 w-5 place-items-center rounded-full border border-white/10 bg-white/[0.04] text-[9px] font-bold text-mist">
                2
              </span>
              Come back here and press <span className="font-semibold text-mist">Verify</span>. VAULTED
              remembers the unlock on this PC.
            </li>
          </ol>

          {(openError || error) && (
            <p
              role="alert"
              className="mt-3 rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-[12px] leading-relaxed text-rose-200"
            >
              {openError || error}
            </p>
          )}

          <button
            type="button"
            onClick={() => {
              if (busy || opening) return
              if (!verified && !serverOpened) {
                void handleOpenServer()
                return
              }
              onVerify()
            }}
            disabled={busy || opening}
            className={cx(
              'mt-4 flex w-full items-center justify-center gap-2 rounded-2xl px-4 py-3 text-[13px] font-bold text-white transition-all duration-200',
              busy || opening
                ? 'cursor-wait bg-[#5865F2]/70 opacity-80'
                : 'bg-[#5865F2] shadow-[0_16px_34px_-18px_rgba(88,101,242,0.95)] hover:brightness-110 active:scale-[0.99]',
            )}
          >
            {busy || opening ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : verified || serverOpened ? (
              <Check className="h-4 w-4" />
            ) : (
              <ExternalLink className="h-4 w-4" />
            )}
            {busy
              ? 'Verifying community…'
              : opening
                ? 'Opening Discord…'
                : verified
                  ? 'Community verified'
                  : serverOpened
                    ? 'Verify'
                    : `Open ${projectLabel} Discord Server`}
          </button>

          {verified && onLauncherImported && (
            <CommunityLauncherPanel
              gate={gate}
              verified={verified}
              onImported={onLauncherImported}
              onDone={onClose}
            />
          )}

          <div className="mt-3 flex items-center gap-2 rounded-xl border border-white/10 bg-black/25 px-3 py-2">
            <code className="min-w-0 flex-1 truncate text-[11px] text-fog">{gate.inviteUrl}</code>
            <button
              type="button"
              onClick={onCopyInvite}
              disabled={busy}
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-white/15 bg-white/[0.06] px-2.5 py-1.5 text-[11px] font-semibold text-mist transition-colors duration-200 hover:border-[#5865F2]/60 hover:bg-[#5865F2]/10 hover:text-white disabled:cursor-wait disabled:opacity-50"
            >
              <Copy className="h-3 w-3" />
              Copy
            </button>
          </div>

          <p className="mt-3 text-center text-[10px] leading-relaxed text-fog/70">
            VAULTED opens this invite in your Discord app, and the copy box stays available. Close
            this panel to cancel the launch.
          </p>
        </div>
      </div>
    </div>,
    document.body,
  )
}