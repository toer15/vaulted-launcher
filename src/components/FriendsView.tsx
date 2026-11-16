import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Check, Clock3, Globe, LogOut, UserPlus, Users, Wifi, X } from 'lucide-react'
import { cx } from '../lib/cx'
import { getSession, signOut, type AccountSession } from '../lib/auth'
import {
  addFriend,
  fetchFriends,
  removeFriend,
  respondToRequest,
  type FriendsSummary,
} from '../lib/friends'
import { FriendsAuth } from './FriendsAuth'

interface FriendsViewProps {
  username: string
  onBack: () => void
  onSummary?: (summary: FriendsSummary | null) => void
  onJoin?: (address: string, buildId: string | null, label: string | null) => void
}

export function FriendsView({ username, onBack, onSummary, onJoin }: FriendsViewProps) {
  const [session, setSession] = useState<AccountSession | null>(null)
  const [checking, setChecking] = useState(true)
  const [summary, setSummary] = useState<FriendsSummary | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [offline, setOffline] = useState(false)
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const alive = useRef(true)
  const summaryListener = useRef(onSummary)
  summaryListener.current = onSummary

  const apply = useCallback((next: FriendsSummary) => {
    setSummary(next)
    summaryListener.current?.(next)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const next = await fetchFriends()
      if (!alive.current) return
      apply(next)
      setOffline(false)
    } catch (error) {
      if (!alive.current) return
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof TypeError || message === 'Failed to fetch') setOffline(true)
    }
  }, [apply])

  useEffect(() => {
    alive.current = true
    void getSession().then((found) => {
      if (!alive.current) return
      setSession(found)
      setChecking(false)
    })
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    if (!session) return
    let timer: number | undefined
    void refresh()
    timer = window.setInterval(() => void refresh(), 4000)
    return () => {
      if (timer) window.clearInterval(timer)
    }
  }, [session, refresh])

  const handleSignedIn = (next: AccountSession) => {
    setSession(next)
    setNote(null)
  }

  const handleSignOut = async () => {
    await signOut()
    setSession(null)
    setSummary(null)
    summaryListener.current?.(null)
    setName('')
  }

  const submit = async () => {
    const target = name.trim()
    if (!target || busy || !session) return
    setBusy(true)
    setNote(null)
    try {
      const next = await addFriend(target)
      apply(next)
      setName('')
      const accepted = next.friends.some((friend) => friend.toLowerCase() === target.toLowerCase())
      setNote({
        tone: 'ok',
        text: accepted
          ? `${target} is now your friend.`
          : `Request sent to ${target}. It appears here as soon as they accept.`,
      })
    } catch (error) {
      setNote({ tone: 'error', text: error instanceof Error ? error.message : 'Could not send that request.' })
    } finally {
      setBusy(false)
    }
  }

  const respond = async (from: string, accept: boolean) => {
    setBusy(true)
    setNote(null)
    try {
      apply(await respondToRequest(from, accept))
      setNote({ tone: 'ok', text: accept ? `${from} is now your friend.` : `Declined ${from}'s request.` })
    } catch (error) {
      setNote({ tone: 'error', text: error instanceof Error ? error.message : 'Could not answer that request.' })
    } finally {
      setBusy(false)
    }
  }

  const drop = async (friend: string) => {
    setBusy(true)
    setNote(null)
    try {
      apply(await removeFriend(friend))
      setNote({ tone: 'ok', text: `Removed ${friend}.` })
    } catch (error) {
      setNote({ tone: 'error', text: error instanceof Error ? error.message : 'Could not remove that friend.' })
    } finally {
      setBusy(false)
    }
  }

  const incoming = summary?.incoming ?? []
  const friends = summary?.friends ?? []
  const outgoing = summary?.outgoing ?? []
  const hosting = new Map((summary?.hosting ?? []).map((entry) => [entry.username.toLowerCase(), entry]))
  const lobbies = summary?.lobbies ?? []
  const mine = summary?.mine ?? null

  return (
    <div className="animate-fade-up mx-auto flex w-full max-w-3xl flex-col gap-4 pb-6">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 rounded-xl border border-line bg-panel/70 px-2.5 py-2 text-[12px] font-medium text-fog transition-colors duration-200 hover:border-arc/45 hover:bg-panel-hi hover:text-mist"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="text-[22px] font-semibold tracking-tight text-mist">Friends</h1>
          <p className="truncate text-[12px] text-fog">
            Works across servers — add anyone by their VAULTED username.
          </p>
        </div>
        {session && (
          <div className="flex shrink-0 items-center gap-2">
            <span className="hidden text-[11.5px] text-fog sm:inline">
              Signed in as <span className="font-medium text-mist">{session.username}</span>
            </span>
            <button
              type="button"
              onClick={() => void handleSignOut()}
              className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1.5 text-[11px] text-fog hover:border-rose-400/40 hover:text-rose-200"
            >
              <LogOut className="h-3 w-3" /> Sign out
            </button>
          </div>
        )}
      </div>

      {checking ? (
        <div className="rounded-2xl border border-line bg-panel/70 p-6 text-[12.5px] text-fog">Loading your account…</div>
      ) : !session ? (
        <FriendsAuth defaultUsername={username} onSignedIn={handleSignedIn} onCancel={onBack} />
      ) : (
        <>
          <section className="rounded-2xl border border-line bg-panel/70 p-4">
            <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-fog">
              <UserPlus className="h-3.5 w-3.5 text-arc" /> Add a friend
            </div>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void submit()
                }}
                placeholder="Their exact VAULTED username"
                maxLength={32}
                spellCheck={false}
                className="min-w-0 flex-1 rounded-xl border border-line bg-black/30 px-3 py-2.5 text-[13px] text-mist outline-none transition-colors placeholder:text-fog/60 focus:border-arc/60"
              />
              <button
                type="button"
                onClick={() => void submit()}
                disabled={busy || !name.trim()}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-arc/50 bg-arc/20 px-4 py-2.5 text-[13px] font-semibold text-white transition-colors duration-200 hover:bg-arc/30 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <UserPlus className="h-4 w-4" /> Send request
              </button>
            </div>
            {note && (
              <p className={cx('mt-2 text-[12px]', note.tone === 'ok' ? 'text-emerald-300' : 'text-rose-300')}>
                {note.text}
              </p>
            )}
            {offline && (
              <p className="mt-2 text-[12px] text-amber-300">
                Can&apos;t reach the friends network right now — retrying every few seconds.
              </p>
            )}
          </section>

          <section className="rounded-2xl border border-line bg-panel/70 p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-fog">
                <Clock3 className="h-3.5 w-3.5 text-amber-300" /> Requests
              </div>
              <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-mist">
                {incoming.length}
              </span>
            </div>

            <ul className="mt-2 divide-y divide-line/60">
              {incoming.length === 0 && (
                <li className="py-3 text-[12px] text-fog">
                  No incoming requests. When someone adds you, it shows up here.
                </li>
              )}
              {incoming.map((request) => (
                <li key={request.from} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-arc to-fuchsia-500 text-[11px] font-bold text-white">
                      {request.from.slice(0, 2).toUpperCase()}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-medium text-mist">{request.from}</span>
                      <span className="block text-[11px] text-fog">wants to be friends</span>
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void respond(request.from, true)}
                      className="inline-flex items-center gap-1 rounded-lg border border-emerald-400/30 bg-emerald-400/[0.08] px-2.5 py-1.5 text-[11.5px] font-medium text-emerald-200 transition-colors hover:bg-emerald-400/15 disabled:opacity-50"
                    >
                      <Check className="h-3 w-3" /> Accept
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void respond(request.from, false)}
                      className="inline-flex items-center gap-1 rounded-lg border border-line bg-white/[0.03] px-2.5 py-1.5 text-[11.5px] font-medium text-fog transition-colors hover:border-rose-400/40 hover:text-rose-200 disabled:opacity-50"
                    >
                      <X className="h-3 w-3" /> Decline
                    </button>
                  </span>
                </li>
              ))}
            </ul>

            {outgoing.length > 0 && (
              <p className="mt-1 text-[11.5px] text-fog">
                Waiting on: {outgoing.map((request) => request.to).join(', ')}
              </p>
            )}
          </section>

          <section className="rounded-2xl border border-line bg-panel/70 p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-fog">
                <Users className="h-3.5 w-3.5 text-arc" /> Your friends
              </div>
              <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-mist">
                {friends.length}
              </span>
            </div>

            <ul className="mt-2 divide-y divide-line/60">
              {friends.length === 0 && (
                <li className="py-3 text-[12px] text-fog">
                  Nobody yet. Send a request above and they land here once accepted.
                </li>
              )}
              {friends.map((friend) => (
                <li key={friend} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="grid h-8 w-8 place-items-center rounded-lg bg-white/[0.06] text-[11px] font-bold text-mist">
                      {friend.slice(0, 2).toUpperCase()}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-medium text-mist">{friend}</span>
                      <span className="flex items-center gap-1 text-[11px] text-emerald-300">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Friend
                        {hosting.has(friend.toLowerCase()) && (
                          <span className="ml-1 truncate text-[11px] text-fog">
                            · hosting {hosting.get(friend.toLowerCase())!.label ?? 'a lobby'}
                          </span>
                        )}
                      </span>
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {hosting.has(friend.toLowerCase()) && onJoin && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          const lobby = hosting.get(friend.toLowerCase())!
                          onJoin(lobby.address, lobby.buildId, lobby.label ?? friend)
                        }}
                        className="rounded-lg border border-emerald-400/35 bg-emerald-400/[0.1] px-2.5 py-1.5 text-[11.5px] font-semibold text-emerald-200 transition-colors hover:bg-emerald-400/20 disabled:opacity-50"
                      >
                        Join
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void drop(friend)}
                      className="rounded-lg border border-line bg-white/[0.03] px-2.5 py-1.5 text-[11.5px] font-medium text-fog transition-colors hover:border-rose-400/40 hover:text-rose-200 disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-2xl border border-line bg-panel/70 p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-fog">
                <Globe className="h-3.5 w-3.5 text-sky-300" /> Open lobbies
              </div>
              <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-mist">
                {lobbies.length}
              </span>
            </div>
            <p className="mt-1 text-[11.5px] leading-relaxed text-fog">
              Every live season lobby on VAULTED. Press Join and the launcher starts that exact build and drops you in.
            </p>

            {mine && (
              <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-emerald-400/25 bg-emerald-400/[0.06] px-3 py-2">
                <span className="flex min-w-0 items-center gap-2 text-[11.5px] text-emerald-200">
                  {mine.public ? <Globe className="h-3.5 w-3.5" /> : <Wifi className="h-3.5 w-3.5" />}
                  <span className="min-w-0">
                    <span className="block font-semibold">Your lobby is live</span>
                    <span className="block truncate font-mono text-[10.5px] text-emerald-200/80">{mine.address}</span>
                  </span>
                </span>
                <span className="shrink-0 rounded-full border border-emerald-400/30 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-200">
                  {mine.public ? 'Internet' : 'WiFi only'}
                </span>
              </div>
            )}

            <ul className="mt-2 divide-y divide-line/60">
              {lobbies.length === 0 && (
                <li className="py-3 text-[12px] text-fog">
                  No open lobbies right now. Start a build and your lobby appears here for everyone.
                </li>
              )}
              {lobbies.map((lobby) => (
                <li key={`${lobby.username}-${lobby.address}`} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/[0.06] text-[11px] font-bold text-mist">
                      {lobby.username.slice(0, 2).toUpperCase()}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-medium text-mist">{lobby.username}</span>
                      <span className="flex items-center gap-1 text-[11px] text-fog">
                        {lobby.public ? <Globe className="h-3 w-3 text-sky-300" /> : <Wifi className="h-3 w-3 text-amber-300" />}
                        <span className="truncate">{lobby.label ?? 'Season lobby'}</span>
                        <span className="text-fog/60">· {lobby.public ? 'internet' : 'same WiFi'}</span>
                      </span>
                    </span>
                  </span>
                  {onJoin && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onJoin(lobby.address, lobby.buildId, lobby.label)}
                      className="shrink-0 rounded-lg border border-emerald-400/35 bg-emerald-400/[0.1] px-3 py-1.5 text-[11.5px] font-semibold text-emerald-200 transition-colors hover:bg-emerald-400/20 disabled:opacity-50"
                    >
                      Join
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>

        </>
      )}
    </div>
  )
}
