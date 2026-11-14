/**
 * Downloads one key-art image per Fortnite season into src/assets/art.
 *
 * The Fandom image CDN blocks direct requests (Cloudflare), so images are
 * fetched through a public resize proxy *at build time* and then bundled
 * locally — the launcher never hotlinks anything at runtime.
 *
 * Run: node scripts/fetch-art.mjs
 */
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const FORCE = process.argv.includes('--force')

const SEASONS = [
  { key: 'ch1-s1', title: 'Season 1' },
  { key: 'ch1-s2', title: 'Season 2' },
  { key: 'ch1-s3', title: 'Season 3' },
  { key: 'ch1-s4', title: 'Season 4' },
  { key: 'ch1-s5', title: 'Season 5' },
  { key: 'ch1-s6', title: 'Season 6' },
  { key: 'ch1-s7', title: 'Season 7' },
  { key: 'ch1-s8', title: 'Season 8' },
  { key: 'ch1-s9', title: 'Season 9' },
  { key: 'ch1-s10', title: 'Season X' },
  { key: 'ch2-s1', title: 'Chapter 2: Season 1' },
  { key: 'ch2-s2', title: 'Chapter 2: Season 2' },
  { key: 'ch2-s3', title: 'Chapter 2: Season 3' },
  { key: 'ch2-s4', title: 'Chapter 2: Season 4' },
  { key: 'ch2-s5', title: 'Chapter 2: Season 5' },
  { key: 'ch2-s6', title: 'Chapter 2: Season 6' },
  { key: 'ch2-s7', title: 'Chapter 2: Season 7' },
  { key: 'ch2-s8', title: 'Chapter 2: Season 8' },
  { key: 'ch3-s1', title: 'Chapter 3: Season 1' },
  { key: 'ch3-s2', title: 'Chapter 3: Season 2' },
  { key: 'ch3-s3', title: 'Chapter 3: Season 3' },
  { key: 'ch3-s4', title: 'Chapter 3: Season 4' },
  { key: 'ch4-s1', title: 'Chapter 4: Season 1' },
  { key: 'ch4-s2', title: 'Chapter 4: Season 2' },
  { key: 'ch4-s3', title: 'Chapter 4: Season 3' },
  { key: 'ch4-s4', title: 'Chapter 4: Season 4' },
  { key: 'ch4-s5', title: 'Fortnite OG' },
  { key: 'ch5-s1', title: 'Chapter 5: Season 1' },
  { key: 'ch5-s2', title: 'Chapter 5: Season 2' },
  { key: 'ch5-s3', title: 'Chapter 5: Season 3' },
  { key: 'ch5-s4', title: 'Chapter 5: Season 4' },
  { key: 'ch5-remix', title: 'Chapter 2 Remix' },
  { key: 'ch6-s1', title: 'Chapter 6: Season 1' },
  { key: 'ch6-s2', title: 'Chapter 6: Season 2' },
  { key: 'ch6-mini1', title: 'Galactic Battle' },
  { key: 'ch6-s3', title: 'Chapter 6: Season 3' },
  { key: 'ch6-s4', title: 'Chapter 6: Season 4' },
  { key: 'ch6-mini2', title: 'Chapter 6: Mini Season 2' },
  { key: 'ch7-s1', title: 'Chapter 7: Season 1' },
  { key: 'ch7-s2', title: 'Chapter 7: Season 2' },
  { key: 'ch7-s3', title: 'Chapter 7: Season 3' },
  { key: 'ch7-s4', title: 'Chapter 7: Season 4' },
]

const OUT_DIR = path.join(import.meta.dirname, '..', 'src', 'assets', 'art')
const API = 'https://fortnite.fandom.com/api.php'
const USER_AGENT = 'RIFT-Launcher/1.0 (local build script)'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function keyArtFor(title) {
  const url = `${API}?action=query&format=json&prop=pageimages&pithumbsize=1400&titles=${encodeURIComponent(title)}`
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!response.ok) throw new Error(`API ${response.status}`)

  const data = await response.json()
  const pages = Object.values(data?.query?.pages ?? {})
  const thumb = pages.find((page) => page.thumbnail)?.thumbnail?.source
  return thumb ?? null
}

async function download(source, target) {
  // strip scheme, let the proxy fetch it (direct CDN access returns 403)
  const bare = source.replace(/^https?:\/\//, '')
  const url = `https://images.weserv.nl/?url=${encodeURIComponent(bare)}&w=1400&output=jpg&q=85`

  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'image/*' },
  })
  if (!response.ok) throw new Error(`proxy ${response.status}`)

  const type = response.headers.get('content-type') ?? ''
  if (!type.startsWith('image/')) throw new Error(`unexpected content-type ${type}`)

  const buffer = Buffer.from(await response.arrayBuffer())
  await writeFile(target, buffer)
  return buffer.length
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true })

  const results = []
  for (const season of SEASONS) {
    const target = path.join(OUT_DIR, `${season.key}.jpg`)
    if (!FORCE && existsSync(target)) {
      results.push({ key: season.key, status: 'skipped (already downloaded)' })
      continue
    }

    try {
      const source = await keyArtFor(season.title)
      if (!source) {
        results.push({ key: season.key, status: 'no page image' })
        continue
      }

      const bytes = await download(source, target)
      results.push({ key: season.key, status: `ok ${Math.round(bytes / 1024)} KB` })
    } catch (error) {
      results.push({ key: season.key, status: `FAILED ${error.message}` })
    }
    await sleep(250)
  }

  for (const result of results) console.log(`${result.key.padEnd(8)} ${result.status}`)

  const ok = results.filter((result) => result.status.startsWith('ok')).length
  console.log(`\n${ok}/${results.length} images downloaded to src/assets/art`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
