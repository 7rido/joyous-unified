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
 * The cart, seeded with one line of each kind so the filled state is reachable.
 *
 * The recording has an empty cart (the live account had nothing in it), which means
 * every cart feature - quantity steppers, remove, totals, checkout gating - is
 * unreachable from an empty start. Three payload shapes were read off the client:
 *
 *   POST /cart { productId, variantId, quantity }
 *   POST /cart { groupBuyItemId, quantity }
 *   POST /cart { saleItemId, quantity }
 *
 * Items are hydrated from the recorded catalogue and group-buy payloads so the client
 * finds the nested product/variant/campaign objects its selectors expect. In memory
 * only; a restart returns to the recording.
 */
function buildSeedCart() {
  const items = []
  const first = catalogProducts[0]
  if (first) {
    const v = first.variants?.[0] ?? null
    items.push({
      id: 'seed-product-1', kind: 'product', productId: first.id,
      variantId: v?.id ?? null, quantity: 2,
      product: first, variant: v, groupBuyItem: null, saleItem: null, campaign: null,
    })
  }
  const second = catalogProducts[3]
  if (second) {
    const v = second.variants?.[0] ?? null
    items.push({
      id: 'seed-product-2', kind: 'product', productId: second.id,
      variantId: v?.id ?? null, quantity: 1,
      product: second, variant: v, groupBuyItem: null, saleItem: null, campaign: null,
    })
  }
  const camp = catalogCampaigns[0]
  const gi = camp?.items?.[0]
  if (gi) {
    items.push({
      id: 'seed-groupbuy-1', kind: 'groupbuy', groupBuyItemId: gi.id, quantity: 1,
      product: gi.product ?? null, variant: gi.variant ?? null,
      groupBuyItem: gi, saleItem: null, campaign: camp,
    })
  }
  return items
}

/** The group-buy campaigns, for hydrating group-buy cart lines. */
let catalogCampaigns = []
try {
  catalogCampaigns = JSON.parse(readFileSync(join(SAMPLES, 'api_groupbuys.json'), 'utf8')).campaigns ?? []
} catch { /* leave empty */ }

/** The cart, in memory, seeded so a filled cart is reachable. */
let cart = buildSeedCart()

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

  // --- promo codes -------------------------------------------------------
  // Returning {} with a 200 for a promo code is a lie the client cannot act on: the
  // request "succeeds" and there is no valid discount in the body. The client reads
  // t.discount.code, throws, and shows a generic failure. A real API rejects an
  // unknown code with a 4xx and a message, so this does the same - the recorded
  // samples contain no promo, so every code is genuinely invalid here.
  if (pathname === '/api/checkout/validate-promo' && req.method === 'POST') {
    let body = {}
    try { body = JSON.parse((await readBody(req)) || '{}') } catch { /* ignore */ }
    console.log(`  [checkout] validate-promo "${body.code ?? ''}" -> 400 (no promo recorded)`)
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'That code didn\'t work.' }))
    return
  }

  // --- checkout validation ----------------------------------------------
  // POST /checkout/validate-cart replies with the price breakdown the order summary
  // renders. The field names below are the destructured props of that component:
  //
  //   function OrderSummary({items, subtotal, discount, shippingCost, insuranceCost,
  //                          coaCost, adminFee, total, freeShippingThreshold,
  //                          freeShippingEnabled, isCollapsed, onToggle})
  //
  // Falling through to the {} fallback left `items` undefined, so items.map threw and
  // the whole checkout page hit the error boundary.
  //
  // The AMOUNTS are computed here from the in-memory cart, not recorded: the live
  // account's cart is empty, so this endpoint cannot be observed, and its server-side
  // pricing (tier discounts, fees, shipping rules) is not something this mock can
  // reproduce faithfully. Treat the arithmetic as invented and the shape as derived.
  if (pathname === '/api/checkout/validate-cart' && req.method === 'POST') {
    const unit = (line) => {
      const v = line.variant ?? {}
      const prod = line.product ?? {}
      const base = v.pricePerUnit ?? prod.pricePerUnit ?? 0
      const disc = v.saleDiscount ?? prod.saleDiscount ?? 0
      return Math.max(base - disc, 0)
    }
    const items = cart.map((line) => {
      const prod = line.product ?? {}
      const v = line.variant ?? {}
      const qty = line.quantity ?? 1
      // The summary reads r.name, r.quantity and r.totalPrice - note totalPrice, a
      // LINE total. Naming it lineTotal left totalPrice undefined and .toFixed threw.
      return {
        ...line,
        name: v.name ? `${prod.name ?? ''} - ${v.name}`.trim() : (prod.name ?? 'Item'),
        quantity: qty,
        unitPrice: unit(line),
        totalPrice: unit(line) * qty,
      }
    })
    const subtotal = items.reduce((sum, i) => sum + i.totalPrice, 0)
    const body = {
      items,
      subtotal,
      // discount is an OBJECT ({code, amount}) or null. Passing 0 still satisfied the
      // truthiness guard and then read .amount off a number.
      discount: null,
      shippingCost: 0,
      insuranceCost: 0,
      coaCost: 0,
      adminFee: 0,
      total: subtotal,
      freeShippingThreshold: 200,
      freeShippingEnabled: true,
    }
    console.log(`  [checkout] validate-cart -> ${items.length} item(s), subtotal ${subtotal}`)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
    return
  }

  // --- cart: in-memory, seeded so the filled state is reachable ----------
  if (pathname === '/api/cart') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ items: cart, cartType: cart.length ? 'MIXED' : null }))
      return
    }
    if (req.method === 'POST') {
      let body = {}
      try { body = JSON.parse((await readBody(req)) || '{}') } catch { /* ignore */ }
      const qty = Number(body.quantity) || 1
      // Adding a product already in the cart INCREMENTS its line rather than
      // appending a second one. Pushing unconditionally left the same item as
      // repeated lines with the true total split across them.
      const existing = cart.find((i) =>
        (body.groupBuyItemId && i.groupBuyItemId === body.groupBuyItemId) ||
        (body.saleItemId && i.saleItemId === body.saleItemId) ||
        (body.productId && i.productId === body.productId &&
          (i.variantId ?? null) === (body.variantId ?? i.variantId ?? null)))
      if (existing) {
        existing.quantity += qty
        console.log(`  [cart] POST merge -> ${existing.id.slice(0, 16)} qty ${existing.quantity}`)
      } else if (body.groupBuyItemId) {
        const camp = catalogCampaigns.find((c) => (c.items ?? []).some((i) => i.id === body.groupBuyItemId))
        const gi = camp?.items?.find((i) => i.id === body.groupBuyItemId) ?? null
        cart.push({ id: `local-gb-${Date.now()}`, kind: 'groupbuy', groupBuyItemId: body.groupBuyItemId,
          quantity: qty, product: gi?.product ?? null, variant: gi?.variant ?? null,
          groupBuyItem: gi, saleItem: null, campaign: camp ?? null })
      } else if (body.saleItemId) {
        cart.push({ id: `local-sale-${Date.now()}`, kind: 'sale', saleItemId: body.saleItemId,
          quantity: qty, product: null, variant: null, groupBuyItem: null, saleItem: { id: body.saleItemId }, campaign: null })
      } else if (body.productId) {
        const product = catalogProducts.find((x) => x.id === body.productId) ?? null
        const variants = product?.variants ?? []
        const variant = variants.find((v) => v.id === body.variantId) ?? variants[0] ?? null
        cart.push({ id: `local-p-${Date.now()}`, kind: 'product', productId: body.productId,
          variantId: body.variantId ?? variant?.id ?? null, quantity: qty,
          product, variant, groupBuyItem: null, saleItem: null, campaign: null })
      }
      console.log(`  [cart] POST -> ${cart.length} line(s)`)
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, items: cart }))
      return
    }
    if (req.method === 'PUT' || req.method === 'PATCH') {
      let body = {}
      try { body = JSON.parse((await readBody(req)) || '{}') } catch { /* ignore */ }
      const line = cart.find((i) => i.id === body.itemId || i.id === body.id)
      if (line) line.quantity = Number(body.quantity) || line.quantity
      console.log(`  [cart] ${req.method} -> quantity=${line?.quantity ?? '?'}`)
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, items: cart }))
      return
    }
    if (req.method === 'DELETE') {
      // The client calls DELETE /cart to clear it.
      const before = cart.length
      cart = []
      console.log(`  [cart] DELETE all -> ${before} to 0`)
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
  }

  // Per-line updates carry the id in the PATH and only {quantity} in the body:
  //   PUT    /api/cart/<itemId>  {"quantity":3}
  //   DELETE /api/cart/<itemId>
  // Looking for the id in the body silently did nothing - the request arrived, the
  // handler matched no line, and the page kept its old quantity with no error.
  if (pathname.startsWith('/api/cart/')) {
    const id = pathname.split('/').pop()
    if (req.method === 'PUT' || req.method === 'PATCH') {
      let body = {}
      try { body = JSON.parse((await readBody(req)) || '{}') } catch { /* ignore */ }
      const line = cart.find((i) => i.id === id)
      if (line) {
        line.quantity = Number(body.quantity) || line.quantity
        console.log(`  [cart] PUT ${id.slice(0, 16)} -> quantity ${line.quantity}`)
      } else {
        console.log(`  [cart] PUT ${id.slice(0, 16)} -> NO SUCH LINE`)
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, items: cart }))
      return
    }
    if (req.method === 'DELETE') {
      const before = cart.length
      cart = cart.filter((i) => i.id !== id)
      console.log(`  [cart] DELETE ${id.slice(0, 16)} -> ${before} to ${cart.length}`)
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
  }

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
    // A 200 with {} is the worst possible answer: the client treats the request as
    // successful, then reads a field off an empty object and dies somewhere far from
    // the cause. That is how the product detail pages and checkout both broke.
    //
    // GETs still get {} and a 200, because for a read the client's own `|| []` guards
    // cope and pages render. WRITES get a 501 instead: a mutation that silently
    // appears to succeed is worse than one that visibly fails.
    notRecorded.add(`${req.method} ${pathname}`)
    const isWrite = req.method !== 'GET' && req.method !== 'HEAD'
    console.warn(`  [api] NOT RECORDED: ${req.method} ${pathname} -> ${isWrite ? '501' : '200 {}'}`)
    if (isWrite) {
      res.writeHead(501, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({
        error: 'Not implemented in this replay',
        detail: `${req.method} ${pathname} was never recorded.`,
      }))
      return
    }
    console.warn('        an empty body here makes the client throw and render a blank page')
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
