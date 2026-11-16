import { useState } from 'react'
import { ArrowRight, Loader2, LockKeyhole, ShieldCheck, Sparkles, UserRound } from 'lucide-react'
import brandIcon from '../assets/brand-icon.png'
import { artFor } from '../lib/art'
import { cx } from '../lib/cx'
import { hasWindowControls } from '../lib/launch'
import { signIn, signUp, type RiftSession } from '../lib/network'
import { seasonForMajor } from '../lib/seasons'
import type { GlobalBackend } from '../types'
import { WindowControls } from './WindowControls'
import { Wordmark } from './Wordmark'

interface AuthScreenProps {
  providers?: GlobalBackend[]
  onAuthenticated: (session: RiftSession) => void
}

type Mode = 'signin' | 'signup'

export function AuthScreen({ providers = [], onAuthenticated }: AuthScreenProps) {
  const [mode, setMode] = useState<Mode>('signin')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [providerBusy, setProviderBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const oauthProviders = providers.filter((provider) => provider.auth === 'oauth')
  const providerAuthAvailable = Boolean(window.arc?.providerAuth?.login)

  const art = artFor(seasonForMajor(12))

  const switchMode = (next: Mode) => {
    setMode(next)
    setError(null)
    setPassword('')
    setConfirm('')
  }

  const beginProviderSignIn = async (provider: GlobalBackend) => {
    if (busy || providerBusy) return
    if (!window.arc?.providerAuth?.login) {
      setError('In-app sign-in needs the desktop app. Run "npm run app".')
      return
    }
    setProviderBusy(provider.id)
    setError(null)
    try {
      const status = await window.arc.providerAuth.login(provider.id)
      if (!status?.signedIn) throw new Error(`${provider.label} did not return a session. Try again.`)
      const displayName = status.displayName?.trim() || `${provider.label} Player`
      const accountId =
        status.accountId?.trim() ||
        displayName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 40) ||
        provider.id
      onAuthenticated({
        token: '',
        providerOnly: true,
        user: {
          id: `${provider.id}:${accountId}`,
          username: displayName,
          avatarUrl: status.avatarUrl || undefined,
          providerId: provider.id,
          providerLabel: provider.label,
        },
      })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `${provider.label} sign-in failed.`)
    } finally {
      setProviderBusy(null)
    }
  }

  const submit = async () => {
    if (busy || providerBusy) return
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

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden">
      <div className="app-drag fixed inset-x-0 top-0 z-30 h-8" aria-hidden />

      {/* key art backdrop */}
      <div className="pointer-events-none fixed inset-0 -z-10" aria-hidden>
        {art && <img src={art} alt="" className="h-full w-full scale-105 object-cover opacity-40" />}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_30%_35%,rgba(20,32,90,0.55),rgba(5,6,10,0.94)_70%)]" />
        <div className="absolute inset-0 bg-gradient-to-t from-void via-void/70 to-transparent" />
        <div className="absolute inset-0 grain opacity-50" />
      </div>

      <header className="relative flex items-center justify-between px-5 pt-11 sm:px-8 sm:pt-12">
        <div className="flex items-center gap-3">
          <span className="relative grid h-10 w-10 place-items-center overflow-hidden rounded-2xl bg-panel shadow-lg shadow-arc/30">
            <img src={brandIcon} alt="VAULTED" draggable={false} className="h-full w-full object-cover" />
            <span className="absolute inset-0 rounded-2xl ring-1 ring-inset ring-white/25" />
          </span>
          <div>
            <Wordmark className="text-[18px]" />
            <p className="mt-1 text-[11px] text-fog">Fortnite Build Launcher</p>
          </div>
        </div>
        {hasWindowControls() && (
          <div className="app-no-drag">
            <WindowControls />
          </div>
        )}
      </header>

      <main className="relative flex flex-1 items-start justify-center overflow-y-auto px-5 py-10 sm:px-8">
        <div className="my-auto grid w-full max-w-[980px] items-center gap-10 lg:grid-cols-[1.05fr_0.95fr]">
          <section className="max-w-md">
            <p className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-[0.2em] text-mist/90 backdrop-blur">
              <Sparkles className="h-3 w-3 text-amber-300" />
              Every chapter · every season
            </p>
            <h1 className="mt-5 font-display text-[3rem] font-black leading-[0.98] tracking-[-0.035em] text-white sm:text-[3.9rem]">
              DROP IN
              <span className="block bg-gradient-to-r from-arc via-indigo-300 to-fuchsia-400 bg-clip-text text-transparent">
                TO ANY ERA.
              </span>
            </h1>
            <p className="mt-4 max-w-sm text-[13.5px] leading-relaxed text-fog">
              Sign in once and VAULTED ties your player profile and live season counts to your account. Your build
              library and downloaded files stay on this PC.
            </p>
            <ul className="mt-6 space-y-2 text-[12.5px] text-mist/80">
              <li className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> 43 builds mapped from Chapter 1 to the
                latest mini season
              </li>
              <li className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-arc" /> See how many players are deployed right now
              </li>
              <li className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-fuchsia-400" /> One click downloads, no links to hunt for
              </li>
            </ul>
          </section>

          <section className="w-full rounded-3xl border border-white/10 bg-ink/80 p-5 shadow-[0_40px_90px_-40px_rgba(0,0,0,0.95)] backdrop-blur-xl sm:p-6">
            {oauthProviders.length > 0 && providerAuthAvailable && (
              <div className="mb-5">
                <p className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.18em] text-emerald-300">
                  <ShieldCheck className="h-3.5 w-3.5" /> One sign-in · VAULTED + global play
                </p>
                <h2 className="mt-2 font-display text-xl font-semibold tracking-tight text-white">
                  Continue with your live account.
                </h2>
                <p className="mt-1 text-[12px] leading-relaxed text-fog">
                  Your Discord or Google profile becomes your VAULTED identity and authorizes live global matchmaking.
                  No separate account to create.
                </p>
                <div className="mt-3 space-y-2">
                  {oauthProviders.map((provider) => (
                    <button
                      key={provider.id}
                      type="button"
                      onClick={() => void beginProviderSignIn(provider)}
                      disabled={Boolean(providerBusy) || busy}
                      className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-emerald-400/35 bg-emerald-400/[0.1] px-4 py-3 text-[13px] font-semibold text-emerald-100 transition-all duration-200 hover:border-emerald-400/65 hover:bg-emerald-400/[0.16] hover:text-white disabled:cursor-wait disabled:opacity-65"
                    >
                      {providerBusy === provider.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <ShieldCheck className="h-4 w-4" />
                      )}
                      {providerBusy === provider.id ? 'Waiting for sign-in…' : `Continue with ${provider.label}`}
                    </button>
                  ))}
                </div>
                <div className="mt-5 flex items-center gap-3 text-[9.5px] font-bold uppercase tracking-[0.18em] text-fog/60">
                  <span className="h-px flex-1 bg-line" />
                  or use a VAULTED account
                  <span className="h-px flex-1 bg-line" />
                </div>
              </div>
            )}

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

            <h2 className="mt-5 font-display text-xl font-semibold tracking-tight text-white">
              {mode === 'signin' ? 'Welcome back, player.' : 'Claim your callsign.'}
            </h2>
            <p className="mt-1 text-[12px] leading-relaxed text-fog">
              {mode === 'signin'
                ? 'Use the username and password you created on VAULTED.'
                : 'Pick a username and a password (6+ characters — letters, numbers or symbols).'}
            </p>

            <div className="mt-5 space-y-3">
              <label className="block">
                <span className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-fog">Username</span>
                <span className="mt-1.5 flex items-center gap-2 rounded-xl border border-line bg-black/40 px-3 py-2.5 focus-within:border-arc/60">
                  <UserRound className="h-4 w-4 shrink-0 text-fog" />
                  <input
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
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
                <span className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-fog">Password</span>
                <span className="mt-1.5 flex items-center gap-2 rounded-xl border border-line bg-black/40 px-3 py-2.5 focus-within:border-arc/60">
                  <LockKeyhole className="h-4 w-4 shrink-0 text-fog" />
                  <input
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
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
                  <span className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-fog">Confirm password</span>
                  <span className="mt-1.5 flex items-center gap-2 rounded-xl border border-line bg-black/40 px-3 py-2.5 focus-within:border-arc/60">
                    <LockKeyhole className="h-4 w-4 shrink-0 text-fog" />
                    <input
                      value={confirm}
                      onChange={(event) => setConfirm(event.target.value)}
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
              disabled={busy || Boolean(providerBusy)}
              className={cx(
                'mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-[13.5px] font-semibold text-white transition-all duration-300',
                busy
                  ? 'cursor-progress opacity-80'
                  : 'bg-gradient-to-r from-arc to-fuchsia-500 shadow-[0_18px_40px_-18px_rgba(124,140,255,0.9)] hover:-translate-y-0.5 hover:brightness-110 active:translate-y-0',
              )}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
              {busy ? 'Connecting…' : mode === 'signin' ? 'Sign in' : 'Create account'}
            </button>

            <p className="mt-3 text-center text-[10.5px] leading-relaxed text-fog/70">
              Your password is salted and hashed; VAULTED never stores it in plain text. VAULTED is not affiliated with Epic Games.
            </p>
          </section>
        </div>
      </main>
    </div>
  )
}
