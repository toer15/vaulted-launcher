import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, ShieldCheck, UserRound, X } from 'lucide-react'
import { cx } from '../lib/cx'

interface ConnectAccountModalProps {
  open: boolean
  busy: boolean
  error?: string | null
  onClose: () => void
  onContinue: () => void
}

/**
 * Generic provider-account prompt. The OAuth or embedded sign-in page opens
 * in VAULTED's own secure BrowserWindow, so the player stays on the season
 * screen and never sees a provider name here.
 */
export function ConnectAccountModal({
  open,
  busy,
  error,
  onClose,
  onContinue,
}: ConnectAccountModalProps) {
  useEffect(() => {
    if (!open) return
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
  }, [busy, onClose, open])

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[95] grid place-items-center overflow-y-auto bg-[#02070c]/88 px-4 py-6 backdrop-blur-md"
      onMouseDown={(event) => {
        if (!busy && event.target === event.currentTarget) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="connect-account-title"
    >
      <div
        className="animate-scale-in relative w-full max-w-[460px] overflow-hidden rounded-3xl border border-line bg-ink shadow-[0_40px_120px_-30px_rgba(0,0,0,0.95)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div
          className="pointer-events-none absolute -top-28 left-1/2 h-64 w-64 -translate-x-1/2 rounded-full bg-arc/15 blur-3xl"
          aria-hidden
        />
        <div
          className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-emerald-400 via-arc to-transparent"
          aria-hidden
        />

        <header className="relative flex items-start justify-between gap-3 p-6 pb-0">
          <div>
            <p className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-emerald-300">
              <ShieldCheck className="h-3.5 w-3.5" />
              Secure account link
            </p>
            <h2
              id="connect-account-title"
              className="mt-2 font-display text-2xl font-black uppercase tracking-[0.04em] text-mist"
            >
              Connect online account
            </h2>
            <p className="mt-2 text-[12.5px] leading-relaxed text-fog">
              This season needs an online account for matchmaking. Connect once and
              VAULTED will finish the launch for you.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close account connection"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-xl border border-line bg-white/[0.03] text-fog transition-colors duration-200 hover:bg-white/[0.08] hover:text-white disabled:cursor-wait disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="relative p-6">
          <div className="rounded-2xl border border-arc/25 bg-arc/[0.08] p-3.5">
            <div className="flex items-start gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-arc/30 bg-arc/15 text-mist">
                <UserRound className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="text-[12.5px] font-semibold text-mist">
                  One connection, every season on this service
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-fog">
                  Sign-in opens in VAULTED&apos;s secure window. Your session is stored
                  encrypted on this PC and is never shown in the game or shared with the
                  season screen.
                </p>
              </div>
            </div>
          </div>

          {error && (
            <p
              role="alert"
              className="mt-3 rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-[12px] leading-relaxed text-rose-200"
            >
              {error}
            </p>
          )}

          <button
            type="button"
            onClick={onContinue}
            disabled={busy}
            className={cx(
              'mt-4 flex w-full items-center justify-center gap-2 rounded-2xl px-4 py-3 text-[13px] font-bold text-white transition-all duration-200',
              busy
                ? 'cursor-wait bg-arc/70 opacity-80'
                : 'bg-arc shadow-[0_16px_34px_-18px_rgba(124,140,255,0.95)] hover:brightness-110 active:scale-[0.99]',
            )}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            {busy ? 'Waiting for sign-in…' : 'Continue to secure sign-in'}
          </button>

          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="mt-2 w-full rounded-2xl border border-line bg-white/[0.03] px-4 py-2.5 text-[12px] font-semibold text-fog transition-colors duration-200 hover:border-white/20 hover:text-mist disabled:cursor-wait disabled:opacity-50"
          >
            Not now
          </button>

          <p className="mt-4 text-center text-[10px] leading-relaxed text-fog/70">
            The secure window may ask you to authorize VAULTED. Close it to cancel.
          </p>
        </div>
      </div>
    </div>,
    document.body,
  )
}
