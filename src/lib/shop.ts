import catalogData from '../assets/shop/catalog.json'
import fullCatalogData from '../assets/shop/catalog.full.json'
import { getActiveHoliday, getHolidayItems, holidayShopInfo } from './holidays'
import type { ShopDay, ShopEquipped, ShopHoliday, ShopItem, ShopItemType, ShopProgress, ShopRarity, ShopState } from '../types'

export const SHOP_STORAGE_KEY = 'vaulted.item-shop.v1'
const SHOP_OWNER_KEY = 'vaulted.item-shop.owner'
export const STARTING_VBUCKS = 1200
export const DAY_MS = 24 * 60 * 60 * 1000

const EQUIPPED_TYPES: ShopItemType[] = [
  'outfit',
  'backpack',
  'pickaxe',
  'glider',
  'emote',
  'wrap',
  'contrail',
  'spray',
  'emoji',
  'loadingscreen',
  'music',
  'toy',
  'pet',
  'petcarrier',
  'sidekick',
  'shoe',
  'aura',
  'banner',
]

export function emptyEquipped(): ShopEquipped {
  return Object.fromEntries(EQUIPPED_TYPES.map((type) => [type, null])) as ShopEquipped
}

function shopStorageKey(accountId?: string | null): string {
  return accountId ? `${SHOP_STORAGE_KEY}.account.${accountId}` : SHOP_STORAGE_KEY
}

const CLASSIC_CATALOG = catalogData as ShopItem[]
const FULL_CATALOG = fullCatalogData as unknown as ShopItem[]

const classicById = new Map(CLASSIC_CATALOG.map((item) => [item.id, item]))

/**
 * The full feed is the current Fortnite BR cosmetic list. The original 32
 * hand-picked cosmetics stay on top so their bundled PNGs keep working even
 * when the remote art CDN is unavailable.
 */
export const SHOP_CATALOG: ShopItem[] = (() => {
  const merged = FULL_CATALOG.map((item) => {
    const classic = classicById.get(item.id)
    return classic
      ? {
          ...item,
          ...classic,
          image: classic.image ?? item.image,
          setName: classic.setName ?? item.setName,
          series: classic.series ?? item.series,
          description: classic.description ?? item.description,
        }
      : item
  })

  const present = new Set(merged.map((item) => item.id))
  for (const item of CLASSIC_CATALOG) {
    if (!present.has(item.id)) merged.push(item)
  }
  return merged
})()

export const SHOP_ITEM_BY_ID = new Map(SHOP_CATALOG.map((item) => [item.id, item]))

/** Convert stored shop IDs into the compact list sent to the game profile. */
export function inventoryItemsFor(ids: string[]): Array<{ id: string; type: ShopItemType }> {
  const seen = new Set<string>()
  const items: Array<{ id: string; type: ShopItemType }> = []
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    const item = SHOP_ITEM_BY_ID.get(id)
    if (item) items.push({ id: item.id, type: item.type })
  }
  return items
}

const SHOP_ART = import.meta.glob('../assets/shop/*.png', {
  eager: true,
  import: 'default',
}) as Record<string, string>

export function shopArt(item: ShopItem): string {
  return SHOP_ART[`../assets/shop/${item.slug}.png`] ?? item.image ?? ''
}

export const RARITY_META: Record<
  ShopRarity,
  { label: string; color: string; soft: string; glow: string }
> = {
  common: { label: 'Common', color: '#b8c0c8', soft: '#1a2026', glow: 'rgba(184,192,200,0.32)' },
  uncommon: { label: 'Uncommon', color: '#63d47b', soft: '#142d20', glow: 'rgba(99,212,123,0.4)' },
  rare: { label: 'Rare', color: '#55a9ff', soft: '#10263f', glow: 'rgba(85,169,255,0.42)' },
  epic: { label: 'Epic', color: '#bd7bff', soft: '#251637', glow: 'rgba(189,123,255,0.42)' },
  legendary: { label: 'Legendary', color: '#ffad55', soft: '#33200f', glow: 'rgba(255,173,85,0.42)' },
  mythic: { label: 'Mythic', color: '#ffd166', soft: '#332812', glow: 'rgba(255,209,102,0.42)' },
  marvel: { label: 'Marvel', color: '#ed5b5b', soft: '#341113', glow: 'rgba(237,91,91,0.42)' },
  dc: { label: 'DC', color: '#5b8dff', soft: '#111d3a', glow: 'rgba(91,141,255,0.42)' },
  icon: { label: 'Icon Series', color: '#36d6e7', soft: '#0e2b30', glow: 'rgba(54,214,231,0.4)' },
  gaminglegends: { label: 'Gaming Legends', color: '#a78bfa', soft: '#211a38', glow: 'rgba(167,139,250,0.42)' },
  starwars: { label: 'Star Wars', color: '#ffe066', soft: '#302a10', glow: 'rgba(255,224,102,0.42)' },
  shadow: { label: 'Shadow', color: '#9b6dff', soft: '#1c1230', glow: 'rgba(155,109,255,0.42)' },
  frozen: { label: 'Frozen', color: '#7dd3fc', soft: '#102733', glow: 'rgba(125,211,252,0.42)' },
  lava: { label: 'Lava', color: '#ff6b35', soft: '#33160d', glow: 'rgba(255,107,53,0.42)' },
  slurp: { label: 'Slurp', color: '#5eead4', soft: '#0d2b27', glow: 'rgba(94,234,212,0.4)' },
  dark: { label: 'Dark', color: '#8b7aa8', soft: '#1b1723', glow: 'rgba(139,122,168,0.38)' },
}

export const SHOP_TYPE_LABEL: Record<ShopItemType, string> = {
  outfit: 'Outfit',
  backpack: 'Back Bling',
  pickaxe: 'Harvesting Tool',
  glider: 'Glider',
  emote: 'Emote',
  wrap: 'Wrap',
  contrail: 'Contrail',
  spray: 'Spray',
  emoji: 'Emoji',
  loadingscreen: 'Loading Screen',
  music: 'Jam Track',
  toy: 'Toy',
  pet: 'Pet',
  petcarrier: 'Pet Carrier',
  sidekick: 'Sidekick',
  shoe: 'Kicks',
  aura: 'Aura',
  banner: 'Banner',
}

/** Every cosmetic type is eligible for the daily lineup. */
export const DAILY_TYPES: ShopItemType[] = [
  'outfit',
  'emote',
  'pickaxe',
  'glider',
  'backpack',
  'wrap',
  'contrail',
  'spray',
  'emoji',
  'loadingscreen',
  'music',
  'toy',
  'petcarrier',
  'sidekick',
  'shoe',
  'aura',
  'banner',
]

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

function rankType(type: ShopItemType, day: string): number {
  return hash(`${day}:type:${type}`)
}

function takeItem(type: ShopItemType, day: string, used: Set<string>, pool: ShopItem[]): ShopItem | null {
  const item = pool
    .filter((candidate) => candidate.type === type && !used.has(candidate.id))
    .sort((left, right) => rank(left, day) - rank(right, day) || left.id.localeCompare(right.id))[0]
  if (!item) return null
  used.add(item.id)
  return item
}

function takeAny(day: string, used: Set<string>, pool: ShopItem[]): ShopItem | null {
  const item = pool
    .filter((candidate) => !used.has(candidate.id))
    .sort((left, right) => rank(left, day) - rank(right, day) || left.id.localeCompare(right.id))[0]
  if (!item) return null
  used.add(item.id)
  return item
}

function shopPool(day: string, catalog: ShopItem[]): { pool: ShopItem[]; holiday: ShopHoliday | null } {
  const date = new Date(`${day}T00:00:00Z`)
  const active = getActiveHoliday(date, catalog)
  if (!active) return { pool: catalog, holiday: null }
  return { pool: getHolidayItems(active, catalog), holiday: holidayShopInfo(active) }
}

/** One deterministic, changing-at-UTC-midnight layout shared by every player. */
export function getDailyShop(day = dayKey(), catalog = SHOP_CATALOG): ShopDay {
  const { pool, holiday } = shopPool(day, catalog)
  const used = new Set<string>()

  const featured: ShopItem[] = []
  for (let index = 0; index < 2; index += 1) {
    const item = takeItem('outfit', day, used, pool)
    if (item) featured.push(item)
  }
  while (featured.length < 2) {
    const item = takeAny(day, used, pool)
    if (!item) break
    featured.push(item)
  }

  // Pick one item from each of eight rotating cosmetic types. On a holiday,
  // the pool is already restricted to that holiday so no normal stock leaks in.
  const availableTypes = DAILY_TYPES.filter((type) => pool.some((item) => item.type === type && !used.has(item.id))).sort(
    (left, right) => rankType(left, day) - rankType(right, day) || left.localeCompare(right),
  )

  const daily: ShopItem[] = []
  for (const type of availableTypes) {
    if (daily.length >= 8) break
    const item = takeItem(type, day, used, pool)
    if (item) daily.push(item)
  }
  while (daily.length < 8) {
    const item = takeAny(day, used, pool)
    if (!item) break
    daily.push(item)
  }

  return { day, holiday, featured, daily }
}

export function createShopState(day = dayKey(), buildId: string | null = null): ShopState {
  return {
    version: 1,
    vbucks: STARTING_VBUCKS,
    owned: [],
    equipped: emptyEquipped(),
    progress: { day, buildId, launches: 0, playSeconds: 0, claimed: [] },
  }
}

/**
 * Purchases are scoped to the signed-in account. The old unscoped key is
 * adopted once by the first account that opens this build, so an upgrade never
 * loses an existing collection while a second account starts clean.
 */
export function loadShopState(accountId?: string | null): ShopState | null {
  try {
    let raw = accountId ? localStorage.getItem(shopStorageKey(accountId)) : localStorage.getItem(SHOP_STORAGE_KEY)
    if (!raw && accountId) {
      const owner = localStorage.getItem(SHOP_OWNER_KEY)
      if (!owner || owner === accountId) raw = localStorage.getItem(SHOP_STORAGE_KEY)
    }
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

    const owned = [...new Set(parsed.owned.filter((item): item is string => typeof item === 'string'))]
    const equipped = emptyEquipped()
    if (parsed.equipped && typeof parsed.equipped === 'object') {
      for (const type of EQUIPPED_TYPES) {
        const itemId = (parsed.equipped as Partial<ShopEquipped>)[type]
        if (typeof itemId === 'string' && owned.includes(itemId)) equipped[type] = itemId
      }
    }

    return {
      version: 1,
      vbucks: Math.max(0, Math.round(parsed.vbucks)),
      owned,
      equipped,
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

export function saveShopState(state: ShopState, accountId?: string | null): void {
  try {
    localStorage.setItem(shopStorageKey(accountId), JSON.stringify(state))
    if (accountId) localStorage.setItem(SHOP_OWNER_KEY, accountId)
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
