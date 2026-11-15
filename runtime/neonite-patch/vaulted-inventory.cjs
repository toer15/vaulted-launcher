const fs = require('node:fs')
const path = require('node:path')

/**
 * The launcher's shop uses Fortnite cosmetic IDs. A private server does not
 * grant those automatically, so this module turns the account's owned list
 * into real athena profile items and keeps a sidecar copy that is re-applied
 * whenever the backend reads the profile.
 *
 * Type prefixes follow the live athena profile format, including the older
 * unified AthenaDance entry used for emotes, sprays, emoji and toys.
 */
const TEMPLATE_BY_TYPE = Object.freeze({
  outfit: 'AthenaCharacter',
  backpack: 'AthenaBackpack',
  pickaxe: 'AthenaPickaxe',
  glider: 'AthenaGlider',
  emote: 'AthenaDance',
  emoji: 'AthenaDance',
  spray: 'AthenaDance',
  toy: 'AthenaDance',
  wrap: 'AthenaItemWrap',
  contrail: 'AthenaSkyDiveContrail',
  loadingscreen: 'AthenaLoadingScreen',
  music: 'AthenaMusicPack',
  petcarrier: 'AthenaBackpack',
  banner: 'BannerToken',
  shoe: 'CosmeticShoes',
  aura: 'SparksAura',
  sidekick: 'CosmeticCompanion',
  pet: 'AthenaPetCosmetic',
})

const ITEM_TYPES = new Set(Object.keys(TEMPLATE_BY_TYPE))
const MAX_ITEMS = 20_000
const INVENTORY_FILE = 'vaulted-inventory.json'

function normalizeAccountId(accountId) {
  return String(accountId || 'Player').replace(/[^a-z0-9_]/gi, '').slice(0, 24) || 'Player'
}

function normalizeItem(value) {
  if (!value || typeof value !== 'object') return null
  const id = String(value.id || '').trim()
  const type = String(value.type || '').trim().toLowerCase()
  if (!id || id.length > 160 || !/^[a-z0-9_.-]+$/i.test(id)) return null
  if (!ITEM_TYPES.has(type)) return null
  return { id, type }
}

function normalizeInventory(payload) {
  const items = []
  const seen = new Set()
  const source = Array.isArray(payload?.items) ? payload.items : []
  for (const value of source) {
    if (items.length >= MAX_ITEMS) break
    const item = normalizeItem(value)
    if (!item) continue
    const key = item.id.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    items.push(item)
  }

  const equipped = {}
  const owned = new Set(items.map((item) => item.id))
  for (const [rawType, rawId] of Object.entries(payload?.equipped || {})) {
    const type = String(rawType || '').trim().toLowerCase()
    const id = String(rawId || '').trim()
    if (!ITEM_TYPES.has(type) || !id || !owned.has(id)) continue
    equipped[type] = id
  }

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    items,
    equipped,
  }
}

function templateId(item) {
  const prefix = TEMPLATE_BY_TYPE[item.type]
  return prefix ? `${prefix}:${item.id}` : null
}

function profilePath(root, accountId, profileId = 'athena') {
  return path.join(root, 'profile', normalizeAccountId(accountId), 'profiles', `profile_${profileId}.json`)
}

function inventoryPath(root, accountId) {
  return path.join(root, 'profile', normalizeAccountId(accountId), INVENTORY_FILE)
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(temporary, file)
}

function readInventory(root, accountId) {
  const value = readJson(inventoryPath(root, accountId))
  if (!value || value.version !== 1 || !Array.isArray(value.items)) return null
  return normalizeInventory(value)
}

function itemRecord(template) {
  const now = new Date().toISOString()
  return {
    templateId: template,
    attributes: {
      max_level_bonus: 0,
      level: 1,
      item_seen: false,
      xp: 0,
      variants: [],
      creation_time: now,
      favorite: false,
    },
    quantity: 1,
  }
}

function addItems(profile, inventory) {
  if (!profile || typeof profile !== 'object') return 0
  if (!profile.items || typeof profile.items !== 'object') profile.items = {}

  const known = new Set(Object.keys(profile.items).map((key) => String(key).toLowerCase()))
  let added = 0
  for (const item of inventory.items) {
    const template = templateId(item)
    if (!template) continue
    const key = template.toLowerCase()
    if (known.has(key)) continue
    profile.items[template] = itemRecord(template)
    known.add(key)
    added += 1
  }
  return added
}

/**
 * Merge the sidecar owned list into an athena profile object. This is called
 * by profile.js on every read, including after the game has saved a profile,
 * so a purchase can never be erased by a later lobby update.
 */
function apply(accountId, profile, root) {
  const inventory = readInventory(root, accountId)
  if (!inventory) return 0
  return addItems(profile, inventory)
}

/**
 * Persist the account's owned list and write the corresponding items into the
 * athena profile immediately. `root` is the neonite_v2 directory.
 */
function sync(root, accountId, payload) {
  if (!root) throw new Error('The private server directory is missing.')
  const account = normalizeAccountId(accountId)
  const inventory = normalizeInventory(payload)
  writeJsonAtomic(inventoryPath(root, account), inventory)

  const file = profilePath(root, account)
  let profile = readJson(file)
  let created = false
  if (!profile) {
    profile = readJson(path.join(root, 'profile_template', 'profiles', 'profile_athena.json'))
    if (!profile) throw new Error('The athena profile template is missing from the private server.')
    const now = new Date().toISOString()
    profile._id = account
    profile.accountId = account
    profile.created = now
    profile.updated = now
    profile.rvn = 1
    profile.commandRevision = 1
    created = true
  }

  const added = addItems(profile, inventory)
  if (added > 0 || created) {
    profile.rvn = (Number(profile.rvn) || 1) + 1
    profile.commandRevision = (Number(profile.commandRevision) || 1) + 1
    profile.updated = new Date().toISOString()
    writeJsonAtomic(file, profile)
  }

  return {
    accountId: account,
    added,
    owned: inventory.items.length,
  }
}

module.exports = {
  TEMPLATE_BY_TYPE,
  ITEM_TYPES,
  normalizeAccountId,
  normalizeInventory,
  templateId,
  apply,
  sync,
}
