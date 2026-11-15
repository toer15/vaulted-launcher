import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { ArrowLeft, LogIn, QrCode, ShieldCheck, UserPlus } from 'lucide-react'
import { cx } from '../lib/cx'
import {
  login,
  pollQr,
  register,
  resetPassword,
  setSession,
  startQr,
  type AccountSession,
  type QrStart,
} from '../lib/auth'

type Mode = 'signin' | 'register' | 'reset' | 'qr'

interface FriendsAuthProps {
  defaultUsername: string
  onSignedIn: (session: AccountSession) => void
  onCancel?: () => void
}

export function FriendsAuth({ defaultUsername, onSignedIn, onCancel }: FriendsAuthProps) {
  const [mode, setMode] = useState<Mode>('signin')
  const [username, setUsername] = useState(defaultUsername)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [recovery, setRecovery] = useState('')
  const [newRecovery, setNewRecovery] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  const [qr, setQr] = useState<QrStart | null>(null)
  const [qrImage, setQrImage] = useState<string | null>(null)
  const [qrExpired, setQrExpired] = useState(false)
  const [pendingSession, setPendingSession] = useState<AccountSession | null>(null)
  const qrRef = useRef<QrStart | null>(null)
  qrRef.current = qr
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    if (mode !== 'qr' || newRecovery) return
    let cancelled = false
    setError(null)
    setQrExpired(false)
    setQr(null)
    setQrImage(null)

    const boot = async () => {
      try {
        const started = await startQr()
        if (cancelled) return
        setQr(started)
        const image = await QRCode.toDataURL(started.url, {
          margin: 1,
          width: 240,
          color: { dark: '#0b0e18', light: '#ffffff' },
        })
        if (!cancelled) setQrImage(image)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not start QR sign-in.')
      }
    }
    void boot()

    const timer = window.setInterval(async () => {
      const started = await Promise.resolve(qrRef.current)
      if (!started || cancelled) return
      try {
        const result = await pollQr(started.code)
        if (cancelled) return
        if (result.status === 'expired') {
          setQrExpired(true)
          window.clearInterval(timer)
        } else if (result.status === 'approved' && result.username) {
          window.clearInterval(timer)
          const session = { username: result.username, token: result.token }
          await setSession(session)
          if (!cancelled) onSignedIn(session)
        }
      } catch {
        /* keep polling */
      }
    }, 2000)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [mode, newRecovery, onSignedIn])

  const submit = async () => {
    if (busy) return
    const name = username.trim()
    setError(null)
    setInfo(null)
    if (!name) {
      setError('Enter your username.')
      return
    }
    if (mode !== 'signin' && password.length < 8) {
      setError('Passwords need at least 8 characters.')
      return
    }
    if ((mode === 'register' || mode === 'reset') && password !== confirm) {
      setError('The two passwords don’t match.')
      return
    }
    if (mode === 'reset' && !recovery.trim()) {
      setError('Enter the recovery code you saved when you created the account.')
      return
    }

    setBusy(true)
    try {
      if (mode === 'signin') {
        onSignedIn(await login(name, password))
      } else if (mode === 'register') {
        const result = await register(name, password)
        setPendingSession(result.session)
        setNewRecovery(result.recoveryCode)
      } else {
        const result = await resetPassword(name, recovery.trim(), password)
        setPendingSession(result.session)
        setNewRecovery(result.recoveryCode)
        setInfo('Password changed. Save the new recovery code below.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  if (newRecovery) {
    return (
      <div className="mx-auto w-full max-w-md rounded-2xl border border-line bg-panel/70 p-5">
        <div className="flex items-center gap-2 text-[13px] font-semibold text-emerald-300">
          <ShieldCheck className="h-4 w-4" /> Recovery code
        </div>
        <p className="mt-2 text-[12.5px] leading-relaxed text-fog">
          Save this somewhere safe. It is the only way to reset the password if you forget it — it will not be shown
          again.
        </p>
        {info && <p className="mt-2 text-[12px] text-emerald-300">{info}</p>}
        <p className="mt-4 select-all rounded-xl border border-arc/40 bg-black/40 px-4 py-3 text-center font-mono text-[18px] tracking-[0.18em] text-mist">
          {newRecovery}
        </p>
        <button
          type="button"
          disabled={!pendingSession}
          onClick={() => pendingSession && onSignedIn(pendingSession)}
          className="mt-4 w-full rounded-xl border border-arc/50 bg-arc/20 px-4 py-2.5 text-[13px] font-semibold text-white transition-colors hover:bg-arc/30 disabled:opacity-50"
        >
          I saved it — continue
        </button>
      </div>
    )
  }

  const tabs: Array<{ id: Mode; label: string; icon: typeof LogIn }> = [
    { id: 'signin', label: 'Sign in', icon: LogIn },
    { id: 'register', label: 'Create account', icon: UserPlus },
    { id: 'qr', label: 'Phone QR', icon: QrCode },
  ]

  return (
    <div className="mx-auto w-full max-w-md rounded-2xl border border-line bg-panel/70 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[16px] font-semibold text-mist">
            {mode === 'reset' ? 'Reset your password' : 'Your VAULTED account'}
          </h2>
          <p className="mt-1 text-[12px] leading-relaxed text-fog">
            {mode === 'signin'
              ? 'Sign in to add friends and keep them on every PC.'
              : mode === 'register'
                ? 'One username and password — friends stay yours even if you reinstall.'
                : mode === 'reset'
                  ? 'Use your recovery code to set a new password.'
                  : 'Scan with your phone and approve the sign-in with your password.'}
          </p>
        </div>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1.5 text-[11px] text-fog hover:text-mist"
          >
            <ArrowLeft className="h-3 w-3" /> Back
          </button>
        )}
      </div>

      <div className="mt-4 flex gap-1.5 rounded-xl bg-black/30 p-1">
        {tabs.map((tab) => {
          const Icon = tab.icon
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                setMode(tab.id)
                setError(null)
                setInfo(null)
                setPassword('')
                setConfirm('')
                setRecovery('')
              }}
              className={cx(
                'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[11.5px] font-medium transition-colors',
                mode === tab.id || (tab.id === 'signin' && mode === 'reset')
                  ? 'bg-arc/20 text-white'
                  : 'text-fog hover:text-mist',
              )}
            >
              <Icon className="h-3.5 w-3.5" /> {tab.label}
            </button>
          )
        })}
      </div>

      {mode === 'qr' ? (
        <div className="mt-4 flex flex-col items-center">
          {qrImage ? (
            <img src={qrImage} alt="QR code for phone sign-in" className="h-[240px] w-[240px] rounded-xl bg-white p-2" />
          ) : (
            <div className="grid h-[240px] w-[240px] place-items-center rounded-xl border border-line bg-black/30 text-[12px] text-fog">
              {error ? 'QR unavailable' : 'Preparing QR…'}
            </div>
          )}
          {qrExpired ? (
            <button
              type="button"
              onClick={() => setMode('signin')}
              className="mt-4 rounded-xl border border-line px-4 py-2 text-[12px] text-mist hover:border-arc/50"
            >
              Code expired — start again
            </button>
          ) : (
            <p className="mt-4 max-w-[280px] text-center text-[12px] leading-relaxed text-fog">
              Open the camera on your phone, scan this, and sign in there. This window finishes signing in by itself.
            </p>
          )}
          {qr?.code && <p className="mt-2 font-mono text-[11px] tracking-[0.2em] text-fog/70">{qr.code}</p>}
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="mb-1 block text-[11px] uppercase tracking-wide text-fog">Username</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              spellCheck={false}
              className="w-full rounded-xl border border-line bg-black/30 px-3 py-2.5 text-[13px] text-mist outline-none placeholder:text-fog/60 focus:border-arc/60"
              placeholder="The name you chose in VAULTED"
            />
          </label>

          {mode === 'reset' && (
            <label className="block">
              <span className="mb-1 block text-[11px] uppercase tracking-wide text-fog">Recovery code</span>
              <input
                value={recovery}
                onChange={(event) => setRecovery(event.target.value)}
                spellCheck={false}
                className="w-full rounded-xl border border-line bg-black/30 px-3 py-2.5 font-mono text-[13px] tracking-wider text-mist outline-none placeholder:text-fog/60 focus:border-arc/60"
                placeholder="XXXX-XXXX-XXXX"
              />
            </label>
          )}

          <label className="block">
            <span className="mb-1 block text-[11px] uppercase tracking-wide text-fog">Password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && mode === 'signin') void submit()
              }}
              className="w-full rounded-xl border border-line bg-black/30 px-3 py-2.5 text-[13px] text-mist outline-none placeholder:text-fog/60 focus:border-arc/60"
              placeholder="At least 8 characters"
            />
          </label>

          {mode !== 'signin' && (
            <label className="block">
              <span className="mb-1 block text-[11px] uppercase tracking-wide text-fog">Repeat password</span>
              <input
                type="password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                autoComplete="new-password"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void submit()
                }}
                className="w-full rounded-xl border border-line bg-black/30 px-3 py-2.5 text-[13px] text-mist outline-none placeholder:text-fog/60 focus:border-arc/60"
              />
            </label>
          )}

          {error && <p className="text-[12px] text-rose-300">{error}</p>}
          {info && <p className="text-[12px] text-emerald-300">{info}</p>}

          <button
            type="button"
            disabled={busy}
            onClick={() => void submit()}
            className="w-full rounded-xl border border-arc/50 bg-arc/20 px-4 py-2.5 text-[13px] font-semibold text-white transition-colors hover:bg-arc/30 disabled:opacity-50"
          >
            {mode === 'signin' ? 'Sign in' : mode === 'register' ? 'Create account' : 'Set new password'}
          </button>

          <div className="flex items-center justify-between text-[11.5px]">
            {mode === 'reset' ? (
              <button type="button" onClick={() => setMode('signin')} className="text-fog hover:text-mist">
                Back to sign in
              </button>
            ) : (
              <button type="button" onClick={() => setMode('reset')} className="text-fog hover:text-mist">
                Forgot password?
              </button>
            )}
            <button
              type="button"
              onClick={() => setMode(mode === 'register' ? 'signin' : 'register')}
              className="text-fog hover:text-mist"
            >
              {mode === 'register' ? 'I already have an account' : 'Create an account'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
