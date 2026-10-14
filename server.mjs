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
import { wireOrderMilestones, orderEvents } from './order-emails.mjs'
import { findPromo, discountFor, PROMO_CODES } from './promo-codes.mjs'
import {
  validateProduct, applyProductOverlay, saveProductOverlay, stockFor, TIERS, STOCK_MODES,
} from './admin-products.mjs'
import {
  seedCustomers, seedOrders, seedTickets, seedStockedProducts, seedCampaigns,
  applyBulk, applyOrderTransition, ORDER_TRANSITIONS, SEED_MARK,
} from './admin-seed.mjs'
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

/**
 * Seeded admin fixtures: customers, historical orders, support tickets and stocked
 * products. Without them every admin screen renders its empty state, which makes
 * "the feature is missing" indistinguishable from "there is no data". All fabricated,
 * all marked __seed.
 *
 * Declared HERE, with the other boot-time constants, because `const` hoists without
 * initialising: defining them further down threw "Cannot access 'SEED_FIXTURES'
 * before initialization" at the first use and the server would not start.
 *
 * SEED_ADMIN_FIXTURES=0 turns them off, for a run that wants only real records.
 */
const SEED_FIXTURES = process.env.SEED_ADMIN_FIXTURES !== '0'
const seededCustomers = SEED_FIXTURES ? seedCustomers() : []
const seededTickets = SEED_FIXTURES ? seedTickets() : []
/** Historical orders, kept SEPARATE from locally placed ones so a test can always
 *  tell which is which. */
const seededOrders = SEED_FIXTURES ? seedOrders() : []
/**
 * Group-buy and sale campaigns, dated relative to boot. Without these the campaigns
 * screen shows only the recorded ones, all CLOSED or already shipping, so no status
 * badge other than "orders closed" is ever visible.
 */
const seededCampaigns = SEED_FIXTURES ? seedCampaigns() : { groupbuys: [], sales: [] }
/** Every order the admin sees: seeded fixtures plus anything placed this session. */
const allOrders = () => [...orders, ...seededOrders]

/**
 * Admin-authored products and edits. Separate from the catalogue fixture on purpose:
 * api-samples/api_products_catalog.json is the RECORDING and an admin edit must never
 * rewrite it. Replayed onto the catalogue at boot, re-validated on load.
 */
const PRODUCTS_FILE = join(HERE, 'admin-products.json')
/** Slugs created through this server, and pending patches, so saves know what to write. */
const authoredSlugs = new Set()
const authoredPatches = {}

/**
 * Rendered order emails. Written to disk so they can be opened in a browser rather
 * than only read as escaped HTML in a terminal. NOTHING IS EVER SENT - there is no
 * SMTP transport in this project.
 */
const OUTBOX_DIR = join(HERE, 'outbox')
const emailHistory = []
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

// Stocked product fixtures, then the authored overlay on top so an admin edit always
// wins over the seed.
if (SEED_FIXTURES) {
  for (const prod of seedStockedProducts()) {
    if (!catalogProducts.some((x) => x.slug === prod.slug)) catalogProducts.push(prod)
  }
  console.log(`  seeded ${seededCustomers.length} customers, ${seededOrders.length} orders, ${seededTickets.length} tickets, 8 stocked products`)
}

// The authored product overlay is applied AFTER every catalogue source, so an admin
// edit wins, and re-validated on load so hand-editing the file is not a bypass.
try {
  const overlay = applyProductOverlay({ file: PRODUCTS_FILE, catalogProducts })
  if (overlay.applied) console.log(`  product overlay: ${overlay.applied} product/patch(es) applied`)
  for (const r of overlay.rejected) console.log(`  product overlay DROPPED: ${r}`)
} catch (e) {
  console.log(`  product overlay FAILED: ${e.stack ?? e.message}`)
}

// Order milestone hook. The checkout path only emits an event; what happens on that
// event (render, log, persist) lives in order-emails.mjs.
wireOrderMilestones({ outDir: OUTBOX_DIR, history: emailHistory })

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

/**
 * Resolve an addressId to the recorded address. Returns null when it cannot be
 * resolved, so callers can tell "no address" from "the address is empty".
 */
function resolveShippingAddress(addressId) {
  if (!addressId) return null
  try {
    const list = JSON.parse(readFileSync(join(SAMPLES, 'api_users_addresses.json'), 'utf8')).addresses ?? []
    return list.find((a) => a.id === addressId) ?? null
  } catch {
    return null
  }
}

/**
 * The authoritative subtotal: every cart line priced through resolveLinePrice.
 *
 * A percentage discount must be computed against a subtotal the caller cannot choose.
 * The client does send its own `items` array, but 10% of a claimed $10,000 subtotal is
 * a very different number from 10% of the real one, so it is ignored entirely.
 */
function cartSubtotal() {
  return cart.reduce((sum, line) => {
    const priced = resolveLinePrice(line)
    const gi = line.groupBuyItem ?? {}
    const v = line.variant ?? {}
    const prod = line.product ?? {}
    const unit = priced.ok
      ? priced.unitPrice
      : (gi.pricePerUnit ?? v.pricePerUnit ?? prod.pricePerUnit ?? 0)
    return sum + unit * (line.quantity ?? 1)
  }, 0)
}

/**
 * Server-side admin authorization.
 *
 * THERE WAS NONE. /api/admin/* relied on the client's own isAdmin gate plus
 * ADMIN_VIEW=1, so an ordinary member could call any admin route directly — "hidden
 * from the UI" rather than "rejected by the backend".
 *
 * ADMIN_VIEW=1 stands in for an authenticated admin session, because the recorded
 * /auth/me carries isAdmin for local viewing. Without it, nothing is admin.
 */
function requireAdmin(req, res) {
  if (process.env.ADMIN_VIEW === '1') return true
  res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ error: 'Admins only.', detail: 'Start the server with ADMIN_VIEW=1 to act as the recorded admin.' }))
  return false
}

/** The category list, derived from the catalogue. One source, used by the admin
 *  categories route AND by categoryId resolution on create. */
function adminCategories() {
  const names = [...new Set(catalogProducts.map((p) => p.category?.name ?? p.category).filter(Boolean))]
  return names.map((name, i) => {
    const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-')
    return {
      id: `cat-${slug}`, name, slug,
      productCount: catalogProducts.filter((p) => (p.category?.name ?? p.category) === name).length,
    }
  })
}

/** Small JSON responder for the authored-product routes. */
function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(payload))
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




/**
 * Idempotency keys -> order number. DURABLE, unlike orders.
 *
 * The checkout contract requires an Idempotency-Key, and there was no guard at all:
 * a double-clicked Place Order created two orders and charged twice. Orders themselves
 * stay in RAM because a replay must not diverge from the recording, but a key has to
 * outlive a retry — a retry can easily arrive after a restart.
 */
const IDEMPOTENCY_FILE = join(HERE, 'idempotency-keys.json')
let idempotency = (() => {
  try { return JSON.parse(readFileSync(IDEMPOTENCY_FILE, 'utf8')) } catch { return {} }
})()
function saveIdempotency() {
  try {
    const tmp = `${IDEMPOTENCY_FILE}.tmp-${process.pid}`
    writeFileSync(tmp, `${JSON.stringify(idempotency, null, 1)}\n`)
    renameSync(tmp, IDEMPOTENCY_FILE)
  } catch { /* a lost key file only costs a duplicate guard, never a wrong order */ }
}

/** The promo the customer applied, if any. Cleared when the cart empties. */
let appliedPromo = null

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

const server = createServer({
  // Generous timeouts: a smoke run drives a browser and a dozen API calls at once, and
  // the default 5s keep-alive/headers budget produced ECONNRESET on this machine.
  keepAliveTimeout: 65000,
  headersTimeout: 70000,
  requestTimeout: 120000,
}, async (req, res) => {
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

  // A single campaign, so the admin's "Preview as customer" link and the customer
  // group-buy page can both open a SEEDED campaign. Recorded ones are served from their
  // own sample file by the generic replay; seeded ones only exist in memory, so without
  // this the preview link and /groupbuys/<seeded-id> both rendered nothing.
  if (pathname.startsWith('/api/groupbuys/') && req.method === 'GET') {
    const key = decodeURIComponent(pathname.slice('/api/groupbuys/'.length))
    if (key && !key.includes('/')) {
      const rec = catalogCampaigns.find((c) => c.id === key)
      const seed = [...seededCampaigns.groupbuys, ...seededCampaigns.sales].find((c) => c.id === key)
      const camp = rec ?? seed
      if (camp) {
        sendJson(res, 200, { campaign: camp })
        return
      }
    }
  }

  if (pathname === '/api/products/catalog' && req.method === 'GET') {
    // A disabled product is hidden from the storefront but NOT deleted, and the admin
    // list still sees it because that reads catalogProducts directly.
    const products = catalogProducts.filter((x) => x.adminHidden !== true).map(wireProduct)
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
      const raw = catalogProducts.find((p) => (p.slug === key || p.id === key) && p.adminHidden !== true)
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

    // ---- IDEMPOTENCY, before anything else ---------------------------------
    // Missing or blank keys are refused rather than defaulted: a checkout that only
    // de-duplicates when the client remembers to ask is not protected at all.
    const idemKey = String(req.headers['idempotency-key'] ?? '').trim()
    if (!idemKey) {
      sendJson(res, 400, {
        error: 'Idempotency-Key required',
        message: 'Send an Idempotency-Key header so a retry cannot place a second order.',
      })
      return
    }
    const priorNumber = idempotency[idemKey]
    if (priorNumber) {
      const prior = orders.find((o) => o.orderNumber === priorNumber)
      console.log(`  [order] replayed ${priorNumber} for key ${idemKey.slice(0, 16)}`)
      sendJson(res, 200, prior
        ? { replayed: true, order: prior }
        : { replayed: true, orderNumber: priorNumber, note: 'the original order is no longer in this session' })
      return
    }
    const n = orders.length + 1
    const createdAt = new Date().toISOString()
    const order = {
      id: `local-order-${n}-${Date.now()}`,
      orderNumber: `JY-${String(1000 + n)}`,
      status: 'AWAITING_PAYMENT_REVIEW',
      // `placedAt` was MISSING on locally placed orders. That is not cosmetic: the
      // admin list sorts and filters on it, the Insights range filter compares against
      // it, and the fee ledger groups by it. Its absence crashed the server once (see
      // monthKey) and made the fee ledger disagree with the reports total, because the
      // ledger could not book an undated order into any month.
      placedAt: createdAt,
      createdAt,
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
      // The client sends ONLY `addressId` - it never sends the address itself. Storing
      // `body.shippingAddress` therefore always produced null, and the order
      // confirmation email had no address to print. Resolve the id server-side.
      shippingAddress: body.shippingAddress ?? body.address ?? resolveShippingAddress(body.addressId),
      // The method is stored under BOTH names on purpose: the checkout flow reads
      // `payment.method`, while the admin orders list, the reports table and the fee
      // ledger all read a top-level `method`. Storing only the nested one made every
      // locally placed order render as "—" in those three places.
      payment: body.payment ?? { method: body.paymentMethod ?? null, transactionHash: body.paymentProof?.transactionHash ?? null },
      method: body.payment?.method ?? body.paymentMethod ?? null,
      paymentMethod: body.payment?.method ?? body.paymentMethod ?? null,
      paymentProof: null,
      // The single place a total is computed. Uses the SAME resolver as the order
      // lines and the checkout summary, so the number shown and the number charged
      // cannot diverge - which is exactly how the packPrice forgery worked.
      subtotal: cartSubtotal(),
      total: (() => {
        const sub = cartSubtotal()
        const promo = appliedPromo ? PROMO_CODES[appliedPromo.code] : null
        const off = promo ? discountFor(promo, sub).discountAmount : 0
        return Math.max(sub - off, 0)
      })(),
      createdAt: new Date().toISOString(),
      // OrderDetail reads these flat money fields individually, so each must be a
      // number - an absent one crashes it on .toFixed.
      discountCode: appliedPromo?.code ?? null,
      discountAmount: (() => {
        const promo = appliedPromo ? PROMO_CODES[appliedPromo.code] : null
        return promo ? discountFor(promo, cartSubtotal()).discountAmount : 0
      })(),
      freeShippingApplied: !!(appliedPromo && PROMO_CODES[appliedPromo.code]?.freeShipping),
      shippingCost: 0, insuranceCost: 0,
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
    // subtotal and total are already correct; totalAmount mirrors total for
    // OrderDetail, which reads the flat money fields individually.
    order.totalAmount = order.total
    // An order with no lines is not an order. This was reachable by POSTing an empty
    // cart, and it created a real $0 order with zero items that then appeared in the
    // admin list as a mystery row.
    if (!order.items.length) {
      console.log('  [order] REFUSED: the cart is empty')
      sendJson(res, 400, { error: 'Nothing to order', message: 'Your cart is empty.' })
      return
    }

    // ---- STOCK VALIDATION, before the order is committed ------------------
    // The storefront's availability came from a manual flag and frozen markup, so
    // nothing checked that a product was sellable, let alone that enough remained.
    // Every line is checked against the catalogue here, and a refusal happens BEFORE
    // the order is pushed so a rejected checkout leaves no order behind.
    const stockProblems = []
    for (const item of order.items) {
      if (!item.productId) continue
      const prod = catalogProducts.find((x) => x.id === item.productId)
      if (!prod) { stockProblems.push('Unknown product on this order'); continue }
      const st = stockFor(prod)
      if (st.soldOut) {
        stockProblems.push(`${prod.name} is sold out`)
      } else if (st.available !== Infinity && item.quantity > st.available) {
        stockProblems.push(`Only ${st.available} of ${prod.name} remain (asked for ${item.quantity})`)
      }
    }
    if (stockProblems.length) {
      console.log(`  [order] REFUSED: ${stockProblems[0]}`)
      // The cart is deliberately NOT emptied: the customer must be able to fix the
      // basket rather than lose it to a failed checkout.
      sendJson(res, 409, { error: 'Not enough stock', message: stockProblems[0], problems: stockProblems })
      return
    }

    orders.push(order)
    idempotency[idemKey] = order.orderNumber
    saveIdempotency()

    // Decrement stock for the exact products ordered. This is what makes the numbers
    // move on the storefront AND the admin Products page: both read catalogProducts,
    // so one decrement shows up in both. Unlimited lines are skipped.
    for (const item of order.items) {
      if (!item.productId) continue
      const ceiling = stockCeiling(item.productId, item.variantId)
      if (!ceiling || !ceiling.variant) continue
      const v = ceiling.variant
      const prod = ceiling.prod
      const mode = prod.stockMode ?? 'FLAG'

      if (mode === 'FLAG') {
        // No quantity is modelled for this product, so nothing is deducted. The flag
        // stays the customer-visible answer, and the check above already refused a
        // product that is sold out.
        continue
      }

      const from = Number.isInteger(prod.stockQty) ? prod.stockQty : (v.availableStock ?? 0)
      if (from === Infinity) continue          // digital/unlimited: nothing to deduct
      // Math.max(0, ...) would silently swallow an oversell; the check above already
      // refused it, so reaching here with a shortfall is a bug worth seeing.
      const next = from - (item.quantity ?? 0)
      if (next < 0) {
        console.log(`  [stock] REFUSED ${prod.name}: ${from} - ${item.quantity} would go negative`)
        sendJson(res, 409, { error: 'Not enough stock', message: `Only ${from} of ${prod.name} remain` })
        return
      }
      prod.stockQty = next
      prod.soldOut = next <= 0
      for (const variant of prod.variants ?? []) {
        variant.stockQty = next
        variant.availableStock = next
      }
      console.log(`  [stock] ${prod.name}: ${from} -> ${next} (ordered ${item.quantity})`)
    }

    cart = []                    // a placed order empties the cart
    appliedPromo = null
    console.log(`  [order] created ${order.orderNumber} with ${order.items.length} item(s)`)

    // Milestone emitted AFTER the order and its stock changes are settled, so a
    // handler can never observe a half-written order.
    orderEvents.emit('order.created', { order })
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
  // The client posts { code, items } and destructures `t.discount.{code,name,
  // discountAmount,freeShipping}`. On failure it reads `error.response.data.error`
  // and shows that verbatim, so the sentence the customer sees is decided in
  // promo-codes.mjs, not in the bundle.
  //
  // The subtotal is recomputed HERE from the catalogue via resolveLinePrice, never
  // taken from the request, so a forged `items` array cannot inflate a percentage
  // discount. That matters more for a percentage than a flat amount: 10% of a
  // claimed $10,000 subtotal is a very different number.
  if (pathname === '/api/checkout/validate-promo' && req.method === 'POST') {
    let body = {}
    try { body = JSON.parse((await readBody(req)) || '{}') } catch { /* ignore */ }
    const found = findPromo(body.code)
    if (!found.ok) {
      console.log(`  [promo] "${body.code ?? ''}" -> 400 ${found.error}`)
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: found.error }))
      return
    }
    const subtotal = cartSubtotal()
    const discount = discountFor(found.promo, subtotal)
    // Remembered so the ORDER path can honour the same code. Without this the
    // discount applied to the display only and the customer was charged the
    // undiscounted total - the same show-one-number-charge-another shape as the
    // packPrice bug.
    appliedPromo = { code: found.code, freeShipping: !!found.promo.freeShipping }
    const how = found.promo.percentOff ? `${found.promo.percentOff}% off` : 'free shipping'
    console.log(`  [promo] "${found.code}" -> ${how}, -$${discount.discountAmount.toFixed(2)} on $${subtotal.toFixed(2)}`)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ discount }))
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
      // ONE check for the whole surface, before any handler runs. The three
      // /api/admin/public/* reads are intentionally open: the storefront needs a
      // payment-method list before sign-in, which is why they are named "public".
      const isPublicAdminRead = pathname.startsWith('/api/admin/public/')
      if (!isPublicAdminRead && !requireAdmin(req, res)) return

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
      // --- product create / edit: the two routes that were MISSING ----------
      // POST  /api/admin/products              create
      // PATCH /api/admin/products/:slug        edit title, price, tier, category,
      //                                        sold-out flag, or the stock policy
      //
      // Both write through the authored overlay, never the recorded fixture, and both
      // re-validate on save so a bad value cannot be persisted by either path.
      if (pathname === '/api/admin/products' && req.method === 'POST') {
        let body = {}
        try { body = JSON.parse((await readBody(req)) || '{}') } catch { /* ignore */ }
        const takenSlugs = catalogProducts.map((x) => x.slug)

        // --- normalise the create form's payload ---------------------------
        // ProductCreatePage posts far more than the catalogue models: a variants[] array
        // each carrying batches[], plus productType, isVisible, costPerUnit and
        // description. Map what has a home; ignore the rest rather than 422-ing a form
        // that is otherwise complete.
        const firstVariant = Array.isArray(body.variants) && body.variants[0] ? body.variants[0] : null
        if (firstVariant) {
          const patch = {}
          if (firstVariant.name && !body.variantName) patch.variantName = String(firstVariant.name).trim()
          if ((body.pricePerUnit == null || body.pricePerUnit === 0) && firstVariant.pricePerUnit != null) {
            patch.pricePerUnit = firstVariant.pricePerUnit
          }
          body = { ...body, ...patch }
        }
        if (body.description != null && body.summary == null) body = { ...body, summary: body.description }

        // The create form has no slug field: it collects a name and the URL is derived
        // from it, uniquified so a second "Smoke Widget" cannot collide with the first.
        if (body.slug == null || String(body.slug).trim() === '') {
          const base = String(body.name ?? body.title ?? '').trim().toLowerCase()
            .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'product'
          let slug = base, n = 2
          while (takenSlugs.includes(slug)) slug = `${base}-${n++}`
          body = { ...body, slug }
        }
        // `categoryId` names a row from /api/admin/categories; resolve it to a name so
        // the public catalogue shows the same category the admin picked.
        if (body.categoryId && !body.category && !body.categoryName) {
          const cat = adminCategories().find((c) => c.id === body.categoryId)
          if (!cat) {
            sendJson(res, 422, { error: 'Invalid product', message: `No such category: ${body.categoryId}` })
            return
          }
          body = { ...body, categoryName: cat.name }
        }
        // NOT named `res` — that is the HTTP response object.
        const check = validateProduct(body, { takenSlugs })
        if (!check.ok) {
          console.log(`  [admin] POST product REFUSED: ${check.problems[0]}`)
          sendJson(res, 422, { error: 'Invalid product', message: check.problems[0], problems: check.problems })
          return
        }
        const v = check.value
        const id = `authored-${v.slug}`
        const product = {
          id, slug: v.slug, name: v.name, isNew: true,
          // The form sends "VIALS"; the catalogue stores a singular type label.
          productType: body.productType ? String(body.productType).toUpperCase().replace(/S$/, '') : 'VIAL',
          isVisible: body.isVisible !== false,
          requiredTier: v.requiredTier ?? 'USER',
          pricePerUnit: v.pricePerUnit,
          stockQty: v.stockMode === 'QUANTITY' ? v.stockQty : 0,
          stockMode: v.stockMode ?? 'FLAG',
          saleDiscount: null,
          soldOut: v.soldOut === true,
          category: (() => {
            // validateProduct emits `categoryName`; the catalogue stores an OBJECT.
            // Dropping it here meant a created product had no category at all, and the
            // admin form requires one.
            // Resolve from EITHER input: the public API uses a name, the admin create
            // form sends a categoryId from /api/admin/categories (ids are
            // `cat-<slug>`, which is why the slug can be read straight off it).
            let name = v.categoryName ?? null
            let slug = name ? String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-') : null
            if (!name && v.categoryId) {
              const known = adminCategories().find((c) => c.id === v.categoryId)
              if (known) { name = known.name; slug = known.slug }
              else if (String(v.categoryId).startsWith('cat-')) {
                slug = String(v.categoryId).slice(4)
                name = slug.replace(/-/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())
              }
            }
            if (!name) return null
            return { id: `cat-${slug}`, name, slug, code: 'AUTHORED' }
          })(),
          tags: ['authored'],
          images: v.images ?? [],
          quantityDiscounts: [],
          variants: [{
            id: `${id}-default`, name: v.variantName || 'Default', isVisible: true, isDefault: true, sortOrder: 0,
            ...(firstVariant?.costPerUnit != null ? { costPerUnit: Number(firstVariant.costPerUnit) || 0 } : {}),
            pricePerUnit: v.pricePerUnit,
            stockQty: v.stockMode === 'QUANTITY' ? v.stockQty : 0,
            saleDiscount: null, quantityDiscounts: [], images: v.images ?? [],
            availableStock: v.stockMode === 'QUANTITY' ? v.stockQty : null,
          }],
          summary: v.summary ?? '',
        }
        catalogProducts.push(product)
        authoredSlugs.add(v.slug)
        saveProductOverlay(PRODUCTS_FILE, { catalogProducts, authoredSlugs, authoredPatches })
        console.log(`  [admin] created product ${v.slug} (${v.stockMode ?? 'FLAG'})`)
        sendJson(res, 201, { ok: true, product })
        return
      }

      // --- the products page's own buttons ----------------------------------
      // Archive / Restore, Show / Hide, the NEW badge, and Move-to-category. All four
      // POST { productIds, ... } and toast from `{ updated, requested }`. They answered
      // the generic empty-shape fallback before, so the buttons reported success and
      // changed nothing.
      if (pathname === '/api/admin/products/bulk-archive' && req.method === 'POST') {
        let body = {}
        try { body = JSON.parse((await readBody(req)) || '{}') } catch { /* ignore */ }
        const res1 = applyBulk(catalogProducts, 'archive', body.productIds ?? body.ids, body.archived !== false)
        console.log(`  [admin] bulk-archive ${res1.updated}/${res1.requested} -> archived=${body.archived !== false}`)
        sendJson(res, 200, res1)
        return
      }
      if (pathname === '/api/admin/products/bulk-visibility' && req.method === 'POST') {
        let body = {}
        try { body = JSON.parse((await readBody(req)) || '{}') } catch { /* ignore */ }
        const res2 = applyBulk(catalogProducts, 'visibility', body.productIds ?? body.ids, body.isVisible !== false)
        console.log(`  [admin] bulk-visibility ${res2.updated}/${res2.requested} -> visible=${body.isVisible !== false}`)
        sendJson(res, 200, res2)
        return
      }
      if (pathname === '/api/admin/products/bulk-new-badge' && req.method === 'POST') {
        let body = {}
        try { body = JSON.parse((await readBody(req)) || '{}') } catch { /* ignore */ }
        const res3 = applyBulk(catalogProducts, 'new-badge', body.productIds ?? body.ids, body.isNew !== false)
        console.log(`  [admin] bulk-new-badge ${res3.updated}/${res3.requested} -> isNew=${body.isNew !== false}`)
        sendJson(res, 200, res3)
        return
      }
      if (pathname === '/api/admin/products/bulk-category' && req.method === 'POST') {
        let body = {}
        try { body = JSON.parse((await readBody(req)) || '{}') } catch { /* ignore */ }
        const cat = adminCategories().find((c) => c.id === body.categoryId)
        if (!cat) { sendJson(res, 422, { error: `No such category: ${body.categoryId}` }); return }
        const ids = new Set(body.productIds ?? body.ids ?? [])
        const matched = catalogProducts.filter((x) => ids.has(x.id) || ids.has(x.slug))
        for (const prod of matched) prod.category = { id: cat.id, name: cat.name, slug: cat.slug, code: prod.category?.code ?? 'AUTHORED' }
        console.log(`  [admin] bulk-category ${matched.length}/${ids.size} -> ${cat.name}`)
        sendJson(res, 200, { updated: matched.length, requested: ids.size, category: cat })
        return
      }
      // Per-product archive toggle used by the row's own menu.
      const archiveMatch = new RegExp('^/api/admin/products/([^/]+)/archive$').exec(pathname)
      if (archiveMatch && (req.method === 'PATCH' || req.method === 'PUT' || req.method === 'POST')) {
        const slug = decodeURIComponent(archiveMatch[1])
        const prod = catalogProducts.find((x) => x.slug === slug || x.id === slug)
        if (!prod) { sendJson(res, 404, { error: 'No such product.', slug }); return }
        let body = {}
        try { body = JSON.parse((await readBody(req)) || '{}') } catch { /* ignore */ }
        prod.archived = body.archived !== false
        console.log(`  [admin] ${slug} archived=${prod.archived}`)
        sendJson(res, 200, { ok: true, updated: 1, product: prod })
        return
      }
      // Spotlight's "mark recent as NEW" — the same badge write, from the other screen.
      if (pathname === '/api/admin/spotlight/mark-recent-as-new' && req.method === 'POST') {
        const recent = catalogProducts.slice(-8)
        for (const prod of recent) prod.isNew = true
        console.log(`  [admin] mark-recent-as-new -> ${recent.length} product(s)`)
        sendJson(res, 200, { ok: true, updated: recent.length })
        return
      }

      // --- order status transitions -----------------------------------------
      const orderActionMatch = new RegExp('^/api/admin/orders/([^/]+)/(confirm-payment|ship|deliver|archive|restore)$').exec(pathname)
      if (orderActionMatch && req.method === 'POST') {
        const ref = decodeURIComponent(orderActionMatch[1])
        const action = orderActionMatch[2] === 'confirm-payment' ? 'confirmPayment' : orderActionMatch[2]
        const order = allOrders().find((o) => o.orderNumber === ref || o.number === ref || o.id === ref)
        if (!order) { sendJson(res, 404, { error: 'No such order.', ref }); return }
        // Confirming an already-confirmed order is a no-op, not an error: a retry, a
        // double click, or a second admin must all be safe. Only the OTHER transitions
        // are genuinely order-dependent.
        if (action === 'confirmPayment' && order.confirmed === true) {
          console.log(`  [admin] ${order.orderNumber}: already confirmed (no-op)`)
          sendJson(res, 200, { ok: true, alreadyConfirmed: true, order: { number: order.orderNumber, status: order.status, confirmed: true } })
          return
        }
        const result = applyOrderTransition(order, action)
        if (!result.ok) {
          console.log(`  [admin] ${action} REFUSED for ${order.orderNumber}: ${result.error}`)
          sendJson(res, 409, { error: 'Invalid transition', message: result.error, status: order.status, allowed: ORDER_TRANSITIONS[action]?.from })
          return
        }
        console.log(`  [admin] ${order.orderNumber}: ${action} -> ${order.status}`)
        sendJson(res, 200, { ok: true, order: { number: order.orderNumber, status: order.status, confirmed: order.confirmed } })
        return
      }
      // What transitions are available for a given order — so a UI can disable buttons
      // rather than offer an action the server will refuse.
      if (pathname.startsWith('/api/admin/order-transitions') && req.method === 'GET') {
        sendJson(res, 200, { transitions: ORDER_TRANSITIONS })
        return
      }

      const patchMatch = new RegExp('^/api/admin/products/([^/]+)$').exec(pathname)

      // DELETE disables rather than destroys. A hard delete would orphan product_images
      // rows and break any order that referenced the slug; a reversible flag keeps the
      // catalogue's history intact. Distinct from sold out: disabled is an ADMIN
      // decision and hides the product, sold out still shows it with a Notify-me button.
      if (patchMatch && req.method === 'DELETE') {
        const slug = decodeURIComponent(patchMatch[1])
        const prod = catalogProducts.find((x) => x.slug === slug)
        if (!prod) {
          sendJson(res, 404, { error: 'No such product.', slug })
          return
        }
        prod.adminHidden = true
        authoredPatches[slug] = { ...(authoredPatches[slug] || {}), adminHidden: true }
        saveProductOverlay(PRODUCTS_FILE, { catalogProducts, authoredSlugs, authoredPatches })
        console.log(`  [admin] disabled ${slug}`)
        sendJson(res, 200, { ok: true, disabled: true, slug })
        return
      }

      if (patchMatch && (req.method === 'PATCH' || req.method === 'PUT')) {
        // Keyed on the product ID by the table's own row actions, and on slug by the
        // editor. Both must resolve or the toggle silently 404s.
        const ref = decodeURIComponent(patchMatch[1])
        const prod = catalogProducts.find((x) => x.slug === ref || x.id === ref)
        if (!prod) {
          sendJson(res, 404, { error: 'No such product.', ref })
          return
        }
        const slug = prod.slug
        let body = {}
        try { body = JSON.parse((await readBody(req)) || '{}') } catch { /* ignore */ }
        const val = validateProduct(body, { partial: true, existing: prod })
        if (!val.ok) {
          console.log(`  [admin] PATCH ${slug} REFUSED: ${val.problems[0]}`)
          sendJson(res, 422, { error: 'Invalid product', message: val.problems[0], problems: val.problems })
          return
        }
        const patch = {}
        for (const [k, v] of Object.entries(val.value)) {
          if (k === 'categoryName') {
            prod.category = v === null ? null : { id: prod.category?.id ?? `cat-${v.toLowerCase().replace(/\W+/g, '-')}`, name: v, slug: v.toLowerCase().replace(/\W+/g, '-'), code: prod.category?.code ?? 'AUTHORED' }
            patch.categoryName = v
            continue
          }
          if (k === 'images') { prod.images = v; patch.images = v; continue }
          prod[k] = v
          // Do NOT persist `soldOut` when it is derived. Storing it meant the next boot
          // re-validated the patch, correctly refused a directly-set soldOut under
          // QUANTITY, and dropped the WHOLE patch — losing the stockQty with it.
          if (!(k === 'soldOut' && (prod.stockMode ?? 'FLAG') === 'QUANTITY')) patch[k] = v
          if (k === 'stockQty') {
            for (const variant of prod.variants ?? []) variant.availableStock = v
          }
          if (k === 'pricePerUnit' && (prod.variants ?? []).length === 1) {
            prod.variants[0].pricePerUnit = v
          }
        }
        authoredPatches[slug] = { ...(authoredPatches[slug] || {}), ...patch }
        saveProductOverlay(PRODUCTS_FILE, { catalogProducts, authoredSlugs, authoredPatches })
        console.log(`  [admin] patched ${slug}: ${Object.keys(patch).join(', ')}`)
        // Return the ADMIN shape (isVisible/archived/isNew), not the raw catalogue
        // object, so a caller sees the same field names it just sent.
        sendJson(res, 200, {
          ok: true, applied: patch,
          product: {
            ...prod,
            isVisible: prod.adminHidden !== true,
            archived: prod.archived === true,
            isNew: prod.isNew === true,
            stockMode: prod.stockMode ?? 'FLAG',
          },
        })
        return
      }

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
            // Reflect the REAL state, not a constant. These were hardcoded, so the
            // archive / hide buttons wrote their flags and the admin list then threw
            // them away — the button reported success and the row never changed.
            isVisible: p.adminHidden !== true,
            archived: p.archived === true,
            isNew: p.isNew === true,
            stockMode: p.stockMode ?? 'FLAG',
            adminHidden: p.adminHidden === true,
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
      if (pathname === '/api/admin/orders' && req.method === 'GET') {
        // The Today tiles link to /admin/orders?status=paid and ?tab=awaiting, and the
        // orders page's own chips send more. Ignoring them meant a tile that counted 2
        // opened a list of 12, so the number and the destination disagreed.
        const oq = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
        const oStatus = oq.searchParams.get('status')
        const oTab = oq.searchParams.get('tab')
        const oSearch = (oq.searchParams.get('search') ?? '').toLowerCase()
        let every = allOrders()
        if (oStatus === 'paid') every = every.filter((o) => o.status === 'PAYMENT_CONFIRMED')
        else if (oStatus === 'shipped') every = every.filter((o) => o.status === 'SHIPPED')
        else if (oStatus === 'delivered') every = every.filter((o) => o.status === 'DELIVERED')
        else if (oStatus && oStatus !== 'all') every = every.filter((o) => o.status === oStatus.toUpperCase())
        if (oTab === 'awaiting') every = every.filter((o) => o.status === 'AWAITING_PAYMENT_REVIEW')
        else if (oTab === 'archive' || oTab === 'archived') every = every.filter((o) => o.archived === true)
        else if (!oTab || oTab === 'active') every = every.filter((o) => o.archived !== true)
        // `?includeArchived=true` is the escape hatch: the default view hides archived
        // orders (they are off the working list) but anything reconciling MONEY must see
        // them, or the totals disagree with the fee ledger by exactly the archived fees.
        // That mismatch is what surfaced this: 11 orders vs 12 fee rows, differing by
        // one archived order's 2% fee.
        if (oq.searchParams.get('includeArchived') === 'true') every = allOrders()
        if (oSearch) every = every.filter((o) => `${o.orderNumber} ${o.customerName ?? ''} ${o.email ?? ''}`.toLowerCase().includes(oSearch))
        const withState = every.map((o) => ({
          ...o,
          // Derived, and MUST be present: the admin list reads it to show payment
          // state, and confirm-payment writes it. It was absent, so a confirmation
          // succeeded and then vanished on reload.
          confirmed: o.confirmed === true || !['AWAITING_PAYMENT_REVIEW', 'PAYMENT_UNDER_REVIEW'].includes(o.status),
        }))
        console.log(`  [admin] /admin/orders -> ${withState.length} order(s) (${seededOrders.length} seeded)`)
        sendJson(res, 200, { orders: withState, total: withState.length, page: 1, pages: 1 })
        return
      }

      // --- reports: the Insights dashboards ---------------------------------
      // DATE-SCOPED: the page sends startDate/endDate and every section is filtered by
      // them, so the range has to be honoured or a "This week" view shows all time.
      //
      // THE PROPS ARE TOP-LEVEL, not nested under `summary`. The overview reads
      // `e.overview.totalRevenue`; payments reads `e.payments.byMethod`; sales reads
      // `e.inStock`, `e.sales`, `e.groupBuys`. Serving `{summary:{collected,...}}` put
      // the numbers one level down where nothing looked, so the screens rendered
      // $0.00 with a 200 and a body full of correct values.
      //
      // Field names were read off each component, not guessed: they are inconsistent
      // (`totalRevenue` not `collected`, `quantity` not `units`, `byMethod` not
      // `byPaymentMethod`), which is exactly how the earlier guesses went wrong.
      if ((pathname === '/api/admin/reports' || pathname === '/api/admin/reports/deliveries') && req.method === 'GET') {
        const rq = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
        const startQ = rq.searchParams.get('startDate')
        const endQ = rq.searchParams.get('endDate')
        const from = startQ ? new Date(startQ).getTime() : -Infinity
        const to = endQ ? new Date(endQ).getTime() : Infinity
        const day = (iso) => String(iso).slice(0, 10)
        const money = (n) => Math.round((Number(n) || 0) * 100) / 100

        const orders = allOrders().filter((o) => {
          if (o.status === 'CANCELLED') return false
          const t = new Date(o.placedAt).getTime()
          return t >= from && t <= to
        })
        const paid = orders.filter((o) => o.confirmed === true)
        // DELIVERED is the only state that has actually arrived.
        const deliveries = orders.filter((o) => o.status === 'DELIVERED')
        const sum = (list, of) => money(list.reduce((n, o) => n + (Number(of(o)) || 0), 0))

        // ---- the shared per-day series -------------------------------------
        const byDay = (list, valueOf) => {
          const map = new Map()
          for (const o of list) {
            const k = day(o.placedAt)
            const cur = map.get(k) ?? { date: k, revenue: 0, orders: 0 }
            cur.revenue = money(cur.revenue + valueOf(o))
            cur.orders += 1
            map.set(k, cur)
          }
          return [...map.values()].sort((a, b) => a.date.localeCompare(b.date))
        }
        const revenueOverTime = byDay(paid, (o) => o.totalAmount ?? o.total)

        // ---- products ------------------------------------------------------
        // `id` and `quantity`, plus `revenue`. The page sorts by quantity for "best
        // sellers" and shows an avg of revenue/quantity.
        const prodMap = new Map()
        for (const o of orders) {
          for (const it of o.items ?? []) {
            const name = it.title ?? it.itemName ?? 'Item'
            // `stock` drives the badge: null -> "—", <=0 -> "Sold out", <=5 -> "N left".
            const cur = prodMap.get(name) ?? { id: name, name, quantity: 0, revenue: 0, stock: null }
            cur.quantity += it.qty ?? it.quantity ?? 1
            cur.revenue = money(cur.revenue + (it.totalPrice ?? 0))
            prodMap.set(name, cur)
          }
        }
        const productPerformance = [...prodMap.values()].sort((a, b) => b.revenue - a.revenue)
        const topProduct = [...productPerformance].sort((a, b) => b.quantity - a.quantity)[0] ?? null

        // ---- payments by method -------------------------------------------
        const payMap = new Map()
        for (const o of orders) {
          const name = (o.method || 'UNKNOWN').toUpperCase()
          const cur = payMap.get(name) ?? { name, value: 0, count: 0 }
          cur.value = money(cur.value + (Number(o.totalAmount ?? o.total) || 0))
          cur.count += 1
          payMap.set(name, cur)
        }

        // ---- customers -----------------------------------------------------
        const custMap = new Map()
        for (const o of orders) {
          const key = o.email ?? o.customerName
          const cur = custMap.get(key) ?? { id: key, email: o.email, name: o.customerName, orders: 0, totalSpent: 0 }
          cur.orders += 1
          cur.totalSpent = money(cur.totalSpent + (Number(o.totalAmount ?? o.total) || 0))
          custMap.set(key, cur)
        }
        const topCustomers = [...custMap.values()].sort((a, b) => b.totalSpent - a.totalSpent)
        const inWindow = seededCustomers.filter((u) => {
          const t = new Date(u.createdAt).getTime()
          return t >= from && t <= to
        })

        if (pathname.endsWith('/deliveries')) {
          const avgDays = deliveries.length
            ? Math.round(deliveries.reduce((n, o) => n + Math.max(1, (Date.now() - new Date(o.placedAt).getTime()) / 86400000), 0) / deliveries.length)
            : 0
          const carrierMap = new Map()
          for (const o of deliveries) {
            const c = o.tracking?.carrier ?? 'Unknown'
            carrierMap.set(c, (carrierMap.get(c) ?? 0) + 1)
          }
          sendJson(res, 200, {
            __derived: `computed from the seeded orders in ${day(startQ ?? '')}..${day(endQ ?? '')}`,
            summary: {
              totalDelivered: deliveries.length,
              // Read as a SIBLING of totalDelivered (it drives the "Confirmed by
              // webhook" KPI), not nested under `automation` as I first had it.
              autoUpdated: 0,
              inTransit: orders.filter((o) => o.status === 'SHIPPED').length,
              avgDeliveryDays: avgDays,
            },
            // `automation.lastWebhookAt` is the ONLY field read off automation, and it
            // is an ISO string — not a boolean or an event object. Leaving it out is
            // the honest answer here: nothing in this replay has a webhook, so the
            // page says "ShipStation last heard never" and shows a quiet pill.
            automation: { lastWebhookAt: null },
            charts: {
              deliveriesByDay: deliveries.reduce((acc, o) => {
                const k = day(o.placedAt)
                const key = String(o.tracking?.carrier ?? 'other').toLowerCase()
                let hit = acc.find((y) => y.date === k)
                if (!hit) {
                  hit = { date: k, count: 0, usps: 0, ups: 0, fedex: 0, other: 0 }
                  acc.push(hit)
                }
                hit.count += 1
                // The table twin renders usps/ups/fedex/other RAW, so a missing key
                // shows as an empty cell rather than a zero.
                if (key in hit) hit[key] += 1
                else hit.other += 1
                return acc
              }, []).sort((a, b) => a.date.localeCompare(b.date)),
              // `value` is what the bar row reads; `count` kept for the chart twin.
              carrierBreakdown: [...carrierMap.entries()].map(([name, value]) => ({ name, value, count: value })).sort((a, b) => b.value - a.value),
            },
            // `recentDeliveries`, not `deliveries` — the table reads that name off the
            // same response, so any other key renders "No deliveries in this range."
            // `orderNumber || id.slice(0,8)` is UNGUARDED, so id must always be present.
            recentDeliveries: deliveries.map((o) => ({
              id: o.id, orderNumber: o.orderNumber, carrier: o.tracking?.carrier ?? '—',
              trackingNumber: o.tracking?.number ?? '—', trackingStatus: o.tracking?.status ?? '—',
              customer: o.customerName, email: o.email, deliveredAt: o.placedAt, placedAt: o.placedAt,
              status: o.status, revenue: o.totalAmount ?? o.total,
            })),
          })
          console.log(`  [admin] reports/deliveries -> ${deliveries.length} delivered in range`)
          return
        }

        const revenue = sum(paid, (o) => o.totalAmount ?? o.total)
        const productSubtotal = sum(orders, (o) => o.subtotal)
        sendJson(res, 200, {
          __derived: `computed from the seeded orders in ${day(startQ ?? '')}..${day(endQ ?? '')}`,
          feePercent: 2,
          overview: {
            totalRevenue: revenue,
            ordersCount: paid.length,
            cancelledOrders: orders.filter((o) => o.status === 'CANCELLED').length,
            avgOrderValue: paid.length ? money(revenue / paid.length) : 0,
            newCustomers: inWindow.length,
            pendingOrders: orders.filter((o) => o.status === 'AWAITING_PAYMENT_REVIEW').length,
            topProduct: topProduct ? { name: topProduct.name, quantity: topProduct.quantity, revenue: topProduct.revenue } : null,
            revenueBreakdown: {
              productSubtotal,
              discounts: sum(orders, (o) => o.discountAmount),
              shipping: sum(orders, (o) => o.shippingCost),
              insurance: sum(orders, (o) => o.insuranceCost),
              adminFees: sum(orders, (o) => o.adminFee),
              paymentAdjustments: 0,
              retailRevenue: 0,
              // Always rendered, so they must be numbers rather than absent.
              groupBuyRevenue: sum(orders.filter((o) => (o.items ?? []).some((it) => it.groupBuyItemId)), (o) => o.totalAmount ?? o.total),
              saleRevenue: sum(orders.filter((o) => o.kind === 'sale'), (o) => o.totalAmount ?? o.total),
            },
          },
          charts: {
            revenueOverTime,
            productPerformance,
            customerGrowth: (() => {
              const map = new Map()
              for (const u of inWindow) {
                const k = day(u.createdAt)
                map.set(k, (map.get(k) ?? 0) + 1)
              }
              return [...map.entries()].sort().map(([date, count]) => ({ date, count }))
            })(),
          },
          // Sales section: revenue by source. Retail is 0 because nothing in this
          // catalogue is stocked retail — every product is a pre-order — and saying so
          // is more useful than a placeholder.
          inStock: { revenue: 0, orders: 0 },
          sales: {
            revenue: sum(orders.filter((o) => o.kind === 'sale'), (o) => o.totalAmount ?? o.total),
            orders: orders.filter((o) => o.kind === 'sale').length,
            campaigns: [],
          },
          // Group buys: the campaigns are the seeded ones, and the byStatus map drives
          // the status filter chips. `buyers`/`units` are read with `?? participants`
          // and `?? 0` fallbacks, so they must be present or every row reads 0.
          groupBuys: (() => {
            const gbOrders = orders.filter((o) => (o.items ?? []).some((it) => it.groupBuyItemId))
            const campaigns = seededCampaigns.groupbuys.filter((c) => c.archived !== true).map((c, i) => ({
              id: c.id, name: c.name, status: c.status, closesAt: c.closesAt, opensAt: c.opensAt,
              // `totalOrdered` is the campaign's own counter; orders in RANGE are what
              // this section is scoped to, so both are shown rather than conflated.
              buyers: Math.max(0, Math.round((c.totalOrdered ?? 0) * 0.6)),
              participants: Math.round((c.totalOrdered ?? 0) * 0.6),
              orders: Math.max(0, Math.round((c.totalOrdered ?? 0) * 0.45)),
              units: c.totalOrdered ?? 0,
              revenue: money((c.totalOrdered ?? 0) * (c.items?.[0]?.pricePerUnit ?? 40)),
            }))
            return {
              // `total` is the "Campaigns" KPI. Without it the tile read 0 while the
              // campaign table below it listed eight rows.
              total: campaigns.length,
              revenue: sum(gbOrders, (o) => o.totalAmount ?? o.total),
              orders: gbOrders.length,
              unitTotals: sum(gbOrders, (o) => (o.items ?? []).reduce((n, it) => n + (it.qty ?? 1), 0)),
              // Each status maps to an OBJECT: the chips test the value for truthiness
              // and then read `.count` / `.revenue` off it. A plain number made every
              // chip render 0.
              byStatus: campaigns.reduce((acc, c) => {
                const cur = acc[c.status] ?? { count: 0, revenue: 0 }
                cur.count += 1
                cur.revenue = money(cur.revenue + c.revenue)
                acc[c.status] = cur
                return acc
              }, {}),
              campaigns,
            }
          })(),
          recentOrders: orders.slice(0, 20).map((o) => ({
            id: o.id, orderNumber: o.orderNumber, status: o.status, total: o.totalAmount ?? o.total,
            customer: o.customerName, email: o.email, placedAt: o.placedAt,
            // `paymentMethod` and `date` are the names the table and its CSV read.
            // The CSV calls `new Date(y.date).toISOString()` with NO guard, so a
            // missing date throws a RangeError on export.
            paymentMethod: o.method, method: o.method,
            date: o.placedAt, items: (o.items ?? []).length,
          })),
          customers: {
            new: inWindow.length,
            returning: Math.max(0, topCustomers.length - inWindow.length),
            topCustomers,
          },
          // The fee tiles read these three off `payments`, plus feePercent at the top
          // level. `preFeeSubtotal` is the page's own name for the fee base:
          // "subtotal − discounts + shipping + insurance".
          payments: {
            byMethod: [...payMap.values()].sort((a, b) => b.value - a.value),
            totalFees: sum(orders, (o) => o.adminFee),
            preFeeSubtotal: money(
              sum(orders, (o) => o.subtotal) - sum(orders, (o) => o.discountAmount)
              + sum(orders, (o) => o.shippingCost) + sum(orders, (o) => o.insuranceCost)
            ),
            settledFees: sum(deliveries, (o) => o.adminFee),
            unsettledFees: sum(orders.filter((o) => o.status !== 'DELIVERED' && o.status !== 'CANCELLED'), (o) => o.adminFee),
          },
        })
        console.log(`  [admin] reports -> ${orders.length} order(s) in range, revenue $${revenue}`)
        return
      }

      // --- fees: settled by month, from the orders that booked them ----------
      // Every order books a platform fee when it is placed, and the page pays a month
      // out and settles it. It was serving `{}`, so the screen read $0.00 owed,
      // $0.00 settled and "no fees booked yet" with a full order book behind it.
      if (pathname === '/api/admin/fees/monthly-summary' && req.method === 'GET') {
        const EAST = 'America/New_York'
        // The page groups by EASTERN-time month and labels today's month "This month",
        // so grouping in UTC would put a late-evening order in the wrong month.
        const monthKey = (iso) => {
          const d = new Date(iso)
          // `Intl.formatToParts` throws RangeError on an Invalid Date, and an
          // unguarded throw here took the WHOLE SERVER down: an order placed through
          // the local checkout has no `placedAt`, so one such record crashed the
          // process on the first fees request. Guard the input, never the caller.
          if (Number.isNaN(d.getTime())) return 'unknown'
          const parts = new Intl.DateTimeFormat('en-US', { timeZone: EAST, year: 'numeric', month: '2-digit' })
            .formatToParts(d)
          return `${parts.find((x) => x.type === 'year')?.value ?? '????'}-${parts.find((x) => x.type === 'month')?.value ?? '??'}`
        }
        // Only orders that carry a placement date can be booked into a month.
        const orders = allOrders().filter((o) => !Number.isNaN(new Date(o.placedAt).getTime()))
        const fees = orders.map((o) => {
          // CANCELLED and ARCHIVED are NOT the same thing. Archiving takes an order off
          // the working list; it does not void it or its fee. Conflating them made the
          // ledger $0.60 short of the orders it was built from — exactly one archived
          // order's 2% — and no amount of re-reading the totals would have shown why.
          const cancelled = o.status === 'CANCELLED'
          const settled = o.status === 'DELIVERED'
          return {
            id: `fee-${o.orderNumber}`,
            orderNumber: o.orderNumber,
            cancelled,
            settled,
            settledAt: settled ? o.placedAt : null,
            paymentMethod: (o.method || 'UNKNOWN').toUpperCase(),
            // The page's copy: "of subtotal − discounts + shipping + insurance".
            feeAmount: Math.round((Number(o.adminFee) || 0) * 100) / 100,
            order: {
              id: o.id, orderNumber: o.orderNumber,
              user: o.user, customerName: o.customerName, email: o.email,
            },
            month: monthKey(o.placedAt),
          }
        })
        const byMonth = new Map()
        for (const f of fees) {
          if (!byMonth.has(f.month)) byMonth.set(f.month, [])
          byMonth.get(f.month).push(f)
        }
        const months = [...byMonth.entries()].map(([month, list]) => {
          const live = list.filter((f) => !f.cancelled)
          return {
            // `key` is what the page matches the current month against
            // (`s.find(n => n.key === k)`) and `month` is what it prints. Serving only
            // `month` left the current-month tiles reading $0.00 / "no fees booked yet"
            // while the all-months totals beside them computed correctly off the array.
            key: month,
            month,
            count: list.length,
            cancelledCount: list.filter((f) => f.cancelled).length,
            unsettledCount: live.filter((f) => !f.settled).length,
            totalOwed: Math.round(live.filter((f) => !f.settled).reduce((n, f) => n + f.feeAmount, 0) * 100) / 100,
            totalSettled: Math.round(live.filter((f) => f.settled).reduce((n, f) => n + f.feeAmount, 0) * 100) / 100,
          }
        }).sort((a, b) => b.month.localeCompare(a.month))
        console.log(`  [admin] fees -> ${fees.length} fee(s) across ${months.length} month(s)`)
        sendJson(res, 200, { __derived: 'booked from the seeded orders', months, fees })
        return
      }

      // The fee rate the page displays, and the one the orders were booked at.
      if (pathname === '/api/admin/settings' && req.method === 'GET') {
        sendJson(res, 200, {
          __derived: 'configuration used by this replay',
          settings: {
            adminFeePercent: 2,
            freeShippingThreshold: 200,
            requirePaymentProof: true,
            storeName: 'Joyous',
            currency: 'USD',
          },
        })
        return
      }

      // --- companions to the Today dashboard --------------------------------
      // These four were serving `{}` while a page was READING them, which is the same
      // failure as the dashboard tiles: an empty object satisfies `if (data)` and every
      // number renders as blank while the response looks fine.
      //
      // `orders/today-stats` — OrdersPage reads deliveredToday / shippedToday /
      // newToday. It has its own `{deliveredToday:0,...}` default, but that only runs on
      // a THROWN error; a 200 `{}` bypasses it and the three counters render empty.
      if (pathname === '/api/admin/orders/today-stats' && req.method === 'GET') {
        const today = new Date().toISOString().slice(0, 10)
        const isToday = (iso) => typeof iso === 'string' && iso.slice(0, 10) === today
        const orders = allOrders()
        sendJson(res, 200, {
          __derived: 'computed from the seeded orders',
          deliveredToday: orders.filter((o) => o.status === 'DELIVERED' && isToday(o.placedAt)).length,
          shippedToday: orders.filter((o) => o.status === 'SHIPPED' && isToday(o.placedAt)).length,
          newToday: orders.filter((o) => isToday(o.placedAt)).length,
        })
        return
      }

      // `open-carts` — the page's own error default is `{carts:[], stats:null,
      // pagination:null}`, which is exactly the shape it expects, so serve it.
      // A cart is "open" when it has lines and no order has been placed: the replay
      // keeps one cart per member in memory, so this is derived from that plus the
      // seeded customers who demonstrably have not ordered.
      if (pathname === '/api/admin/open-carts' && req.method === 'GET') {
        const q2 = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
        const search = (q2.searchParams.get('search') ?? '').toLowerCase()
        const carts = []
        if (cart.length) {
          carts.push({
            id: 'self', email: accountUser?.email ?? 'you@example.com',
            name: accountUser ? `${accountUser.firstName ?? ''} ${accountUser.lastName ?? ''}`.trim() : 'You',
            items: cart.length,
            units: cart.reduce((n, l) => n + (l.quantity ?? 1), 0),
            total: cartSubtotal(),
            at: new Date().toISOString(),
            kind: cart[0]?.kind ?? 'product',
          })
        }
        // Seeded customers with no orders are the honest "abandoned cart" population:
        // they exist, they never checked out.
        const ordered = new Set(allOrders().map((o) => o.email))
        for (const cust of seededCustomers.filter((c) => !ordered.has(c.email)).slice(0, 4)) {
          carts.push({
            id: cust.id, email: cust.email, name: cust.name,
            items: 1 + (cust.orderCount % 3), units: 1 + (cust.orderCount % 4),
            total: Math.round((cust.totalSpent || 40) / 3 * 100) / 100,
            at: new Date(Date.now() - 3600000 * (1 + cust.orderCount)).toISOString(),
            kind: 'product',
          })
        }
        const rows = search ? carts.filter((c) => `${c.email} ${c.name}`.toLowerCase().includes(search)) : carts
        // The row renders `r.user.id` and the header reads
        // stats.{totalItems,totalValue,totalCarts,productItems,groupBuyItems,saleItems}.
        // A cart with only a top-level `id` threw
        // "Cannot read properties of undefined (reading 'id')" during render, which the
        // error boundary turned into a full-page failure — from a 200 response.
        const shaped = rows.map((c) => ({
          ...c,
          user: { id: c.id, email: c.email, name: c.name, firstName: String(c.name || '').split(' ')[0] },
        }))
        sendJson(res, 200, {
          __derived: 'derived from the live cart and the seeded customers who never ordered',
          carts: shaped,
          stats: {
            totalCarts: shaped.length,
            totalItems: shaped.reduce((n, c) => n + c.items, 0),
            totalValue: Math.round(shaped.reduce((n, c) => n + c.total, 0) * 100) / 100,
            productItems: shaped.filter((c) => c.kind !== 'groupbuy' && c.kind !== 'sale').reduce((n, c) => n + c.items, 0),
            groupBuyItems: shaped.filter((c) => c.kind === 'groupbuy').reduce((n, c) => n + c.items, 0),
            saleItems: shaped.filter((c) => c.kind === 'sale').reduce((n, c) => n + c.items, 0),
          },
          pagination: { page: 1, pages: 1, total: shaped.length },
        })
        return
      }

      // The detail panel. The page auto-selects the first cart, so without this route
      // the fetch 404s, the error state wins, and the whole screen renders
      // "Couldn't load open carts / Reload" even though the LIST returned fine.
      const openCartMatch = new RegExp('^/api/admin/open-carts/([^/]+)$').exec(pathname)
      if (openCartMatch && req.method === 'GET') {
        const key = decodeURIComponent(openCartMatch[1])
        const addr = resolveShippingAddress('82591098-2aff-4291-a1e5-049ff1ac23a5')
        const live = key === 'self' && cart.length
          ? {
              id: 'self', email: accountUser?.email, name: accountUser ? `${accountUser.firstName} ${accountUser.lastName}` : 'You',
              items: cart.map((l) => ({
                name: l.groupBuyItem?.name ?? l.product?.name ?? 'Item',
                quantity: l.quantity ?? 1,
                pricePerUnit: l.packPrice ?? l.variant?.pricePerUnit ?? l.product?.pricePerUnit ?? 0,
              })),
              total: cartSubtotal(), at: new Date().toISOString(),
            }
          : null
        const seededCart = seededCustomers.find((c) => c.id === key)
        const detail = live ?? (seededCart ? {
          id: seededCart.id, email: seededCart.email, name: seededCart.name,
          items: [{ name: 'Seeded cart item', quantity: 1 + (seededCart.orderCount % 3), pricePerUnit: Math.round((seededCart.totalSpent || 40) / 3 * 100) / 100 }],
          total: Math.round((seededCart.totalSpent || 40) / 3 * 100) / 100,
          at: new Date(Date.now() - 3600000).toISOString(),
        } : null)
        if (!detail) { sendJson(res, 404, { error: 'No such cart.', key }); return }
        // The panel reads `addresses` to preselect a shipping address.
        sendJson(res, 200, { ...detail, addresses: addr ? [addr] : [] })
        return
      }

      // --- the Today dashboard ----------------------------------------------
      // DERIVED AT REQUEST TIME from the records the other screens read, so a number
      // here always matches the list it links to. It was a static shape of zeros, so
      // every tile read 0 no matter how many orders or tickets existed — and a
      // dashboard that disagrees with its own lists is worse than an empty one.
      //
      // KEYS ARE THE COMPONENT'S, not the obvious names: AdminHome renders
      // `se.map(a => n[a.key])` over its own list, so `todaysPayments` would be a key
      // nothing looks up and the tile would silently print 0.
      if (pathname === '/api/admin/dashboard/counts' && req.method === 'GET') {
        const today = new Date().toISOString().slice(0, 10)
        const isToday = (iso) => typeof iso === 'string' && iso.slice(0, 10) === today
        const orders = allOrders()

        const needsReplyCount = seededTickets.filter((t) => {
          if (t.status !== 'OPEN') return false
          const last = (t.messages ?? [])[t.messages.length - 1]
          return last?.authorType === 'CUSTOMER'
        }).length

        const ship = orders.filter((o) => o.status === 'PAYMENT_CONFIRMED').length
        const payments = orders.filter((o) => o.confirmed === true && isToday(o.placedAt)).length
        const sales = orders
          .filter((o) => o.confirmed === true && isToday(o.placedAt))
          .reduce((n, o) => n + (Number(o.totalAmount ?? o.total) || 0), 0)
        const awaiting = orders.filter((o) => o.status === 'AWAITING_PAYMENT_REVIEW').length

        const body = {
          __derived: 'computed from the seeded orders, tickets and members; not recorded data',
          ordersToShip: ship,
          paymentsToday: payments,
          needsReply: needsReplyCount,
          awaitingApproval: seededCustomers.filter((u) => !u.approved).length,
          backInStock: stockSubscriptions,
          salesToday: Math.round(sales * 100) / 100,
          awaitingPayment: awaiting,
        }
        console.log(`  [admin] dashboard/counts -> ship=${ship} pay=${payments} reply=${needsReplyCount} approve=${body.awaitingApproval} sales=$${body.salesToday}`)
        sendJson(res, 200, body)
        return
      }

      // The two activity lines under the Today tiles.
      if (pathname === '/api/admin/dashboard/today' && req.method === 'GET') {
        const today = new Date().toISOString().slice(0, 10)
        const isToday = (iso) => typeof iso === 'string' && iso.slice(0, 10) === today
        const orders = allOrders()
        const byStatus = (s) => orders.filter((o) => o.status === s && isToday(o.placedAt)).length
        const body = {
          __derived: 'computed from the seeded orders',
          delivered: byStatus('DELIVERED'),
          shipped: orders.filter((o) => ['SHIPPED'].includes(o.status) && isToday(o.placedAt)).length,
          newOrders: orders.filter((o) => isToday(o.placedAt)).length,
          paymentsConfirmed: orders.filter((o) => o.confirmed === true && isToday(o.placedAt)).length,
          awaitingPayment: orders.filter((o) => o.status === 'AWAITING_PAYMENT_REVIEW').length,
          ordersToShip: orders.filter((o) => o.status === 'PAYMENT_CONFIRMED').length,
        }
        sendJson(res, 200, body)
        return
      }

      // --- confirm-payment: the ONE order status transition ------------------
      // The real API has POST /api/admin/orders/:id/confirm-payment and the client calls
      // it, but no route existed here, so the request fell through to the generic admin
      // no-op fallback and answered 200 {}. The admin UI reported a confirmation that
      // never happened.
      const confirmMatch = new RegExp('^/api/admin/orders/([^/]+)/confirm-payment$').exec(pathname)
      if (confirmMatch && req.method === 'POST') {
        const ref = decodeURIComponent(confirmMatch[1])
        const order = orders.find((o) => o.orderNumber === ref || o.id === ref)
        if (!order) {
          sendJson(res, 404, { error: 'No such order.', ref })
          return
        }
        if (order.confirmed) {
          // Idempotent: confirming twice is not an error, and must not double-fire
          // anything downstream.
          sendJson(res, 200, { order: { number: order.orderNumber, confirmed: true }, alreadyConfirmed: true })
          return
        }
        order.confirmed = true
        order.status = 'PAYMENT_CONFIRMED'
        console.log(`  [admin] confirmed payment for ${order.orderNumber}`)
        sendJson(res, 200, { order: { number: order.orderNumber, confirmed: true } })
        return
      }

      // --- campaigns: archive / restore / delete ----------------------------
      // The page PATCHes `{archived}` to `/<api>/<id>/archive` and DELETEs `/<api>/<id>`.
      // Neither existed, so Archive and Delete toasted success and changed nothing.
      const campMatch = new RegExp('^/api/admin/(groupbuys|sales)/([^/]+?)(/archive)?$').exec(pathname)
      if (campMatch) {
        const [, kind, id, isArchive] = campMatch
        const pool = kind === 'groupbuys' ? seededCampaigns.groupbuys : seededCampaigns.sales
        const rec = catalogCampaigns
        const row = pool.find((c) => c.id === id) ?? rec.find((c) => c.id === id)
        if (!row) { sendJson(res, 404, { error: 'No such campaign.', id }); return }
        if (isArchive && (req.method === 'PATCH' || req.method === 'PUT' || req.method === 'POST')) {
          let body = {}
          try { body = JSON.parse((await readBody(req)) || '{}') } catch { /* ignore */ }
          row.archived = body.archived !== false
          console.log(`  [admin] ${kind} ${row.name}: archived=${row.archived}`)
          sendJson(res, 200, { ok: true, campaign: row })
          return
        }
        if (!isArchive && req.method === 'DELETE') {
          const at = pool.indexOf(row)
          if (at >= 0) pool.splice(at, 1)
          else { const j = rec.indexOf(row); if (j >= 0) rec.splice(j, 1) }
          console.log(`  [admin] ${kind} deleted: ${row.name}`)
          sendJson(res, 200, { ok: true, deleted: row.id })
          return
        }
        if (!isArchive && req.method === 'GET') {
          sendJson(res, 200, { campaign: row })
          return
        }
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

      // Approval: the one mutation the Customers directory offers. Tier is changed the
      // same way, because "approve and upgrade" is one decision in practice.
      const userMatch = new RegExp('^/api/admin/users/([^/]+)$').exec(pathname)
      if (userMatch && (req.method === 'PATCH' || req.method === 'PUT' || req.method === 'POST')) {
        const ref = decodeURIComponent(userMatch[1])
        const target = seededCustomers.find((x) => x.id === ref || x.email === ref)
        if (!target) { sendJson(res, 404, { error: 'No such member.', ref }); return }
        let body = {}
        try { body = JSON.parse((await readBody(req)) || '{}') } catch { /* ignore */ }
        const before = { approved: target.approved, tier: target.tier }
        if (body.approved !== undefined) target.approved = !!body.approved
        if (body.tier) {
          const tier = String(body.tier).toUpperCase()
          if (!TIERS.includes(tier)) { sendJson(res, 422, { error: `tier must be one of ${TIERS.join(', ')}` }); return }
          target.tier = tier
        }
        console.log(`  [admin] member ${target.email}: ${JSON.stringify(before)} -> approved=${target.approved} tier=${target.tier}`)
        sendJson(res, 200, { ok: true, user: target })
        return
      }

      // Rendered order emails, so the payload can be looked at without a terminal.
      //   GET /api/admin/outbox          -> the history, with subjects and links
      //   GET /api/admin/outbox/<n>      -> message n's HTML, served inline
      if (pathname === '/api/admin/outbox' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({
          note: 'Rendered locally. No email was sent.',
          events: orderEvents.log,
          messages: emailHistory,
        }))
        return
      }
      const outboxMatch = /^\/api\/admin\/outbox\/(\d+)$/.exec(pathname)
      if (outboxMatch && req.method === 'GET') {
        const flat = emailHistory.flatMap((h) => h.messages)
        const msg = flat[Number(outboxMatch[1])]
        if (!msg) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'No such message' }))
          return
        }
        try {
          const html = readFileSync(msg.file)
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(html)
        } catch {
          res.writeHead(410, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'File missing', file: msg.file }))
        }
        return
      }

      // Support tickets: one of each issue type, so the filters have something to filter.
      // `needsReply` is the one the header counts: a ticket whose LAST message is from
      // the customer is waiting on an admin, which is exactly how the page computes it.
      const needsReply = (t) => {
        if (t.status !== 'OPEN') return false
        const last = (t.messages ?? [])[t.messages.length - 1]
        return last?.authorType === 'CUSTOMER'
      }
      if ((pathname === '/api/admin/support/tickets/counts' || pathname === '/api/admin/tickets/counts') && req.method === 'GET') {
        sendJson(res, 200, {
          needsReply: seededTickets.filter(needsReply).length,
          openOrderIssues: seededTickets.filter((t) => t.status === 'OPEN' && t.category === 'ORDER_ISSUE').length,
          open: seededTickets.filter((t) => !['RESOLVED', 'CLOSED'].includes(t.status)).length,
          urgent: seededTickets.filter((t) => t.priority === 'URGENT').length,
          high: seededTickets.filter((t) => t.priority === 'HIGH').length,
          awaiting: seededTickets.filter((t) => t.status === 'WAITING_ON_CUSTOMER').length,
          resolved: seededTickets.filter((t) => t.status === 'RESOLVED').length,
        })
        return
      }
      if ((pathname === '/api/admin/tickets' || pathname === '/api/admin/support/tickets') && req.method === 'GET') {
        // `{ tickets, hasMore }`, NOT a bare array: the page reads `m.tickets || []`
        // and keys pagination off `m.hasMore`. A bare array gave it `undefined || []`
        // and the inbox rendered empty while the header counted correctly.
        // The query narrows server-side, the way the real route does, because the page
        // passes `awaiting`/`status`/`search`/`category` as params.
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
        const awaiting = url.searchParams.get('awaiting')
        const status = url.searchParams.get('status')
        const category = url.searchParams.get('category')
        const search = (url.searchParams.get('search') ?? '').toLowerCase()
        const page = Math.max(1, Number(url.searchParams.get('page')) || 1)
        const limit = Math.max(1, Number(url.searchParams.get('limit')) || 25)
        let list = seededTickets
        if (awaiting === 'ADMIN') list = list.filter(needsReply)
        else if (awaiting === 'CUSTOMER') list = list.filter((t) => t.status === 'OPEN' && (t.messages ?? []).at(-1)?.authorType === 'ADMIN')
        if (status && status !== 'all') list = list.filter((t) => t.status === status)
        if (category) list = list.filter((t) => t.category === category)
        if (search) list = list.filter((t) => `${t.subject} ${t.customer} ${t.customerName ?? ''}`.toLowerCase().includes(search))
        const start = (page - 1) * limit
        const slice = list.slice(start, start + limit)
        console.log(`  [admin] support tickets -> ${slice.length}/${list.length} (awaiting=${awaiting ?? '-'} status=${status ?? '-'})`)
        sendJson(res, 200, { tickets: slice, hasMore: start + limit < list.length, total: list.length, page })
        return
      }
      const ticketMatch = new RegExp('^/api/admin/(?:support/)?tickets/(?!counts$)([^/]+)$').exec(pathname)
      if (ticketMatch && req.method === 'GET') {
        const t = seededTickets.find((x) => x.id === decodeURIComponent(ticketMatch[1]))
        if (!t) { sendJson(res, 404, { error: 'No such ticket.' }); return }
        sendJson(res, 200, { ticket: t })
        return
      }
      if (ticketMatch && (req.method === 'PATCH' || req.method === 'PUT')) {
        const t = seededTickets.find((x) => x.id === decodeURIComponent(ticketMatch[1]))
        if (!t) { sendJson(res, 404, { error: 'No such ticket.' }); return }
        let body = {}
        try { body = JSON.parse((await readBody(req)) || '{}') } catch { /* ignore */ }
        const before = t.status
        if (body.status) t.status = String(body.status).toUpperCase()
        if (body.priority) t.priority = String(body.priority).toUpperCase()
        if (body.resolution) t.resolution = String(body.resolution).toUpperCase()
        t.updatedAt = new Date().toISOString()
        if (body.message) t.messages.push({ author: 'support', body: String(body.message), at: t.updatedAt })
        console.log(`  [admin] ticket ${t.id}: ${before} -> ${t.status}`)
        sendJson(res, 200, { ok: true, ticket: t })
        return
      }

      // The directory: seeded customers plus the recorded account.
      if (pathname === '/api/admin/users' && req.method === 'GET') {
        // The only account the recording contains - already sanitised, so no real
        // details are involved. Served so the directory is not empty and the seeded
        // admin appears as a row.
        const seeded = seededCustomers
        const u = JSON.parse(await readFile(join(SAMPLES, 'api_auth_me.json'), 'utf8')).user
        let addr = null
        try {
          addr = (JSON.parse(await readFile(join(SAMPLES, 'api_users_addresses.json'), 'utf8')).addresses ?? [])[0] ?? null
        } catch { /* none */ }
        const row = { ...u, address: addr, addresses: addr ? [addr] : [] }
        const everyone = [row, ...seeded]
        console.log(`  [admin] /admin/users -> ${everyone.length} account(s) (${seeded.length} seeded, ${seeded.filter((x) => !x.approved).length} awaiting approval)`)
        sendJson(res, 200, {
          users: everyone,
          total: everyone.length,
          page: 1,
          pages: 1,
          counts: {
            total: everyone.length,
            pending: everyone.filter((x) => !x.approved).length,
            elite: everyone.filter((x) => x.tier === 'ELITE').length,
            vip: everyone.filter((x) => x.tier === 'VIP').length,
          },
        })
        return
      }

      if ((pathname === '/api/admin/groupbuys' || pathname === '/api/admin/sales') && req.method === 'GET') {
        const isGb = pathname.endsWith('groupbuys')
        const q = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
        const wantStatus = q.searchParams.get('status')
        const includeArchived = q.searchParams.get('includeArchived') === 'true'
        const search = (q.searchParams.get('search') ?? '').toLowerCase()
        const seeded = isGb ? seededCampaigns.groupbuys : seededCampaigns.sales
        const all = [...(isGb ? catalogCampaigns : []), ...seeded]
        let rows = all
        if (!includeArchived) rows = rows.filter((c) => c.archived !== true)
        if (wantStatus && wantStatus !== 'all') rows = rows.filter((c) => c.status === wantStatus)
        if (search) rows = rows.filter((c) => `${c.name} ${c.vendorName ?? ''}`.toLowerCase().includes(search))
        // statsAll is the UNFILTERED picture ("statsAll" means all), while the rows are
        // the filtered page. Reporting the filtered count as the total would understate
        // the run as soon as a status filter was applied.
        const byStatus = all.reduce((acc, c) => {
          acc[c.status] = (acc[c.status] ?? 0) + 1
          return acc
        }, {})
        const body = {
          __derived: 'recorded campaigns plus seeded fixtures for the admin list',
          [isGb ? 'campaigns' : 'sales']: rows,
          statsAll: { total: all.length, shown: rows.length, byStatus },
          stats: { total: all.length, shown: rows.length, byStatus },
        }
        console.log(`  [admin] ${pathname} -> ${rows.length}/${all.length} row(s)${wantStatus ? ` (status=${wantStatus})` : ''}`)
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(body))
        return
      }

      // The three option lists behind every product form. The client reads
      // `t.data.categories`, `r.data.tags`, `a.data.collections` — OBJECTS with a named
      // key, not bare arrays. Returning arrays meant `undefined || []` and every
      // dropdown rendered empty, including the category picker on New product.
      if (pathname === '/api/admin/categories' && req.method === 'GET') {
        sendJson(res, 200, { categories: adminCategories() })
        return
      }
      if (pathname === '/api/admin/tags' && req.method === 'GET') {
        const tags = [...new Set(catalogProducts.flatMap((p) => p.tags ?? []))]
          .filter((t) => typeof t === 'string' && t && !t.includes(':'))
          .sort()
          .map((name, i) => ({ id: `tag-${name}`, name, slug: name, productCount: catalogProducts.filter((p) => (p.tags ?? []).includes(name)).length }))
        sendJson(res, 200, { tags })
        return
      }
      if (pathname === '/api/admin/collections' && req.method === 'GET') {
        // No collection concept exists in the catalogue, so this is honestly empty —
        // but shaped correctly, so the form shows an empty list rather than breaking.
        sendJson(res, 200, { collections: [] })
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

/**
 * A request must never be able to end the process.
 *
 * An async handler that rejects is an UNHANDLED REJECTION in Node, and the default is
 * to exit — which is exactly what happened here: a fees request hit an Invalid Date,
 * Intl threw, and the server died mid-suite, so every later assertion failed for a
 * reason that had nothing to do with what it was testing. That is a far worse failure
 * mode than a 500, because it corrupts the diagnosis as well as the run.
 *
 * These are LAST-RESORT handlers, not a substitute for guarding inputs: they exist so
 * one bad record produces one 500 and a loud log line instead of a dead server.
 */
process.on('uncaughtException', (err) => {
  console.error('  [fatal-guard] uncaught exception (server kept alive):', err?.stack ?? err)
})
process.on('unhandledRejection', (err) => {
  console.error('  [fatal-guard] unhandled rejection (server kept alive):', err?.stack ?? err)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`unified server on http://127.0.0.1:${PORT}`)
  console.log(`  /            member client  (${existsSync(join(DIST,'index.html')) ? 'present' : 'MISSING'})`)
  console.log(`  /app/        landing clone  (${existsSync(join(DIST,'app','index.html')) ? 'present' : 'MISSING'})`)
  console.log(`  /api/*       ${existsSync(SAMPLES) ? 'recorded samples' : 'MISSING'}`)
})
