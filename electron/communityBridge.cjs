'use strict'

/**
 * Bridge into a community launcher's own library.
 *
 * Several community launchers (Omen today) run their UI in a WebView2 page
 * that exposes the launcher's real library API. VAULTED already starts that
 * launcher, so it can open a loopback DevTools port and call the launcher's
 * own AddVersionInfo/SaveLibraryDiskEntries path: the exact build the player
 * downloaded in VAULTED appears in the launcher's library, with the launcher's
 * own version id, instead of asking the player to use Import Build by hand.
 *
 * Everything is local: the port binds 127.0.0.1, the page is the launcher we
 * just started, and no credential leaves the machine. When the launcher does
 * not expose this API the result is `supported: false` and the caller keeps
 * its manual handoff.
 */

const http = require('node:http')
const net = require('node:net')
const { WebSocket } = require('ws')

const CLIENT_RELATIVE = ['FortniteGame', 'Binaries', 'Win64', 'FortniteClient-Win64-Shipping.exe']

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Reserve a loopback port for the launcher's DevTools endpoint. */
async function allocateLauncherDebugPort() {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.on('error', () => resolve(0))
    server.listen(0, '127.0.0.1', () => {
      let port = 0
      try {
        port = server.address().port
      } catch {
        port = 0
      }
      server.close(() => resolve(port))
    })
  })
}

/**
 * Environment for a launcher started by VAULTED. WebView2 reads this variable
 * and ignores it in apps that do not use WebView2.
 */
function launcherBridgeEnv(port, baseEnv = process.env) {
  if (!port) return { ...baseEnv }
  const args = `--remote-debugging-port=${port}`
  return {
    ...baseEnv,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: baseEnv.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
      ? `${baseEnv.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS} ${args}`
      : args,
  }
}

function fetchJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`HTTP ${response.statusCode}`))
        return
      }
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk
        if (body.length > 2 * 1024 * 1024) request.destroy(new Error('response too large'))
      })
      response.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch (error) {
          reject(error)
        }
      })
    })
    request.on('timeout', () => request.destroy(new Error('timeout')))
    request.on('error', reject)
  })
}

/** Wait until the launcher's WebView2 exposes a page target. */
async function waitForLauncherPage(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`, 1500).catch(() => null)
    if (Array.isArray(targets)) {
      const page = targets.find((target) => target && target.type === 'page' && target.webSocketDebuggerUrl)
      if (page) return page
    }
    await delay(250)
  }
  return null
}

/** One Runtime.evaluate round trip over a fresh DevTools socket. */
function evaluateOnPage(webSocketUrl, expression, timeoutMs = 12_000) {
  return new Promise((resolve, reject) => {
    let socket
    try {
      socket = new WebSocket(webSocketUrl, { handshakeTimeout: 4000 })
    } catch (error) {
      reject(error)
      return
    }
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        /* already closed */
      }
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => finish(new Error('launcher did not answer')), timeoutMs)
    socket.on('open', () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: {
            expression,
            awaitPromise: true,
            returnByValue: true,
            userGesture: true,
          },
        }),
      )
    })
    socket.on('message', (raw) => {
      let message
      try {
        message = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (!message || message.id !== 1) return
      if (message.error) {
        finish(new Error(message.error.message || 'launcher evaluation failed'))
        return
      }
      const result = message.result
      if (result && result.exceptionDetails) {
        const detail = result.exceptionDetails
        finish(
          new Error(
            (detail.exception && detail.exception.description) ||
              detail.text ||
              'launcher evaluation failed',
          ),
        )
        return
      }
      finish(null, result && result.result ? result.result.value : undefined)
    })
    socket.on('error', (error) => finish(error))
    socket.on('close', () => finish(new Error('launcher closed the bridge')))
  })
}

/**
 * Expression that mirrors the launcher's own AttemptAddBuild without opening a
 * folder picker: read the client's version from its executable, resolve the
 * launcher's version info, then persist the library entry through its own API.
 */
function buildImportExpression(folder) {
  return `(async () => {
  const folder = ${JSON.stringify(folder)};
  const separator = String.fromCharCode(92);
  const exe = folder + separator + ${JSON.stringify(CLIENT_RELATIVE.join('/'))}.split('/').join(separator);
  const manager = globalThis.LauncherManager && globalThis.LauncherManager.LibraryManager;
  if (!manager || typeof manager.AddVersionInfo !== 'function') {
    return JSON.stringify({ supported: false, reason: 'no-library-manager' });
  }
  const internals = window.__TAURI_INTERNALS__;
  const invoke = internals && internals.invoke;
  if (typeof invoke !== 'function') {
    return JSON.stringify({ supported: true, linked: false, reason: 'no-invoke' });
  }
  let version = '';
  let cl = '';
  try {
    const read = await invoke('read_version', { path: exe });
    if (Array.isArray(read)) {
      version = read[0];
      cl = read[1];
    } else if (read && typeof read === 'object') {
      version = read.version;
      cl = read.cl;
    }
  } catch (error) {
    return JSON.stringify({ supported: true, linked: false, reason: 'read-version-failed', detail: String(error && error.message || error) });
  }
  if (!version || !cl) {
    return JSON.stringify({ supported: true, linked: false, reason: 'no-build-version' });
  }
  const entries = Array.isArray(manager.libraryDiskEntries) ? manager.libraryDiskEntries : [];
  const existing = entries.find((entry) => entry && String(entry.path || '').toLowerCase() === folder.toLowerCase());
  if (existing) {
    return JSON.stringify({ supported: true, linked: true, already: true, versionId: existing.versionId });
  }
  let info = null;
  try {
    info = await manager.AddVersionInfo(String(version), parseInt(cl, 10));
  } catch (error) {
    return JSON.stringify({ supported: true, linked: false, reason: 'version-info-failed', detail: String(error && error.message || error) });
  }
  if (!info || !info.version_id) {
    return JSON.stringify({ supported: true, linked: false, reason: 'not-signed-in' });
  }
  const entry = {
    path: folder,
    manifestId: '++Fortnite+Release-' + version + '-CL-' + cl + '.json',
    versionId: info.version_id,
    version: parseFloat(version),
    cl: parseInt(cl, 10),
  };
  manager.libraryDiskEntries = entries.concat([entry]);
  await manager.SaveLibraryDiskEntries();
  if (typeof manager.emit === 'function') manager.emit();
  return JSON.stringify({ supported: true, linked: true, added: true, versionId: info.version_id, title: info.title || '' });
})()`
}

/**
 * @param {object} options
 * @param {number} options.port loopback DevTools port the launcher was started with
 * @param {string} options.folder installed season folder VAULTED downloaded
 */
async function linkBuildIntoLauncher({ port, folder, timeoutMs = 30_000 } = {}) {
  if (!port) return { supported: false, linked: false, reason: 'no-port' }
  if (!folder) return { supported: false, linked: false, reason: 'no-folder' }
  const page = await waitForLauncherPage(port, Math.min(20_000, timeoutMs))
  if (!page) return { supported: false, linked: false, reason: 'launcher-not-reachable' }

  const deadline = Date.now() + timeoutMs
  let last = { supported: false, linked: false, reason: 'launcher-not-ready' }
  while (Date.now() < deadline) {
    let raw
    try {
      raw = await evaluateOnPage(page.webSocketDebuggerUrl, buildImportExpression(folder))
    } catch (error) {
      last = { supported: false, linked: false, reason: 'bridge-failed', detail: String(error && error.message) }
      await delay(400)
      continue
    }
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
      // The launcher loads its library and session a few seconds after its
      // window appears. A supported-but-not-linked answer (empty library,
      // session not restored yet) is retried instead of treated as final.
      if (parsed && parsed.linked === true) return parsed
      last = parsed || last
    } catch {
      last = { supported: false, linked: false, reason: 'bad-reply' }
    }
    await delay(700)
  }
  return last
}

module.exports = {
  allocateLauncherDebugPort,
  buildImportExpression,
  evaluateOnPage,
  launcherBridgeEnv,
  linkBuildIntoLauncher,
  waitForLauncherPage,
}
