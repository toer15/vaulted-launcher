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
 * password. This popup is centred like the app's other dialogs while the
 * launcher window handles the actual sign-in. Once the account is saved the
 * popup disappears on its own and the card's button changes back to Download
 * Season.
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
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose, open])

  if (!open) return null

  const watching = opened && !busy

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
        className="animate-scale-in relative w-full max-w-[460px] overflow-hidden rounded-3xl border border-line bg-ink shadow-[0_40px_120px_-30px_rgba(0,0,0,0.95)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div
          className="h-[3px] bg-gradient-to-r from-emerald-400 via-arc to-transparent"
          aria-hidden
        />

        <div className="p-3.5">
          <div className="flex items-start justify-between gap-2">
            <p className="flex items-center gap-1.5 pt-0.5 text-[9px] font-semibold uppercase tracking-[0.18em] text-emerald-300">
              <ShieldCheck className="h-3 w-3" /> Launcher account
            </p>
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              aria-label="Close launcher sign-in"
              className="grid h-6 w-6 shrink-0 place-items-center rounded-lg text-fog transition-colors duration-200 hover:bg-white/[0.08] hover:text-white disabled:cursor-wait disabled:opacity-50"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <h2
            id="launcher-signin-title"
            className="mt-1 font-display text-[15px] font-black uppercase tracking-[0.03em] text-mist"
          >
            Sign in to {launcherLabel}
          </h2>
          <p className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-fog/75">
            {seasonLabel}
          </p>

          <div
            className={cx(
              'mt-2.5 rounded-xl border px-2.5 py-2',
              signedIn === false
                ? 'border-amber-300/25 bg-amber-400/[0.07]'
                : 'border-arc/25 bg-arc/[0.08]',
            )}
          >
            <p className="flex items-center gap-1.5 text-[11.5px] font-semibold text-mist">
              <LogIn className="h-3.5 w-3.5 shrink-0 text-arc" />
              {signedIn === false
                ? `${launcherLabel} is signed out on this PC`
                : verifiable
                  ? 'Checking your launcher account'
                  : 'Use the launcher window that opens'}
            </p>
            <p className="mt-1 text-[10.5px] leading-relaxed text-fog">
              {signedIn === false
                ? verifiable
                  ? `Sign in at ${launcherLabel}. VAULTED closes it and returns here automatically.`
                  : `Sign in at ${launcherLabel}, then press continue. VAULTED closes it and brings you back.`
                : verifiable
                  ? `VAULTED reads ${launcherLabel}'s saved session only; it never sees your password.`
                  : `VAULTED cannot read ${launcherLabel}'s account storage, so confirm once you are signed in.`}
            </p>
          </div>

          {opened && (
            <p
              role="status"
              className="mt-2 flex items-start gap-2 rounded-xl border border-emerald-300/25 bg-emerald-400/[0.07] px-2.5 py-2 text-[10.5px] leading-relaxed text-emerald-100"
            >
              {verifiable ? (
                <Loader2 className={cx('mt-0.5 h-3 w-3 shrink-0', watching && 'animate-spin')} />
              ) : (
                <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0" />
              )}
              {verifiable
                ? `Waiting for your ${launcherLabel} session. It closes and this goes away on its own.`
                : `Finish in ${launcherLabel}, then press continue — it closes and this goes away.`}
            </p>
          )}

          {error && (
            <p
              role="alert"
              className="mt-2 rounded-xl border border-rose-400/30 bg-rose-500/10 px-2.5 py-2 text-[10.5px] leading-relaxed text-rose-200"
            >
              {error}
            </p>
          )}

          <div className="mt-2.5 grid gap-2">
            <button
              type="button"
              onClick={onOpen}
              disabled={busy}
              className={cx(
                'flex w-full items-center justify-center gap-1.5 rounded-xl px-2.5 py-2 text-[11.5px] font-bold text-white transition-all duration-200',
                busy
                  ? 'cursor-wait bg-arc/70 opacity-80'
                  : 'bg-arc shadow-[0_12px_26px_-16px_rgba(124,140,255,0.95)] hover:brightness-110 active:scale-[0.99]',
              )}
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ExternalLink className="h-3.5 w-3.5" />
              )}
              {opened ? `Sign in to ${launcherLabel} again` : `Sign in to ${launcherLabel}`}
            </button>
            <button
              type="button"
              onClick={onContinue}
              disabled={busy}
              className={cx(
                'flex w-full items-center justify-center gap-1.5 rounded-xl border px-2.5 py-2 text-[11.5px] font-bold transition-all duration-200',
                busy
                  ? 'cursor-wait border-line bg-white/[0.04] text-fog/60'
                  : 'border-emerald-300/30 bg-emerald-400/10 text-emerald-100 hover:bg-emerald-400/15 active:scale-[0.99]',
              )}
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ShieldCheck className="h-3.5 w-3.5" />
              )}
              {busy ? 'Signing in…' : "I've signed in — continue"}
            </button>
          </div>

          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="mt-1 w-full rounded-lg px-2 py-1 text-[10.5px] font-semibold text-fog transition-colors duration-200 hover:text-mist disabled:cursor-wait disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
