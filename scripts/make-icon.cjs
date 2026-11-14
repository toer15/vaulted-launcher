/**
 * Builds build/icon.ico (window + taskbar icon) and src/assets/brand-icon.png
 * from the VAULTED badge. Run: npm run icon
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const SIZES = [256, 128, 64, 48, 32, 16]

const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2b3fa8"/>
      <stop offset="0.55" stop-color="#5b21b6"/>
      <stop offset="1" stop-color="#0a0e22"/>
    </linearGradient>
    <linearGradient id="face" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="0.5" stop-color="#e7edff"/>
      <stop offset="1" stop-color="#8ea2ff"/>
    </linearGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#fde68a"/>
      <stop offset="1" stop-color="#f59e0b"/>
    </linearGradient>
    <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.16"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <rect width="256" height="256" rx="58" fill="url(#bg)"/>
  <rect width="256" height="140" rx="58" fill="url(#gloss)"/>
  <path d="M0 196 L256 118 L256 256 L0 256 Z" fill="#05060a" opacity="0.45"/>
  <path d="M0 74 L256 0 L256 26 L0 104 Z" fill="#ffffff" opacity="0.06"/>

  <g transform="translate(0 4) translate(128 0) skewX(-9) translate(-128 0)">
    <text x="128" y="188" text-anchor="middle"
      font-family="'Arial Black', 'Segoe UI Black', Arial, sans-serif"
      font-size="168" font-style="italic" font-weight="900"
      fill="url(#face)" stroke="#070b1a" stroke-width="14"
      paint-order="stroke" letter-spacing="-6">V</text>
  </g>

  <path d="M62 204 L186 204 L177 217 L53 217 Z" fill="url(#gold)"/>
</svg>`

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 256,
    height: 256,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: { offscreen: false },
  })

  const html = `<!doctype html><html><head><style>
    html,body{margin:0;padding:0;background:transparent;overflow:hidden}
    svg{display:block}
  </style></head><body>${SVG}</body></html>`

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise((resolve) => setTimeout(resolve, 500))

  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 })

  if (image.isEmpty()) {
    console.error('Could not render the icon.')
    app.exit(1)
    return
  }

  const frames = SIZES.map((size) => ({
    size,
    data: image.resize({ width: size, height: size, quality: 'best' }).toPNG(),
  }))

  // ICO container with PNG payloads (Vista+); width/height 0 means 256
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(frames.length, 4)

  const entries = []
  let offset = 6 + frames.length * 16

  for (const frame of frames) {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(frame.size >= 256 ? 0 : frame.size, 0)
    entry.writeUInt8(frame.size >= 256 ? 0 : frame.size, 1)
    entry.writeUInt8(0, 2)
    entry.writeUInt8(0, 3)
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(frame.data.length, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    offset += frame.data.length
  }

  const outDir = path.join(__dirname, '..', 'build')
  fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, 'icon.ico')
  fs.writeFileSync(outFile, Buffer.concat([header, ...entries, ...frames.map((frame) => frame.data)]))

  const assetDir = path.join(__dirname, '..', 'src', 'assets')
  fs.mkdirSync(assetDir, { recursive: true })
  fs.writeFileSync(path.join(assetDir, 'brand-icon.png'), frames[0].data)

  console.log(`wrote ${outFile} (${SIZES.join(', ')}px) and src/assets/brand-icon.png`)
  app.quit()
})
