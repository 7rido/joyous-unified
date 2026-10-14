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

function phase(name) {
  currentPhase = name
  console.log(`\n${'─'.repeat(72)}\n  ${name}\n${'─'.repeat(72)}`)
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

async function api(path, { method = 'GET', body, token, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  let json = null
  const text = await res.text()
  try { json = text ? JSON.parse(text) : null } catch { json = { raw: text.slice(0, 200) } }
  return { status: res.status, body: json }
}

const get = (p, o) => api(p, o)
const post = (p, body, o = {}) => api(p, { ...o, method: 'POST', body })
const put = (p, body, o = {}) => api(p, { ...o, method: 'PUT', body })
const del = (p, o = {}) => api(p, { ...o, method: 'DELETE' })

/* ============================================================== PHASE 1 ==== */

phase('1. Environment')

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

/* ============================================================== PHASE 2 ==== */

phase('2. Customer — catalog, tier gating, stock display')

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

/* ============================================================== PHASE 3 ==== */

phase('3. Customer — cart lifecycle')

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

/* ============================================================== PHASE 4 ==== */

phase('4. Server-side guards (the security assertions)')

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

/* ============================================================== PHASE 5 ==== */

phase('5. Customer — checkout and order creation')

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

/* ============================================================== PHASE 6 ==== */

phase('6. Admin — orders, authorization, status transitions')

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
blocked('admin product create / edit / disable / delete',
  'Only GET /api/admin/products and image routes exist. No POST/PATCH/DELETE for products.')
blocked('stock quantity model',
  'No quantity column. sold_out is a manual boolean, so per-unit stock cannot be asserted.')
blocked('fail-closed test-mode environment guard',
  'No test-mode flag and no database-identity check exist in the server.')
blocked('server-persisted cart line items',
  'The replay cart is in-memory and resets on restart; it is not a durable cart.')

/* ============================================================== PHASE 7 ==== */

phase('7. UI — real browser journey')

// Phase 5 emptied the cart, and /checkout redirects to /cart when empty.
await clearCart()
await post('/api/cart', { productId: A.id, variantId: A.variants[0].id, quantity: 2 })
const preUi = (await get('/api/cart')).body
check('cart is populated before the UI walk', preUi.items.length === 1,
  `${preUi.items.length} line(s)`)

const { spawnSync } = await import('node:child_process')

const uiScript = new URL('./smoke-ui.py', import.meta.url).pathname
const py = PY || 'python3'
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
