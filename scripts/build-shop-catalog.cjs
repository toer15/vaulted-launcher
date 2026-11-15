#!/usr/bin/env node
/**
 * Rebuilds the Item Shop catalog from the public Fortnite-API cosmetic feed.
 * The generated file is checked in so the shop works offline and does not
 * depend on a third-party request every time VAULTED starts.
 */
const fs = require('node:fs')
const path = require('node:path')

const API_URL = 'https://fortnite-api.com/v2/cosmetics/br?language=en'
const OUTPUT = path.join(__dirname, '..', 'src', 'assets', 'shop', 'catalog.full.json')

const TYPE_BASE = {
  outfit: 1200,
  backpack: 400,
  pickaxe: 800,
  glider: 800,
  emote: 500,
  wrap: 300,
  contrail: 300,
  spray: 200,
  emoji: 200,
  loadingscreen: 300,
  music: 300,
  toy: 200,
  pet: 800,
  petcarrier: 800,
  sidekick: 800,
  shoe: 800,
  aura: 600,
  banner: 200,
}

const RARITY_MULTIPLIER = {
  common: 1,
  uncommon: 1,
  rare: 1.25,
  epic: 1.5,
  legendary: 1.75,
  mythic: 2,
  marvel: 1.6,
  dc: 1.6,
  icon: 1.5,
  gaminglegends: 1.5,
  starwars: 1.6,
  shadow: 1.4,
  frozen: 1.4,
  lava: 1.5,
  slurp: 1.3,
  dark: 1.4,
}

const TYPE_LABEL = {
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

function priceFor(type, rarity) {
  const base = TYPE_BASE[type] ?? 400
  const multiplier = RARITY_MULTIPLIER[rarity] ?? 1.15
  return Math.max(200, Math.min(2800, Math.round((base * multiplier) / 100) * 100))
}

function seasonFor(introduction) {
  if (introduction?.chapter && introduction?.season) {
    return `Chapter ${introduction.chapter} · Season ${introduction.season}`
  }
  if (introduction?.text) {
    return introduction.text.replace(/^Introduced in\s+/i, '').replace(/\.$/, '')
  }
  return 'Classic'
}

function imageFor(item) {
  const images = item.images ?? {}
  return (
    images.featured ||
    images.icon ||
    images.smallIcon ||
    images.other?.decal ||
    images.other?.background ||
    images.other?.coverart ||
    ''
  )
}

function slugFor(id) {
  return String(id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

async function main() {
  console.log(`Fetching ${API_URL}`)
  const response = await fetch(API_URL, { headers: { 'User-Agent': 'VAULTED-Launcher/catalog' } })
  if (!response.ok) throw new Error(`Fortnite-API returned ${response.status}`)
  const payload = await response.json()
  if (!Array.isArray(payload.data)) throw new Error('Fortnite-API response did not contain a cosmetic list')

  const seen = new Set()
  const catalog = []

  for (const item of payload.data) {
    const type = item.type?.value
    const image = imageFor(item)
    const name = String(item.name ?? '').trim()
    if (!item.id || !name || !image || !TYPE_LABEL[type] || seen.has(item.id)) continue

    seen.add(item.id)
    const rarity = String(item.rarity?.value ?? 'uncommon').toLowerCase()
    const record = {
      id: item.id,
      slug: slugFor(item.id),
      name,
      type,
      rarity,
      price: priceFor(type, rarity),
      season: seasonFor(item.introduction),
      image,
    }
    if (item.set?.value) record.setName = String(item.set.value)
    if (item.series?.value) record.series = String(item.series.value)
    if (item.description) record.description = String(item.description).slice(0, 180)
    catalog.push(record)
  }

  catalog.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true })
  fs.writeFileSync(OUTPUT, JSON.stringify(catalog))

  const typeCounts = {}
  const rarityCounts = {}
  for (const item of catalog) {
    typeCounts[item.type] = (typeCounts[item.type] ?? 0) + 1
    rarityCounts[item.rarity] = (rarityCounts[item.rarity] ?? 0) + 1
  }

  console.log(`Wrote ${catalog.length} cosmetics to ${path.relative(process.cwd(), OUTPUT)}`)
  console.log('Types:', JSON.stringify(typeCounts))
  console.log('Rarities:', JSON.stringify(rarityCounts))
  console.log(`Size: ${(fs.statSync(OUTPUT).size / 1024 / 1024).toFixed(2)} MiB`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
