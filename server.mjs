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
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { existsSync, statSync } from 'node:fs'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = join(HERE, 'dist')
const SAMPLES = join(HERE, 'api-samples')

/**
 * Pack-deal overlay state. Declared up here WITH the other path constants, because
 * `const` is hoisted but not initialised: defining these further down meant the
 * boot-time applyPackDeals() threw "Cannot access 'PACK_DEALS_FILE' before
 * initialization", the catch reported it as a generic failure, and the overlay
 * silently never applied - so a hand-edited pack-deals.json was ignored entirely.
 */
const PACK_DEALS_FILE = join(HERE, 'pack-deals.json')
const packDeals = { __applied: 0, __rejected: [] }
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

/**
 * Inventory test suite - 5 products seeded to stress stock edges. Appended to the
 * live catalogue so both the storefront and the admin Products page see them.
 *
 * `"unlimited"` in the fixture is revived to Infinity here. It has to be a number
 * rather than null because the client decides availability with a `> 0` test, and
 * `null > 0` is false - the digital product would have rendered Sold out. Infinity
 * also cannot survive JSON.stringify, so UNLIMITED_STOCK is what goes on the wire.
 */
const UNLIMITED_STOCK = 999999

/** Served when a product has no image anywhere; see the catalogue handler. */
const PLACEHOLDER_IMAGE = '/uploads/placeholders/no-image.svg'
const unlimitedVariants = new Set()
let inventoryTests = []
try {
  inventoryTests = JSON.parse(readFileSync(join(SAMPLES, 'api_products_inventory-tests.json'), 'utf8')).products ?? []
  const revive = (node, kind) => {
    for (const field of ['stockQty', 'availableStock']) {
      if (node[field] === 'unlimited') {
        node[field] = Infinity
        if (kind === 'variant') unlimitedVariants.add(node.id)
      }
    }
  }
  for (const prod of inventoryTests) {
    revive(prod, 'product')
    for (const v of prod.variants ?? []) revive(v, 'variant')
  }
  catalogProducts = catalogProducts.concat(inventoryTests)
  console.log(`  seeded ${inventoryTests.length} inventory test products`)
} catch { /* suite not generated */ }

// The overlay is applied after every catalogue source, so an authored pack deal wins.
try {
  const n = applyPackDeals()
  if (n) console.log(`  pack-deal overlay: ${n} deal(s) applied`)
} catch (e) {
  // Loud, with the stack. A quiet one-line message here is what hid a TDZ bug that
  // disabled the entire overlay and made hand-edits to pack-deals.json silently inert.
  console.log(`  pack-deal overlay FAILED: ${e.stack ?? e.message}`)
}

/**
 * THE PRICE AUTHORITY.
 *
 * Nothing the client sends may influence what a line costs. The client does send a
 * `packPrice` and `packSize`, because the pack options it renders come from the
 * catalogue's own `quantityDiscounts` - but those fields are treated as a REQUEST to
 * use a pack ("the 5-pack"), never as the price. The price is looked up here from the
 * catalogue using (variantId, minQuantity).
 *
 * This existed as a real vulnerability: the order total read `line.packPrice` first,
 * so `POST /api/cart {packPrice:1}` on a $25 product produced a $250 checkout summary
 * and a $10 charge, and `packPrice:-100` produced a NEGATIVE total.
 *
 * Returns { ok, unitPrice, reason }. Anything not resolvable in the catalogue is
 * refused rather than defaulted, because a default is a price the caller chose.
 */
function resolveLinePrice(line) {
  const product = catalogProducts.find((x) => x.id === line.productId)
  if (!product) return { ok: false, reason: 'unknown product' }
  const variants = product.variants ?? []
  const variant = variants.find((v) => v.id === line.variantId) ?? variants[0]
  if (!variant) return { ok: false, reason: 'unknown variant' }

  const base = variant.pricePerUnit ?? product.pricePerUnit
  if (typeof base !== 'number' || !Number.isFinite(base) || base < 0) {
    return { ok: false, reason: 'catalogue price is not a valid number' }
  }
  const saleOff = variant.saleDiscount ?? product.saleDiscount ?? 0
  const single = Math.max(base - (typeof saleOff === 'number' ? saleOff : 0), 0)

  // No pack requested -> the single-unit price from the catalogue.
  if (line.packSize == null) return { ok: true, unitPrice: single, source: 'catalogue' }

  // A pack was requested: it must EXIST in the catalogue for this variant, and the
  // price comes from there. An unknown pack is refused, not silently repriced.
  const packs = (variant.quantityDiscounts ?? product.quantityDiscounts ?? [])
    .filter((d) => d && d.packPrice != null && d.packPrice > 0)
  const pack = packs.find((d) => d.minQuantity === line.packSize)
  if (!pack) return { ok: false, reason: `no ${line.packSize}-pack defined for this variant` }
  const packOff = typeof pack.saleDiscount === 'number' ? pack.saleDiscount : 0
  const unitPrice = Math.max(pack.packPrice - packOff, 0)
  return {
    ok: true,
    unitPrice,
    source: 'catalogue.quantityDiscounts',
    // Recorded so a mismatch between what the client asked for and what the catalogue
    // says can be reported rather than silently applied.
    forged: line.packPrice != null && line.packPrice !== unitPrice ? line.packPrice : null,
  }
}

/**
 * Pack-deal validation. THIS is the rule that keeps a "pack discount" a discount.
 *
 * A pack is only a deal if it costs less than the same units bought singly. Nothing
 * enforced that before, so a typo in an admin form could persist a markup (or a
 * negative price) and - now that resolveLinePrice treats the stored packPrice as
 * authoritative - that value would be charged.
 *
 * Returns an array of human-readable problems. Empty means valid.
 */
function validatePackDeal(deal, unitPrice) {
  const errs = []
  if (deal == null || typeof deal !== 'object') return ['deal must be an object']

  const mq = deal.minQuantity
  if (!Number.isInteger(mq) || mq < 2) {
    errs.push(`minQuantity must be a whole number of 2 or more (got ${JSON.stringify(mq)})`)
  }

  const pp = deal.packPrice
  if (typeof pp !== 'number' || !Number.isFinite(pp) || !(pp > 0)) {
    errs.push(`packPrice must be a number greater than 0 (got ${JSON.stringify(pp)})`)
  }

  if (typeof unitPrice === 'number' && Number.isFinite(unitPrice) && unitPrice >= 0 &&
      Number.isInteger(mq) && mq >= 2 && typeof pp === 'number' && Number.isFinite(pp)) {
    const singles = unitPrice * mq
    if (pp >= singles) {
      errs.push(`packPrice ${pp} must be below ${mq} x ${unitPrice} = ${singles}; at or above it this is a markup, not a deal`)
    }
  }

  for (const f of ['saleDiscount', 'discountPercent']) {
    const v = deal[f]
    if (v != null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
      errs.push(`${f} must be a non-negative number or null (got ${JSON.stringify(v)})`)
    }
  }
  const mpo = deal.maxPerOrder
  if (mpo != null && (!Number.isInteger(mpo) || mpo < 1)) {
    errs.push(`maxPerOrder must be a positive whole number or null (got ${JSON.stringify(mpo)})`)
  }
  return errs
}

/**
 * PACK-DEAL OVERLAY - the only durable state in this server.
 *
 * Everything else (cart, orders, stock decrements, wishlist) lives in RAM and resets
 * on restart, because a replay must not silently diverge from the recording. Pack
 * deals are the deliberate exception: they are authored data, so an edit has to
 * survive, and keeping them in a separate file leaves the recorded samples untouched.
 *
 * Shape: { "<productId>": { "<variantId>": [deal, ...] } }
 */

function readPackDealsFile() {
  try {
    const raw = JSON.parse(readFileSync(PACK_DEALS_FILE, 'utf8'))
    delete raw.__comment
    return raw
  } catch {
    return {}
  }
}

/** Apply the overlay onto catalogProducts. Called at boot and after every edit. */
function applyPackDeals() {
  const all = readPackDealsFile()
  let applied = 0
  const rejected = []
  for (const [productId, byVariant] of Object.entries(all)) {
    const prod = catalogProducts.find((x) => x.id === productId)
    if (!prod) continue
    for (const [variantId, deals] of Object.entries(byVariant ?? {})) {
      const variant = (prod.variants ?? []).find((v) => v.id === variantId)
      if (!variant) continue
      // Re-validated on LOAD, not just on write. The file is editable by hand, so
      // writing a bad deal into it must not be a way around the guard.
      const unitPrice = variant.pricePerUnit ?? prod.pricePerUnit
      const list = Array.isArray(deals) ? deals : []
      const good = []
      for (const deal of list) {
        const errs = validatePackDeal(deal, unitPrice)
        if (errs.length) rejected.push(`${prod.name} ${deal?.minQuantity}-pack: ${errs[0]}`)
        else good.push(deal)
      }
      variant.quantityDiscounts = good
      applied += good.length
    }
  }
  packDeals.__applied = applied
  packDeals.__rejected = rejected
  for (const r of rejected) console.log(`  [pack-deals] DROPPED invalid stored deal -> ${r}`)
  return applied
}

/** Atomic write: a crash mid-write must not leave a truncated catalogue overlay. */
function writePackDealsFile(all) {
  const tmp = `${PACK_DEALS_FILE}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(all, null, 1)}\n`)
  renameSync(tmp, PACK_DEALS_FILE)
}

/** Stock on the wire: Infinity is not JSON, so unlimited ships as a big number. */
const wireStock = (n) => (n === Infinity ? UNLIMITED_STOCK : n)

/** Look up the stock ceiling for a product/variant, or null when not our catalogue. */
function stockCeiling(productId, variantId) {
  const prod = catalogProducts.find((x) => x.id === productId)
  if (!prod) return null
  const variants = prod.variants ?? []
  const variant = variants.find((v) => v.id === variantId) ?? variants[0] ?? null
  if (!variant) return { available: prod.stockQty === Infinity ? Infinity : (prod.stockQty ?? 0), prod, variant: null }
  const raw = variant.availableStock ?? variant.stockQty
  return { available: raw === Infinity ? Infinity : (raw ?? 0), prod, variant }
}

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
  const wantGroupBuy = process.env.CART_SEED === 'groupbuy'
  const first = wantGroupBuy ? null : catalogProducts[0]
  if (first) {
    const v = first.variants?.[0] ?? null
    items.push({
      id: 'seed-product-1', kind: 'product', productId: first.id,
      variantId: v?.id ?? null, quantity: 2,
      product: first, variant: v, groupBuyItem: null, saleItem: null, campaign: null,
    })
  }
  // A pack line: pack deals are chosen on the detail page and stored on the line, so
  // seeding one keeps that pricing path exercised by the default state.
  const second = wantGroupBuy ? null : catalogProducts.find((p) => (p.variants ?? []).some((v) =>
    (v.quantityDiscounts ?? []).some((q) => q.packPrice > 0 && (v.stockQty ?? 0) > 10)))
  if (second) {
    const pv = (second.variants ?? []).find((v) =>
      (v.quantityDiscounts ?? []).some((q) => q.packPrice > 0))
    const pack = (pv?.quantityDiscounts ?? []).find((q) => q.packPrice > 0) ?? null
    items.push({
      id: 'seed-product-2', kind: 'product', productId: second.id,
      variantId: pv?.id ?? null, quantity: 1,
      packType: pack ? `${pack.minQuantity}-pack` : null,
      packSize: pack?.minQuantity ?? null,
      packPrice: pack?.packPrice ?? null,
      product: second, variant: pv, groupBuyItem: null, saleItem: null, campaign: null,
    })
  }
  // THE CART IS SINGLE-TYPE, AND THAT IS ENFORCED BY THE APP.
  //
  //   addProductItem:    if (getCartItemType() === "groupbuy") throw
  //                      "Your cart contains Group Buy items. Please complete or
  //                       clear your cart before adding regular products."
  //   addGroupBuyItem:   if (getCartItemType() === "product") throw ...
  //
  // Seeding both kinds produced a MIXED cart - a state the UI cannot reach - and
  // every attempt to add a regular product failed with that error. The app was
  // correct; the fixture was invalid.
  //
  // Set CART_SEED=groupbuy to start with a campaign line instead, so that flow is
  // still testable without hand-editing the seed.
  if (process.env.CART_SEED === 'groupbuy') {
    const camp = catalogCampaigns[0]
    const gi = camp?.items?.[0]
    if (gi) {
      items.push({
        id: 'seed-groupbuy-1', kind: 'groupbuy', groupBuyItemId: gi.id, quantity: 1,
        product: gi.product ?? null, variant: gi.variant ?? null,
        groupBuyItem: gi, saleItem: null, campaign: camp,
      })
    }
  }
  return items
}

/** Orders placed locally through the checkout flow. In memory only. */
const orders = []

/** The recorded (sanitised) account, used to attribute locally placed orders. */
let accountUser = null
try {
  accountUser = JSON.parse(readFileSync(join(SAMPLES, 'api_auth_me.json'), 'utf8')).user ?? null
} catch { /* leave null */ }

/** Back-in-stock subscriptions, counted for the dashboard tile. */
let stockSubscriptions = 0
try {
  stockSubscriptions = (JSON.parse(readFileSync(join(SAMPLES, 'api_stock-notifications.json'), 'utf8')).subscriptions ?? []).length
} catch { /* leave zero */ }

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

/**
 * The community forum is a SEPARATE APPLICATION the client expects to find on its own
 * host. The client picks it by environment:
 *
 *   function Po() {
 *     const {hostname, port, protocol} = window.location
 *     return hostname === 'localhost' || hostname === '127.0.0.1'
 *       ? `${protocol}//community.localhost${port ? ':' + port : ''}`
 *       : 'https://community.joyous.is'
 *   }
 *
 * Clicking Community POSTs /api/community-handoff for a one-time code and redirects to
 * `<community>/sso#code=...`. Nothing serves that host here, and because this server
 * ignored the Host header it answered with the MEMBER APP - so the redirect landed the
 * user silently inside the wrong application.
 *
 * A forum cannot be fabricated, so this host now says what is missing and carries the
 * handoff code forward. Point COMMUNITY_ORIGIN at a real instance to proxy to it.
 */
const COMMUNITY_ORIGIN = process.env.COMMUNITY_ORIGIN ?? ''

function communityPlaceholder(host, pathname, code) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Community — not running here</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:#1F1F20; color:#F7F8F9;
         font:16px/1.5 Nunito, ui-rounded, system-ui, sans-serif; }
  main { max-width:640px; padding:40px; }
  h1 { font-size:1.6rem; margin:0 0 12px; color:#FFD93D; }
  code { background:#141415; padding:2px 6px; border-radius:6px;
         font-family:"JetBrains Mono", ui-monospace, monospace; font-size:.86em; }
  .pill { display:inline-block; background:#FFD93D; color:#0D3364; font-weight:700;
          font-size:.72rem; padding:3px 10px; border-radius:999px; margin-bottom:14px; }
  p { color:#F7F8F9cc; }
  .code { margin-top:18px; padding:12px 14px; background:#141415; border-radius:12px;
          border:1px solid #ffffff14; word-break:break-all; }
</style></head>
<body><main>
  <div class="pill">NOT RUNNING LOCALLY</div>
  <h1>The community forum is a separate application</h1>
  <p>You were sent here by the <strong>Community</strong> button, which issues a
     single-sign-on handoff code and redirects to the forum host.</p>
  <p>That host is <code>${host}</code> in a local session and
     <code>https://community.joyous.is</code> in production. Nothing is serving it
     here, and the real deployment is a forum (Discourse) with its own SSO
     endpoint &mdash; it cannot be reproduced by a static replay.</p>
  ${code ? `<p>The handoff code was issued and carried through:</p>
     <div class="code"><code>${code}</code></div>` : ''}
  <p style="margin-top:22px">
    <a href="http://127.0.0.1:${PORT}/products" style="color:#79C9F2">Back to the site</a>
    &nbsp;·&nbsp;
    Set <code>COMMUNITY_ORIGIN</code> to proxy to a real instance.
  </p>
</main></body></html>`
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  const pathname = decodeURIComponent(url.pathname)
  const host = (req.headers.host ?? '').split(':')[0]
  if (VERBOSE) console.log(`  <- ${req.method} ${host}${pathname}`)

  // --- the community host is a different application ---------------------
  if (host.startsWith('community.')) {
    if (COMMUNITY_ORIGIN) {
      try {
        const upstream = await fetch(COMMUNITY_ORIGIN + pathname + url.search, { method: req.method })
        const body = Buffer.from(await upstream.arrayBuffer())
        res.writeHead(upstream.status, {
          'Content-Type': upstream.headers.get('content-type') ?? 'text/html',
          'Content-Length': String(body.length),
        })
        res.end(body)
      } catch (error) {
        res.writeHead(502, { 'Content-Type': 'text/plain' }).end(`Community proxy failed: ${error.message}`)
      }
      return
    }
    // The code rides in the fragment, so the server never sees it; read it from the
    // Referer when a browser sends one, otherwise just explain.
    const code = (req.headers.referer ?? '').match(/code=([A-Za-z0-9_-]+)/)?.[1] ?? ''
    const body = Buffer.from(communityPlaceholder(req.headers.host ?? host, pathname, code))
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(body.length) })
    res.end(body)
    return
  }

  // --- the catalogue, served from STATE not from the file ---------------
  // The replay reads api_products_catalog.json straight off disk, which cannot show
  // stock moving. Serving the in-memory catalogue instead is what makes a placed order
  // decrement stock on the storefront: this array is the same one the cart validates
  // against and the order path decrements.
  // One transform pair, used by both the catalogue and the single-product route, so
  // the two can never disagree about stock or images.
  //
  // Image fallback is applied as DATA: the compiled card resolves
  // `product.images[0]?.url || variant.images[0]?.url`, and when both are empty it
  // renders nothing at all - no <img>, no placeholder, no broken-image icon. The
  // client cannot be edited, so an imageless product gets the local SVG here.
  const withImage = (node) => {
    if ((node.images ?? []).length > 0) return node
    if ((node.variants ?? []).flatMap((v) => v.images ?? [])[0]) return node
    return { ...node, images: [{ url: PLACEHOLDER_IMAGE, sortOrder: 0 }] }
  }
  const wireProduct = (prod) => ({
    ...withImage(prod),
    stockQty: wireStock(prod.stockQty),
    variants: (prod.variants ?? []).map((v) => ({
      ...v,
      stockQty: wireStock(v.stockQty),
      availableStock: wireStock(v.availableStock ?? v.stockQty),
    })),
  })

  if (pathname === '/api/products/catalog' && req.method === 'GET') {
    const products = catalogProducts.map(wireProduct)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({
      products,
      productTypes: [...new Set(products.map((p) => p.productType).filter(Boolean))],
    }))
    return
  }

  // GET /api/products/<slug-or-id> - the detail page reads { product, related }.
  // Unhandled it answered {} and every detail page rendered "Try again".
  if (pathname.startsWith('/api/products/') && req.method === 'GET') {
    const key = decodeURIComponent(pathname.slice('/api/products/'.length))
    if (key && !key.includes('/')) {
      const raw = catalogProducts.find((p) => p.slug === key || p.id === key)
      if (raw) {
        const related = catalogProducts
          .filter((p) => p.id !== raw.id && (p.category?.name ?? p.category) === (raw.category?.name ?? raw.category))
          .slice(0, 6)
          .map(wireProduct)
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ product: wireProduct(raw), related }))
        return
      }
    }
  }

  // --- order creation and payment proof ---------------------------------
  // These are the two endpoints a checkout ENDS on, and neither can be recorded: one
  // creates an order and the other accepts an upload. Synthesised here so the flow
  // completes and the result is visible in the admin panel. What is real: the items,
  // the address, the pricing and the uploaded file. What is invented: the order
  // number and the storage.
  if (pathname === '/api/orders/create' && req.method === 'POST') {
    let body = {}
    try { body = JSON.parse((await readBody(req)) || '{}') } catch { /* ignore */ }
    const n = orders.length + 1
    const order = {
      id: `local-order-${n}-${Date.now()}`,
      orderNumber: `JY-${String(1000 + n)}`,
      status: 'AWAITING_PAYMENT_REVIEW',
      items: cart.map((line) => {
        const prod = line.product ?? {}
        const gi = line.groupBuyItem ?? {}
        const v = line.variant ?? {}
        const qty = line.quantity ?? 1
        // Price from the catalogue via the shared authority, NOT from the cart line.
        // Group buy items have no catalogue entry of their own, so they fall back to
        // the campaign item's price, which is also server-recorded data.
        const priced = resolveLinePrice(line)
        const unit = priced.ok
          ? priced.unitPrice
          : (gi.pricePerUnit ?? v.pricePerUnit ?? prod.pricePerUnit ?? 0)
        // Field names are the ones OrderDetail reads:
        //   n.product || n.groupBuyItem || n.saleItem     -> the item record
        //   n.totalPrice || n.pricePerUnit * n.quantity   -> line total
        //   n.pricePerUnit || m.pricePerUnit              -> unit price  (must exist)
        //   n.itemName || m.name                          -> label
        return {
          id: line.id, quantity: qty, productId: line.productId ?? null,
          groupBuyItemId: line.groupBuyItemId ?? null, variantId: line.variantId ?? null,
          itemName: gi.name ?? (v.name ? `${prod.name ?? ''} - ${v.name}` : (prod.name ?? 'Item')),
          name: gi.name ?? (v.name ? `${prod.name ?? ''} - ${v.name}` : (prod.name ?? 'Item')),
          pricePerUnit: unit, unitPrice: unit, totalPrice: unit * qty,
          product: line.product ?? null, groupBuyItem: gi ?? null, variant: v ?? null,
          coas: [], coaRequested: false,
        }
      }),
      shippingAddress: body.shippingAddress ?? body.address ?? null,
      payment: body.payment ?? { method: body.paymentMethod ?? null, transactionHash: body.paymentProof?.transactionHash ?? null },
      paymentProof: null,
      // The single place a total is computed. Uses the SAME resolver as the order
      // lines and the checkout summary, so the number shown and the number charged
      // cannot diverge - which is exactly how the packPrice forgery worked.
      total: cart.reduce((sum, line) => {
        const v = line.variant ?? {}; const prod = line.product ?? {}; const gi = line.groupBuyItem ?? {}
        const priced = resolveLinePrice(line)
        const unit = priced.ok
          ? priced.unitPrice
          : (gi.pricePerUnit ?? v.pricePerUnit ?? prod.pricePerUnit ?? 0)
        return sum + unit * (line.quantity ?? 1)
      }, 0),
      createdAt: new Date().toISOString(),
      // OrderDetail reads these flat money fields individually, so each must be a
      // number - an absent one crashes it on .toFixed.
      subtotal: 0, discountAmount: 0, shippingCost: 0, insuranceCost: 0,
      coaCost: 0, adminFee: 0, paymentMethodFee: 0,
      coas: [], tickets: [], updates: [],
      // The admin list shows Customer from these; without them the row reads "Unknown".
      // Taken from the recorded (sanitised) account, since this is that account's order.
      userId: accountUser?.id ?? null,
      user: accountUser ?? null,
      customer: accountUser ?? null,
      customerName: accountUser ? `${accountUser.firstName ?? ''} ${accountUser.lastName ?? ''}`.trim() : null,
      email: accountUser?.email ?? null,
      __local: 'created by the local replay; not a real order',
    }
    order.subtotal = order.total
    order.totalAmount = order.total
    orders.push(order)

    // Decrement stock for the exact products ordered. This is what makes the numbers
    // move on the storefront AND the admin Products page: both read catalogProducts,
    // so one decrement shows up in both. Unlimited lines are skipped.
    for (const item of order.items) {
      if (!item.productId) continue
      const ceiling = stockCeiling(item.productId, item.variantId)
      if (!ceiling || !ceiling.variant) continue
      const v = ceiling.variant
      const from = v.availableStock ?? v.stockQty
      if (from === Infinity) continue          // digital/unlimited: nothing to deduct
      const next = Math.max(0, (from ?? 0) - (item.quantity ?? 0))
      v.availableStock = next
      v.stockQty = next
      const prod = ceiling.prod
      const total = (prod.variants ?? []).reduce((n, x) => {
        const raw = x.availableStock ?? x.stockQty
        return n + (raw === Infinity ? 0 : (raw ?? 0))
      }, 0)
      prod.stockQty = total
      console.log(`  [stock] ${prod.name}: ${from} -> ${next} (ordered ${item.quantity})`)
    }

    cart = []                    // a placed order empties the cart
    console.log(`  [order] created ${order.orderNumber} with ${order.items.length} item(s)`)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ order }))
    return
  }

  if (pathname === '/api/payments/crypto/upload-screenshot' && req.method === 'POST') {
    // multipart/form-data: file + orderId. The bytes are accepted and discarded -
    // storing an uploaded payment proof is not something a replay should pretend to do.
    const raw = await readBody(req)
    const idMatch = raw.match(/name="orderId"\s*\r?\n\r?\n([^\r\n]+)/)
    const orderId = idMatch?.[1]?.trim() ?? null
    const order = orders.find((o) => o.id === orderId)
    if (order) {
      order.paymentProof = { uploadedAt: new Date().toISOString(), bytes: raw.length, stored: false }
      order.status = 'PAYMENT_UNDER_REVIEW'
      console.log(`  [order] payment proof for ${order.orderNumber}: ${raw.length} bytes (discarded)`)
    } else {
      console.log(`  [order] payment proof upload for unknown order ${orderId}`)
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, orderId }))
    return
  }

  // The order list, so a placed order is visible afterwards.
  if (pathname === '/api/orders' && req.method === 'GET' && orders.length) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ orders }))
    return
  }
  if (pathname.startsWith('/api/orders/') && req.method === 'GET') {
    const id = pathname.split('/').pop()
    const order = orders.find((o) => o.id === id || o.orderNumber === id)
    if (order) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ order }))
      return
    }
  }

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
    // Same authority as the order path. Previously this read `v.pricePerUnit` while
    // the order read `line.packPrice`, which is why a forged pack produced a $250
    // checkout summary and a $10 charge.
    const unit = (line) => {
      const priced = resolveLinePrice(line)
      if (priced.ok) return priced.unitPrice
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
      // Quantities are positive whole numbers. `Number(x) || 1` let -5 through, which
      // a negative packPrice could then turn into a credit rather than a charge.
      const rawQty = Number(body.quantity ?? 1)
      if (!Number.isFinite(rawQty) || !Number.isInteger(rawQty) || rawQty < 1 || rawQty > 10000) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({
          error: 'Invalid quantity',
          message: 'Quantity must be a whole number between 1 and 10000.',
        }))
        return
      }
      const qty = rawQty
      // Adding a product already in the cart INCREMENTS its line rather than
      // appending a second one. Pushing unconditionally left the same item as
      // repeated lines with the true total split across them.
      const existing = cart.find((i) =>
        (body.groupBuyItemId && i.groupBuyItemId === body.groupBuyItemId) ||
        (body.saleItemId && i.saleItemId === body.saleItemId) ||
        (body.productId && i.productId === body.productId &&
          (i.variantId ?? null) === (body.variantId ?? i.variantId ?? null)))
      // Stock guard. Checked BEFORE the line is written, so an over-add leaves the cart
      // exactly as it was rather than half-applied.
      if (body.productId) {
        const ceiling = stockCeiling(body.productId, body.variantId)
        if (ceiling && ceiling.available !== Infinity) {
          const already = cart
            .filter((i) => i.productId === body.productId && (i.variantId ?? null) === (body.variantId ?? ceiling.variant?.id ?? null))
            .reduce((n, i) => n + (i.quantity ?? 0), 0)
          if (already + qty > ceiling.available) {
            console.log(`  [cart] REFUSED ${already}+${qty} > ${ceiling.available} stock`)
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({
              error: 'Cannot add more items than available stock',
              message: `Only ${ceiling.available} of ${ceiling.prod.name} in stock` +
                (already ? `, and ${already} ${already === 1 ? 'is' : 'are'} already in your cart.` : '.'),
              available: ceiling.available, inCart: already, requested: qty,
            }))
            return
          }
        }
      }

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
        if (!product) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'Unknown product', message: 'That product is not in the catalogue.' }))
          return
        }
        const variants = product.variants ?? []
        const variant = variants.find((v) => v.id === body.variantId) ?? variants[0] ?? null

        // Pack deals are selected on the detail page and travel on the line as
        //   {packType:"5-pack", packSize:5, packPrice:65}
        // `packSize` is honoured because it names a pack the catalogue defines.
        // `packPrice` is NOT trusted - it is compared against the catalogue price and
        // the catalogue wins. A forged value is dropped and logged.
        const priced = resolveLinePrice({ productId: body.productId, variantId: body.variantId ?? variant?.id ?? null, packSize: body.packSize ?? null, packPrice: body.packPrice ?? null })
        if (!priced.ok) {
          console.log(`  [price] REFUSED cart line: ${priced.reason}`)
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'Cannot price that item', message: `This item could not be priced: ${priced.reason}.` }))
          return
        }
        if (priced.forged !== null) {
          console.log(`  [price] IGNORED client packPrice=${priced.forged}; catalogue says ${priced.unitPrice} for the ${body.packSize}-pack`)
        }
        cart.push({ id: `local-p-${Date.now()}`, kind: 'product', productId: body.productId,
          variantId: body.variantId ?? variant?.id ?? null, quantity: qty,
          packType: body.packType ?? null, packSize: body.packSize ?? null,
          // Stored from the catalogue, never from the request.
          packPrice: priced.source === 'catalogue.quantityDiscounts' ? priced.unitPrice : null,
          unitPrice: priced.unitPrice,
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
        // Same rule on PUT: a whole number >= 1, else leave the line alone.
        const rawWant = Number(body.quantity)
        if (!Number.isFinite(rawWant) || !Number.isInteger(rawWant) || rawWant < 1 || rawWant > 10000) {
          console.log(`  [cart] REFUSED PUT invalid quantity ${JSON.stringify(body.quantity)}`)
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({
            error: 'Invalid quantity',
            message: 'Quantity must be a whole number between 1 and 10000.',
          }))
          return
        }
        const want = rawWant
        // Same ceiling as POST. PUT sets the quantity outright, so it is THIS number
        // that must fit - not a delta.
        if (line.productId && want > 0) {
          const ceiling = stockCeiling(line.productId, line.variantId)
          if (ceiling && ceiling.available !== Infinity && want > ceiling.available) {
            console.log(`  [cart] REFUSED PUT qty ${want} > ${ceiling.available} stock`)
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({
              error: 'Cannot add more items than available stock',
              message: `Only ${ceiling.available} of ${ceiling.prod.name} in stock.`,
              available: ceiling.available, requested: want,
            }))
            return
          }
        }
        line.quantity = want
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
      // The client does:  const {data:o} = await O.post('/wishlist', a)
      //                   e({items:[o.item, ...]})
      // so the response must carry `item`. Returning a summary ({ok, count}) left
      // o.item undefined and the UI showed "Failed to update wishlist" for a write
      // that had in fact succeeded.
      const product = catalogProducts.find((p) => p.id === body.productId) ?? null
      const variants = product?.variants ?? []
      const variant = variants.find((v) => v.id === body.variantId) ?? variants[0] ?? null
      let item = wishlist.find((i) => i.productId === body.productId &&
        (i.variantId ?? null) === (body.variantId ?? null))
      if (!item) {
        item = {
          id: `local-${Date.now()}-${wishlist.length}`,
          productId: body.productId,
          variantId: body.variantId ?? null,
          createdAt: new Date().toISOString(),
          product,
          variant,
          hasVariants: variants.length > 0,
          availableStock: variant?.availableStock ?? product?.stockQty ?? 0,
          activeSale: null,
        }
        wishlist.push(item)
      }
      console.log(`  [wishlist] POST ${item.id.slice(0, 16)} -> ${wishlist.length} item(s)`)
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ item }))
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
    // --- TEMPORARY ADMIN SEED -------------------------------------------
    // The admin gate is:  !!user.isAdmin && (await GET /auth/me).user.isAdmin
    //   - a cached isAdmin on the store passes it for 5 minutes, then it re-verifies
    //   - a real verification call is made on first mount
    // so the RECORDED /auth/me must itself carry isAdmin: true, not just localStorage.
    //
    // The recorded account is deliberately isAdmin:false, because the real session is
    // VIP and not an admin. ADMIN_VIEW=1 promotes that single field for local viewing:
    //
    //     ADMIN_VIEW=1 node server.mjs 4400
    //
    // This is a LOCAL VIEWING SEED. It grants nothing real - every /api/admin/*
    // endpoint is unrecorded and answers 501 - and it is off unless the flag is set.
    if (pathname === '/api/auth/me' && process.env.ADMIN_VIEW === '1') {
      try {
        const raw = JSON.parse(await readFile(join(SAMPLES, 'api_auth_me.json'), 'utf8'))
        if (raw?.user) {
          raw.user.isAdmin = true
          raw.user.__localAdminSeed = true
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(JSON.stringify(raw))
          return
        }
      } catch { /* fall through to the recording */ }
    }

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

    // --- unrecorded ADMIN endpoints --------------------------------------
    // Admin access was never available, so no /api/admin/* response was ever
    // observed. Returning {} made pages die on shape, not on data:
    //
    //   /admin/spotlight   -> /admin/storefront  TypeError: J.filter is not a function
    //     the page does `l(y.data || [])` then filters; {} is truthy, [] is not an array
    //   /admin/activity-log -> TypeError: reading 'configured'
    //     needs the facets object, and the list needs {logs,total,pages,...}
    //
    // The shapes below are derived from the call sites - they are NOT recorded data.
    // Every one is empty, so pages render their own empty states rather than crashing.
    if (pathname.startsWith('/api/admin/')) {
      // --- derived admin data ----------------------------------------------
      // No /api/admin/* response was ever observable: the live site refuses a
      // non-admin session server-side. But the DATA is not invented - it comes from
      // the recorded catalogue, regrouped into the shape the admin pages read.
      //
      // DERIVED FROM THE RECORDING:  products, stats.total, stats.archived,
      //                              pagination.total, categories
      // COMPUTED:                    stats.lowStock  (availableStock < 10)
      //                              stockQty        (sum of variant stock)
      //                              sku             (code from the product image name,
      //                                               e.g. JYS-CAP-0004 — the only SKU
      //                                               hint in the data; 50 of 61 have one)
      // ABSENT IN THE DATA:          archived (no such field, so false),
      //                              isVisible (no such field, so true)
      //
      // Flagged so it is never mistaken for a recorded response.
      if (pathname === '/api/admin/products' && req.method === 'GET') {
        const SKU = /\/(JYS?-[A-Z]+-\d{4})-/
        const shape = (p) => {
          const variants = p.variants ?? []
          const codes = variants.flatMap((v) => (v.images ?? []).map((i) => i.url))
            .concat((p.images ?? []).map((i) => i.url))
            .map((u) => u.match(SKU)?.[1]).filter(Boolean)
          // Infinity is not JSON, and summing it would poison the total, so unlimited
          // variants contribute nothing to the number but still ship as UNLIMITED_STOCK.
          const stockQty = variants.reduce((n, v) => {
            const raw = v.availableStock ?? v.stockQty
            return n + (raw === Infinity ? 0 : (raw ?? 0))
          }, 0)
          return {
            ...p,
            // ONE stockQty key only. A second one below silently overwrote this and the
            // unlimited product reported 0 - a duplicate object key is not an error in
            // JS, just a last-one-wins assignment.
            stockQty: p.stockQty === Infinity ? UNLIMITED_STOCK : stockQty,
            sku: codes[0] ?? null,
            variants: variants.map((v) => ({
              ...v,
              stockQty: wireStock(v.stockQty),
              availableStock: wireStock(v.availableStock ?? v.stockQty),
            })),
            isVisible: true,
            archived: false,
            categoryName: p.category?.name ?? p.category ?? null,
          }
        }
        const all = catalogProducts.map(shape)
        const low = all.filter((p) => p.stockQty > 0 && p.stockQty < 10)
        const body = {
          __derived: 'assembled from the recorded catalogue; no admin response was observed',
          products: all,
          stats: {
            total: all.length,
            lowStock: low.length,
            archived: all.filter((p) => p.archived).length,
          },
          pagination: { page: 1, pages: 1, total: all.length },
        }
        console.log(`  [admin] /admin/products -> ${all.length} products (derived from the catalogue)`)
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(body))
        return
      }

      // Campaign lists. Both the group-buy and sale pages are the SAME component
      // (CampaignList) driven by a config; the config sets `api` and `listKey`:
      //
      //   groupbuy -> { api: '/admin/groupbuys', listKey: 'campaigns' }
      //   sale     -> { api: '/admin/sales',     listKey: 'sales'     }
      //
      // and reads  i[a.listKey] || []  and  i.statsAll || i.stats.
      // The campaign rows are the RECORDED campaigns, statuses already in the
      // vocabulary the page switches on (CLOSED, SHIPPING_TO_CUSTOMERS, ...).
      if (pathname === '/api/admin/orders' && req.method === 'GET' && orders.length) {
        console.log(`  [admin] /admin/orders -> ${orders.length} locally placed order(s)`)
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ orders, total: orders.length, page: 1, pages: 1 }))
        return
      }

      // --- pack deals: the one AUTHORED, PERSISTED surface ------------------
      // GET    /api/admin/products/<productId>/variants/<variantId>/pack-deals
      // PUT    same path, body [deal, ...]  -> validates, replaces, persists
      // DELETE same path                    -> clears this variant's deals
      //
      // Every write is validated by validatePackDeal before anything is stored, so a
      // markup or a negative price cannot be persisted. That is the guard: it lives on
      // the write path, because by checkout time a bad deal is already the price of
      // record.
      const packDealMatch = new RegExp('^/api/admin/products/([^/]+)/variants/([^/]+)/pack-deals$').exec(pathname)
      if (packDealMatch) {
        const [, productId, variantId] = packDealMatch
        const prod = catalogProducts.find((x) => x.id === productId)
        const variant = prod && (prod.variants ?? []).find((v) => v.id === variantId)
        if (!prod || !variant) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'Not found', message: 'No such product or variant.' }))
          return
        }
        const unitPrice = variant.pricePerUnit ?? prod.pricePerUnit

        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(JSON.stringify({
            productId, variantId, unitPrice,
            packDeals: variant.quantityDiscounts ?? [],
            persisted: existsSync(PACK_DEALS_FILE),
          }))
          return
        }

        if (req.method === 'PUT' || req.method === 'POST') {
          let body = {}
          try { body = JSON.parse((await readBody(req)) || '{}') } catch { /* ignore */ }
          const incoming = Array.isArray(body) ? body : (body.packDeals ?? (body.minQuantity != null ? [body] : null))
          if (!Array.isArray(incoming)) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: 'Invalid payload', message: 'Send an array of pack deals, or one deal object.' }))
            return
          }

          // Validate ALL of them before writing ANY - a rejected batch must leave the
          // previous deals exactly as they were.
          const problems = []
          incoming.forEach((deal, i) => {
            for (const e of validatePackDeal(deal, unitPrice)) problems.push({ index: i, problem: e })
          })
          const seen = new Set()
          incoming.forEach((deal, i) => {
            if (seen.has(deal.minQuantity)) problems.push({ index: i, problem: `duplicate minQuantity ${deal.minQuantity}` })
            seen.add(deal.minQuantity)
          })
          if (problems.length) {
            console.log(`  [pack-deals] REFUSED ${problems.length} problem(s) for ${prod.name}`)
            res.writeHead(422, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({
              error: 'Invalid pack deal',
              message: problems[0].problem,
              problems,
            }))
            return
          }

          const clean = incoming
            .map((d) => ({
              id: d.id ?? `pd-${variantId.slice(0, 8)}-${d.minQuantity}`,
              variantId,
              minQuantity: d.minQuantity,
              packPrice: d.packPrice,
              saleDiscount: d.saleDiscount ?? null,
              discountPercent: d.discountPercent ?? null,
              maxPerOrder: d.maxPerOrder ?? null,
            }))
            .sort((a, b) => a.minQuantity - b.minQuantity)

          const all = readPackDealsFile()
          all[productId] = all[productId] ?? {}
          all[productId][variantId] = clean
          all.__comment = 'Authored pack deals. Managed by PUT /api/admin/products/:id/variants/:vid/pack-deals. The only durable state in this server.'
          writePackDealsFile(all)
          applyPackDeals()
          console.log(`  [pack-deals] ${prod.name} / ${variant.name}: ${clean.length} deal(s) saved and persisted`)
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true, packDeals: clean, persistedTo: 'pack-deals.json' }))
          return
        }

        if (req.method === 'DELETE') {
          const all = readPackDealsFile()
          if (all[productId]) delete all[productId][variantId]
          writePackDealsFile(all)
          variant.quantityDiscounts = []
          applyPackDeals()
          console.log(`  [pack-deals] ${prod.name} / ${variant.name}: cleared`)
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true, packDeals: [] }))
          return
        }
      }

      if (pathname === '/api/admin/users' && req.method === 'GET') {
        // The only account the recording contains - already sanitised, so no real
        // details are involved. Served so the directory is not empty and the seeded
        // admin appears as a row.
        const u = JSON.parse(await readFile(join(SAMPLES, 'api_auth_me.json'), 'utf8')).user
        let addr = null
        try {
          addr = (JSON.parse(await readFile(join(SAMPLES, 'api_users_addresses.json'), 'utf8')).addresses ?? [])[0] ?? null
        } catch { /* none */ }
        const row = { ...u, address: addr, addresses: addr ? [addr] : [] }
        console.log('  [admin] /admin/users -> 1 account (recorded, sanitised)')
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ users: [row], total: 1, page: 1, pages: 1 }))
        return
      }

      if ((pathname === '/api/admin/groupbuys' || pathname === '/api/admin/sales') && req.method === 'GET') {
        const isGb = pathname.endsWith('groupbuys')
        const rows = isGb ? catalogCampaigns : []
        const counts = rows.reduce((acc, c) => {
          acc[c.status] = (acc[c.status] ?? 0) + 1
          return acc
        }, {})
        const body = {
          __derived: 'recorded campaigns regrouped for the admin list',
          [isGb ? 'campaigns' : 'sales']: rows,
          statsAll: { total: rows.length, byStatus: counts },
        }
        console.log(`  [admin] ${pathname} -> ${rows.length} row(s) (recorded campaigns)`)
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(body))
        return
      }

      if (pathname === '/api/admin/categories' && req.method === 'GET') {
        const names = [...new Set(catalogProducts.map((p) => p.category?.name ?? p.category).filter(Boolean))]
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(names.map((n, i) => ({ id: `cat-${i + 1}`, name: n, slug: String(n).toLowerCase(), productCount: catalogProducts.filter((p) => (p.category?.name ?? p.category) === n).length }))))
        return
      }

      const EMPTY_ARRAY = new Set([
        '/api/admin/spotlight/products',
        '/api/admin/categories', '/api/admin/collections', '/api/admin/tags',
        '/api/admin/tickets', '/api/admin/support/tickets',
        '/api/admin/users', '/api/admin/orders', '/api/admin/discounts',
        '/api/admin/fees/settlement-wallets', '/api/admin/newsletter/subscribers',
      ])
      const SHAPES = {
        // The activity page does `n(N.value.data.stats || null)` off /admin/demand,
        // so it must be an object carrying `stats` - an empty array gave undefined.
        '/api/admin/demand': { stats: { inTransit: 0, lastEventAt: null }, rows: [], items: [] },
        '/api/admin/activity-logs': { logs: [], total: 0, pages: 1, actors: {}, resources: {} },
        '/api/admin/activity-logs/facets': { resourceTypes: [], actions: [], admins: [] },
        // The activity page destructures nested groups off this and reads them
        // WITHOUT optional chaining:
        //     const c = t?.shipstation, p = t?.webhook, d = t?.trackingJob
        //     ... p.lastEventAt        <- p undefined if `webhook` is absent
        // The groups must therefore be PRESENT and hold their expected keys, not just
        // be omitted for being "empty".
        '/api/admin/system/health': {
          configured: false, ok: true, database: 'ok', storage: 'ok',
          version: 'local-replay',
          shipstation: { configured: false, fromAddress: null },
          webhook: { lastEventAt: null, inTransit: 0 },
          trackingJob: { running: false, lastStartedAt: null },
          email: { configured: false },
          payments: { configured: false },
        },
        '/api/admin/dashboard/today': { delivered: 0, shipped: 0, newOrders: 0 },
        // Each count is taken from the recorded source that would feed it, so a zero
        // means the recording is empty rather than that a number was invented:
        //   backInStockWaiting <- stock-notifications subscriptions
        //   needsReply         <- support tickets total
        //   ordersToShip, awaitingPayment, todaysPayments, todaysSales <- orders (empty)
        //   awaitingApproval   <- users pending approval (no admin user list recorded)
        // KEYS MUST MATCH THE COMPONENT, not the obvious names. AdminHome renders
        //   se.map(a => n[a.key])       // n is this response
        // where its key list is:
        //   ordersToShip, paymentsToday, needsReply, awaitingApproval,
        //   backInStock, salesToday
        // plus `awaitingPayment`, read separately for the header line. Serving
        // `todaysPayments`/`backInStockWaiting`/`todaysSales` meant three tiles looked
        // up keys that did not exist and silently printed 0.
        '/api/admin/dashboard/counts': {
          ordersToShip: 0,
          paymentsToday: 0,
          needsReply: 0,
          awaitingApproval: 0,
          backInStock: stockSubscriptions,
          salesToday: 0,
          awaitingPayment: 0,
        },
        '/api/admin/spotlight/settings': { enabled: false, products: [] },
      }
      const body = SHAPES[pathname] ?? (EMPTY_ARRAY.has(pathname) ? [] : {})
      notRecorded.add(`${req.method} ${pathname}`)
      console.warn(`  [admin] ${pathname} -> empty ${Array.isArray(body) ? 'array' : 'shape'} (never recorded)`)
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
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
