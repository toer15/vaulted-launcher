import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ExternalLink, KeyRound, Loader2, ShieldCheck, X } from 'lucide-react'
import { cx } from '../lib/cx'
import { cleanIpcError } from '../lib/launch'
import type { GlobalBackend, ProviderAuthStatus } from '../types'

interface ProviderSignInDialogProps {
  provider: GlobalBackend | null
  seasonLabel: string
  onClose: () => void
  /** Return an error message to keep the dialog open without accepting the code. */
  onSubmit: (code: string) => string | null | void
  /** OAuth providers sign in natively; App starts the pending launch after this resolves. */
  onAuthenticated?: (status: ProviderAuthStatus) => void
}

export function ProviderSignInDialog({
  provider,
  seasonLabel,
  onClose,
  onSubmit,
  onAuthenticated,
}: ProviderSignInDialogProps) {
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  busyRef.current = busy
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!provider) return
    setCode('')
    setError(null)
    setBusy(false)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) closeRef.current()
    }
    document.addEventListener('keydown', onKeyDown)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [provider])

  if (!provider) return null

  const isOAuth = provider.auth === 'oauth'

  const submit = () => {
    const value = code.trim()
    if (value.length < 8) {
      setError('Paste the full exchange code from the provider.')
      return
    }
    const errorMessage = onSubmit(value)
    if (errorMessage) {
      setError(errorMessage)
      return
    }
    setError(null)
  }

  const openSignIn = () => {
    const url = provider.signInUrl || provider.website
    if (url) void window.arc?.openExternal?.(url)
  }

  const signInNatively = async () => {
    if (!window.arc?.providerAuth?.login) {
      setError('In-app sign-in needs the desktop app. Run "npm run app".')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const status = await window.arc.providerAuth.login(provider.id)
      if (!status?.signedIn) throw new Error(`${provider.label} did not return a session. Try again.`)
      onAuthenticated?.(status)
    } catch (signInError) {
      setError(cleanIpcError(signInError).message)
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[95] grid place-items-center overflow-y-auto bg-[#02070c]/88 px-4 py-6 backdrop-blur-md"
      onMouseDown={(event) => {
        if (!busy && event.target === event.currentTarget) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="provider-sign-in-title"
    >
      <div
        className="animate-scale-in relative w-full max-w-[500px] overflow-hidden rounded-3xl border border-line bg-ink shadow-[0_40px_120px_-30px_rgba(0,0,0,0.95)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="pointer-events-none absolute -top-28 left-1/2 h-64 w-64 -translate-x-1/2 rounded-full bg-arc/15 blur-3xl" aria-hidden />
        <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-emerald-400 via-arc to-transparent" aria-hidden />

        <header className="relative flex items-start justify-between gap-3 p-6 pb-0">
          <div>
            <p className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-emerald-300">
              {isOAuth ? <ShieldCheck className="h-3.5 w-3.5" /> : <KeyRound className="h-3.5 w-3.5" />}
              {isOAuth ? 'Live account link' : 'Global account link'}
            </p>
            <h2
              id="provider-sign-in-title"
              className="mt-2 font-display text-2xl font-black uppercase tracking-[0.04em] text-mist"
            >
              Sign in to {provider.label}
            </h2>
            <p className="mt-2 text-[12.5px] leading-relaxed text-fog">
              {isOAuth ? (
                <>
                  {seasonLabel} is live on {provider.name}. Sign in with Discord or Google in VAULTED&rsquo;s
                  secure window. VAULTED keeps the session encrypted and requests a fresh one-time code
                  automatically whenever you press Play.
                </>
              ) : (
                <>
                  {seasonLabel} runs on {provider.name}&rsquo;s live global backend. Open the provider, copy a
                  fresh exchange code, then paste it here to queue into their real matchmaker.
                </>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close sign in"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-xl border border-line bg-white/[0.03] text-fog transition-colors duration-200 hover:bg-white/[0.08] hover:text-white disabled:cursor-wait disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="relative p-6">
          {isOAuth ? (
            <>
              <button
                type="button"
                onClick={() => void signInNatively()}
                disabled={busy}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-400 to-emerald-500 px-4 py-3 text-[12px] font-bold text-void shadow-[0_12px_30px_-14px_rgba(16,185,129,0.9)] transition-all duration-200 hover:brightness-110 active:scale-[0.99] disabled:cursor-wait disabled:opacity-70"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                {busy ? 'Waiting for sign-in…' : `Sign in to ${provider.label}`}
              </button>

              <p className="mt-3 rounded-xl border border-line/70 bg-white/[0.015] px-3 py-2.5 text-[10.5px] leading-relaxed text-fog/85">
                The provider&rsquo;s own sign-in page opens inside VAULTED. VAULTED never sees your password.
                The encrypted session stays on this PC, and the game code is used once and never saved.
              </p>

            </>
          ) : (
            <>
              <button
                type="button"
                onClick={openSignIn}
                disabled={!provider.signInUrl && !provider.website}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-arc/35 bg-arc/[0.08] px-4 py-2.5 text-[12px] font-semibold text-arc transition-colors duration-200 hover:border-arc/65 hover:bg-arc/[0.14] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Open {provider.label} sign-in
              </button>

              <label className="mt-4 block">
                <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-fog">
                  Exchange code or one-time token
                </span>
                <input
                  autoFocus
                  value={code}
                  onChange={(event) => {
                    setCode(event.target.value)
                    setError(null)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') submit()
                  }}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="Paste the code from the provider"
                  className={cx(
                    'mt-1.5 w-full rounded-xl border bg-black/40 px-3.5 py-2.5 font-mono text-[12.5px] text-mist placeholder:text-fog/50 focus:outline-none',
                    error ? 'border-rose-400/60' : 'border-line focus:border-arc/60',
                  )}
                />
              </label>

              <p className="mt-3 rounded-xl border border-line/70 bg-white/[0.015] px-3 py-2.5 text-[10.5px] leading-relaxed text-fog/85">
                The code is used once for this launch and is never saved by VAULTED. It becomes
                <span className="mx-1 font-mono text-mist/80">-AUTH_PASSWORD=…</span>
                with <span className="font-mono text-mist/80">-AUTH_TYPE=exchangecode</span>.
              </p>
            </>
          )}

          {error && <p className="mt-2 text-[11px] leading-relaxed text-rose-300">{error}</p>}

          <div className="mt-5 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-xl border border-line bg-white/[0.03] px-4 py-2.5 text-[12px] font-semibold text-mist transition-colors duration-200 hover:bg-white/[0.07] disabled:opacity-50"
            >
              Cancel
            </button>
            {!isOAuth && (
              <button
                type="button"
                onClick={submit}
                className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-emerald-400 to-emerald-500 px-4 py-2.5 text-[12px] font-bold text-void shadow-[0_12px_30px_-14px_rgba(16,185,129,0.9)] transition-all duration-200 hover:brightness-110 active:scale-[0.99]"
              >
                <KeyRound className="h-3.5 w-3.5" />
                Sign in &amp; queue
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
