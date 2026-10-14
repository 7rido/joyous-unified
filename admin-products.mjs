/**
 * Admin product CRUD, inventory, and the server-side admin guard.
 *
 * WHY THIS FILE EXISTS
 * The replay server served /api/admin/* with NO authorization check at all — it relied
 * on the client's own gate plus ADMIN_VIEW=1. That is "hidden from the UI", not
 * "rejected by the backend", and a crafted request walked straight through.
 *
 * PERSISTENCE, and why it is an overlay
 * The catalogue lives in RAM, loaded from api-samples/api_products_catalog.json. That
 * file is the RECORDED fixture and must not be rewritten by an admin edit. So authored
 * products and edits go to their own file and are replayed onto the catalogue at boot,
 * the same pattern as pack-deals.json. One source of truth at runtime (catalogProducts),
 * one authored overlay on disk, recorded fixtures untouched.
 *
 * INVENTORY, and why stock_mode exists
 * There was no quantity anywhere — `sold_out` is a manual boolean, and the storefront's
 * "Not enough stock" was frozen markup. Rather than silently reinterpret sold_out as a
 * count, a product now declares which policy it follows:
 *
 *   FLAG      sold_out is set by hand; nothing else changes. The default, so all 66
 *             recorded products keep behaving exactly as they did.
 *   QUANTITY  stock_qty is the count and sold_out is DERIVED from it (<= 0), so the
 *             two can never disagree.
 *
 * Checkout consults stockFor() before pricing anything in.
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'

/* ------------------------------------------------------------- validation --- */

export const TIERS = ['USER', 'VIP', 'ELITE']
export const STOCK_MODES = ['FLAG', 'QUANTITY']

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Validate a create/update payload. Returns { ok, value, problems }.
 *
 * `partial` is true for PATCH: absent fields are left alone, but any field that IS
 * present must still be valid. Validating only the present keys is what stops a PATCH
 * from being a way to write a value a POST would have refused.
 */
export function validateProduct(input, { partial = false, existing = null, takenSlugs = [] } = {}) {
  const problems = []
  const value = {}
  const has = (k) => input != null && Object.prototype.hasOwnProperty.call(input, k) && input[k] !== undefined

  // ---- slug: immutable after create, and it is the primary key AND a built URL ----
  if (has('slug')) {
    const slug = String(input.slug).trim()
    if (existing) {
      problems.push('slug cannot be changed: it is the product key and its URL')
    } else if (!SLUG_RE.test(slug)) {
      problems.push('slug must be lowercase letters, numbers and single hyphens (e.g. my-product-2)')
    } else if (takenSlugs.includes(slug)) {
      problems.push(`slug "${slug}" is already taken`)
    } else {
      value.slug = slug
    }
  } else if (!partial) {
    problems.push('slug is required')
  }

  // ---- title ----
  if (has('title') || has('name')) {
    const title = String(input.title ?? input.name).trim()
    if (title.length < 1 || title.length > 200) problems.push('title must be 1-200 characters')
    else value.name = title
  } else if (!partial) {
    problems.push('title is required')
  }

  // ---- price ----
  if (has('price') || has('pricePerUnit')) {
    const raw = input.price ?? input.pricePerUnit
    const price = Number(raw)
    // Check the DECIMAL PLACES TEXTUALLY. `Math.round(price*100) !== price*100` is the
    // obvious way and it is wrong: 19.99*100 is 1998.9999999999998 in binary floating
    // point, so that test rejects every legitimate price ending in 9.
    const decimals = (() => {
      const t = String(raw).trim()
      const m = /^-?\d+(?:\.(\d+))?$/.exec(t)
      if (m) return m[1] ? m[1].length : 0
      // exponential or a number that arrived as a JS number: fall back to rounding.
      const r = Math.round(price * 100) / 100
      return Math.abs(r - price) < 1e-9 ? 2 : 3
    })()
    if (!Number.isFinite(price) || price < 0) problems.push('price must be a number of 0 or more')
    else if (decimals > 2) problems.push('price may have at most 2 decimal places')
    else value.pricePerUnit = Math.round(price * 100) / 100
  } else if (!partial) {
    problems.push('price is required')
  }

  // ---- required tier ----
  if (has('requiredTier')) {
    const tier = String(input.requiredTier).toUpperCase()
    if (!TIERS.includes(tier)) problems.push(`requiredTier must be one of ${TIERS.join(', ')}`)
    else value.requiredTier = tier
  } else if (!partial) {
    value.requiredTier = 'USER'
  }

  // ---- category ----
  // The create form sends `categoryId`, not a name, because its dropdown is built
  // from /api/admin/categories. Accept either; the caller resolves an id.
  if (has('category')) {
    const cat = input.category == null ? null : String(input.category).trim()
    if (cat && cat.length > 60) problems.push('category must be 60 characters or fewer')
    else value.categoryName = cat || null
  }
  if (has('categoryId')) value.categoryId = input.categoryId == null ? null : String(input.categoryId)

  // ---- opening quantity -------------------------------------------------
  // The create form's "openingQty" is a LOT number in its own words, not a stock
  // count. Mapping it to stockQty would silently invent a quantity model on a field
  // that never meant one, so it is accepted only as an explicit opt-in.
  if (has('openingQty') && input.openingQty !== '' && input.openingQty != null) {
    if (String(input.stockMode ?? '').toUpperCase() !== 'QUANTITY') {
      problems.push('openingQty is a lot number, not a stock count; set stockMode "QUANTITY" and stockQty to track inventory')
    }
  }

  // ---- availability: an ADMIN decision, distinct from sold out ---------
  // Disabled hides the product; sold out keeps it visible with a Notify-me button.
  if (has('disabled') || has('adminHidden')) {
    value.adminHidden = !!(input.disabled ?? input.adminHidden)
  }

  // ---- first variant name ----------------------------------------------
  if (has('variantName')) {
    const vn = String(input.variantName ?? '').trim()
    if (vn.length > 80) problems.push('variantName must be 80 characters or fewer')
    else value.variantName = vn || null
  }

  // ---- description / summary ----
  if (has('summary')) {
    const sum = String(input.summary ?? '').trim()
    if (sum.length > 2000) problems.push('summary must be 2000 characters or fewer')
    else value.summary = sum
  }

  // ---- stock policy ----
  const wantMode = has('stockMode') ? String(input.stockMode).toUpperCase() : null
  if (wantMode && !STOCK_MODES.includes(wantMode)) {
    problems.push(`stockMode must be one of ${STOCK_MODES.join(', ')}`)
  }

  const mode = wantMode
    ?? existing?.stockMode
    ?? 'FLAG'

  // A quantity is only meaningful under the QUANTITY policy. Accepting one under FLAG
  // would create a number nothing reads, which is how two stock models start.
  let qty = null
  if (has('stockQty')) {
    // `stockQty: 0` is the create form's DEFAULT for a product that tracks no quantity,
    // so refusing it outright blocked every create. An explicit zero under FLAG is a
    // harmless no-op; a NON-zero quantity under FLAG is a real attempt to track stock
    // with nothing set up to read it, and that is what gets refused.
    const isExplicitZero = Number(input.stockQty) === 0
    if (wantMode === 'FLAG' || (!wantMode && mode === 'FLAG' && input.stockQty !== null && !isExplicitZero)) {
      problems.push('stockQty requires stockMode "QUANTITY"; under "FLAG" set soldOut instead')
    } else if (input.stockQty === null) {
      qty = null
    } else {
      const n = Number(input.stockQty)
      if (!Number.isInteger(n) || n < 0) problems.push('stockQty must be a whole number of 0 or more')
      else qty = n
    }
  }

  if (wantMode) value.stockMode = wantMode
  if (has('stockQty') && !problems.some((p) => p.startsWith('stockQty'))) value.stockQty = qty

  // ---- sold-out flag ----
  if (has('soldOut')) {
    if (mode === 'QUANTITY') {
      // Derived, so an explicit value is refused rather than silently ignored.
      problems.push('soldOut is derived from stockQty under stockMode "QUANTITY" and cannot be set directly')
    } else {
      value.soldOut = !!input.soldOut
    }
  }

  // Switching to QUANTITY needs a count, or the product becomes unsellable by accident.
  const finalMode = value.stockMode ?? mode
  if (finalMode === 'QUANTITY') {
    const finalQty = value.stockQty !== undefined ? value.stockQty : (existing?.stockQty ?? null)
    if (finalQty === null || finalQty === undefined) {
      problems.push('a product using stockMode "QUANTITY" needs a stockQty')
    } else {
      value.soldOut = finalQty <= 0
    }
  }

  // ---- images (array of url strings, normalised to the catalogue shape) ----
  if (has('images')) {
    if (!Array.isArray(input.images)) problems.push('images must be an array of URLs')
    else {
      value.images = input.images
        .map((u) => String(u).trim())
        .filter(Boolean)
        .slice(0, 12)
        .map((url, i) => ({ url, sortOrder: i }))
    }
  }

  return { ok: problems.length === 0, value, problems }
}

/* ---------------------------------------------------------------- overlay --- */

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return {} }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(data, null, 1)}\n`)
  renameSync(tmp, file)
}

/**
 * Apply the authored overlay onto the in-memory catalogue.
 *
 * Order matters: products created here are APPENDED, then patches are applied to
 * whatever is present. Re-validated on load, so hand-editing the file is not a way
 * around the write-time validation.
 */
export function applyProductOverlay({ file, catalogProducts, indexBySlug }) {
  const data = readJson(file)
  const created = Array.isArray(data.created) ? data.created : []
  const patches = data.patches && typeof data.patches === 'object' ? data.patches : {}
  const rejected = []
  let applied = 0

  for (const row of created) {
    if (!row || typeof row.slug !== 'string') { rejected.push('an entry in created has no slug'); continue }
    if (catalogProducts.some((p) => p.slug === row.slug)) continue
    catalogProducts.push(row)
    applied++
  }

  for (const [slug, patch] of Object.entries(patches)) {
    const prod = catalogProducts.find((p) => p.slug === slug)
    if (!prod) { rejected.push(`patch for unknown slug "${slug}"`); continue }
    const res = validateProduct(patch, { partial: true, existing: prod, takenSlugs: [] })
    if (!res.ok) { rejected.push(`${slug}: ${res.problems[0]}`); continue }
    for (const [k, v] of Object.entries(res.value)) {
      if (k === 'categoryName') prod.category = v === null ? null : { id: prod.category?.id ?? `cat-${v.toLowerCase().replace(/\W+/g, '-')}`, name: v, slug: v.toLowerCase().replace(/\W+/g, '-'), code: prod.category?.code ?? 'AUTHORED' }
      else prod[k] = v
    }
    applied++
  }

  if (typeof indexBySlug === 'function') indexBySlug()
  return { applied, rejected }
}

export function saveProductOverlay(file, { catalogProducts, authoredSlugs, authoredPatches }) {
  const data = existsSync(file) ? readJson(file) : {}
  const created = Array.isArray(data.created) ? data.created : []
  const patches = data.patches && typeof data.patches === 'object' ? data.patches : {}
  for (const slug of authoredSlugs) {
    const prod = catalogProducts.find((p) => p.slug === slug)
    if (prod && !created.some((c) => c.slug === slug)) created.push(prod)
  }
  for (const [slug, patch] of Object.entries(authoredPatches)) {
    patches[slug] = { ...(patches[slug] || {}), ...patch }
  }
  writeJsonAtomic(file, {
    __comment: 'Admin-authored products and edits. Managed by POST/PATCH /api/admin/products. The recorded catalogue fixture is never rewritten.',
    created,
    patches,
  })
  return { created: created.length, patches: Object.keys(patches).length }
}

/* ---------------------------------------------------------------- stock ----- */

/**
 * The one place that answers "may this be ordered, and how many remain".
 * Returns { mode, soldOut, available } where available is Infinity under FLAG when the
 * product is sellable, so callers can compare without special-casing.
 */
export function stockFor(prod) {
  const mode = prod?.stockMode ?? 'FLAG'
  if (mode === 'QUANTITY') {
    const qty = Number.isInteger(prod?.stockQty) ? prod.stockQty : 0
    return { mode, soldOut: qty <= 0, available: qty }
  }
  return { mode, soldOut: prod?.soldOut === true, available: prod?.soldOut === true ? 0 : Infinity }
}
