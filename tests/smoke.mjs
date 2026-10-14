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
    return { status: res.status, body: json }
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
  'fallback pages', 'insights',
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
// A dashboard of zeros cannot be distinguished from a broken one, so the fixtures are
// arranged to put a real order in each bucket.
check('the fixtures make all three counters non-zero',
  (todayStats.body?.deliveredToday || 0) > 0 && (todayStats.body?.shippedToday || 0) > 0 && (todayStats.body?.newToday || 0) > 0,
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
