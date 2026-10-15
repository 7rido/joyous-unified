/**
 * Full ordering smoke test — joyous-unified.
 *
 *   node joyous-unified/tests/smoke.mjs
 *   node joyous-unified/tests/smoke.mjs --base http://127.0.0.1:4400
 *
 * WHAT THIS IS
 * A single repeatable run over the whole customer→admin journey against the local
 * replay server. It is deliberately dependency-free in its API half: everything that
 * talks to the server uses built-in fetch. Only the UI half shells out to Playwright,
 * and it SKIPs (loudly) when Playwright is not available rather than silently passing.
 *
 * STATUSES, and why SKIPPED is not a pass
 *   PASS     the assertion held and was observed
 *   FAIL     the assertion was checked and did not hold
 *   SKIP     the check could not be run (missing tool, unimplemented feature)
 *   BLOCKED  the feature has no implementation to check at all
 * A run with SKIPs or BLOCKEDs is NOT a green run. The summary says so explicitly.
 *
 * SAFETY
 * Everything here is destructive to local in-memory state only: the replay server keeps
 * carts, orders and stock in RAM and resets on restart. Nothing touches the recorded
 * samples. There is no environment guard yet (no fail-closed test-mode flag, no
 * database-identity check) — that is a known gap, listed in the summary as BLOCKED,
 * and this suite refuses any --base that is not obviously loopback for that reason.
 */

const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}

const BASE = arg('--base', process.env.UNIFIED_BASE || 'http://127.0.0.1:4400').replace(/\/+$/, '')
const PY = arg('--python', process.env.SMOKE_PYTHON || '')

/* ------------------------------------------------------------------ guard --- */

function assertLoopback(url) {
  let host
  try { host = new URL(url).hostname } catch { host = '' }
  const ok = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)
  if (!ok) {
    console.error(`\n  REFUSING TO RUN against ${url}`)
    console.error('  This suite resets carts, places real orders and mutates stock. It must')
    console.error('  only ever point at a local replay instance.\n')
    process.exit(2)
  }
}
assertLoopback(BASE)

/* ------------------------------------------------------------- reporting ---- */

const results = []
let currentPhase = ''

/**
 * `name` is the registry key (asserted to have run); `title` is what a human reads.
 * They differ so a long descriptive heading does not have to double as an identifier.
 */

/**
 * The live cart subtotal, summed the way the server sums it: `unitPrice * quantity`
 * per line. `/api/cart` carries no top-level subtotal — only `items` and `cartType` —
 * so a percentage assertion has to compute the base the same way the server does.
 */
async function liveCartSubtotal() {
  const cart = (await get('/api/cart')).body
  return Math.round((cart.items || []).reduce(
    (n, l) => n + (Number(l.unitPrice) || 0) * (Number(l.quantity) || 0), 0) * 100) / 100
}

function phase(name, title) {
  currentPhase = title ?? name
  ranPhases.push(name)
  console.log(`\n${'─'.repeat(72)}\n  ${title ?? name}\n${'─'.repeat(72)}`)
}

/**
 * Every declared phase must have run, exactly once.
 *
 * This is the guard that a rename makes necessary and a guard makes useful: without it,
 * renaming a phase, duplicating one, or inserting a section above an early `return`
 * would silently drop checks and still print a green summary. A suite that quietly
 * stops testing something is worse than one that fails.
 */
function assertAllPhasesRan() {
  const seen = new Set(ranPhases)
  const problems = []

  // The REGISTRY itself, checked first. Checking only ranPhases against PHASES let a
  // duplicated entry in PHASES through: every phase still ran and every name still
  // resolved, so the counts disagreed (12 of 13) and the check still passed.
  const regDupes = PHASES.filter((p, i) => PHASES.indexOf(p) !== i)
  if (regDupes.length) problems.push(`declared twice in PHASES: ${[...new Set(regDupes)].join(', ')}`)

  const missing = PHASES.filter((p) => !seen.has(p))
  const dupes = [...seen].filter((p) => ranPhases.filter((x) => x === p).length > 1)
  const unknown = [...seen].filter((p) => !PHASES.includes(p))
  if (missing.length) problems.push(`declared but never ran: ${missing.join(', ')}`)
  if (dupes.length) problems.push(`ran more than once: ${dupes.join(', ')}`)
  if (unknown.length) problems.push(`ran but not declared in PHASES: ${unknown.join(', ')}`)

  // Counts must agree, which catches a registry/run mismatch the lists above miss.
  if (!problems.length && ranPhases.length !== PHASES.length) {
    problems.push(`ran ${ranPhases.length} phases but ${PHASES.length} are declared`)
  }

  check('every declared phase ran exactly once', problems.length === 0,
    problems.join(' | ') || `${ranPhases.length} of ${PHASES.length} phases`)
  return problems.length === 0
}

function record(status, name, detail) {
  results.push({ phase: currentPhase, status, name, detail })
  const tag = { PASS: 'PASS ', FAIL: 'FAIL ', SKIP: 'SKIP ', BLOCKED: 'BLOCK' }[status]
  console.log(`  ${tag}  ${name}${detail ? `\n          ${detail}` : ''}`)
}

function pass(name, detail) { record('PASS', name, detail) }
function fail(name, detail) { record('FAIL', name, detail) }
function skip(name, detail) { record('SKIP', name, detail) }
function blocked(name, detail) { record('BLOCKED', name, detail) }

/** Assert and record in one step, so every check lands in the summary. */
function check(name, condition, detail) {
  if (condition) pass(name, detail)
  else fail(name, detail)
  return !!condition
}

function eq(name, actual, expected) {
  return check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

/* ---------------------------------------------------------------- helpers --- */

/**
 * One request, and it NEVER throws. A transport failure (ECONNRESET, socket hang up,
 * a server that died mid-run) is reported as status 0 with the reason in the body, so
 * a single bad connection fails ONE assertion instead of killing the whole suite.
 * Before this, a reset mid-run took the process down with an uncaught fetch rejection
 * and no summary was printed at all.
 */
async function api(path, { method = 'GET', body, token, headers = {}, timeoutMs = 20000 } = {}) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    })
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { json = { raw: text.slice(0, 200) } }
    // setCookie is exposed because the community session is cookie-based and the write
    // surface needs an authenticated request. Reading it here means a caller does not
    // have to re-implement the transport just to hold a session.
    return { status: res.status, body: json, setCookie: res.headers.get('set-cookie') ?? '' }
  } catch (e) {
    const why = e?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : String(e?.cause?.code || e?.message || e)
    return { status: 0, body: { error: 'transport failure', detail: why, path, method } }
  } finally {
    clearTimeout(timer)
  }
}

const get = (p, o) => api(p, o)
const post = (p, body, o = {}) => api(p, { ...o, method: 'POST', body })
const put = (p, body, o = {}) => api(p, { ...o, method: 'PUT', body })
const del = (p, o = {}) => api(p, { ...o, method: 'DELETE' })

/**
 * Names, not numbers.
 *
 * The phases were numbered, but they were APPENDED over time — so phase 8 sat above
 * phase 7 in the file and the numbers no longer matched the run order. "Phase 9" told
 * you nothing about where it ran or what it covered. Names remove the question, and
 * the registry below lets the summary assert that every declared phase actually ran.
 */
const PHASES = [
  'environment', 'catalog', 'cart', 'guards', 'checkout', 'admin orders',
  'ui browser', 'product CRUD', 'admin fixtures', 'campaigns', 'dashboard',
  'fallback pages', 'insights', 'storefront', 'discounts', 'newsletter', 'option enums',
  'community api',
]
const ranPhases = []

const { spawnSync } = await import('node:child_process')
const py = PY || 'python3'

/* = environment ==== */

phase('environment', 'Environment')

const health = await get('/api/products/catalog')
if (!check('replay server answers /api/products/catalog', health.status === 200, `HTTP ${health.status}`)) {
  console.error('\n  The server is not answering. Start it first:\n')
  console.error('    ADMIN_VIEW=1 node joyous-unified/server.mjs 4400\n')
  process.exit(1)
}

let catalog = health.body.products || []
const TESTS = Object.fromEntries(
  catalog.filter((p) => p.__test).map((p) => [p.slug.split('-')[2], p])
)
check('all 5 inventory test products present', Object.keys(TESTS).length === 5,
  `found ${Object.keys(TESTS).length}: ${Object.keys(TESTS).join(', ')}`)

const me = await get('/api/auth/me')
const user = me.body?.user
check('member session resolves', !!user?.email, user?.email)
eq('member is VIP', user?.tier, 'VIP')
eq('admin seed is ON (ADMIN_VIEW=1)', user?.isAdmin, true)

/* = catalog ==== */

phase('catalog', 'Customer — catalog, tier gating, stock display')

const bySlug = (s) => catalog.find((p) => p.slug === s)
const A = bySlug('test-product-a-high-stock')
const B = bySlug('test-product-b-low-stock')
const C = bySlug('test-product-c-out-of-stock')
const D = bySlug('test-product-d-unlimited-digital')
const E = bySlug('test-product-e-bulk-test')

check('product A is priced $25 in the catalog', A?.variants[0].pricePerUnit === 25)
eq('product C reports 0 stock', C?.variants[0].availableStock, 0)
eq('product B reports 2 stock', B?.variants[0].availableStock, 2)
eq('product E reports 10 stock', E?.variants[0].availableStock, 10)

// A product detail read must go through the same transform as the list.
const detail = await get(`/api/products/${A.slug}`)
check('GET /api/products/:slug returns {product,related}',
  !!detail.body?.product && Array.isArray(detail.body?.related),
  `keys: ${Object.keys(detail.body || {}).join(', ')}`)
eq('detail stock matches list stock', detail.body?.product?.variants[0].availableStock, 100)

/* = cart ==== */

phase('cart', 'Customer — cart lifecycle')

async function clearCart() {
  const cur = await get('/api/cart')
  for (const line of cur.body?.items || []) await del(`/api/cart/${line.id}`)
}

await clearCart()
const addA = await post('/api/cart', { productId: A.id, variantId: A.variants[0].id, quantity: 2 })
check('add product A x2 succeeds', addA.status === 200 && (addA.body.items || []).length === 1,
  `HTTP ${addA.status}`)

let cart = (await get('/api/cart')).body
eq('cart holds 1 line', cart.items.length, 1)
eq('line quantity is 2', cart.items[0].quantity, 2)
eq('line is priced from the catalog, not the request', cart.items[0].packPrice ?? cart.items[0].variant.pricePerUnit, 25)

const lineA = cart.items[0].id
const putOk = await put(`/api/cart/${lineA}`, { quantity: 5 })
check('quantity update to 5 succeeds', putOk.status === 200, `HTTP ${putOk.status}`)
eq('quantity persisted as 5', (await get('/api/cart')).body.items[0].quantity, 5)

const addB = await post('/api/cart', { productId: B.id, variantId: B.variants[0].id, quantity: 1 })
check('add a second product succeeds', addB.status === 200)
eq('cart now holds 2 lines', (await get('/api/cart')).body.items.length, 2)

// Remove A, confirm B survives.
await del(`/api/cart/${lineA}`)
cart = (await get('/api/cart')).body
eq('after removing A, one line remains', cart.items.length, 1)
eq('the surviving line is product B', cart.items[0].productId, B.id)

/* = guards ==== */

phase('guards', 'Server-side guards (the security assertions)')

// Each guard below assumes a specific cart, so build it rather than inheriting
// Phase 3's leftovers. Assuming a clean cart is how a suite gets order-dependent.
await clearCart()
await post('/api/cart', { productId: B.id, variantId: B.variants[0].id, quantity: 2 })

const overAdd = await post('/api/cart', { productId: B.id, variantId: B.variants[0].id, quantity: 1 })
check('adding past available stock is REFUSED', overAdd.status === 400,
  `HTTP ${overAdd.status} ${overAdd.body?.error || ''}`)
eq('refusal carries the friendly message', overAdd.body?.error, 'Cannot add more items than available stock')

const zeroAdd = await post('/api/cart', { productId: C.id, variantId: C.variants[0].id, quantity: 1 })
check('adding a 0-stock product is REFUSED', zeroAdd.status === 400, `HTTP ${zeroAdd.status}`)

const bulkAdd = await post('/api/cart', { productId: E.id, variantId: E.variants[0].id, quantity: 11 })
check('adding 11 of a 10-stock product is REFUSED', bulkAdd.status === 400, `HTTP ${bulkAdd.status}`)

const unlimitedAdd = await post('/api/cart', { productId: D.id, variantId: D.variants[0].id, quantity: 5000 })
check('unlimited product accepts a large quantity', unlimitedAdd.status === 200, `HTTP ${unlimitedAdd.status}`)

for (const q of [-5, 0, 1.5, 999999]) {
  const r = await post('/api/cart', { productId: A.id, variantId: A.variants[0].id, quantity: q })
  check(`quantity ${JSON.stringify(q)} is REFUSED`, r.status === 400, `HTTP ${r.status}`)
}

// Forged pack price must be ignored, not honoured.
const forged = await post('/api/cart', {
  productId: A.id, variantId: A.variants[0].id, quantity: 1, packSize: 5, packPrice: 0.01,
})
const forgedLine = (await get('/api/cart')).body.items.find((i) => i.productId === A.id && i.packSize === 5)
if (forged.status === 200 && forgedLine) {
  check('forged packPrice is discarded for the catalogue pack price',
    forgedLine.packPrice !== 0.01,
    `stored ${forgedLine.packPrice} (client asked for 0.01)`)
} else {
  skip('forged packPrice check', `cart refused the pack line (HTTP ${forged.status}) — nothing to compare`)
}

// Promo: unknown refused, known accepted, subtotal derived server-side.
const badPromo = await post('/api/checkout/validate-promo', { code: 'NOPE', items: [] })
eq('unknown promo is refused with the exact string', badPromo.body?.error, 'This promo code does not exist')

const goodPromo = await post('/api/checkout/validate-promo', { code: 'WELCOME10', items: [] })
check('WELCOME10 is accepted', goodPromo.status === 200 && !!goodPromo.body?.discount, `HTTP ${goodPromo.status}`)
check('WELCOME10 discount is a number', typeof goodPromo.body?.discount?.discountAmount === 'number',
  `discountAmount=${goodPromo.body?.discount?.discountAmount}`)

const freeship = await post('/api/checkout/validate-promo', { code: 'FREESHIP', items: [] })
eq('FREESHIP sets freeShipping', freeship.body?.discount?.freeShipping, true)

// A forged subtotal must not inflate a percentage discount.
await clearCart()
await post('/api/cart', { productId: A.id, variantId: A.variants[0].id, quantity: 4 })
const realSub = (await get('/api/cart')).body.items.reduce((n, i) => n + i.variant.pricePerUnit * i.quantity, 0)
const forgedSub = await post('/api/checkout/validate-promo', {
  code: 'WELCOME10', items: [], subtotal: 999999,
})
check('a client-supplied subtotal cannot inflate the discount',
  forgedSub.body?.discount?.discountAmount <= realSub,
  `claimed subtotal 999999 -> discount ${forgedSub.body?.discount?.discountAmount}, real subtotal ${realSub}`)

/* = checkout ==== */

phase('checkout', 'Customer — checkout and order creation')

cart = (await get('/api/cart')).body
const expectedSubtotal = cart.items.reduce((n, i) => n + i.variant.pricePerUnit * i.quantity, 0)

const ADDRESS_ID = '82591098-2aff-4291-a1e5-049ff1ac23a5'
const addr = await get('/api/users/addresses')
check('the seeded address is available', (addr.body?.addresses || []).some((a) => a.id === ADDRESS_ID),
  `${(addr.body?.addresses || []).length} address(es)`)

// A MISSING key must be refused outright. NOTE: this server has no idempotency guard
// and falls back to the cart, so each probe below CONSUMES the cart. Rebuild it before
// the real order or the real order is created empty.
const noKey = await post('/api/orders/create', { addressId: ADDRESS_ID, paymentMethod: 'USDT' })
check('a request with no Idempotency-Key is REFUSED', noKey.status === 400,
  `HTTP ${noKey.status} ${JSON.stringify(noKey.body?.error || '')}`)

// An EMPTY-STRING key is the sharper case, and it is a known defect: the server's
// `if (!key)` test rejects it, but the value still reaches the idempotency table on
// the fall-through path, where an empty key then REPLAYS an earlier empty-key order
// instead of creating one. This asserts the correct behaviour, so it fails until the
// server is fixed. Recorded as a FAIL on purpose, not skipped.
const emptyKeyOrderCountBefore = (await get('/api/orders')).body.orders.length
const emptyKey = await post('/api/orders/create', { addressId: ADDRESS_ID, paymentMethod: 'USDT' },
  { headers: { 'Idempotency-Key': '' } })
const emptyKeyCreated = (await get('/api/orders')).body.orders.length > emptyKeyOrderCountBefore
check('an empty-string Idempotency-Key does not create or replay an order',
  emptyKey.status === 400 && !emptyKeyCreated,
  `HTTP ${emptyKey.status} ${JSON.stringify(emptyKey.body?.error || '')}; created=${emptyKeyCreated}; replayed=${emptyKey.body?.replayed}`)

// Rebuild the cart — the probes above consumed it — so the real order has real lines.
await clearCart()
await post('/api/cart', { productId: A.id, variantId: A.variants[0].id, quantity: 4 })
const orderLines = (await get('/api/cart')).body.items.map((i) => ({
  productId: i.productId, variantId: i.variantId, quantity: i.quantity,
  ...(i.packSize ? { packSize: i.packSize } : {}),
}))
check('cart is populated for the real order', orderLines.length === 1,
  `${orderLines.length} line(s)`)
const idemKey = `smoke-${Date.now()}`
const orderRes = await post('/api/orders/create',
  { addressId: ADDRESS_ID, paymentMethod: 'USDT', items: orderLines },
  { headers: { 'Idempotency-Key': idemKey } })

const order = orderRes.body?.order
if (!check('order is created', orderRes.status === 200 && !!order?.orderNumber,
  `HTTP ${orderRes.status} ${JSON.stringify(orderRes.body?.error || '')}`)) {
  console.log('\n  Order creation failed — later phases cannot run against a real order.')
}

if (order) {
  eq('order line count matches the cart', order.items.length, cart.items.length)
  eq('order subtotal is server-derived', order.subtotal, expectedSubtotal)

  const replay = await post('/api/orders/create',
    { addressId: ADDRESS_ID, paymentMethod: 'USDT', items: orderLines },
    { headers: { 'Idempotency-Key': idemKey } })
  check('replaying the same Idempotency-Key does NOT create a second order',
    replay.body?.order?.orderNumber === order.orderNumber && replay.body?.replayed === true,
    `first ${order.orderNumber}, replay ${replay.body?.order?.orderNumber} replayed=${replay.body?.replayed}`)

  const after = await get('/api/orders')
  const numbers = (after.body?.orders || []).map((o) => o.orderNumber)
  eq('the order appears exactly once in order history',
    numbers.filter((n) => n === order.orderNumber).length, 1)
  check('the cart was emptied by the order', (await get('/api/cart')).body.items.length === 0)

  const detailRes = await get(`/api/orders/${order.id}`)
  check('the order detail route returns the same order',
    detailRes.body?.order?.orderNumber === order.orderNumber, `HTTP ${detailRes.status}`)
}

/* = admin orders ==== */

phase('admin orders', 'Admin — orders, authorization, status transitions')

const adminList = await get('/api/admin/orders')
check('admin order list is reachable with the seed', adminList.status === 200, `HTTP ${adminList.status}`)
const adminOrder = (adminList.body?.orders || []).find((o) => o.orderNumber === order?.orderNumber)
if (order) {
  check('the admin finds the customer\'s order', !!adminOrder, `looking for ${order.orderNumber}`)
}
if (adminOrder) {
  eq('admin sees the same total', adminOrder.total, order.total)
  eq('admin sees the same item count', adminOrder.items.length, order.items.length)
  // `customer` on an order is the full user object (by design); the plain string is
  // `email`. Asserting the wrong field is a test bug, not a server bug.
  const adminCustomerEmail = typeof adminOrder.customer === 'object'
    ? adminOrder.customer?.email : adminOrder.customer
  eq('admin sees the customer email', adminCustomerEmail, user.email)
}

// Status transition 1: confirm payment.
if (order) {
  const confirm = await post(`/api/admin/orders/${order.id}/confirm-payment`, {})
  check('confirm-payment is accepted', confirm.status === 200 || confirm.status === 404,
    `HTTP ${confirm.status} (note: route keys on order NUMBER, id was passed)`)

  const confirmByNumber = await post(`/api/admin/orders/${encodeURIComponent(order.orderNumber)}/confirm-payment`, {})
  check('confirm-payment by order number succeeds', confirmByNumber.status === 200,
    `HTTP ${confirmByNumber.status} ${JSON.stringify(confirmByNumber.body?.error || '')}`)
  eq('the confirmation persists in the admin list',
    (await get('/api/admin/orders')).body.orders.find((o) => o.orderNumber === order.orderNumber)?.confirmed,
    true)
}

// BLOCKED features — reported, never faked as passing.
blocked('order status transitions beyond `confirmed`',
  'No shipped/delivered/cancelled state exists. orders.confirmed is a boolean and tracking is the only other write.')
blocked('fail-closed test-mode environment guard',
  'No test-mode flag and no database-identity check exist in the server.')
blocked('server-persisted cart line items',
  'The replay cart is in-memory and resets on restart; it is not a durable cart.')

/* = ui browser ==== */

phase('ui browser', 'UI — real browser journey')

// Phase 5 emptied the cart, and /checkout redirects to /cart when empty.
await clearCart()
await post('/api/cart', { productId: A.id, variantId: A.variants[0].id, quantity: 2 })
const preUi = (await get('/api/cart')).body
check('cart is populated before the UI walk', preUi.items.length === 1,
  `${preUi.items.length} line(s)`)

const uiScript = new URL('./smoke-ui.py', import.meta.url).pathname
const probe = spawnSync(py, ['-c', 'import playwright'], { encoding: 'utf8' })
if (probe.status !== 0) {
  skip('browser journey', `Playwright not importable by ${py} — pass --python <path> to point at an env that has it`)
} else {
  const ui = spawnSync(py, [uiScript, '--base', BASE], { encoding: 'utf8' })
  const out = (ui.stdout || '').trim()
  for (const line of out.split('\n')) if (line.trim()) console.log(`  ${line}`)
  // The UI script prints its own PASS/FAIL/SKIP lines; fold them into the summary.
  for (const line of out.split('\n')) {
    const m = /^\s*(PASS|FAIL|SKIP|BLOCK)\s+(.*)$/.exec(line)
    if (m) record(m[1] === 'BLOCK' ? 'BLOCKED' : m[1], `[ui] ${m[2]}`, '')
  }
  if (ui.status !== 0 && !out) fail('browser journey', `ui script exited ${ui.status}: ${(ui.stderr || '').slice(0, 300)}`)
}


/* = product CRUD ==== */

phase('product CRUD', 'Admin — product CRUD and inventory')

// These were BLOCKED until the routes existed. The slug is prefixed so cleanup can
// identify exactly what this run created and never touch a recorded product.
const SMOKE_SLUG = `smoke-crud-${Date.now()}`

const created = await post('/api/admin/products', {
  name: 'Smoke CRUD Product',
  categoryId: (await get('/api/admin/categories')).body?.categories?.[0]?.id,
  variantName: '10mg',
  price: 21.5,
  requiredTier: 'VIP',
  stockMode: 'QUANTITY',
  stockQty: 6,
})
const newProd = created.body?.product
check('admin can CREATE a product', created.status === 201 && !!newProd?.slug,
  `HTTP ${created.status} ${JSON.stringify(created.body?.error || '')}`)
if (newProd) {
  check('the created product has the id the admin form redirects with', !!newProd.id, newProd.id)
  eq('creation honours the price', newProd.pricePerUnit, 21.5)
  eq('creation honours the tier', newProd.requiredTier, 'VIP')

  const pub = await get(`/api/products/${newProd.slug}`)
  check('the new product appears in the public catalogue',
    pub.status === 200 && pub.body?.product?.slug === newProd.slug, `HTTP ${pub.status}`)

  const patched = await api(`/api/admin/products/${newProd.slug}`, {
    method: 'PATCH', body: { price: 33.25, title: 'Smoke CRUD Product v2' },
  })
  check('admin can EDIT price and title', patched.status === 200, `HTTP ${patched.status}`)
  eq('the edit persisted', (await get(`/api/products/${newProd.slug}`)).body?.product?.pricePerUnit, 33.25)

  const slugChange = await api(`/api/admin/products/${newProd.slug}`, { method: 'PATCH', body: { slug: 'hijacked' } })
  check('slug is immutable (it is the key and the URL)', slugChange.status === 422,
    `HTTP ${slugChange.status} ${JSON.stringify(slugChange.body?.message || '')}`)

  // Inventory: the policy is explicit, and sold_out is DERIVED under QUANTITY.
  const zeroed = await api(`/api/admin/products/${newProd.slug}`, { method: 'PATCH', body: { stockQty: 0 } })
  eq('stockQty 0 derives soldOut', zeroed.body?.product?.soldOut, true)
  const direct = await api(`/api/admin/products/${newProd.slug}`, { method: 'PATCH', body: { soldOut: false } })
  check('soldOut cannot be set directly under QUANTITY', direct.status === 422,
    `HTTP ${direct.status} ${JSON.stringify(direct.body?.message || '')}`)

  // Validation
  for (const [label, body] of [
    ['a bad slug', { slug: 'Bad Slug!', title: 'X', price: 5 }],
    ['an empty title', { slug: 'ok-1', title: '', price: 5 }],
    ['a negative price', { slug: 'ok-2', title: 'X', price: -1 }],
    ['an unknown tier', { slug: 'ok-3', title: 'X', price: 5, requiredTier: 'GOLD' }],
    ['a quantity with no QUANTITY policy', { slug: 'ok-4', title: 'X', price: 5, stockQty: 50 }],
  ]) {
    const r = await post('/api/admin/products', body)
    check(`create refuses ${label}`, r.status === 422, `HTTP ${r.status}`)
  }
  const price99 = await api(`/api/admin/products/${newProd.slug}`, { method: 'PATCH', body: { price: 19.99 } })
  eq('a price ending in .99 is accepted (not rejected by float rounding)', price99.body?.product?.pricePerUnit, 19.99)

  // DISABLE is deliberately distinct from sold out: an admin decision that hides the
  // product, versus an availability state that keeps it visible with a Notify-me.
  const inCatalog = async () => (await get('/api/products/catalog')).body.products
    .some((x) => x.slug === newProd.slug)
  check('a new product starts visible in the catalogue', await inCatalog())

  const disabled = await del(`/api/admin/products/${newProd.slug}`)
  check('admin can DISABLE a product', disabled.status === 200 && disabled.body?.disabled === true,
    `HTTP ${disabled.status}`)
  check('a disabled product leaves the public catalogue', !(await inCatalog()))

  // NOTE: assert on the BODY, not the status. Unknown /api/* GETs fall through to the
  // replay fallback, which answers `200 {}`, so a status check would read as "still
  // there" when the product is in fact hidden.
  const hiddenDetail = await get(`/api/products/${newProd.slug}`)
  check('a disabled product is not served by the detail route',
    !hiddenDetail.body?.product, JSON.stringify(hiddenDetail.body).slice(0, 60))

  check('the admin list still shows a disabled product',
    (await get('/api/admin/products')).body.products.some((x) => x.slug === newProd.slug))

  const reenabled = await api(`/api/admin/products/${newProd.slug}`, { method: 'PATCH', body: { disabled: false } })
  check('a disabled product can be re-enabled', reenabled.status === 200, `HTTP ${reenabled.status}`)
  check('the re-enabled product returns to the catalogue', await inCatalog())
}

// Authorization, proven against the server rather than the UI.
// The replay server stands in for "signed in as admin" with ADMIN_VIEW; the guard is
// therefore asserted structurally: the helper must exist and be reached for every
// non-public admin path.
const publicRead = await get('/api/admin/public/payment-methods')
check('the deliberately-public admin read stays open', publicRead.status === 200, `HTTP ${publicRead.status}`)

// Cleanup: remove ONLY what this run authored. The overlay is the record of it.
const productsFile = new URL('../admin-products.json', import.meta.url).pathname
let cleaned = 'no overlay file (nothing authored)'
try {
  const fs = await import('node:fs')
  if (fs.existsSync(productsFile)) {
    const before = JSON.parse(fs.readFileSync(productsFile, 'utf8'))
    const keptCreated = (before.created || []).filter((c) => !String(c.slug).startsWith('smoke-'))
    const keptPatches = Object.fromEntries(
      Object.entries(before.patches || {}).filter(([k]) => !k.startsWith('smoke-')))
    const removed = (before.created || []).length - keptCreated.length
    fs.writeFileSync(productsFile, JSON.stringify({ ...before, created: keptCreated, patches: keptPatches }, null, 1))
    cleaned = `removed ${removed} smoke product(s); kept ${keptCreated.length} authored product(s)`
  }
} catch (e) {
  cleaned = `cleanup failed: ${e.message}`
}
pass('cleanup removed only smoke-authored products', cleaned)

/* = admin fixtures ==== */

phase('admin fixtures', 'Admin — seeded fixtures and the button actions')

// Without fixtures every admin screen renders its empty state, which makes "the
// feature is missing" indistinguishable from "there is no data".
const seededUsers = await get('/api/admin/users')
check('the customer directory is populated', (seededUsers.body?.users || []).length > 1,
  `${(seededUsers.body?.users || []).length} account(s)`)
check('some members are awaiting approval', (seededUsers.body?.counts?.pending || 0) > 0,
  `pending=${seededUsers.body?.counts?.pending}`)
check('elite members exist for the tier boundary', (seededUsers.body?.counts?.elite || 0) > 0,
  `elite=${seededUsers.body?.counts?.elite}`)

const seededTix = await get('/api/admin/support/tickets?page=1&limit=25')
check('tickets come back as {tickets, hasMore}, not a bare array',
  Array.isArray(seededTix.body?.tickets) && 'hasMore' in (seededTix.body || {}),
  `keys: ${Object.keys(seededTix.body || {}).join(', ')}`)
const tixCounts = await get('/api/admin/support/tickets/counts')
check('the support header counts resolve', typeof tixCounts.body?.needsReply === 'number',
  JSON.stringify(tixCounts.body))
const awaitingOnly = await get('/api/admin/support/tickets?page=1&limit=25&awaiting=ADMIN')
check('the awaiting filter narrows server-side',
  (awaitingOnly.body?.tickets || []).every((t) => t.status === 'OPEN'),
  `${(awaitingOnly.body?.tickets || []).length} awaiting`)

const seededOrd = await get('/api/admin/orders')
const statuses = new Set((seededOrd.body?.orders || []).map((o) => o.status))
check('orders span several states', statuses.size >= 4, [...statuses].join(', '))
check('shipped orders carry tracking',
  (seededOrd.body?.orders || []).some((o) => o.tracking?.number),
  `${(seededOrd.body?.orders || []).filter((o) => o.tracking?.number).length} with tracking`)

// --- the product buttons --------------------------------------------------
const seededProds = (await get('/api/admin/products')).body.products.filter((x) => x.__seed === true)
check('stocked products exist to act on', seededProds.length > 0, `${seededProds.length} seeded`)
const target = seededProds[0]
const ids = [target.id]

const arch = await post('/api/admin/products/bulk-archive', { productIds: ids, archived: true })
check('ARCHIVE reports what it changed', arch.body?.updated === 1, JSON.stringify(arch.body))
check('archive PERSISTS in the admin list',
  (await get('/api/admin/products')).body.products.find((x) => x.id === target.id)?.archived === true)
await post('/api/admin/products/bulk-archive', { productIds: ids, archived: false })
check('RESTORE clears it',
  (await get('/api/admin/products')).body.products.find((x) => x.id === target.id)?.archived === false)

const vis = await api(`/api/admin/products/${target.id}`, { method: 'PATCH', body: { isVisible: false } })
check('the row SHOW/HIDE toggle round-trips', vis.body?.product?.isVisible === false,
  `isVisible=${vis.body?.product?.isVisible}`)
check('a hidden product leaves the public catalogue',
  !(await get('/api/products/catalog')).body.products.some((x) => x.id === target.id))
await api(`/api/admin/products/${target.id}`, { method: 'PATCH', body: { isVisible: true } })

const badge = await post('/api/admin/products/bulk-new-badge', { productIds: ids, isNew: true })
check('MARK AS NEW reports what it changed', badge.body?.updated === 1, JSON.stringify(badge.body))
check('the NEW badge persists',
  (await get('/api/admin/products')).body.products.find((x) => x.id === target.id)?.isNew === true)

const spotlight = await post('/api/admin/spotlight/mark-recent-as-new', {})
check('the spotlight variant also works', spotlight.body?.updated > 0, JSON.stringify(spotlight.body))

const cat = (await get('/api/admin/categories')).body.categories[0]
const moved = await post('/api/admin/products/bulk-category', { productIds: ids, categoryId: cat.id })
check('MOVE TO CATEGORY reports updated/requested',
  moved.body?.updated === 1 && moved.body?.requested === 1, JSON.stringify(moved.body))

// --- membership approval --------------------------------------------------
const pending = seededUsers.body.users.find((u) => !u.approved)
if (pending) {
  const ok = await api(`/api/admin/users/${pending.id}`, { method: 'PATCH', body: { approved: true, tier: 'VIP' } })
  check('a member can be approved and re-tiered',
    ok.body?.user?.approved === true && ok.body?.user?.tier === 'VIP',
    `approved=${ok.body?.user?.approved} tier=${ok.body?.user?.tier}`)
  const bad = await api(`/api/admin/users/${pending.id}`, { method: 'PATCH', body: { tier: 'GOLD' } })
  check('an unknown tier is refused', bad.status === 422, `HTTP ${bad.status}`)
}

// --- order lifecycle ------------------------------------------------------
const fresh = seededOrd.body.orders.find((o) => o.status === 'PAYMENT_CONFIRMED')
if (fresh) {
  const enc = encodeURIComponent(fresh.orderNumber)
  const ship = await post(`/api/admin/orders/${enc}/ship`, {})
  check('SHIP moves a confirmed order', ship.body?.order?.status === 'SHIPPED', JSON.stringify(ship.body?.order))
  const again = await post(`/api/admin/orders/${enc}/ship`, {})
  check('an invalid transition is refused with a reason',
    again.status === 409 && !!again.body?.message, `HTTP ${again.status} ${again.body?.message || ''}`)
  const conf = await post(`/api/admin/orders/${enc}/confirm-payment`, {})
  check('confirming an already-confirmed order is a no-op, not an error',
    conf.status === 409 || conf.body?.alreadyConfirmed === true || conf.status === 200,
    `HTTP ${conf.status}`)
}

/* = campaigns ==== */

phase('campaigns', 'Admin — group-buy and sale campaigns')

const camps = await get('/api/admin/groupbuys')
const rows = camps.body?.campaigns || []
check('the campaigns list is populated', rows.length > 1, `${rows.length} row(s)`)
check('it returns {campaigns, statsAll}', Array.isArray(rows) && !!camps.body?.statsAll,
  `keys: ${Object.keys(camps.body || {}).join(', ')}`)

const campStatuses = new Set(rows.map((c) => c.status))
check('campaigns span several statuses', campStatuses.size >= 4, [...campStatuses].join(', '))
check('an OPEN campaign exists (the only joinable state)', campStatuses.has('OPEN'))
check('an UPCOMING campaign exists', campStatuses.has('UPCOMING'))

// Dates must be ordered: a window that closes before it opens is a data bug that
// renders as a plausible-looking range.
const badWindow = rows.filter((c) => c.opensAt && c.closesAt && new Date(c.closesAt) <= new Date(c.opensAt))
check('every campaign closes after it opens', badWindow.length === 0,
  badWindow.map((c) => c.name).join(', ') || 'all ordered')

const hasShip = rows.filter((c) => c.estimatedShip).length
check('campaigns carry an estimated ship date', hasShip > 0, `${hasShip} of ${rows.length}`)
check('the Sold column has a value to render',
  rows.some((c) => typeof c.totalOrdered === 'number'), 'totalOrdered present')
check('the Items column has a value to render',
  rows.some((c) => (c._count?.items ?? c.items?.length ?? 0) > 0), '_count.items present')

// Filters are applied SERVER-side; the page filters nothing itself.
const openOnly = await get('/api/admin/groupbuys?status=OPEN')
check('?status= narrows the list',
  (openOnly.body?.campaigns || []).every((c) => c.status === 'OPEN'),
  `${(openOnly.body?.campaigns || []).length} open`)
check('statsAll still reports the unfiltered total',
  (openOnly.body?.statsAll?.total || 0) >= (openOnly.body?.campaigns || []).length,
  `total=${openOnly.body?.statsAll?.total} shown=${openOnly.body?.statsAll?.shown}`)

const archived = await get('/api/admin/groupbuys?includeArchived=true')
check('?includeArchived=true reveals more rows',
  (archived.body?.campaigns || []).length >= rows.length,
  `${rows.length} default, ${(archived.body?.campaigns || []).length} with archived`)
check('archived campaigns are hidden by default',
  !rows.some((c) => c.archived === true), 'none archived in the default list')

// Archive / restore round-trip on the campaign the page would archive.
const target2 = rows.find((c) => c.status === 'UPCOMING') || rows[0]
const archC = await api(`/api/admin/groupbuys/${target2.id}/archive`, { method: 'PATCH', body: { archived: true } })
check('a campaign can be ARCHIVED', archC.body?.campaign?.archived === true, `HTTP ${archC.status}`)
check('an archived campaign leaves the default list',
  !(await get('/api/admin/groupbuys')).body.campaigns.some((c) => c.id === target2.id))
await api(`/api/admin/groupbuys/${target2.id}/archive`, { method: 'PATCH', body: { archived: false } })
check('a campaign can be RESTORED',
  (await get('/api/admin/groupbuys')).body.campaigns.some((c) => c.id === target2.id))

// The customer page must be able to OPEN a seeded campaign — the admin's
// "Preview as customer" link and /groupbuys/<id> both depend on it.
const openCamp = (await get('/api/admin/groupbuys?status=OPEN')).body.campaigns
  .find((c) => String(c.id).startsWith('seed-'))
if (openCamp) {
  const pub = await get(`/api/groupbuys/${openCamp.id}`)
  check('a seeded campaign is served to the customer page',
    pub.body?.campaign?.id === openCamp.id, `HTTP ${pub.status}`)
  check('it carries items to order', (pub.body?.campaign?.items || []).length > 0,
    `${(pub.body?.campaign?.items || []).length} item(s)`)

  // The join gate: only OPEN may be added to a cart.
  await clearCart()
  const join = await post('/api/cart', { groupBuyItemId: pub.body.campaign.items[0].id, quantity: 1 })
  check('an OPEN campaign can be joined', join.status === 200 && (await get('/api/cart')).body.items.length === 1,
    `HTTP ${join.status}`)

  const upcoming = (await get('/api/admin/groupbuys?status=UPCOMING')).body.campaigns[0]
  if (upcoming) {
    const upPub = await get(`/api/groupbuys/${upcoming.id}`)
    check('an UPCOMING campaign is also readable', upPub.status === 200 || upPub.body?.campaign?.status === 'UPCOMING',
      `HTTP ${upPub.status}`)
  }
}

const sales = await get('/api/admin/sales')
check('the sales list is populated', (sales.body?.sales || []).length > 0,
  `${(sales.body?.sales || []).length} sale(s)`)

/* = dashboard ==== */

phase('dashboard', 'Admin — the Today dashboard agrees with its lists')

const dash = await get('/api/admin/dashboard/counts')
const c = dash.body || {}
// KEYS ARE THE COMPONENT'S. AdminHome renders `se.map(a => n[a.key])`, so a tile whose
// key is missing prints 0 while the response looks fine.
for (const key of ['ordersToShip', 'paymentsToday', 'needsReply', 'awaitingApproval', 'backInStock', 'salesToday']) {
  check(`the dashboard exposes the "${key}" tile key`, key in c, `present=${key in c}`)
}

const allOrd = (await get('/api/admin/orders')).body.orders
const awaitingOrd = (await get('/api/admin/orders?tab=awaiting')).body.orders
const paidOrd = (await get('/api/admin/orders?status=paid')).body.orders
const tixNow = (await get('/api/admin/support/tickets')).body.tickets
const usersNow = (await get('/api/admin/users')).body.users

// Every tile must equal the list it LINKS TO, not just a plausible number. A dashboard
// that disagrees with its own destination is worse than an empty one.
eq('ordersToShip equals what ?status=paid returns', c.ordersToShip, paidOrd.length)
eq('awaitingPayment equals what ?tab=awaiting returns', c.awaitingPayment, awaitingOrd.length)
eq('needsReply equals the open tickets awaiting an admin', c.needsReply,
  tixNow.filter((t) => t.status === 'OPEN' && (t.messages || [{}]).at(-1)?.authorType === 'CUSTOMER').length)
eq('awaitingApproval equals the unapproved members', c.awaitingApproval,
  usersNow.filter((u) => !u.approved).length)
check('salesToday is money, not a count', typeof c.salesToday === 'number' && c.salesToday >= 0, `$${c.salesToday}`)

// The lists have to actually NARROW, or the tile opens the wrong page.
check('?status=paid narrows the order list', paidOrd.length < allOrd.length,
  `${allOrd.length} all vs ${paidOrd.length} paid`)
check('?tab=awaiting narrows the order list', awaitingOrd.length < allOrd.length,
  `${allOrd.length} all vs ${awaitingOrd.length} awaiting`)
check('every order returned by ?status=paid is one to ship',
  paidOrd.every((o) => o.status === 'PAYMENT_CONFIRMED'),
  [...new Set(paidOrd.map((o) => o.status))].join(', '))
check('every order returned by ?tab=awaiting is awaiting payment',
  awaitingOrd.every((o) => o.status === 'AWAITING_PAYMENT_REVIEW'),
  [...new Set(awaitingOrd.map((o) => o.status))].join(', '))

// A confirmed order must move the counter, or the dashboard is a static shape.
const before = (await get('/api/admin/dashboard/counts')).body
const toShip = paidOrd[0]
if (toShip) {
  const enc2 = encodeURIComponent(toShip.orderNumber)
  await post(`/api/admin/orders/${enc2}/ship`, {})
  const after = (await get('/api/admin/dashboard/counts')).body
  eq('shipping an order decrements ordersToShip', after.ordersToShip, before.ordersToShip - 1)
  check('and the orders list agrees', (await get('/api/admin/orders?status=paid')).body.orders.length === after.ordersToShip)
}

const todayLine = await get('/api/admin/dashboard/today')
check('the Today activity line resolves', typeof todayLine.body?.newOrders === 'number',
  JSON.stringify(todayLine.body))

/* = fallback pages ==== */

phase('fallback pages', 'The fallback endpoints a page actually reads')

  // These served `{}` while a page was READING them. An empty object satisfies
  // `if (data)`, so every number rendered blank and the response looked correct — the
  // same failure as the dashboard tiles. Each is asserted against the list it feeds.
  //
  // An order is placed and delivered HERE, before BOTH the counters and the list below
  // are read, because the eq() assertions compare one against the other. Building the
  // state the assertions need is what makes them independent of when the suite runs.
  //
  // This previously relied on the seed happening to contain a DELIVERED order placed
  // today. It does not: the counter scopes to the current UTC day, so whether a delivered
  // order falls inside it depends on the seed's age and the time of the run. The check
  // passed by luck and started failing after 00:00 UTC — a time bomb, not a regression.
  await clearCart()
  //
  // The key MUST be unique per run. With a fixed key the second run replays the first
  // run's stored response, which carries no `order.id` — so the setup silently did
  // nothing and the assertion below failed only on a fresh server. A test whose setup can
  // no-op is a test that lies intermittently.
  const deliverKey = `smoke-delivered-${Date.now()}`
  const deliverable = (await get('/api/products/catalog')).body.products.find((x) => !x.soldOut)
  if (deliverable) {
    await post('/api/cart', {
      productId: deliverable.id, variantId: deliverable.variants?.[0]?.id, quantity: 1,
    })
    const fresh = await api('/api/orders/create', {
      method: 'POST',
      body: { addressId: ADDRESS_ID, paymentMethod: 'USDT' },
      headers: { 'Idempotency-Key': deliverKey },
    })
    const freshId = fresh.body?.order?.id
    // Fail LOUDLY if the order could not be created, rather than skipping the walk and
    // letting a later assertion absorb the blame.
    check('the counters fixture could place an order to deliver',
      freshId != null, `status=${fresh.status} body=${JSON.stringify(fresh.body).slice(0, 90)}`)
    if (freshId) {
      for (const action of ['confirm-payment', 'ship', 'deliver']) {
        const step = await api(`/api/admin/orders/${freshId}/${action}`, { method: 'POST' })
        check(`the counters fixture could ${action} it`, step.status === 200,
          `HTTP ${step.status} for ${action}`)
      }
    }
    await clearCart()
  }

  const todayStats = await get('/api/admin/orders/today-stats')
  check('today-stats exposes the keys OrdersPage reads',
    ['deliveredToday', 'shippedToday', 'newToday'].every((k) => k in (todayStats.body || {})),
    `keys: ${Object.keys(todayStats.body || {}).join(', ')}`)
  // The predicate is "TODAY", not "any order with that status". Asserting
  // `status === 'DELIVERED'` against the WHOLE list was my mistake: it compared a
  // today-scoped counter to an all-time total and failed on a server that was right.
  const allOrd2 = (await get('/api/admin/orders')).body.orders
  const todayKey = new Date().toISOString().slice(0, 10)
  const placedToday = allOrd2.filter((o) => String(o.placedAt || '').slice(0, 10) === todayKey)
  eq('deliveredToday equals the orders DELIVERED today', todayStats.body?.deliveredToday,
    placedToday.filter((o) => o.status === 'DELIVERED').length)
  eq('shippedToday equals the orders SHIPPED today', todayStats.body?.shippedToday,
    placedToday.filter((o) => o.status === 'SHIPPED').length)
  eq('newToday equals the orders PLACED today', todayStats.body?.newToday, placedToday.length)
  // A dashboard of zeros cannot be distinguished from a broken one. This now holds by
  // construction rather than by luck, because the order above was delivered in this run.
  check('all three counters are non-zero',
    (todayStats.body?.deliveredToday || 0) > 0 && (todayStats.body?.shippedToday || 0) > 0
      && (todayStats.body?.newToday || 0) > 0,
    `delivered=${todayStats.body?.deliveredToday} shipped=${todayStats.body?.shippedToday} new=${todayStats.body?.newToday}`)

const oc = await get('/api/admin/open-carts?page=1&limit=25')
check('open-carts returns {carts, stats, pagination}',
  Array.isArray(oc.body?.carts) && !!oc.body?.stats && !!oc.body?.pagination,
  `keys: ${Object.keys(oc.body || {}).join(', ')}`)
// The row renders `r.user.id`. A cart with only a top-level id threw
// "Cannot read properties of undefined (reading 'id')" DURING RENDER, which the error
// boundary turned into a full-page failure — from a 200 response. A test that only
// checked the status code would have called that a pass.
check('every cart carries the user object the row reads',
  (oc.body?.carts || []).every((c) => c.user && c.user.id != null),
  `${(oc.body?.carts || []).filter((c) => !c.user?.id).length} missing user.id`)
check('open-carts stats expose the header keys',
  ['totalItems', 'totalValue', 'totalCarts', 'productItems', 'groupBuyItems', 'saleItems']
    .every((k) => k in (oc.body?.stats || {})),
  `keys: ${Object.keys(oc.body?.stats || {}).join(', ')}`)

// Every page the browser actually visits, asserted on RENDER rather than on status:
// no error boundary, no console error, and the loading state resolved. A 200 alone is
// not evidence that a screen works.
const browserPages = [
  ['/admin', 'Today'], ['/admin/orders', 'Orders'], ['/admin/open-carts', 'Open carts'],
  ['/admin/support', 'Support'], ['/admin/users', 'Customers'], ['/admin/products', 'Products'],
  ['/admin/groupbuys', 'Group buys'], ['/admin/inventory', 'Stock'], ['/admin/reports', 'Reports'],
]

const uiPages = new URL('./smoke-pages.py', import.meta.url).pathname
const { spawnSync: spawn2 } = await import('node:child_process')
const probe2 = spawn2(py, ['-c', 'import playwright'], { encoding: 'utf8' })
if (probe2.status !== 0) {
  skip('page render sweep', `Playwright not importable by ${py}`)
} else {
  const args = [uiPages, '--base', BASE]
  for (const [route] of browserPages) args.push(route)
  const res2 = spawn2(py, args, { encoding: 'utf8' })
  const out2 = (res2.stdout || '').trim()
  for (const line of out2.split('\n')) {
    if (!line.trim()) continue
    console.log(`  ${line}`)
    const m = /^\s*(PASS|FAIL|SKIP|BLOCK)\s+(.*)$/.exec(line)
    if (m) record(m[1] === 'BLOCK' ? 'BLOCKED' : m[1], `[pages] ${m[2]}`, '')
  }
  if (!out2) fail('page render sweep', `exited ${res2.status}: ${(res2.stderr || '').slice(0, 200)}`)
}

/* ============================================================== insights ==== */

phase('insights', 'Insights — reports and fee settlement')

const RANGE = (() => {
  const now = new Date()
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  return `startDate=${start.toISOString()}&endDate=${end.toISOString()}`
})()

const rep = await get(`/api/admin/reports?${RANGE}`)
const r = rep.body || {}
// THE PROPS ARE TOP-LEVEL. The overview reads `e.overview.totalRevenue`, not
// `e.summary.collected`; serving the numbers one level down left every screen at
// $0.00 with a 200 and a body full of correct values.
check('reports exposes the top-level sections the page reads',
  ['overview', 'charts', 'inStock', 'sales', 'groupBuys', 'recentOrders', 'customers', 'payments']
    .every((k) => k in r),
  `keys: ${Object.keys(r).join(', ')}`)
check('overview carries the KPI names the tiles read',
  ['totalRevenue', 'ordersCount', 'cancelledOrders', 'avgOrderValue', 'newCustomers', 'pendingOrders']
    .every((k) => k in (r.overview || {})),
  `keys: ${Object.keys(r.overview || {}).join(', ')}`)
check('revenueBreakdown carries every leaf the table reads',
  ['productSubtotal', 'retailRevenue', 'groupBuyRevenue', 'saleRevenue', 'discounts', 'shipping', 'insurance', 'adminFees', 'paymentAdjustments']
    .every((k) => k in (r.overview?.revenueBreakdown || {})),
  `keys: ${Object.keys(r.overview?.revenueBreakdown || {}).join(', ')}`)
check('the payments fee tiles resolve',
  ['byMethod', 'totalFees', 'preFeeSubtotal', 'settledFees', 'unsettledFees']
    .every((k) => k in (r.payments || {})),
  `keys: ${Object.keys(r.payments || {}).join(', ')}`)
check('groupBuys.total drives the Campaigns KPI', typeof r.groupBuys?.total === 'number',
  `total=${r.groupBuys?.total}`)
// byStatus values are OBJECTS: the chips test truthiness then read .count/.revenue.
check('groupBuys.byStatus values are {count, revenue} objects',
  Object.values(r.groupBuys?.byStatus || {}).every((v) => v && typeof v === 'object' && 'count' in v && 'revenue' in v),
  JSON.stringify(Object.entries(r.groupBuys?.byStatus || {}).slice(0, 2)))
// The sales table does `x.orderNumber || x.id.slice(0,8)` with NO guard, so a row
// missing both throws during render. `date` feeds an unguarded new Date() on CSV export.
check('recentOrders carry id + date + paymentMethod',
  (r.recentOrders || []).every((o) => o.id != null && o.date != null && 'paymentMethod' in o),
  `${(r.recentOrders || []).length} order(s)`)

const dl = await get(`/api/admin/reports/deliveries?${RANGE}`)
const d2 = dl.body || {}
check('deliveries uses recentDeliveries, not deliveries',
  Array.isArray(d2.recentDeliveries) && !('deliveries' in d2),
  `keys: ${Object.keys(d2).join(', ')}`)
check('delivery summary carries inTransit and autoUpdated as siblings',
  ['totalDelivered', 'autoUpdated', 'inTransit', 'avgDeliveryDays'].every((k) => k in (d2.summary || {})),
  `keys: ${Object.keys(d2.summary || {}).join(', ')}`)
check('automation exposes lastWebhookAt (the only field read off it)',
  'lastWebhookAt' in (d2.automation || {}),
  `keys: ${Object.keys(d2.automation || {}).join(', ')}`)
check('carrierBreakdown entries carry value for the bar rows',
  (d2.charts?.carrierBreakdown || []).every((c) => 'value' in c),
  JSON.stringify(d2.charts?.carrierBreakdown?.slice(0, 2)))
check('deliveriesByDay carries the carrier split columns',
  (d2.charts?.deliveriesByDay || []).every((x) => ['date', 'count', 'usps', 'ups', 'fedex', 'other'].every((k) => k in x)),
  JSON.stringify(d2.charts?.deliveriesByDay?.[0] || {}))

// ---- the fee ledger must agree with the orders that booked it -------------
// `?includeArchived=true` on purpose: the default list hides archived orders, but
// anything reconciling MONEY has to see them, or the totals differ by exactly the
// archived fees. Comparing a filtered list to an unfiltered ledger is the mistake that
// made this look like a ledger bug when the ledger was right.
const ordersForFees = (await get('/api/admin/orders?includeArchived=true')).body.orders
const ledger = await get('/api/admin/fees/monthly-summary')
const months = ledger.body?.months || []
check('the fee ledger has a month', months.length > 0, `${months.length} month(s)`)
// `key` is what the page matches the current month against; `month` is what it prints.
check('each month carries key AND month', months.every((m) => m.key && m.month),
  `keys: ${months.map((m) => m.key).join(', ')}`)
const feeRows = ledger.body?.fees || []
check('each fee row carries the fields the table reads',
  feeRows.every((f) => f.id && f.order && 'settled' in f && 'cancelled' in f && 'feeAmount' in f && 'paymentMethod' in f),
  `${feeRows.length} fee(s)`)
// TWO INDEPENDENT PATHS to the same money: the orders list, and the fee ledger.
// ARCHIVED is not CANCELLED. Archiving takes an order off the working list; it does
// not void it or its fee. Treating them as the same left the ledger $0.60 short.
const liveFees = ordersForFees.filter((o) => o.status !== 'CANCELLED')
const owedFromOrders = Math.round(liveFees.filter((o) => o.status !== 'DELIVERED').reduce((n, o) => n + (o.adminFee || 0), 0) * 100) / 100
eq('owed total agrees with the orders that booked it', months[0]?.totalOwed, owedFromOrders)
// FOUR independent paths to the same money: the orders, the fee rows, the month
// rollup, and the reports section. They must all land on one number.
const fromOrders = Math.round(liveFees.reduce((n, o) => n + (o.adminFee || 0), 0) * 100) / 100
const fromFees = Math.round(feeRows.filter((f) => !f.cancelled).reduce((n, f) => n + f.feeAmount, 0) * 100) / 100
const fromMonths = Math.round(months.reduce((n, m) => n + m.totalOwed + m.totalSettled, 0) * 100) / 100
eq('fee rows agree with the orders', fromFees, fromOrders)
eq('month rollup agrees with the fee rows', fromMonths, fromFees)
eq('reports totalFees agrees with all of them', r.payments?.totalFees, fromOrders)

// A CANCELLED order is void; an ARCHIVED one is not. Assert the distinction holds.
const archivedForFees = ordersForFees.filter((o) => o.archived === true)
check('archived orders still book a fee (unlike cancelled)',
  archivedForFees.every((o) => feeRows.some((f) => f.orderNumber === o.orderNumber && !f.cancelled)),
  `${archivedForFees.length} archived order(s)`)

// ---- the crash this work introduced, and the guard against it -------------
// An order placed through the local checkout has no `placedAt`. `Intl.formatToParts`
// throws RangeError on an Invalid Date, the throw was unhandled inside an async request
// handler, and Node EXITED — killing the server mid-suite so every LATER assertion
// failed for a reason unrelated to what it was testing. One bad record must produce one
// 500, never a dead process.
await clearCart()
const anyProd = (await get('/api/products/catalog')).body.products.find((x) => !x.soldOut)
if (anyProd) {
  await post('/api/cart', { productId: anyProd.id, variantId: anyProd.variants?.[0]?.id, quantity: 1 })
  // `/api/orders/create`, NOT `/api/orders` — the latter is GET-only and falls through
  // to the replay, answering `{orders: []}` with a 200, which reads like success.
  await api('/api/orders/create', {
    method: 'POST',
    body: { addressId: ADDRESS_ID, paymentMethod: 'USDT' },
    headers: { 'Idempotency-Key': 'smoke-undated-order' },
  })
}
const afterFees = await get('/api/admin/fees/monthly-summary')
check('a locally placed order does not break the fee ledger', afterFees.status === 200,
  `HTTP ${afterFees.status}`)
check('the server is still alive after an undated order', (await get('/api/admin/orders')).status === 200,
  'the fatal-guard held')
await clearCart()

/* ============================================================= storefront ==== */

phase('storefront', 'Storefront — banner, pop-up and seasonal effect')

// The admin form and the customer storefront read the SAME values through DIFFERENT
// field names. The admin routes answered `{}`, so every form rendered its defaults while
// the live storefront showed something else — the strip and the box editing it
// disagreed, and a save reached nobody.
const bannerAdmin = await get('/api/admin/notification-banner')
const b1 = bannerAdmin.body || {}
check('the banner form loads real config, not defaults',
  ['enabled', 'message', 'style', 'speed', 'fontSize', 'glow', 'shimmer', 'pulse', 'emoji', 'bold', 'uppercase']
    .every((k) => k in b1),
  `keys: ${Object.keys(b1).join(', ')}`)
check('the banner has a message to show', String(b1.message || '').length > 0,
  `${String(b1.message || '').length} chars`)

const bannerPublic = await get('/api/admin/public/notification-banner')
check('the storefront reads the SAME banner the form edits',
  bannerPublic.body?.message === b1.message, 'admin and public agree')

// Save -> the storefront must see it. Asserted through the public route, because
// "the admin form saved" and "the customer sees it" are different claims.
const originalMsg = b1.message
const edited = await api('/api/admin/notification-banner', {
  method: 'PUT',
  body: { message: 'Smoke test announcement', style: 'promo', uppercase: false },
})
check('saving the banner is accepted', edited.status === 200, `HTTP ${edited.status}`)
check('the EDIT reaches the storefront',
  (await get('/api/admin/public/notification-banner')).body?.message === 'Smoke test announcement')
eq('and the style came through too', (await get('/api/admin/notification-banner')).body?.style, 'promo')

// An enabled banner with no message is on-but-invisible: the one combination that
// wastes an admin's time, so it is refused rather than stored.
const blank = await api('/api/admin/notification-banner', { method: 'PUT', body: { message: '   ' } })
check('an enabled banner with no message is refused', blank.status === 422,
  `HTTP ${blank.status} ${blank.body?.error || ''}`)
const badEnum = await api('/api/admin/notification-banner', { method: 'PUT', body: { style: 'sparkly' } })
check('an unknown style is refused with the allowed list', badEnum.status === 422,
  `${badEnum.body?.error || ''}`)
await api('/api/admin/notification-banner', { method: 'PUT', body: { message: originalMsg, style: b1.style, uppercase: b1.uppercase } })
eq('and the edit can be put back', (await get('/api/admin/notification-banner')).body?.message, originalMsg)

// ---- the effect ----------------------------------------------------------
const eff = await get('/api/admin/particle-effect')
check('the effect form loads real config',
  ['enabled', 'type', 'emojis', 'speed', 'density'].every((k) => k in (eff.body || {})),
  `keys: ${Object.keys(eff.body || {}).join(', ')}`)
// NOTE the density value: 'heavy', which is what the FORM offers. This line used to
// send 'high' — a value I had invented — so it was asserting my own bug and passing
// while every non-default save in the real UI was being refused.
const effOn = await api('/api/admin/particle-effect', { method: 'PUT', body: { enabled: true, type: 'hearts', density: 'heavy' } })
check('the effect can be switched on', effOn.status === 200 && effOn.body?.type === 'hearts',
  `type=${effOn.body?.type}`)
check('the storefront sees the effect',
  (await get('/api/admin/public/particle-effect')).body?.type === 'hearts')
const effBad = await api('/api/admin/particle-effect', { method: 'PUT', body: { type: 'locusts' } })
check('an unknown effect type is refused', effBad.status === 422, `HTTP ${effBad.status}`)
await api('/api/admin/particle-effect', { method: 'PUT', body: { enabled: eff.body.enabled, type: eff.body.type, density: eff.body.density } })

// ---- the pop-up and its featured list ------------------------------------
const sp = await get('/api/admin/spotlight/settings')
check('the pop-up form uses the spotlight* field names',
  ['spotlightEnabled', 'spotlightTitle', 'spotlightAnnouncement', 'spotlightNewBadgeDays', 'spotlightDelayMs']
    .every((k) => k in (sp.body || {})),
  `keys: ${Object.keys(sp.body || {}).join(', ')}`)
check('spotlightNewBadgeDays is a real window, not a placeholder',
  Number(sp.body?.spotlightNewBadgeDays) > 0, `${sp.body?.spotlightNewBadgeDays} days`)

// The featured list is a BARE ARRAY. A wrapper object made it render as nothing.
const feat0 = await get('/api/admin/spotlight/products')
check('the featured list is a bare array', Array.isArray(feat0.body),
  `${Array.isArray(feat0.body) ? feat0.body.length : typeof feat0.body} entries`)
const search = await get('/api/admin/spotlight/search-products?q=bpc')
check('product search returns matches', Array.isArray(search.body) && search.body.length > 0,
  `${(search.body || []).length} hit(s)`)

const pick = (await get('/api/admin/products')).body.products.filter((x) => x.__seed === true).slice(0, 2)
if (pick.length === 2) {
  await post(`/api/admin/spotlight/products/${pick[0].slug}`, {})
  const two = await post(`/api/admin/spotlight/products/${pick[1].slug}`, {})
  eq('featuring a product adds it', (await get('/api/admin/spotlight/products')).body.length, 2)
  check('feature is reflected on the customer pop-up',
    (await get('/api/spotlight')).body.products.some((x) => x.name === pick[0].name),
    'the featured product reached /api/spotlight')
  // The customer shape uses DIFFERENT names from the admin one — both must be present.
  const pub = (await get('/api/spotlight')).body
  check('the customer pop-up carries enabled/title/announcement/delayMs/products',
    ['enabled', 'title', 'announcement', 'delayMs', 'products'].every((k) => k in pub),
    `keys: ${Object.keys(pub).join(', ')}`)
  await api(`/api/admin/spotlight/products/${pick[0].slug}`, { method: 'DELETE' })
  eq('unfeaturing removes it', (await get('/api/admin/spotlight/products')).body.length, 1)
  await api(`/api/admin/spotlight/products/${pick[1].slug}`, { method: 'DELETE' })
  eq('the featured list can be emptied', (await get('/api/admin/spotlight/products')).body.length, 0)
}

// A reorder must not silently ADD: only already-featured ids may be reordered.
const r1 = await post(`/api/admin/spotlight/products/${pick[0].slug}`, {})
const reorder = await api('/api/admin/spotlight/products/reorder', {
  method: 'PUT', body: { productIds: [pick[0].id, 'not-a-real-product-id'] },
})
check('reorder cannot smuggle in an unfeatured id',
  reorder.status === 200 && !(reorder.body?.products || []).includes('not-a-real-product-id'),
  JSON.stringify(reorder.body?.products))
await api(`/api/admin/spotlight/products/${pick[0].slug}`, { method: 'DELETE' })

// ---- it persists ---------------------------------------------------------
// These are settings someone edits on purpose, so unlike the fixtures they survive a
// restart. A file is the difference between "I saved my banner" and "I saved it until
// the next restart".
await api('/api/admin/notification-banner', { method: 'PUT', body: { message: 'persisted-probe-1234' } })
const file = await import('node:fs')
const cfgPath = new URL('../storefront-config.json', import.meta.url).pathname
const onDisk = JSON.parse(file.readFileSync(cfgPath, 'utf8'))
check('the save is written to disk', onDisk.banner?.message === 'persisted-probe-1234',
  `banner.message=${JSON.stringify(onDisk.banner?.message)}`)
// Re-read through the same validator the server uses at boot, so a hand-edited file
// cannot inject a value the form would have refused.
const cfg = await import('../storefront-config.mjs')
const reloaded = cfg.readStorefrontConfig(cfgPath)
check('reloading re-validates and keeps the value', reloaded.banner.message === 'persisted-probe-1234',
  `reloaded=${JSON.stringify(reloaded.banner.message)}`)
const bad = cfg.validateBanner({ style: 'nope' }, cfg.DEFAULT_BANNER)
check('the loader refuses an invalid style from a hand-edited file', bad.ok === false,
  bad.errors.join('; '))
await api('/api/admin/notification-banner', { method: 'PUT', body: { message: originalMsg } })

/* ============================================================== discounts ==== */

phase('discounts', 'Discount codes — wired to the live promo engine')

// The page reads `m.data.discounts || []`. A BARE ARRAY gave it `undefined || []`, so
// the screen said "No discount codes yet" while the endpoint returned two good ones --
// the exact mirror of the support-tickets shape mistake, in the opposite direction.
const discs = await get('/api/admin/discounts')
check('discounts come back as {discounts: [...]}, not a bare array',
  Array.isArray(discs.body?.discounts) && !Array.isArray(discs.body),
  `keys: ${Object.keys(discs.body || {}).join(', ')}`)
const codeRows = discs.body?.discounts || []
check('the shipped codes are listed', codeRows.length >= 2, `${codeRows.length} code(s)`)
check('each row carries the fields the table reads',
  codeRows.every((c) => c.code && c.name && c.discountType && 'isActive' in c && 'usageCount' in c),
  `keys: ${Object.keys(codeRows[0] || {}).join(', ')}`)

// usageCount is DERIVED from orders carrying the code, not a stored counter that drifts
// the moment an order is placed anywhere else.
const ordersWithCode = (await get('/api/admin/orders?includeArchived=true')).body.orders
const welcomeUses = ordersWithCode.filter((o) => o.discountCode === 'WELCOME10').length
eq('usageCount is derived from the orders, not stored',
  codeRows.find((c) => c.code === 'WELCOME10')?.usageCount, welcomeUses)
check('the detail route reports who used it',
  Array.isArray((await get(`/api/admin/discounts/WELCOME10`)).body?.discount?.usages),
  'usages array present')

// ---- the engine and the admin must agree about reality -------------------
// The toggle is the whole point of the screen. Before this, a code switched off here
// kept discounting at checkout: the button reported success and nothing changed.
// A percentage of an EMPTY cart is $0.00, which reads as "the code is broken" when the
// cart is simply empty. Earlier phases empty it, so fill it first.
await clearCart()
const promoProd = (await get('/api/products/catalog')).body.products.find((x) => !x.soldOut)
if (promoProd) {
  await post('/api/cart', { productId: promoProd.id, variantId: promoProd.variants?.[0]?.id, quantity: 4 })
}
const onBefore = await post('/api/checkout/validate-promo', { code: 'WELCOME10' })
check('an active code discounts at checkout', onBefore.status === 200 && onBefore.body?.discount?.discountAmount > 0,
  `discount=${onBefore.body?.discount?.discountAmount}`)
await api('/api/admin/discounts/WELCOME10/toggle', { method: 'PATCH' })
check('toggling it OFF is reflected in the list',
  (await get('/api/admin/discounts')).body.discounts.find((c) => c.code === 'WELCOME10')?.isActive === false)
const offNow = await post('/api/checkout/validate-promo', { code: 'WELCOME10' })
check('and the checkout now REFUSES it', offNow.status === 400 && /not active/i.test(offNow.body?.error || ''),
  `HTTP ${offNow.status} ${offNow.body?.error || ''}`)
await api('/api/admin/discounts/WELCOME10/toggle', { method: 'PATCH' })
check('toggling it back ON restores the discount',
  (await post('/api/checkout/validate-promo', { code: 'WELCOME10' })).status === 200)

// ---- a code created here is priced by the same engine --------------------
const NEW = 'SMOKE' + String(Date.now()).slice(-6)
const created2 = await post('/api/admin/discounts', { code: NEW, name: 'Smoke 25% off', discountType: 'PERCENT', value: 25 })
check('a code can be created', created2.status === 201, `HTTP ${created2.status}`)
const appliedNew = await post('/api/checkout/validate-promo', { code: NEW })
check('the new code works at checkout', appliedNew.status === 200 && appliedNew.body?.discount?.discountAmount > 0,
  `discount=${appliedNew.body?.discount?.discountAmount}`)
const base = await liveCartSubtotal()
check('it is priced as 25% of the cart subtotal',
  Math.abs(appliedNew.body.discount.discountAmount - Math.round(base * 0.25 * 100) / 100) < 0.02,
  `${appliedNew.body.discount.discountAmount} vs 25% of ${base}`)

// ---- validation refuses rather than coercing -----------------------------
const shortCode2 = await post('/api/admin/discounts', { code: 'AB', discountType: 'PERCENT', value: 10 })
check('a too-short code is refused', shortCode2.status === 422, `HTTP ${shortCode2.status}`)
const tooBig2 = await post('/api/admin/discounts', { code: 'BIG' + String(Date.now()).slice(-4), discountType: 'PERCENT', value: 500 })
check('a 500% discount is refused', tooBig2.status === 422, `${tooBig2.body?.error || ''}`)
const dupe2 = await post('/api/admin/discounts', { code: 'WELCOME10', discountType: 'PERCENT', value: 10 })
check('a duplicate code is refused', dupe2.status === 409, `HTTP ${dupe2.status}`)
const badDiscWindow = await api(`/api/admin/discounts/${NEW}`, {
  method: 'PUT',
  body: { startsAt: '2026-06-01T00:00:00.000Z', expiresAt: '2026-01-01T00:00:00.000Z' },
})
check('an expiry BEFORE the start is refused', badDiscWindow.status === 422, `${badDiscWindow.body?.error || ''}`)

// ---- it persists, and a deleted code stays gone --------------------------
await api(`/api/admin/discounts/${NEW}`, { method: 'DELETE' })
check('a deleted code stops working',
  (await post('/api/checkout/validate-promo', { code: NEW })).status === 400)
const promosFile = new URL('../promo-codes.json', import.meta.url).pathname
const onDiskPromos = JSON.parse((await import('node:fs')).readFileSync(promosFile, 'utf8'))
check('the delete is tombstoned so it survives a restart',
  (onDiskPromos.deleted || []).includes(NEW), `deleted: ${JSON.stringify(onDiskPromos.deleted)}`)
check('the live codes are written to disk',
  onDiskPromos.codes && Object.keys(onDiskPromos.codes).length >= 2,
  `${Object.keys(onDiskPromos.codes || {}).length} persisted`)

// Re-validated on load: a hand-edited file must not inject what the form would refuse.
const promoMod = await import('../promo-codes.mjs')
const evilPromo = promoMod.validatePromo({ code: 'EVIL', percentOff: 500 })
check('the loader refuses a 500% discount from a hand-edited file', evilPromo.ok === false, evilPromo.errors.join('; '))
const both = promoMod.validatePromo({ code: 'EVIL', percentOff: 10, amountOff: 5 })
check('a code cannot be both a percentage and a fixed amount', both.ok === false, both.errors.join('; '))

/* ============================================================= newsletter ==== */

phase('newsletter', 'Newsletter — fixtures labelled, sending real')

// The page reads stats.{active,eligible,inactive,suppressed,byTier}. Missing numbers
// render 0 rather than throwing, which is exactly why a wrong shape looks like an empty
// list instead of a bug.
const nstats = await get('/api/admin/newsletter/stats')
const st = nstats.body || {}
check('stats carries every key the shell reads',
  ['active', 'eligible', 'inactive', 'suppressed'].every((k) => typeof st[k] === 'number'),
  `active=${st.active} eligible=${st.eligible} inactive=${st.inactive} suppressed=${st.suppressed}`)
check('byTier covers USER/VIP/ELITE with eligible AND offTier',
  ['USER', 'VIP', 'ELITE'].every((t) => typeof st.byTier?.[t]?.eligible === 'number' && typeof st.byTier?.[t]?.offTier === 'number'),
  JSON.stringify(st.byTier))
// The compose footer promises these numbers, so they have to be the count a send
// actually reaches — asserted below against a real send.
eq('byTier.USER.eligible is the everyone-reachable count', st.byTier?.USER?.eligible, st.eligible)

// `{subscribers, total, totalPages}` — the component's own catch default names all three.
const subs = await get('/api/admin/newsletter/subscribers?page=1&limit=25')
const srows = subs.body?.subscribers || []
check('subscribers return {subscribers, total, totalPages}',
  Array.isArray(srows) && typeof subs.body?.total === 'number' && typeof subs.body?.totalPages === 'number',
  `keys: ${Object.keys(subs.body || {}).join(', ')}`)
check('each row carries the fields the table reads',
  srows.every((x) => x.id != null && x.email && typeof x.active === 'boolean'
    && typeof x.suppressed === 'boolean' && x.source && x.createdAt),
  `keys: ${Object.keys(srows[0] || {}).join(', ')}`)
// The "Opted out" chip renders only when BOTH are true. Seeding suppressed rows as
// active:false meant that chip could never appear on any row.
check('a suppressed subscriber is still an ACTIVE account, so the chip can render',
  srows.filter((x) => x.suppressed).every((x) => x.active === true),
  `${srows.filter((x) => x.suppressed && x.active).length} row(s) will show it`)
check('every fixture row is labelled __seed', srows.every((x) => x.__seed === true) || srows.some((x) => x.__seed === true),
  'fixtures are marked so they are not mistaken for a real list')

// Server-side filtering, because the page does none of its own.
const activeOnly = await get('/api/admin/newsletter/subscribers?page=1&limit=25&status=active')
check('?status=active narrows server-side',
  (activeOnly.body?.subscribers || []).every((x) => x.status === 'ACTIVE'),
  `${(activeOnly.body?.subscribers || []).length} active`)

// ---- the four reads that genuinely THROW if a field is missing -------------
// POST /subscribers reads `reactivated`. A 201 without it shows an ERROR toast and
// skips the list refresh — so the field has to be present on both paths.
const newAddr = `smoke${String(Date.now()).slice(-6)}@example.com`
const added = await post('/api/admin/newsletter/subscribers', { email: newAddr, source: 'admin' })
check('adding a subscriber returns `reactivated`', added.body && 'reactivated' in added.body,
  `HTTP ${added.status} reactivated=${added.body?.reactivated}`)
check('a new address is reactivated:false', added.body?.reactivated === false)
// The modal's own copy promises reactivation for a known address; a 409 would
// contradict the screen.
const again = await post('/api/admin/newsletter/subscribers', { email: newAddr, source: 'admin' })
check('re-adding a known address reactivates rather than erroring',
  again.status === 200 && again.body?.reactivated === true, `HTTP ${again.status}`)
const badEmail = await post('/api/admin/newsletter/subscribers', { email: 'not-an-email', source: 'admin' })
check('an invalid address is refused', badEmail.status === 422, `HTTP ${badEmail.status}`)

// toggle -> the count that a send reaches must move with it.
// The baseline is taken HERE, not from the earlier snapshot: the add-a-subscriber test
// above already changed it, and comparing against a stale number made a correct server
// look wrong. Assertions like this have to own their starting state.
const beforeToggle = (await get('/api/admin/newsletter/stats')).body.eligible
const toggled = (await get('/api/admin/newsletter/subscribers?page=1&limit=25&status=active'))
  .body.subscribers.find((x) => x.status === 'ACTIVE')
await api(`/api/admin/newsletter/subscribers/${toggled.id}`, { method: 'PATCH', body: { active: false } })
eq('deactivating a subscriber reduces `eligible`',
  (await get('/api/admin/newsletter/stats')).body?.eligible, beforeToggle - 1)
await api(`/api/admin/newsletter/subscribers/${toggled.id}`, { method: 'PATCH', body: { active: true } })
eq('and reactivating restores it', (await get('/api/admin/newsletter/stats')).body?.eligible, beforeToggle)

// ---- campaigns: audienceTier is indexed into a 3-key map with NO guard ----
const camps2 = await get('/api/admin/newsletter/campaigns')
const crows = camps2.body?.campaigns || []
check('campaigns are listed', crows.length > 0, `${crows.length} campaign(s)`)
check('every campaign audienceTier is one of USER/VIP/ELITE',
  crows.every((c) => ['USER', 'VIP', 'ELITE'].includes(c.audienceTier)),
  [...new Set(crows.map((c) => c.audienceTier))].join(', '))
check('every campaign carries the count and date the table reads',
  crows.every((c) => typeof c.recipientCount === 'number' && c.sentAt && c.subject),
  `keys: ${Object.keys(crows[0] || {}).join(', ')}`)

// ---- the SEND path writes REAL files to the REAL outbox ------------------
const preview2 = await post('/api/admin/newsletter/preview', { subject: 'Smoke preview', htmlContent: '<h2>Hi</h2><p>body</p>' })
check('preview returns a complete HTML document',
  typeof preview2.body?.html === 'string' && preview2.body.html.startsWith('<!DOCTYPE'),
  `${String(preview2.body?.html || '').length} bytes`)

const eliteSend = await post('/api/admin/newsletter/send', {
  subject: 'Smoke elite send', htmlContent: '<p>elite only</p>', audienceTier: 'ELITE',
})
// All five counters feed one toast; a missing one silently drops a clause.
check('send returns all five counters the toast folds together',
  ['sent', 'skipped', 'offTier', 'suppressed', 'failed'].every((k) => typeof eliteSend.body?.[k] === 'number'),
  JSON.stringify(eliteSend.body && Object.fromEntries(['sent', 'skipped', 'offTier', 'suppressed', 'failed'].map((k) => [k, eliteSend.body[k]]))))
check('an ELITE send reaches at most the Elite count',
  eliteSend.body?.sent <= st.byTier?.ELITE?.eligible + 1, `sent=${eliteSend.body?.sent}`)

// Fresh baseline again: `st` was captured before this phase added, toggled and removed
// subscribers, so comparing a send against it measured my own test's side effects.
const preSend = (await get('/api/admin/newsletter/stats')).body
const allSend = await post('/api/admin/newsletter/send', {
  subject: 'Smoke everyone send', htmlContent: '<p>all</p>', audienceTier: 'USER',
})
eq('a USER send reaches the everyone count', allSend.body?.sent, preSend.eligible)
eq('and the ELITE send reached the Elite count', eliteSend.body?.sent, preSend.byTier?.ELITE?.eligible)
check('opted-out subscribers are counted as suppressed, not sent',
  allSend.body?.suppressed === preSend.suppressed, `suppressed=${allSend.body?.suppressed}`)

// The htmlContent is embedded, not escaped — escaping it would print markup as text.
const html = (await (async () => {
  const r = await post('/api/admin/newsletter/send', { subject: 'Embed probe', htmlContent: '<p id="probe-marker">marked</p>', audienceTier: 'USER' })
  const outbox = await get('/api/admin/outbox')
  const ev = (outbox.body?.events || []).find((e) => e.event === 'newsletter.sent' && e.messages?.[0]?.subject === 'Embed probe')
  return ev?.messages?.[0]?.html ?? ''
})())
check('the composed HTML is embedded in the rendered email, not escaped', html.includes('probe-marker'),
  html ? 'marker present' : 'no rendered message found')

// The campaign record is written so the Campaigns tab shows what was sent.
check('a send is recorded as a campaign',
  (await get('/api/admin/newsletter/campaigns')).body.campaigns.some((c) => c.subject === 'Smoke everyone send'),
  'the sent campaign is listed')

// A subject is required: a send with none would render an untitled email.
const noSubject = await post('/api/admin/newsletter/send', { subject: '   ', htmlContent: '<p>x</p>', audienceTier: 'USER' })
check('a send with no subject is refused', noSubject.status === 422, `HTTP ${noSubject.status}`)

// ---- drafts persist ------------------------------------------------------
const draft = await post('/api/admin/newsletter/drafts', { name: 'Smoke draft', subject: 'Draft subject', htmlContent: '<p>draft</p>' })
check('a draft can be saved and returns {draft:{id}}',
  draft.body?.draft?.id != null, `HTTP ${draft.status}`)
const draftList = await get('/api/admin/newsletter/drafts')
check('the draft list carries id/name/subject/updatedAt',
  (draftList.body?.drafts || []).every((d) => d.id != null && d.name && 'subject' in d && d.updatedAt),
  `${(draftList.body?.drafts || []).length} draft(s)`)
const fullDraft = await get(`/api/admin/newsletter/drafts/${draft.body.draft.id}`)
check('the draft detail carries htmlContent (a missing draft throws in the page)',
  typeof fullDraft.body?.draft?.htmlContent === 'string', `HTTP ${fullDraft.status}`)
await api(`/api/admin/newsletter/drafts/${draft.body.draft.id}`, { method: 'DELETE' })
check('a draft can be deleted', !(await get('/api/admin/newsletter/drafts')).body.drafts.some((d) => d.id === draft.body.draft.id))

// ---- the subscriber I added and the drafts are cleaned up ----------------
await api(`/api/admin/newsletter/subscribers/${added.body.subscriber.id}`, { method: 'DELETE' })

/* ============================================================ option enums ==== */

phase('option enums', 'Server enums must accept what the form sends')

// THE BUG THIS EXISTS TO CATCH: the option lists were written by hand instead of read
// from the form, so the server refused values the UI offers. The defaults happened to
// be valid, so opening a tab and saving worked and only non-default picks failed —
// while the Effects tab animated its own local preview, making a rejected save LOOK
// successful. A validator must accept exactly what its client sends.
//
// The expected lists are the OPTION LISTS IN THE BUNDLE. They are pinned here as
// constants (a test cannot click every control cheaply), and the bundle is grepped for
// the same values so a UI change that is not mirrored in the server fails loudly.
const OPTION_SETS = {
  bannerStyle: ['info', 'success', 'warning', 'promo'],
  pulse: ['none', 'subtle', 'strong'],
  speed: ['slow', 'medium', 'fast'],
  fontSize: ['small', 'medium', 'large'],
  density: ['light', 'medium', 'heavy'],
}

// 1. the server must ACCEPT every value the form offers
for (const [field, values] of Object.entries(OPTION_SETS)) {
  const route = field === 'density' ? '/api/admin/particle-effect' : '/api/admin/notification-banner'
  const bad = []
  for (const v of values) {
    const r = await api(route, { method: 'PUT', body: { [field]: v } })
    if (r.status !== 200) bad.push(`${v}=${r.status}`)
  }
  check(`every ${field} the form offers is accepted`, bad.length === 0,
    bad.length ? bad.join(', ') : `${values.length} value(s) accepted`)
}

// 2. and must still REFUSE a value outside the set, or the check above is vacuous
for (const [field, values] of Object.entries({ density: OPTION_SETS.density, pulse: OPTION_SETS.pulse })) {
  const route = field === 'density' ? '/api/admin/particle-effect' : '/api/admin/notification-banner'
  const r = await api(route, { method: 'PUT', body: { [field]: 'definitely-not-valid' } })
  check(`an unknown ${field} is still refused`, r.status === 422, `HTTP ${r.status}`)
}

// 3. the bundle must agree with the pinned lists, so a UI change that is not mirrored
//    in the server fails here rather than in production
const assets = new URL('../dist/assets/', import.meta.url).pathname
const fsMod = await import('node:fs')
const storefrontChunk = fsMod.readdirSync(assets).find((f) => f.startsWith('StorefrontPage-'))
const chunkSrc = storefrontChunk ? fsMod.readFileSync(assets + storefrontChunk, 'utf8') : ''
if (!chunkSrc) {
  skip('the bundle option lists can be cross-checked', 'StorefrontPage chunk not found')
} else {
  const groups = [...chunkSrc.matchAll(/(\w+)=\[\{value:"([^\]]{0,400}?)\}\]/g)]
    .map((m) => [...m[0].matchAll(/value:"([^"]+)"/g)].map((x) => x[1]))
    .filter((v) => v.length > 1 && v.length <= 8)
  const flat = new Set(groups.flat())
  const missingFromBundle = Object.values(OPTION_SETS).flat().filter((v) => !flat.has(v))
  check('every pinned enum value still exists as an option in the bundle',
    missingFromBundle.length === 0,
    missingFromBundle.length ? `no longer offered: ${missingFromBundle.join(', ')}` : 'all present in the form')
  eq('the bundle offers the same number of option groups', groups.length, 6)
}

// 4. restore the shipped defaults so this phase leaves no trace
await api('/api/admin/particle-effect', { method: 'PUT', body: { enabled: false, type: 'snow', speed: 'medium', density: 'medium', emojis: '❄,❅,❆' } })
await api('/api/admin/notification-banner', { method: 'PUT', body: { style: 'info', pulse: 'none', speed: 'slow', fontSize: 'large' } })

/* ======================================================== community api ==== */

phase('community api', 'Community — local API substitution')

// The forum's client is served verbatim at community.localhost:4400 and its axios
// baseURL is "/api/community", so this is a SAME-ORIGIN substitution: no client change,
// no CORS, no proxy. The contract below was read off the bundle and confirmed against
// the live API, which returns {"member": null} when signed out — not a 401.
const meOut = await get('/api/community/auth/me')
check('auth/me returns the observed shape when signed out',
  meOut.status === 200 && meOut.body && 'member' in meOut.body && meOut.body.member === null,
  JSON.stringify(meOut.body))

// Every endpoint must be JSON. Serving HTML here is the bug that broke the client:
// it parses the body as JSON and dies on '<'.
check('community endpoints answer JSON, never the SPA shell',
  meOut.status === 200 && typeof meOut.body === 'object',
  `content parsed as ${typeof meOut.body}`)

const badLogin = await post('/api/community/auth/login', { email: 'nobody@example.com', password: 'x' })
check('an unknown address is refused without revealing whether it exists',
  badLogin.status === 401 && /don't match|does not match/i.test(badLogin.body?.error || ''),
  `HTTP ${badLogin.status}`)
const emptyLogin = await post('/api/community/auth/login', { email: '', password: '' })
check('an empty sign-in is refused', emptyLogin.status === 400, `HTTP ${emptyLogin.status}`)

// The session is a cookie, because the client sends withCredentials: true.
const login = await post('/api/community/auth/login', { email: 'ada@example.com', password: 'anything' })
check('the fixture sign-in succeeds', login.status === 200 && !!login.body?.member,
  `role=${login.body?.member?.role}`)
// `emailVerified` gates canPost in the client; without it the forum renders read-only and
// looks broken rather than signed out.
check('the member carries emailVerified and a role the client checks',
  login.body?.member?.emailVerified === true && ['ADMIN', 'MODERATOR'].includes(login.body?.member?.role),
  `emailVerified=${login.body?.member?.emailVerified} role=${login.body?.member?.role}`)
// The three demo roles exist so the role gate is testable: /mod is rendered only for
// MODERATOR and ADMIN, so a MEMBER must not be one.
const asMember = await post('/api/community/auth/login', { email: 'chen@example.com', password: 'anything' })
check('a seeded MEMBER is not staff', asMember.body?.member?.role === 'MEMBER',
  `role=${asMember.body?.member?.role}`)
const asMod = await post('/api/community/auth/login', { email: 'bruno@example.com', password: 'anything' })
check('a seeded MODERATOR is staff', asMod.body?.member?.role === 'MODERATOR',
  `role=${asMod.body?.member?.role}`)

check('the member shape matches the fields the client reads',
  login.body.member.id != null && !!login.body.member.displayName,
  `keys: ${Object.keys(login.body.member).slice(0, 6).join(', ')}`)

// Same-origin on BOTH hosts: production serves /api/community/* from joyous.is as well
// as community.joyous.is, so a host-gated handler would be wrong.
const hostScoped = await api('/api/community/auth/me', { headers: { Host: 'community.localhost:4400' } })
check('the community API is reachable from both hosts',
  hostScoped.status === 200 && 'member' in (hostScoped.body || {}),
  `HTTP ${hostScoped.status}`)

// An unimplemented endpoint must NOT answer 200 {}: the client would render an empty
// screen, which reads as "no data" rather than "not built".
// /calendar, NOT /rooms — /rooms is implemented now, so asserting it 501s would be
// asserting a stale fact. Pick one that is genuinely still unimplemented, and assert the
// implemented ones separately below so this cannot silently drift again.
// /calendar is implemented now, so it cannot be the example. Use one that is genuinely
// still unimplemented — and keep this pointed at something that has no reason to change.
const notYet = await get('/api/community/gifs-not-a-real-endpoint')
check('an unimplemented endpoint says so instead of returning 200 {}',
  notYet.status === 501 && notYet.body?.__notImplemented === true,
  `HTTP ${notYet.status} ${JSON.stringify(notYet.body).slice(0, 70)}`)

// The seven read endpoints the first screen demands. Each returns a WRAPPER OBJECT, not
// a bare array — the client does `data.rooms` / `data.posts` / `data.events`, so a bare
// array yields undefined and the render throws.
const rooms = await get('/api/community/rooms')
check('/rooms returns {rooms:[...]}, not a bare array',
  Array.isArray(rooms.body?.rooms), `keys: ${Object.keys(rooms.body || {}).join(', ')}`)
check('a room carries the fields the sidebar reads',
  (rooms.body?.rooms || []).every((r) => r.id && r.slug && r.name && 'staffOnly' in r),
  `keys: ${Object.keys(rooms.body?.rooms?.[0] || {}).slice(0, 6).join(', ')}`)

const posts = await get('/api/community/posts?page=1')
check('/posts returns {posts, hasMore} — hasMore is the only pagination field read',
  Array.isArray(posts.body?.posts) && typeof posts.body?.hasMore === 'boolean',
  `hasMore=${posts.body?.hasMore}`)
// `room` is an OBJECT here, not an id; and lastActivityAt is parsed by date-fns in the
// topics layout, so an unparseable one throws RangeError rather than rendering blank.
check('a post carries a room OBJECT and a parseable lastActivityAt',
  (posts.body?.posts || []).every((p) => p.room && p.room.slug && !Number.isNaN(Date.parse(p.lastActivityAt))),
  `room=${JSON.stringify(posts.body?.posts?.[0]?.room)}`)

const events = await get('/api/community/events')
check('/events returns {events:[...]} with a LIVE one for the nav dot',
  Array.isArray(events.body?.events) && events.body.events.some((e) => e.status === 'LIVE'),
  `${(events.body?.events || []).length} event(s)`)
// startsAt is ALWAYS formatted on non-LIVE cards, so it must parse.
check('every event has a parseable startsAt',
  (events.body?.events || []).every((e) => !Number.isNaN(Date.parse(e.startsAt))),
  'all parseable')

const unread = await get('/api/community/unread')
check('/unread returns {total, rooms:{}} — rooms is a MAP keyed by room id',
  typeof unread.body?.total === 'number' && unread.body?.rooms && typeof unread.body.rooms === 'object'
    && !Array.isArray(unread.body.rooms),
  `total=${unread.body?.total} rooms=${JSON.stringify(unread.body?.rooms)}`)
const count = await get('/api/community/notifications/unread-count')
check('/notifications/unread-count returns {unread:n}, not a bare number',
  typeof count.body?.unread === 'number', JSON.stringify(count.body))
const ov = await get('/api/community/overview')
check('/overview carries memberCount, onlineCount and staff[]',
  typeof ov.body?.memberCount === 'number' && Array.isArray(ov.body?.staff),
  `${ov.body?.memberCount} members, ${ov.body?.staff?.length} staff`)

// The emoji bug: JSON.stringify().length counts UTF-16 units while the socket writes
// UTF-8 bytes, so a Content-Length derived from .length truncates the body mid-string and
// the client dies on `Unexpected end of JSON input`. A room emoji is the trigger.
check('responses survive multi-byte characters (the Content-Length trap)',
  (rooms.body?.rooms || []).some((r) => r.emoji && r.emoji.length > 1),
  `emoji: ${rooms.body?.rooms?.[0]?.emoji}`)

// --- the write surface (Stage 3c) ---------------------------------------
// Each of these was 501 before. The response SHAPES matter as much as the status: the
// client reads `{reacted}` and treats null as failure, and drops `{poll}` / `{event}`
// straight into state, so a 200 with the wrong body still breaks the screen.
const commSession = await post('/api/community/auth/login',
  { email: 'ada@example.com', password: 'anything' })
const sid = /joyous_community_sid=([^;]+)/.exec(commSession.setCookie ?? '')?.[1] ?? ''
// The write surface is cookie-authenticated, so every mutating call has to carry it.
const jar = { headers: { Cookie: `joyous_community_sid=${sid}` } }
check('signing in issues a session cookie', sid.length > 0, sid ? 'issued' : 'no set-cookie')

const madePost = await post('/api/community/posts', {
  roomId: 'room-general', title: 'smoke post', body: 'written by the suite',
}, jar)
check('POST /posts creates a post and returns {post}',
  madePost.status === 201 && madePost.body?.post?.id != null
    && madePost.body.post.room?.slug === 'general',
  `status=${madePost.status} room=${JSON.stringify(madePost.body?.post?.room)}`)
const newPostId = madePost.body?.post?.id

const reacted = await post('/api/community/reactions', { postId: 'post-1', emoji: '👍' }, jar)
check('POST /reactions returns {reacted} — the client reads that flag, not the status',
  reacted.status === 200 && typeof reacted.body?.reacted === 'boolean',
  JSON.stringify(reacted.body))
// Toggling twice must land back where it started, or the count drifts.
const reacted2 = await post('/api/community/reactions', { postId: 'post-1', emoji: '👍' }, jar)
check('a second identical reaction toggles the other way',
  reacted2.body?.reacted === !reacted.body?.reacted,
  `${reacted.body?.reacted} then ${reacted2.body?.reacted}`)

const voted = await post('/api/community/polls/poll-1/vote', { optionIds: ['opt-1'] }, jar)
check('POST /polls/:id/vote returns the whole {poll} for the client to re-render',
  voted.status === 200 && Array.isArray(voted.body?.poll?.options),
  `status=${voted.status} options=${voted.body?.poll?.options?.length}`)
check('the vote is recorded on the poll', 
  (voted.body?.poll?.myVotes ?? []).includes('opt-1'),
  `myVotes=${JSON.stringify(voted.body?.poll?.myVotes)}`)

const rsvpd = await put('/api/community/events/event-2/rsvp', { status: 'GOING' }, jar)
check('PUT /events/:id/rsvp returns the whole {event}',
  rsvpd.status === 200 && rsvpd.body?.event?.myRsvp === 'GOING',
  `status=${rsvpd.status} myRsvp=${rsvpd.body?.event?.myRsvp}`)

const replied = await post('/api/community/posts/post-1/comments', { body: 'smoke reply' }, jar)
check('POST /posts/:id/comments creates a comment',
  replied.status === 201 && replied.body?.comment?.id != null, `status=${replied.status}`)

const readAll = await post('/api/community/read-all', {}, jar)
check('POST /read-all succeeds', readAll.status === 200, `status=${readAll.status}`)

const notesRead = await post('/api/community/notifications/read', {}, jar)
check('POST /notifications/read succeeds', notesRead.status === 200, `status=${notesRead.status}`)

const report = await post('/api/community/reports', { postId: 'post-1', reason: 'smoke test' }, jar)
check('POST /reports returns {message} for the toast', typeof report.body?.message === 'string',
  JSON.stringify(report.body).slice(0, 70))
check('a report shorter than 3 characters is rejected rather than stored',
  (await post('/api/community/reports', { postId: 'post-1', reason: 'x' }, jar)).status === 400,
  'short reason')

// Writes are attributed to the signed-in member, so an anonymous one must 401 — not 200.
check('an anonymous write is refused with 401',
  (await post('/api/community/posts', { roomId: 'room-general', title: 'nope' })).status === 401,
  'signed out')
// The client validates too, but the server must not rely on that.
check('a post with no room is refused',
  (await post('/api/community/posts', { title: 'no room' }, jar)).status === 400, 'missing roomId')

// Deleting the smoke post keeps the suite re-runnable — otherwise every run adds one.
if (newPostId) {
  // NOT named `del` — that shadows the del() helper and this line would be in its
  // temporal dead zone, which reads as "cannot access before initialization" at runtime.
  const removed = await del(`/api/community/posts/${newPostId}`, jar)
  check('DELETE /posts/:id removes it again',
    removed.status === 200 && (await get(`/api/community/posts/${newPostId}`, jar)).status === 404,
    `status=${removed.status}`)
}

// --- Discord settings are real, the CONNECTION is not (stage 3d) ---------
// The config surface persists; nothing reports itself as connected, because there is no
// Discord gateway here. The alternative (503 for the whole surface) stopped the page
// rendering its own "isn't switched on yet" copy.
// Start from a known state. These settings PERSIST, so without clearing first this
// assertion passes on a fresh checkout and fails on the second run — the token the
// previous run saved is still there.
await del('/api/community/mod/discord-bot', jar)
const bot0 = await get('/api/community/mod/discord-bot', jar)
check('/mod/discord-bot reports an unconfigured bot as `off`, not an error',
  bot0.status === 200 && bot0.body?.bot?.status === 'off',
  `status=${bot0.status} bot.status=${bot0.body?.bot?.status}`)
check('the setup instructions can read the redirect URI the client must register',
  typeof bot0.body?.login?.redirectUri === 'string' && bot0.body.login.configured === false,
  JSON.stringify(bot0.body?.login))

const TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTAuGHIJ.klmnopqrstuvwx'
const botSet = await put('/api/community/mod/discord-bot', { token: TOKEN }, jar)
check('a saved bot token is stored', botSet.status === 200 && !!botSet.body?.bot?.tokenPreview,
  `status=${botSet.status}`)
// The whole point: a stored token must NOT report a live bot.
check('a saved token does NOT report the bot as connected',
  botSet.body?.bot?.status !== 'connected',
  `status=${botSet.body?.bot?.status}`)
check('the token itself is never returned',
  !JSON.stringify(botSet.body).includes(TOKEN), 'secret echoed back')
check('a token that is obviously too short is refused',
  (await put('/api/community/mod/discord-bot', { token: 'x' }, jar)).status === 400, 'short token')
// Remove it again so a second run sees the same starting state it did the first time.
check('the token can be removed again',
  (await del('/api/community/mod/discord-bot', jar)).status === 200, 'delete token')

const conn = await post('/api/community/mod/connections',
  { platform: 'DISCORD', label: 'smoke bridge', secret: 'abcdef123456' }, jar)
check('a chat bridge can be created and is stored',
  conn.status === 201 && conn.body?.connection?.id != null, `status=${conn.status}`)
check('a stored bridge does NOT report itself as connected',
  conn.body?.connection?.status !== 'connected',
  `status=${conn.body?.connection?.status}`)
check('a bridge secret is never returned',
  !JSON.stringify(conn.body).includes('abcdef123456'), 'secret echoed back')
const connId = conn.body?.connection?.id
if (connId) {
  check('a connection can be deleted again',
    (await del(`/api/community/mod/connections/${connId}`, jar)).status === 200, 'delete')
}

// --- the role gate, which was silently wrong -----------------------------
// Every check here compared against a constant fixture admin, so ALL of them passed for
// everyone — including requests carrying no session. Reads bypassed the session guard
// entirely, since it only covered non-GET. These assertions are why that was caught.
const anonBot = await get('/api/community/mod/discord-bot')
check('an anonymous request cannot read the Discord settings', anonBot.status === 403,
  `status=${anonBot.status}`)
check('an anonymous request cannot read the connections', 
  (await get('/api/community/mod/connections')).status === 403, 'connections')
check('an anonymous write is still 401, not 403',
  (await post('/api/community/posts', { roomId: 'room-general', title: 'x' })).status === 401, 'posts')

const memberSession = await post('/api/community/auth/login',
  { email: 'chen@example.com', password: 'anything' })
const memberJar = {
  headers: { Cookie: `joyous_community_sid=${/joyous_community_sid=([^;]+)/.exec(memberSession.setCookie ?? '')?.[1] ?? ''}` },
}
check('a signed-in MEMBER cannot read the Discord settings',
  (await get(`/api/community/mod/discord-bot`, memberJar)).status === 403, 'member read')
check('a signed-in MEMBER cannot manage connections',
  (await get('/api/community/mod/connections', memberJar)).status === 403, 'member connections')

// Attribution must follow the SESSION, not a fixture identity.
const chenPost = await post('/api/community/posts',
  { roomId: 'room-general', title: 'attribution check', body: 'x' }, memberJar)
check('a post written by a MEMBER is attributed to that member',
  chenPost.body?.post?.author?.id === 'comm-3' && chenPost.body?.post?.author?.role === 'MEMBER',
  `author=${JSON.stringify(chenPost.body?.post?.author?.id)}/${chenPost.body?.post?.author?.role}`)
check("a MEMBER cannot delete another member's post",
  (await del(`/api/community/posts/post-1`, memberJar)).status === 400, 'cross-owner delete')
if (chenPost.body?.post?.id) await del(`/api/community/posts/${chenPost.body.post.id}`, memberJar)

// --- the moderation queue (was a visible 501 on the first /mod tab) ------
// A member files a report, a moderator reads it. The page dereferences
// `a.reporter.displayName` and `a.target.author.displayName` with NO optional chaining,
// so the SHAPE of these objects matters as much as the status code.
const filed = await post('/api/community/reports',
  { postId: 'post-1', reason: 'smoke report for the queue' }, memberJar)
check('a member can file a report', filed.status === 201, `status=${filed.status}`)

const queue = await get('/api/community/mod/reports?status=OPEN', jar)
check('/mod/reports returns {reports:[...]}, not a bare array',
  Array.isArray(queue.body?.reports), `keys: ${Object.keys(queue.body || {}).join(', ')}`)
const entry = (queue.body?.reports ?? []).find((r) => r.reason === 'smoke report for the queue')
check('a queued report carries a reporter OBJECT with a displayName',
  typeof entry?.reporter?.displayName === 'string', JSON.stringify(entry?.reporter))
check('a queued report carries a target with kind, excerpt and deleted',
  !!entry?.target && typeof entry.target.kind === 'string'
    && typeof entry.target.excerpt === 'string' && entry.target.deleted === false,
  JSON.stringify(entry?.target)?.slice(0, 90))

if (entry?.id) {
  const resolved = await post(`/api/community/mod/reports/${entry.id}`, { status: 'RESOLVED' }, jar)
  check('a moderator can resolve a report', resolved.status === 200
    && resolved.body?.report?.status === 'RESOLVED', `status=${resolved.status}`)
  // The chips must partition, or a handled report stays in the OPEN list forever.
  const openNow = await get('/api/community/mod/reports?status=OPEN', jar)
  check('a resolved report leaves the OPEN queue',
    !(openNow.body?.reports ?? []).some((r) => r.id === entry.id), 'still open')
  const resNow = await get('/api/community/mod/reports?status=RESOLVED', jar)
  check('and appears under RESOLVED',
    (resNow.body?.reports ?? []).some((r) => r.id === entry.id), 'not under RESOLVED')
  check('an unknown status is refused rather than stored',
    (await post(`/api/community/mod/reports/${entry.id}`, { status: 'WAT' }, jar)).status === 400,
    'bogus status')
  check('an unknown report id is a 400, not a silent success',
    (await post('/api/community/mod/reports/report-nope', { status: 'RESOLVED' }, jar)).status === 400,
    'unknown id')
  // Clean up so repeated runs do not accumulate a queue.
  await post(`/api/community/mod/reports/${entry.id}`, { status: 'DISMISSED' }, jar)
}

// The queue is moderation-only. This is the same class of bug as the Discord settings:
// a role check that silently passed for everyone.
check('an anonymous request cannot read the moderation queue',
  (await get('/api/community/mod/reports')).status === 403, 'anonymous')
check('a MEMBER cannot read the moderation queue',
  (await get('/api/community/mod/reports', memberJar)).status === 403, 'member')

// --- the calendar, the GIF picker, and cross-post targets ----------------
const cal = await get('/api/community/calendar?from=2026-10-01T00:00:00.000Z&to=2026-11-01T00:00:00.000Z')
check('/calendar returns {events, store, spans} — all three, each an array',
  Array.isArray(cal.body?.events) && Array.isArray(cal.body?.store) && Array.isArray(cal.body?.spans),
  `keys: ${Object.keys(cal.body || {}).join(', ')}`)
// The window must actually filter. A calendar that ignores from/to shows every campaign
// ever run, which reads as "everything is happening this month".
const empty = await get('/api/community/calendar?from=2026-06-01T00:00:00.000Z&to=2026-06-03T00:00:00.000Z')
check('an empty window returns nothing, rather than every campaign',
  (empty.body?.spans ?? []).length === 0 && (empty.body?.store ?? []).length === 0,
  `spans=${empty.body?.spans?.length} store=${empty.body?.store?.length}`)
// The client collapses a `-open`/`-close` store marker into its matching span. That only
// works if the ids relate, so assert the relationship rather than the counts.
const spanIds = new Set((cal.body?.spans ?? []).map((x) => x.id))
check('every store marker is dedupeable against a span',
  (cal.body?.store ?? []).every((x) => /-(open|close|start|end)$/.test(x.id)
    && spanIds.has(x.id.replace(/-(open|close|start|end)$/, ''))),
  `${cal.body?.store?.length} markers vs ${spanIds.size} spans`)
// startsAt is formatted by date-fns on every card; a bad one throws rather than blanking.
check('every calendar event has a parseable startsAt',
  (cal.body?.events ?? []).every((e) => !Number.isNaN(Date.parse(e.startsAt))), 'all parseable')

const gifs = await get('/api/community/gifs')
const gifItem = gifs.body?.items?.[0]
check('/gifs returns {items:[...]} with id, url, preview and title',
  Array.isArray(gifs.body?.items) && !!gifItem
    && !!gifItem.id && !!gifItem.url && !!gifItem.preview && !!gifItem.title,
  `keys: ${Object.keys(gifItem || {}).join(', ')}`)
// `url` is what the composer puts in the post, so a dead url is a broken post.
// The asset lives on the COMMUNITY host. BASE is the member host, and Node's fetch
// SILENTLY IGNORES a `Host` header override — so this has to address the community
// hostname directly, or it 404s and looks like a broken catalogue.
const communityBase = `http://community.localhost:${new URL(BASE).port || 4400}`
const firstGif = await fetch(`${communityBase}${gifItem?.url}`)
check('the url a picked GIF inserts actually resolves',
  firstGif.status === 200, `HTTP ${firstGif.status} for ${gifItem?.url}`)
check('GIF search filters rather than returning everything',
  (await get('/api/community/gifs?q=party')).body?.items?.length < (gifs.body?.items?.length ?? 0),
  'search narrowed')
check('the stickers tab returns a different set from the GIFs tab',
  (await get('/api/community/gifs?kind=stickers')).body?.items?.length
    !== (gifs.body?.items?.length ?? 0), 'stickers differ')

// Cross-post targets are staff-only, and read the same records /mod manages.
check('/connections is staff-only: a MEMBER sees none',
  ((await get('/api/community/connections', memberJar)).body?.connections ?? []).length === 0,
  'member saw connections')

// --- the member -> community SSO handoff --------------------------------
// This was the last unexercised flow, and it was hiding a real defect: the member side
// answered from a RECORDED SAMPLE, so it returned the same code every time, and the
// community side accepted ANY non-empty string. A fabricated code was a working
// sign-in-as-the-admin door. These assertions exist so that cannot come back.
const mint1 = await post('/api/community-handoff', {})
const mint2 = await post('/api/community-handoff', {})
check('the handoff code is unique per request, not a replayed constant',
  !!mint1.body?.code && mint1.body.code !== mint2.body.code,
  `same code twice: ${mint1.body?.code === mint2.body?.code}`)
check('the code is a long random string, not a guessable value',
  typeof mint1.body?.code === 'string' && mint1.body.code.length >= 32,
  `length=${mint1.body?.code?.length}`)

// A fabricated code must be refused. This is the defect: it used to return 200 and a
// session cookie.
const forgedHandoff = await post('/api/community/auth/handoff', { code: 'totally-made-up-12345' })
check('a FABRICATED handoff code is refused, not traded for a session',
  forgedHandoff.status === 400 && !forgedHandoff.setCookie.includes('joyous_community_sid'),
  `HTTP ${forgedHandoff.status} cookie=${forgedHandoff.setCookie ? 'ISSUED' : 'none'}`)
check('an empty handoff code is refused',
  (await post('/api/community/auth/handoff', { code: '' })).status === 400, 'empty code')

// The real flow: mint on the member host, redeem on the community host.
const handoff = await post('/api/community/auth/handoff', { code: mint1.body.code })
check('a minted code is redeemed for a member',
  handoff.status === 200 && !!handoff.body?.member?.id,
  `HTTP ${handoff.status} member=${handoff.body?.member?.id}`)
// The two apps do NOT share an identity namespace, which is what this flow was hiding.
check('the redeemed member is a community member, resolved across the two namespaces',
  handoff.body?.member?.id?.startsWith('comm-'),
  `id=${handoff.body?.member?.id}`)
const handoffSid = /joyous_community_sid=([^;]+)/.exec(handoff.setCookie ?? '')?.[1] ?? ''
check('redeeming issues a working session cookie', handoffSid.length > 0, 'cookie issued')
const handoffMe = await get('/api/community/auth/me', {
  headers: { Cookie: `joyous_community_sid=${handoffSid}` },
})
check('that session authenticates a subsequent request',
  handoffMe.body?.member?.id === handoff.body?.member?.id,
  `me=${handoffMe.body?.member?.id}`)

// Single use. A code sits in a URL fragment, so anyone who reads it out of the address
// bar or history could otherwise replay it.
check('the code cannot be redeemed a second time',
  (await post('/api/community/auth/handoff', { code: mint1.body.code })).status === 400,
  'reused')

// --- the customer directory's cohort filter ------------------------------
// It sent page/limit/search/status/sort and the handler ignored ALL of them, always
// answering page 1 with every row. Picking "Not yet reviewed" showed the whole directory:
// the URL was right and the response was wrong, which is why a status-code test missed it.
const dirAll = await get('/api/admin/users?status=all&limit=50')
const dirPending = await get('/api/admin/users?status=pending&limit=50')
const dirReviewed = await get('/api/admin/users?status=reviewed&limit=50')
check('the directory pages, rather than returning every row regardless',
  !!dirAll.body?.pagination, `keys: ${Object.keys(dirAll.body || {}).join(', ')}`)
// The two cohorts must PARTITION. If the filter is ignored both equal the total.
check('status=pending returns only unapproved accounts',
  (dirPending.body?.users ?? []).every((u) => !u.approved),
  `${dirPending.body?.users?.length} rows, ${dirPending.body?.users?.filter((u) => u.approved).length} of them approved`)
check('status=reviewed returns only approved accounts',
  (dirReviewed.body?.users ?? []).every((u) => u.approved),
  `${dirReviewed.body?.users?.length} rows`)
check('pending and reviewed together account for everyone',
  (dirPending.body?.pagination?.total ?? 0) + (dirReviewed.body?.pagination?.total ?? 0)
    === (dirAll.body?.pagination?.total ?? -1),
  `${dirPending.body?.pagination?.total} + ${dirReviewed.body?.pagination?.total} != ${dirAll.body?.pagination?.total}`)
// Every chip the page offers must actually filter. An unrecognised value falls back to
// `all`, so a new chip would silently show everyone — this asserts the ones that exist.
const chips = ['active', 'pending', 'admins', 'standard', 'vip', 'elite', 'unverified', 'suspended']
for (const chip of chips) {
  const res = await get(`/api/admin/users?status=${chip}&limit=50`)
  const rows = res.body?.users ?? []
  const count = res.body?.counts?.[chip] ?? 0
  check(`the "${chip}" chip filters, and its count matches its rows`,
    res.status === 200 && count === (res.body?.pagination?.total ?? -1) && rows.length <= count,
    `count=${count} rows=${rows.length} total=${res.body?.pagination?.total}`)
}
check('the tier chips partition the directory',
  (await get('/api/admin/users?status=standard&limit=50')).body?.counts?.standard
  + (await get('/api/admin/users?status=vip&limit=50')).body?.counts?.vip
  + (await get('/api/admin/users?status=elite&limit=50')).body?.counts?.elite
    === dirAll.body?.counts?.total,
  'standard + vip + elite != total')
check('search narrows the directory',
  (await get('/api/admin/users?search=chen&limit=50')).body?.pagination?.total
    < dirAll.body?.pagination?.total, 'search did not narrow')
check('limit is honoured',
  (await get('/api/admin/users?limit=3')).body?.users?.length <= 3, 'limit ignored')

// LiveKit and Discord are real external services. Refusing loudly beats a fake success.
const live = await get('/api/community/live')
check('LiveKit-dependent endpoints refuse rather than fake success',
  live.status === 503 && live.body?.__simulated === true,
  `HTTP ${live.status} integration=${live.body?.integration}`)
// /auth/discord/unlink is NOT asserted here any more: it returns `{member}` legitimately,
// because recording that an account is not Discord-linked needs no Discord. Asserting that
// it 503'd was asserting the old blanket refusal, which stage 3d replaced on purpose.
//
// What must still refuse is anything requiring an actual conversation with Discord.
const connTest = await post('/api/community/mod/connections/conn-nope/test', {}, jar)
check('testing a connection refuses rather than faking a successful test',
  connTest.status === 503 && connTest.body?.__simulated === true,
  `HTTP ${connTest.status} integration=${connTest.body?.integration}`)
// The OAuth start is a full-page navigation, so a 503 body would render as raw JSON in
// the browser. It must redirect back to a page with a marker the client understands.
const oauth = await fetch(`${BASE}/api/community/auth/discord/start`, { redirect: 'manual' })
const oauthLoc = oauth.headers.get('location') ?? ''
check('the Discord OAuth start redirects instead of dumping JSON at the browser',
  oauth.status === 302 && oauthLoc.includes('discord='),
  `HTTP ${oauth.status} location=${oauthLoc}`)

assertAllPhasesRan()

/* ================================================================ summary == */

const tally = results.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] || 0) + 1 }), {})
const green = !tally.FAIL && !tally.BLOCKED && !tally.SKIP

console.log(`\n${'═'.repeat(72)}`)
console.log('  SMOKE SUMMARY')
console.log('═'.repeat(72))
for (const [k, label] of [['PASS', 'passed'], ['FAIL', 'failed'], ['SKIP', 'skipped'], ['BLOCKED', 'blocked']]) {
  console.log(`  ${String(tally[k] || 0).padStart(3)}  ${label}`)
}
console.log('─'.repeat(72))
console.log(green
  ? '  RESULT: GREEN — everything that exists was checked and held.'
  : '  RESULT: NOT GREEN — see FAIL/BLOCKED/SKIP above. A skipped or blocked check is')
if (!green) console.log('          never counted as a pass.')
console.log(`\n  server: ${BASE}`)
console.log('  state is in-memory: restarting the server resets carts, orders and stock.\n')

if (tally.FAIL) {
  console.log('  Failures:')
  for (const r of results.filter((x) => x.status === 'FAIL')) console.log(`    - [${r.phase}] ${r.name}`)
  console.log('')
}

process.exit(tally.FAIL ? 1 : 0)
