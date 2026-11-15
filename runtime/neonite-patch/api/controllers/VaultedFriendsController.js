const fs = require('fs')
const path = require('path')

// Stored next to the backend so everyone signed into the same private server
// sees the same friend graph (two launchers can share one host).
const STORE_PATH = path.join(__dirname, '..', '..', 'vaulted-friends.json')

function allow(res) {
  res.set('Access-Control-Allow-Origin', '*')
  res.set('Access-Control-Allow-Headers', 'Content-Type')
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.set('Cache-Control', 'no-store')
}

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))
    if (parsed && Array.isArray(parsed.pairs)) return parsed
  } catch (error) {
    /* first run */
  }
  return { pairs: [] }
}

function writeStore(store) {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2))
  } catch (error) {
    /* keep serving the in-memory copy */
  }
}

function key(value) {
  return String(value || '').trim().toLowerCase()
}

function display(value) {
  return String(value || '').trim().slice(0, 32)
}

function validName(name) {
  return /^[a-zA-Z0-9_.\- ]{2,32}$/.test(name)
}

function summaryFor(store, username) {
  const me = key(username)
  const friends = []
  const incoming = []
  const outgoing = []

  for (const pair of store.pairs) {
    const from = key(pair.from)
    const to = key(pair.to)
    if (from === me && to === me) continue
    if (pair.status === 'accepted') {
      if (from === me) friends.push(pair.to)
      if (to === me) friends.push(pair.from)
    } else if (pair.status === 'pending') {
      if (to === me) incoming.push({ from: pair.from, at: pair.at })
      if (from === me) outgoing.push({ to: pair.to, at: pair.at })
    }
  }

  const unique = []
  for (const name of friends) {
    if (!unique.some((known) => key(known) === key(name))) unique.push(name)
  }

  return { username: display(username), friends: unique, incoming, outgoing }
}

function findPair(store, a, b) {
  return store.pairs.find((pair) => {
    const from = key(pair.from)
    const to = key(pair.to)
    return (from === a && to === b) || (from === b && to === a)
  })
}

module.exports = {
  preflight: function (req, res) {
    allow(res)
    return res.send('')
  },

  summary: function (req, res) {
    allow(res)
    return res.json(summaryFor(readStore(), req.params.username))
  },

  request: function (req, res) {
    allow(res)
    const body = req.body || {}
    const from = display(body.from)
    const to = display(body.to)

    if (!validName(from) || !validName(to)) {
      return res.status(400).json({
        error: 'Enter a username of 2–32 letters, numbers, spaces, dots, dashes or underscores.',
      })
    }
    if (key(from) === key(to)) {
      return res.status(400).json({ error: "You can't add yourself." })
    }

    const store = readStore()
    const existing = findPair(store, key(from), key(to))

    if (existing) {
      if (existing.status === 'accepted') {
        return res.status(409).json({ error: `${to} is already on your friends list.` })
      }
      if (existing.status === 'pending' && key(existing.to) === key(from)) {
        // They already asked us — adding them back accepts it.
        existing.status = 'accepted'
        existing.at = new Date().toISOString()
        writeStore(store)
        return res.json({ ok: true, accepted: true, ...summaryFor(store, from) })
      }
      if (existing.status === 'pending') {
        return res.status(409).json({ error: `A request to ${to} is already pending.` })
      }
      existing.from = from
      existing.to = to
      existing.status = 'pending'
      existing.at = new Date().toISOString()
      writeStore(store)
      return res.json({ ok: true, accepted: false, ...summaryFor(store, from) })
    }

    store.pairs.push({
      from,
      to,
      status: 'pending',
      at: new Date().toISOString(),
    })
    writeStore(store)
    return res.json({ ok: true, accepted: false, ...summaryFor(store, from) })
  },

  respond: function (req, res) {
    allow(res)
    const body = req.body || {}
    const user = display(body.user)
    const from = display(body.from)
    const accept = body.accept === true || body.accept === 'true'

    const store = readStore()
    const pair = findPair(store, key(user), key(from))
    if (!pair || pair.status !== 'pending') {
      return res.status(404).json({ error: 'That request is no longer available.' })
    }
    if (key(pair.to) !== key(user)) {
      return res.status(403).json({ error: 'That request was not sent to you.' })
    }

    if (accept) {
      pair.status = 'accepted'
      pair.at = new Date().toISOString()
    } else {
      store.pairs = store.pairs.filter((entry) => entry !== pair)
    }
    writeStore(store)
    return res.json({ ok: true, ...summaryFor(store, user) })
  },

  remove: function (req, res) {
    allow(res)
    const body = req.body || {}
    const user = display(body.user)
    const friend = display(body.friend)
    const store = readStore()
    const before = store.pairs.length
    store.pairs = store.pairs.filter((pair) => !findPair({ pairs: [pair] }, key(user), key(friend)))
    if (store.pairs.length !== before) writeStore(store)
    return res.json({ ok: true, ...summaryFor(store, user) })
  },
}
