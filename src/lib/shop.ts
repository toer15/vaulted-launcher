import catalogData from '../assets/shop/catalog.json'
import type { ShopDay, ShopItem, ShopItemType, ShopProgress, ShopRarity, ShopState } from '../types'

export const SHOP_STORAGE_KEY = 'vaulted.item-shop.v1'
export const STARTING_VBUCKS = 1200
export const DAY_MS = 24 * 60 * 60 * 1000

export const SHOP_CATALOG = catalogData as ShopItem[]

const SHOP_ART = import.meta.glob('../assets/shop/*.png', {
  eager: true,
  import: 'default',
}) as Record<string, string>

export function shopArt(slug: string): string {
  return SHOP_ART[`../assets/shop/${slug}.png`] ?? ''
}

export const RARITY_META: Record<
  ShopRarity,
  { label: string; color: string; soft: string; glow: string }
> = {
  uncommon: { label: 'Uncommon', color: '#63d47b', soft: '#142d20', glow: 'rgba(99,212,123,0.4)' },
  rare: { label: 'Rare', color: '#55a9ff', soft: '#10263f', glow: 'rgba(85,169,255,0.42)' },
  epic: { label: 'Epic', color: '#bd7bff', soft: '#251637', glow: 'rgba(189,123,255,0.42)' },
  legendary: { label: 'Legendary', color: '#ffad55', soft: '#33200f', glow: 'rgba(255,173,85,0.42)' },
}

export const SHOP_TYPE_LABEL: Record<ShopItemType, string> = {
  outfit: 'Outfit',
  emote: 'Emote',
  pickaxe: 'Harvesting Tool',
  glider: 'Glider',
  backpack: 'Back Bling',
}

export const DAILY_CHALLENGES = [
  { id: 'launch', target: 1, reward: 150 },
  { id: 'play10', target: 10 * 60, reward: 250 },
  { id: 'play30', target: 30 * 60, reward: 500 },
] as const

export type ShopChallengeId = (typeof DAILY_CHALLENGES)[number]['id']

export function dayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10)
}

export function nextShopRefresh(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0))
}

export function formatCountdown(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':')
}

export function formatShopDate(day: string): string {
  const date = new Date(`${day}T00:00:00Z`)
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(date)
}

export function formatVbucks(amount: number): string {
  return new Intl.NumberFormat('en-US').format(Math.max(0, Math.round(amount)))
}

function hash(input: string): number {
  let value = 2166136261
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index)
    value = Math.imul(value, 16777619)
  }
  return value >>> 0
}

function rank(item: ShopItem, day: string): number {
  return hash(`${day}:${item.id}:${item.type}`)
}

function takeItem(type: ShopItemType, day: string, used: Set<string>): ShopItem | null {
  const item = SHOP_CATALOG.filter((candidate) => candidate.type === type && !used.has(candidate.id)).sort(
    (left, right) => rank(left, day) - rank(right, day) || left.id.localeCompare(right.id),
  )[0]
  if (!item) return null
  used.add(item.id)
  return item
}

/** One deterministic, changing-at-UTC-midnight layout shared by every player. */
export function getDailyShop(day = dayKey()): ShopDay {
  const used = new Set<string>()
  const featured = [
    takeItem('outfit', day, used),
    takeItem('outfit', day, used),
  ].filter((item): item is ShopItem => item !== null)

  const daily = [
    takeItem('outfit', day, used),
    takeItem('emote', day, used),
    takeItem('pickaxe', day, used),
    takeItem('glider', day, used),
    takeItem('backpack', day, used),
    takeItem('emote', day, used),
  ].filter((item): item is ShopItem => item !== null)

  return { day, featured, daily }
}

export function createShopState(day = dayKey(), buildId: string | null = null): ShopState {
  return {
    version: 1,
    vbucks: STARTING_VBUCKS,
    owned: [],
    progress: { day, buildId, launches: 0, playSeconds: 0, claimed: [] },
  }
}

export function loadShopState(): ShopState | null {
  try {
    const raw = localStorage.getItem(SHOP_STORAGE_KEY)
    if (!raw) return null

    const parsed = JSON.parse(raw) as Partial<ShopState>
    if (parsed.version !== 1 || !Array.isArray(parsed.owned) || typeof parsed.vbucks !== 'number') return null
    const progress = parsed.progress
    if (
      !progress ||
      typeof progress.day !== 'string' ||
      !Array.isArray(progress.claimed) ||
      typeof progress.launches !== 'number' ||
      typeof progress.playSeconds !== 'number'
    ) {
      return null
    }

    return {
      version: 1,
      vbucks: Math.max(0, Math.round(parsed.vbucks)),
      owned: [...new Set(parsed.owned.filter((item): item is string => typeof item === 'string'))],
      progress: {
        day: progress.day,
        buildId: typeof progress.buildId === 'string' ? progress.buildId : null,
        launches: Math.max(0, Math.round(progress.launches)),
        playSeconds: Math.max(0, Math.round(progress.playSeconds)),
        claimed: progress.claimed.filter((item): item is string => typeof item === 'string'),
      },
    }
  } catch {
    return null
  }
}

export function saveShopState(state: ShopState): void {
  try {
    localStorage.setItem(SHOP_STORAGE_KEY, JSON.stringify(state))
  } catch {
    /* storage full / disabled — the shop still works for this session */
  }
}

export function challengeValue(progress: ShopProgress, id: ShopChallengeId): number {
  if (id === 'launch') return progress.launches
  return progress.playSeconds
}

export function challengeTarget(id: ShopChallengeId): number {
  return DAILY_CHALLENGES.find((task) => task.id === id)?.target ?? 0
}

export function challengeReward(id: ShopChallengeId): number {
  return DAILY_CHALLENGES.find((task) => task.id === id)?.reward ?? 0
}
