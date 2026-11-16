/**
 * Friends live on the account relay, keyed by the signed-in account, so two
 * players on completely different hosts can still add each other.
 */

import { getSession } from './auth'

export const FRIENDS_API_BASE = 'https://site-710f0be1e3b24f2694e9e13b9ce4c84b.freebuff.page/api'
const API = FRIENDS_API_BASE

export interface FriendRequest {
  from: string
  at: string
}

export interface OutgoingRequest {
  to: string
  at: string
}

export interface LobbyInfo {
  username: string
  address: string
  /** installed build id, so a joiner launches the exact season that is hosted */
  buildId: string | null
  /** human label such as "Chapter 2 Season 3" */
  label: string | null
  /** reachable from outside the local network */
  public: boolean
  updated: string
  /** season key reported by a custom lobby service, e.g. ch1-s3 */
  seasonId?: string | null
  /** live player count when the service reports one */
  players?: number
  /** True for a joinable row from a configured external community directory. */
  external?: boolean
  /** community directory id/label when known */
  providerId?: string
  providerLabel?: string
  source?: string
  sourceLabel?: string
  maxPlayers?: number
  /**
   * False when a directory supplies a joinable row without a player field.
   * The relay omits this because its host still counts as one player.
   */
  playersKnown?: boolean
  /** Measured or directory-reported round-trip latency in milliseconds. */
  pingMs?: number
  /**
   * Freshness window in ms. 0 means the directory controls membership (for
   * example a WebSocket list that removes servers when they go offline).
   */
  freshForMs?: number
}

export type HostingFriend = LobbyInfo

export const LOBBY_FRESH_MS = 30_000

/** A relay lobby represents at least its host; external directories may not report a count. */
export function lobbyPlayers(lobby: LobbyInfo): number {
  if (typeof lobby.players === 'number' && lobby.players > 0) return Math.floor(lobby.players)
  return lobby.playersKnown === false ? 0 : 1
}

/** Ignore relay entries whose host stopped heartbeating. */
export function lobbyIsFresh(lobby: LobbyInfo): boolean {
  const updated = Date.parse(lobby.updated)
  if (!Number.isFinite(updated)) return false
  if (lobby.freshForMs === 0) return true
  const windowMs = typeof lobby.freshForMs === 'number' && lobby.freshForMs > 0 ? lobby.freshForMs : LOBBY_FRESH_MS
  return Date.now() - updated < windowMs
}

export interface FriendsSummary {
  username: string
  friends: string[]
  incoming: FriendRequest[]
  outgoing: OutgoingRequest[]
  hosting: HostingFriend[]
  /** every live lobby on the relay, friends or not */
  lobbies: LobbyInfo[]
  /** the signed-in player's own published lobby */
  mine: LobbyInfo | null
}

async function readError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string }
    if (payload?.error) return payload.error
  } catch {
    /* not json */
  }
  return `The friends network answered ${response.status}.`
}

async function authHeaders(): Promise<Record<string, string>> {
  const session = await getSession()
  if (!session) throw new Error('Sign in to use friends.')
  return { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' }
}

async function post(path: string, body: Record<string, unknown>): Promise<FriendsSummary> {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(await readError(response))
  return (await response.json()) as FriendsSummary
}

export async function fetchFriends(): Promise<FriendsSummary> {
  const response = await fetch(`${API}/summary`, { headers: await authHeaders(), cache: 'no-store' })
  if (!response.ok) throw new Error(await readError(response))
  return (await response.json()) as FriendsSummary
}

export function addFriend(friend: string): Promise<FriendsSummary> {
  return post('/request', { to: friend })
}

export function respondToRequest(from: string, accept: boolean): Promise<FriendsSummary> {
  return post('/respond', { from, accept })
}

export function removeFriend(friend: string): Promise<FriendsSummary> {
  return post('/remove', { friend })
}

async function postOk(path: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(await readError(response))
}

export function publishSession(
  address: string,
  meta?: {
    buildId?: string
    label?: string
    public?: boolean
    seasonId?: string | null
    players?: number
  },
): Promise<void> {
  return postOk('/session', { address, ...meta })
}

export function stopHosting(): Promise<void> {
  return postOk('/session/clear', {})
}
