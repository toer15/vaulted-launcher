import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRight, Loader2, LockKeyhole, ShieldCheck, UserRound, X } from 'lucide-react'
import { cx } from '../lib/cx'
import { signIn, signUp, type RiftSession } from '../lib/network'

interface SignInModalProps {
  open: boolean
  onClose: () => void
  onAuthenticated: (session: RiftSession) => void
}

type Mode = 'signin' | 'signup'

export function SignInModal({ open, onClose, onAuthenticated }: SignInModalProps) {
  const [mode, setMode] = useState<Mode>('signin')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  busyRef.current = busy
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!open) return
    setError(null)
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
  }, [open])

  if (!open) return null

  const switchMode = (next: Mode) => {
    setMode(next)
    setError(null)
    setPassword('')
    setConfirm('')
  }

  const submit = async () => {
    if (busy) return
    setError(null)

    const name = username.trim()
    if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) {
      setError('Username: 3–20 letters, numbers or underscores.')
      return
    }
    if (!/^\S{6,64}$/.test(password)) {
      setError('Password must be 6–64 characters, no spaces.')
      return
    }
    if (mode === 'signup' && password !== confirm) {
      setError('The passwords do not match.')
      return
    }

    setBusy(true)
    try {
      const session = mode === 'signup' ? await signUp(name, password) : await signIn(name, password)
      onAuthenticated(session)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not reach the VAULTED service.')
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
      aria-labelledby="vaulted-sign-in-title"
    >
      <div
        className="animate-scale-in relative w-full max-w-[460px] overflow-hidden rounded-3xl border border-line bg-ink shadow-[0_40px_120px_-30px_rgba(0,0,0,0.95)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="pointer-events-none absolute -top-28 left-1/2 h-64 w-64 -translate-x-1/2 rounded-full bg-arc/15 blur-3xl" aria-hidden />
        <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-emerald-400 via-arc to-transparent" aria-hidden />

        <header className="relative flex items-start justify-between gap-3 p-6 pb-0">
          <div>
            <p className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-emerald-300">
              <ShieldCheck className="h-3.5 w-3.5" />
              Secure account link
            </p>
            <h2 id="vaulted-sign-in-title" className="mt-2 font-display text-2xl font-black uppercase tracking-[0.04em] text-mist">
              VAULTED · SECURE ACCOUNT LINK
            </h2>
            <p className="mt-2 text-[12.5px] leading-relaxed text-fog">
              Sign in to VAULTED to download and play any season.
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
          <p className="mb-4 text-[11px] text-fog">Use your VAULTED account to continue.</p>

          <div className="grid grid-cols-2 gap-1 rounded-2xl border border-line bg-black/30 p-1">
            {(['signin', 'signup'] as Mode[]).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => switchMode(value)}
                aria-pressed={mode === value}
                className={cx(
                  'rounded-xl px-3 py-2 text-[12.5px] font-semibold transition-all duration-200',
                  mode === value ? 'bg-white text-void shadow' : 'text-fog hover:text-mist',
                )}
              >
                {value === 'signin' ? 'Sign in' : 'Create account'}
              </button>
            ))}
          </div>

          <div className="mt-4 space-y-3">
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-fog">Username</span>
              <span className="mt-1.5 flex items-center gap-2 rounded-xl border border-line bg-black/40 px-3 py-2.5 focus-within:border-arc/60">
                <UserRound className="h-4 w-4 shrink-0 text-fog" />
                <input
                  value={username}
                  onChange={(event) => {
                    setUsername(event.target.value)
                    setError(null)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void submit()
                  }}
                  autoComplete="username"
                  autoFocus
                  spellCheck={false}
                  maxLength={20}
                  placeholder="renegade_raider"
                  className="min-w-0 flex-1 bg-transparent text-[13px] text-mist placeholder:text-fog/50 focus:outline-none"
                />
              </span>
            </label>

            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-fog">Password</span>
              <span className="mt-1.5 flex items-center gap-2 rounded-xl border border-line bg-black/40 px-3 py-2.5 focus-within:border-arc/60">
                <LockKeyhole className="h-4 w-4 shrink-0 text-fog" />
                <input
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value)
                    setError(null)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void submit()
                  }}
                  type="password"
                  maxLength={64}
                  autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                  placeholder="letters, numbers, symbols"
                  className="min-w-0 flex-1 bg-transparent text-[13px] text-mist placeholder:text-fog/50 focus:outline-none"
                />
              </span>
            </label>

            {mode === 'signup' && (
              <label className="block">
                <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-fog">Confirm password</span>
                <span className="mt-1.5 flex items-center gap-2 rounded-xl border border-line bg-black/40 px-3 py-2.5 focus-within:border-arc/60">
                  <LockKeyhole className="h-4 w-4 shrink-0 text-fog" />
                  <input
                    value={confirm}
                    onChange={(event) => {
                      setConfirm(event.target.value)
                      setError(null)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void submit()
                    }}
                    type="password"
                    maxLength={64}
                    autoComplete="new-password"
                    placeholder="repeat your password"
                    className="min-w-0 flex-1 bg-transparent text-[13px] text-mist placeholder:text-fog/50 focus:outline-none"
                  />
                </span>
              </label>
            )}
          </div>

          {error && (
            <p role="alert" className="mt-3 rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-200">
              {error}
            </p>
          )}

          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy}
            className={cx(
              'mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-[13px] font-semibold text-white transition-all duration-300',
              busy
                ? 'cursor-progress opacity-80'
                : 'bg-gradient-to-r from-arc to-fuchsia-500 shadow-[0_18px_40px_-18px_rgba(124,140,255,0.9)] hover:-translate-y-0.5 hover:brightness-110 active:translate-y-0',
            )}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
            {busy ? 'Connecting…' : mode === 'signin' ? 'Sign in' : 'Create account'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
