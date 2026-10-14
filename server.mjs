/**
 * Unified server: landing clone + member app, one origin.
 *
 * ROUTING
 *   /app/*      the landing clone (authored React, its own /assets/ and theme.css)
 *   /api/*      recorded responses
 *   everything else
 *               the member client, with SPA fallback
 *
 * WHY the landing clone is not at `/`
 * Both clients emit root-relative asset URLs under /assets/, and the member client
 * is a prebuilt bundle that hardcodes its own. Two immovable namespaces cannot both
 * own `/assets/`, so the landing clone — the half we can rebuild — moves to /app/.
 * Its root links still work: `/` is caught here and served the member client.
 *
 * WHY the two index.html files are kept separate
 * They load different bundles. Merging them would load both clients at once.
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { existsSync, statSync } from 'node:fs'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = join(HERE, 'dist')
const SAMPLES = join(HERE, 'api-samples')
const PORT = Number(process.argv[2] ?? 4400)
const VERBOSE = process.env.UNIFIED_LOG === '1'
/** Every endpoint asked for but never recorded, exposed at /__gaps for auditing. */
const notRecorded = new Set()

/**
 * The recorded catalogue, used to hydrate wishlist items the same way the real API
 * does. A wishlist item is not a bare id: it carries the whole product object, so a
 * row added without one renders blank.
 */
let catalogProducts = []
try {
  catalogProducts = JSON.parse(readFileSync(join(SAMPLES, 'api_products_catalog.json'), 'utf8')).products ?? []
} catch { /* leave empty */ }

/** Read a request body as text (used by the few endpoints that accept one). */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

/**
 * The wishlist, seeded from the recorded sample so it starts as the real account had
 * it. Mutations live in memory only.
 */
let wishlist = []
try {
  wishlist = JSON.parse(readFileSync(join(SAMPLES, 'api_wishlist.json'), 'utf8')).items ?? []
} catch { /* leave empty */ }

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
}

/** Resolve a regular file under `base`, refusing directories and traversal. */
function resolveFile(base, rel) {
  const clean = normalize(rel).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]/, '')
  const candidate = join(base, clean)
  if (!candidate.startsWith(base)) return null
  try {
    return statSync(candidate).isFile() ? candidate : null
  } catch {
    return null
  }
}

/** Map an API path to its recorded sample: `/api/auth/me` -> api_auth_me.json */
function sampleFileFor(pathname) {
  const name = pathname.replace(/\/+$/, '').replace(/^\//, '').replace(/\//g, '_')
  return name.length === 0 ? null : join(SAMPLES, `${name}.json`)
}

async function sendFile(res, file, { cache, range, req } = {}) {
  const body = await readFile(file)
  const type = TYPES[extname(file)] ?? 'application/octet-stream'
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes' }

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (m) {
      const [, s, e] = m
      const start = s === '' ? Math.max(body.length - Number(e), 0) : Number(s)
      const end = s === '' || e === '' ? body.length - 1 : Math.min(Number(e), body.length - 1)
      if (start <= end && start < body.length) {
        const slice = body.subarray(start, end + 1)
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': String(slice.length) })
        res.end(slice)
        return
      }
    }
  }
  res.writeHead(200, { ...headers, 'Content-Length': String(body.length), ...(cache ? { 'Cache-Control': cache } : {}) })
  res.end(body)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  const pathname = decodeURIComponent(url.pathname)
  if (VERBOSE) console.log(`  <- ${req.method} ${pathname}`)

  // --- wishlist: in-memory, seeded from the recording --------------------
  // The read endpoint is a static sample, so a toggle that removes an item appears to
  // work but reverts on reload - and it 404s the POST/DELETE the client actually
  // sends. This keeps the same item shape while letting add/remove persist for the
  // life of the process. Deliberately NOT persisted to disk: the recording stays the
  // source of truth, and a restart returns to it.
  if (pathname === '/api/wishlist') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ items: wishlist }))
      return
    }
    if (req.method === 'POST') {
      let body = {}
      try { body = JSON.parse((await readBody(req)) || '{}') } catch { /* ignore */ }
      if (body.productId && !wishlist.some((i) => i.productId === body.productId)) {
        // Hydrate from the catalogue so the item has the same shape the real API
        // returns. Without this the row has product: null and renders empty.
        const product = catalogProducts.find((p) => p.id === body.productId) ?? null
        const variants = product?.variants ?? []
        const variant = variants.find((v) => v.id === body.variantId) ?? variants[0] ?? null
        wishlist.push({
          id: `local-${Date.now()}-${wishlist.length}`,
          productId: body.productId,
          variantId: body.variantId ?? null,
          createdAt: new Date().toISOString(),
          product,
          variant,
          hasVariants: variants.length > 0,
          availableStock: variant?.availableStock ?? product?.stockQty ?? 0,
          activeSale: null,
        })
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, items: wishlist.length }))
      return
    }
  }

  if (pathname.startsWith('/api/wishlist/') && req.method === 'DELETE') {
    const id = pathname.split('/').pop()
    const before = wishlist.length
    for (let i = wishlist.length - 1; i >= 0; i--) if (wishlist[i].id === id) wishlist.splice(i, 1)
    console.log(`  [wishlist] DELETE ${id.slice(0, 8)} -> ${before} item(s) to ${wishlist.length}`)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  // --- audit surface -----------------------------------------------------
  // Lets a sweep end with "zero unrecorded endpoints" as a checked fact rather than
  // a claim, and names any that were hit.
  if (pathname === '/__gaps') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ count: notRecorded.size, gaps: [...notRecorded].sort() }, null, 1))
    return
  }

  // --- API ---------------------------------------------------------------
  if (pathname.startsWith('/api/')) {
    // --- Auth is synthesised, not recorded -------------------------------
    // These are the only endpoints that CANNOT be recorded: a recorded login
    // response is a snapshot, and the client needs a live one to establish a
    // session. Without this, POST /auth/login returns {} with a 200, the client
    // reads `data.user`, finds undefined, and bounces straight back to /login.
    //
    // The client only requires `user` in the response shape the /auth/me sample
    // already uses, so the same object is returned for login, register and me.
    // NO CREDENTIAL IS CHECKED - any email and password are accepted, because
    // there is no backend behind this.
    if (pathname === '/api/auth/login' || pathname === '/api/auth/register') {
      let user = null
      try {
        user = JSON.parse(await readFile(join(SAMPLES, 'api_auth_me.json'), 'utf8')).user
      } catch { /* fall through */ }
      if (user) {
        console.log(`  [auth] ${pathname} -> synthetic session for ${user.email}`)
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ user, token: 'placeholder-token' }))
        return
      }
    }
    if (pathname === '/api/auth/logout') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
      return
    }

    // --- method-aware, where the method was actually observed -------------
    // /api/community-handoff issues a single-sign-on code, so it POSTs. Returning
    // its payload for a GET would invent a response the real API never gives, and
    // hide a client bug that got the verb wrong. Only the observed verb is answered.
    const POST_ONLY = new Set(['/api/community-handoff'])
    if (POST_ONLY.has(pathname) && req.method !== 'POST') {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({
        message: `Route ${req.method}:${pathname} not found`, error: 'Not Found', statusCode: 404,
      }))
      return
    }

    const file = sampleFileFor(pathname)
    if (file && existsSync(file)) {
      const body = await readFile(file)
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(body)
      return
    }

    // --- unrecorded ------------------------------------------------------
    // Returns {} with a 200, which is deliberately noisy in the log because the
    // failure mode is invisible otherwise: the client destructures a field off the
    // empty object, throws, and renders a blank page that still looks like it
    // loaded. That is exactly how the empty product detail pages hid.
    console.warn(`  [api] NOT RECORDED: ${req.method} ${pathname} -> {}`)
    console.warn('        an empty body here makes the client throw and render a blank page')
    notRecorded.add(`${req.method} ${pathname}`)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{}')
    return
  }

  // --- landing clone, mounted at /app/ -----------------------------------
  if (pathname === '/app' || pathname.startsWith('/app/')) {
    const rel = pathname.replace(/^\/app\/?/, '')
    let file = rel === '' ? join(DIST, 'app', 'index.html') : resolveFile(join(DIST, 'app'), rel)
    if (file === null) {
      // SPA fallback within the mounted app, but never for a missing asset.
      if (/\.[a-z0-9]+$/i.test(rel)) {
        console.log(`  [app] MISSING ${pathname}`)
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found')
        return
      }
      file = join(DIST, 'app', 'index.html')
    }
    await sendFile(res, file, { cache: rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' , range: req.headers.range, req })
    return
  }

  // --- member client at the root ----------------------------------------
  const rel = pathname.replace(/^\//, '')
  let file = rel === '' ? join(DIST, 'index.html') : resolveFile(DIST, rel)
  if (file === null) {
    if (rel.startsWith('assets/') || /\.[a-z0-9]+$/i.test(rel)) {
      console.log(`  [asset] MISSING ${pathname}`)
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found')
      return
    }
    file = join(DIST, 'index.html') // SPA fallback: member routes
  }
  await sendFile(res, file, { cache: rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache', range: req.headers.range, req })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`unified server on http://127.0.0.1:${PORT}`)
  console.log(`  /            member client  (${existsSync(join(DIST,'index.html')) ? 'present' : 'MISSING'})`)
  console.log(`  /app/        landing clone  (${existsSync(join(DIST,'app','index.html')) ? 'present' : 'MISSING'})`)
  console.log(`  /api/*       ${existsSync(SAMPLES) ? 'recorded samples' : 'MISSING'}`)
})
