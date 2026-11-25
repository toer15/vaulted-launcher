import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { ExternalLink, Loader2, LogIn, ShieldCheck, X } from 'lucide-react'
import { cx } from '../lib/cx'

interface LauncherSignInModalProps {
  open: boolean
  seasonLabel: string
  launcherLabel: string
  /** true when VAULTED can read the launcher's saved account */
  verifiable: boolean
  /** null means the launcher has no common token store */
  signedIn: boolean | null
  busy: boolean
  opened: boolean
  error?: string | null
  onOpen: () => void
  onContinue: () => void
  onClose: () => void
}

/**
 * The season's own launcher owns its account, so VAULTED never asks for its
 * password. It opens that launcher once, waits for the player to sign in, then
 * resumes the season download that is wired to the same launcher.
 */
export function LauncherSignInModal({
  open,
  seasonLabel,
  launcherLabel,
  verifiable,
  signedIn,
  busy,
  opened,
  error,
  onOpen,
  onContinue,
  onClose,
}: LauncherSignInModalProps) {
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
      aria-labelledby="launcher-signin-title"
    >
      <div
        className="animate-scale-in relative w-full max-w-[480px] overflow-hidden rounded-3xl border border-line bg-ink shadow-[0_40px_120px_-30px_rgba(0,0,0,0.95)]"
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
              <ShieldCheck className="h-3.5 w-3.5" /> Launcher account
            </p>
            <h2
              id="launcher-signin-title"
              className="mt-2 font-display text-2xl font-black uppercase tracking-[0.04em] text-mist"
            >
              Sign in to {launcherLabel}
            </h2>
            <p className="mt-2 text-[12.5px] leading-relaxed text-fog">
              {seasonLabel} downloads through {launcherLabel}. Sign in there once and VAULTED can
              start the download that belongs to this season.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close launcher sign-in"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-xl border border-line bg-white/[0.03] text-fog transition-colors duration-200 hover:bg-white/[0.08] hover:text-white disabled:cursor-wait disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="relative p-6">
          <div
            className={cx(
              'rounded-2xl border p-3.5',
              signedIn === false
                ? 'border-amber-300/25 bg-amber-400/[0.07]'
                : 'border-arc/25 bg-arc/[0.08]',
            )}
          >
            <div className="flex items-start gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-arc/30 bg-arc/15 text-mist">
                <LogIn className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="text-[12.5px] font-semibold text-mist">
                  {signedIn === false
                    ? `${launcherLabel} is signed out on this PC`
                    : verifiable
                      ? 'Checking your launcher account'
                      : 'Use the launcher window that opens'}
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-fog">
                  {signedIn === false
                    ? verifiable
                      ? `Sign in at ${launcherLabel}. VAULTED closes it and returns here automatically once the account is saved.`
                      : `Sign in at ${launcherLabel}, then press continue. VAULTED closes it and brings you back.`
                    : verifiable
                      ? `VAULTED reads ${launcherLabel}'s saved session only; it never sees your password.`
                      : `VAULTED cannot read ${launcherLabel}'s account storage, so confirm once you are signed in there.`}
                </p>
              </div>
            </div>
          </div>

          {opened && (
            <p
              role="status"
              className="mt-3 rounded-xl border border-emerald-300/25 bg-emerald-400/[0.07] px-3 py-2 text-[12px] leading-relaxed text-emerald-100"
            >
              {verifiable
                ? `Finish signing in in the ${launcherLabel} window. VAULTED closes it and returns here automatically.`
                : `Finish signing in in the ${launcherLabel} window, then press continue to close it and return.`}
            </p>
          )}

          {error && (
            <p
              role="alert"
              className="mt-3 rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-[12px] leading-relaxed text-rose-200"
            >
              {error}
            </p>
          )}

          <div className="mt-4 grid gap-2">
            <button
              type="button"
              onClick={onOpen}
              disabled={busy}
              className={cx(
                'flex w-full items-center justify-center gap-2 rounded-2xl px-4 py-3 text-[13px] font-bold text-white transition-all duration-200',
                busy
                  ? 'cursor-wait bg-arc/70 opacity-80'
                  : 'bg-arc shadow-[0_16px_34px_-18px_rgba(124,140,255,0.95)] hover:brightness-110 active:scale-[0.99]',
              )}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
              {opened ? `Sign in to ${launcherLabel} again` : `Sign in to ${launcherLabel}`}
            </button>
            <button
              type="button"
              onClick={onContinue}
              disabled={busy}
              className={cx(
                'flex w-full items-center justify-center gap-2 rounded-2xl border px-4 py-3 text-[13px] font-bold transition-all duration-200',
                busy
                  ? 'cursor-wait border-line bg-white/[0.04] text-fog/60'
                  : 'border-emerald-300/30 bg-emerald-400/10 text-emerald-100 hover:bg-emerald-400/15 active:scale-[0.99]',
              )}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ShieldCheck className="h-4 w-4" />
              )}
              {busy ? 'Signing in…' : "I've signed in — continue"}
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-2xl px-4 py-2 text-[12px] font-semibold text-fog transition-colors duration-200 hover:text-mist disabled:cursor-wait disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
