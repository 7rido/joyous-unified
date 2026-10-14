/**
 * Seeded admin fixtures, and the mutations behind the admin buttons.
 *
 * WHY THIS EXISTS
 * Most admin screens render their empty state, which makes it impossible to tell "this
 * feature is missing" from "there is no data". This supplies a complete, obviously-fake
 * dataset so every screen can be judged on the feature — and, more importantly, so the
 * archive / visibility / NEW-badge / approval / status actions have something to act on.
 *
 * EVERY RECORD HERE IS FABRICATED. Names, emails, addresses and tracking numbers are
 * synthetic, marked `__seed`, and use example.com / 555 numbers so nobody mistakes them
 * for real customers. Nothing contacts a carrier, a payment provider or a mailbox.
 *
 * WHY IT LIVES IN A MODULE
 * server.mjs is already ~1900 lines. The fixtures and the mutation helpers are one
 * cohesive concern, and keeping them here means the routes stay thin.
 */

export const SEED_MARK = '__seed'

/* --------------------------------------------------------------- customers --- */

const CUSTOMERS = [
  { email: 'ada.reyes@example.com', name: 'Ada Reyes', tier: 'ELITE', approved: true, orders: 6, spent: 2841.5 },
  { email: 'bruno.sato@example.com', name: 'Bruno Sato', tier: 'VIP', approved: true, orders: 4, spent: 962.0 },
  { email: 'chen.wei@example.com', name: 'Chen Wei', tier: 'VIP', approved: true, orders: 3, spent: 741.25 },
  { email: 'dara.okafor@example.com', name: 'Dara Okafor', tier: 'ELITE', approved: true, orders: 5, spent: 1980.0 },
  { email: 'elif.demir@example.com', name: 'Elif Demir', tier: 'USER', approved: false, orders: 0, spent: 0 },
  { email: 'farid.haddad@example.com', name: 'Farid Haddad', tier: 'USER', approved: true, orders: 1, spent: 88.0 },
  { email: 'gita.nair@example.com', name: 'Gita Nair', tier: 'VIP', approved: true, orders: 2, spent: 415.75 },
  { email: 'hana.kim@example.com', name: 'Hana Kim', tier: 'ELITE', approved: true, orders: 4, spent: 1502.0 },
  { email: 'ivan.petrov@example.com', name: 'Ivan Petrov', tier: 'USER', approved: false, orders: 0, spent: 0 },
  { email: 'juno.alvarez@example.com', name: 'Juno Alvarez', tier: 'VIP', approved: true, orders: 3, spent: 655.0 },
]

/** Two awaiting approval, so the Approvals tab is not empty. */
const AWAITING_APPROVAL = ['elif.demir@example.com', 'ivan.petrov@example.com']

export function seedCustomers() {
  return CUSTOMERS.map((c, i) => ({
    id: `seed-cust-${i + 1}`,
    email: c.email,
    firstName: c.name.split(' ')[0],
    lastName: c.name.split(' ')[1] ?? '',
    name: c.name,
    tier: c.tier,
    role: 'member',
    approved: c.approved,
    emailVerified: true,
    isAdmin: false,
    createdAt: new Date(Date.UTC(2026, 0, 8 + i * 3, 14, 20)).toISOString(),
    orderCount: c.orders,
    totalSpent: c.spent,
    phone: `55555501${String(10 + i).slice(-2)}`,
    [SEED_MARK]: true,
  }))
}

/* ------------------------------------------------------------------ orders --- */

/**
 * Orders across the states the admin actually filters on: awaiting payment review,
 * payment confirmed, shipped (with tracking), delivered, and archived. Amounts are
 * consistent with the line items so a totals check has something true to compare.
 */
const ORDER_PLAN = [
  { who: 0, status: 'AWAITING_PAYMENT_REVIEW', confirmed: false, items: [['BPC-157 5mg', 2, 15]], method: 'Zelle' },
  { who: 1, status: 'PAYMENT_CONFIRMED', confirmed: true, items: [['CJC-1295 (No DAC) 5mg', 1, 15]], method: 'USDT' },
  { who: 3, status: 'SHIPPED', confirmed: true, carrier: 'USPS', track: '9405511202555123456789', trackingStatus: 'IN_TRANSIT', items: [['GHK-CU 100mg', 3, 20], ['BPC-157 5mg', 1, 15]], method: 'Zelle' },
  { who: 7, status: 'DELIVERED', confirmed: true, carrier: 'UPS', track: '1Z999AA10123456784', trackingStatus: 'DELIVERED', items: [['SS-31 50mg', 1, 45]], method: 'Chime' },
  { who: 6, status: 'SHIPPED', confirmed: true, carrier: 'FedEx', track: '772019283746', trackingStatus: 'OUT_FOR_DELIVERY', items: [['Tesamorelin 10mg / vial', 2, 25]], method: 'Bitcoin' },
  { who: 9, status: 'AWAITING_PAYMENT_REVIEW', confirmed: false, items: [['BPC-157 5mg', 5, 15]], method: 'Zelle' },
  { who: 5, status: 'PAYMENT_CONFIRMED', confirmed: true, items: [['JB-3-R 30mg', 1, 60]], method: 'USDT' },
  { who: 2, status: 'DELIVERED', confirmed: true, carrier: 'USPS', track: '9400111899223197428490', trackingStatus: 'DELIVERED', items: [['AOD-9604 5mg', 2, 20], ['Aqualyx 8ml Vial', 1, 30]], method: 'Zelle' },
  { who: 4, status: 'ARCHIVED', confirmed: false, archived: true, items: [['Melanotan II 10mg', 1, 30]], method: 'Zelle' },
  { who: 8, status: 'AWAITING_PAYMENT_REVIEW', confirmed: false, items: [['Methylene Blue 60 caps', 1, 35]], method: 'Chime' },
  { who: 1, status: 'DELIVERED', confirmed: true, carrier: 'DHL', track: 'JD0146000038291744', trackingStatus: 'DELIVERED', items: [['Semax 10mg', 1, 40]], method: 'Zelle' },
  { who: 0, status: 'SHIPPED', confirmed: true, carrier: 'USPS', track: '9405511202555987654321', trackingStatus: 'PRE_SHIPMENT', items: [['NAD+ 500mg', 2, 55]], method: 'USDT' },
]

export function seedOrders() {
  const customers = seedCustomers()
  const out = []
  const base = Date.UTC(2026, 9, 6, 15, 30)
  ORDER_PLAN.forEach((plan, i) => {
    const cust = customers[plan.who]
    // Declared AFTER `cust`: `const` does not hoist, and using it earlier threw
    // "Cannot access 'cust' before initialization" at module load.
    const items = plan.items.map(([title, qty, price], k) => ({
      title, qty, price,
      totalPrice: qty * price,
      id: `seed-item-${i}-${k}`,
      itemName: title,
      pricePerUnit: price,
      quantity: qty,
    }))
    const subtotal = items.reduce((n, x) => n + x.totalPrice, 0)
    const adminFee = Math.round(subtotal * 0.02 * 100) / 100
    const number = `#${12000 + i}`
    out.push({
      id: `seed-order-${i + 1}`,
      orderNumber: number,
      number,
      status: plan.status,
      confirmed: plan.confirmed,
      archived: !!plan.archived,
      customer: cust.email,
      customerName: cust.name,
      email: cust.email,
      name: cust.name,
      userId: cust.id,
      user: { id: cust.id, email: cust.email, firstName: cust.firstName, lastName: cust.lastName, tier: cust.tier },
      method: plan.method,
      items,
      subtotal,
      discountAmount: 0,
      discountCode: null,
      shippingCost: 0,
      insuranceCost: 0,
      coaCost: 0,
      adminFee,
      paymentMethodFee: 0,
      total: Math.round((subtotal + adminFee) * 100) / 100,
      totalAmount: Math.round((subtotal + adminFee) * 100) / 100,
      tracking: plan.carrier
        ? { carrier: plan.carrier, number: plan.track, status: plan.trackingStatus }
        : null,
      placedAt: new Date(base + i * 86400000 * 0.7).toISOString(),
      createdAt: new Date(base + i * 86400000 * 0.7).toISOString(),
      shippingAddress: {
        fullName: cust.name,
        addressLine1: `${100 + i} Example Avenue`,
        addressLine2: '',
        city: 'Springfield',
        state: 'IL',
        zipCode: '62704',
        country: 'US',
        phone: cust.phone,
      },
      paymentProof: plan.confirmed ? { uploadedAt: new Date(base + i * 86400000 * 0.7 + 3600000).toISOString(), bytes: 240000 + i * 1000, stored: false } : null,
      [SEED_MARK]: true,
    })
  })
  return out
}

/* ----------------------------------------------------------------- tickets --- */

/** One of each issue type the support queue filters on. */
const TICKET_PLAN = [
  { subject: 'Vial arrived cracked', who: 1, status: 'OPEN', priority: 'HIGH', category: 'SHIPPING', issue: 'DAMAGED_IN_TRANSIT', resolution: 'ATTENTION_NEEDED', order: '#12001' },
  { subject: 'Tracking has not moved in 3 days', who: 3, status: 'IN_PROGRESS', priority: 'NORMAL', category: 'ORDER_ISSUE', issue: 'LOST_IN_SHIPPING', resolution: 'UNDER_INVESTIGATION', order: '#12002' },
  { subject: 'Wrong strength shipped', who: 7, status: 'OPEN', priority: 'HIGH', category: 'FULFILLMENT', issue: 'WRONG_ITEM', resolution: 'ATTENTION_NEEDED', order: '#12003' },
  { subject: 'Payment sent, order still pending', who: 0, status: 'IN_PROGRESS', priority: 'URGENT', category: 'PAYMENT', issue: 'PAYMENT_NOT_MATCHED', resolution: 'UNDER_INVESTIGATION', order: '#12000' },
  { subject: 'Requesting COA for batch', who: 6, status: 'WAITING_ON_CUSTOMER', priority: 'LOW', category: 'DOCUMENTATION', issue: 'COA_REQUEST', resolution: 'AWAITING_CUSTOMER', order: '#12004' },
  { subject: 'Cannot sign in after password reset', who: 4, status: 'OPEN', priority: 'NORMAL', category: 'ACCOUNT', issue: 'LOGIN_ISSUE', resolution: 'ATTENTION_NEEDED', order: null },
  { subject: 'Tier upgrade request', who: 9, status: 'RESOLVED', priority: 'LOW', category: 'ACCOUNT', issue: 'TIER_UPGRADE', resolution: 'RESOLVED_UPGRADED', order: null },
  { subject: 'Duplicate charge on card', who: 2, status: 'RESOLVED', priority: 'HIGH', category: 'PAYMENT', issue: 'DUPLICATE_CHARGE', resolution: 'REFUNDED', order: '#12007' },
]

export function seedTickets() {
  const customers = seedCustomers()
  const base = Date.UTC(2026, 9, 9, 9, 0)
  return TICKET_PLAN.map((t, i) => {
    // The Support page treats "needs a reply" as `status === OPEN && last message is
    // from the CUSTOMER`. Seeding a ticket as IN_PROGRESS whose last message was the
    // customer's made the header count it and the filter hide it, so the tab said
    // "Needs reply 2" over an empty list. Enforce the invariant at the source.
    const lastFromCustomer = i % 3 !== 0
    if (lastFromCustomer && ['OPEN', 'IN_PROGRESS'].includes(t.status)) t.status = 'OPEN'
    const cust = customers[t.who]
    // Declared AFTER `cust`: `const` does not hoist, and referencing it earlier threw
    // "Cannot access 'cust' before initialization" at module load.
    const customer = { id: cust.id, email: cust.email, firstName: cust.firstName, lastName: cust.lastName, name: cust.name, tier: cust.tier }
    return {
      id: `T-${3100 + i}`,
      subject: t.subject,
      // The ticket's person arrives under TWO names in the bundle: the inbox header
      // reads `ticket.customer` and the order-issues row reads `ticket.user`. Sending
      // only one of them rendered "Unknown" in the other view, so both carry the same
      // object. It must be an OBJECT, not an email string — `A()` prints
      // `firstName lastName || email || "Unknown"`.
      customer: customer,
      user: customer,
      customerEmail: cust.email,
      customerName: cust.name,
      status: t.status,
      priority: t.priority,
      category: t.category,
      issueType: t.issue,
      resolution: t.resolution,
      orderNumber: t.order,
      createdAt: new Date(base + i * 5400000).toISOString(),
      updatedAt: new Date(base + i * 5400000 + 1800000).toISOString(),
      messages: [
        // `authorType` is what the support page reads to decide "needs a reply":
        // a ticket whose LAST message is from the CUSTOMER is waiting on an admin.
        { author: 'customer', authorType: 'CUSTOMER', body: `${t.subject}. This is a seeded example ticket.`, at: new Date(base + i * 5400000).toISOString() },
        ...(i % 3 === 0 ? [{ author: 'support', authorType: 'ADMIN', body: 'Thanks for flagging it — we are looking into this now.', at: new Date(base + i * 5400000 + 900000).toISOString() }] : []),
      ],
      [SEED_MARK]: true,
    }
  })
}

/* ----------------------------------------------- stocked, authored products --- */

/**
 * Products that actually carry a quantity, so the inventory column, the low-stock
 * filter and the checkout decrement all have something real to operate on. Prices are
 * invented; the names are marked "(seed)" so they cannot be confused with the catalogue.
 */
const STOCK_PLAN = [
  { slug: 'seed-bpc-157-5mg', name: 'BPC-157 5mg (seed)', price: 15, qty: 42, tier: 'USER', cat: 'Peptides' },
  { slug: 'seed-ghk-cu-100mg', name: 'GHK-CU 100mg (seed)', price: 20, qty: 7, tier: 'USER', cat: 'Peptides' },
  { slug: 'seed-ss-31-50mg', name: 'SS-31 50mg (seed)', price: 45, qty: 2, tier: 'VIP', cat: 'Peptides' },
  { slug: 'seed-nad-500mg', name: 'NAD+ 500mg (seed)', price: 55, qty: 0, tier: 'VIP', cat: 'Injectables' },
  { slug: 'seed-jb-3-r-30mg', name: 'JB-3-R 30mg (seed)', price: 60, qty: 120, tier: 'ELITE', cat: 'Peptides' },
  { slug: 'seed-aqualyx-8ml', name: 'Aqualyx 8ml (seed)', price: 30, qty: 15, tier: 'VIP', cat: 'Injectables' },
  { slug: 'seed-semax-10mg', name: 'Semax 10mg (seed)', price: 40, qty: 1, tier: 'ELITE', cat: 'Peptides' },
  { slug: 'seed-mb-60caps', name: 'Methylene Blue 60 caps (seed)', price: 35, qty: 64, tier: 'USER', cat: 'Capsules' },
]

export function seedStockedProducts() {
  return STOCK_PLAN.map((p) => {
    const id = `authored-${p.slug}`
    const category = { id: `cat-${p.cat.toLowerCase()}`, name: p.cat, slug: p.cat.toLowerCase(), code: 'SEED' }
    const images = [{ url: '/uploads/placeholders/no-image.svg', sortOrder: 0 }]
    return {
      id,
      slug: p.slug,
      name: p.name,
      isNew: p.qty > 100,
      productType: 'VIAL',
      requiredTier: p.tier,
      pricePerUnit: p.price,
      stockQty: p.qty,
      stockMode: 'QUANTITY',
      soldOut: p.qty <= 0,
      saleDiscount: null,
      category,
      tags: ['seed'],
      images,
      quantityDiscounts: [],
      variants: [{
        id: `${id}-default`, name: 'Default', isVisible: true, isDefault: true, sortOrder: 0,
        pricePerUnit: p.price, stockQty: p.qty, saleDiscount: null,
        quantityDiscounts: [], images, availableStock: p.qty,
      }],
      summary: 'Seeded inventory fixture. Not a real product.',
      [SEED_MARK]: true,
    }
  })
}

/* ---------------------------------------------------------------- mutations --- */

/**
 * Bulk product mutations. All four buttons on the products page route through here so
 * the behaviour is identical whether one row or fifty are selected, and every one
 * returns `{ updated, requested }` — the shape the page toasts from.
 */
export function applyBulk(products, action, ids, value) {
  const wanted = new Set(ids ?? [])
  const matched = products.filter((p) => wanted.has(p.id) || wanted.has(p.slug))
  for (const p of matched) {
    if (action === 'archive') p.archived = !!value
    else if (action === 'visibility') p.adminHidden = value === false
    else if (action === 'new-badge') p.isNew = !!value
  }
  return { updated: matched.length, requested: wanted.size, products: matched.map((p) => p.slug) }
}

/** Order status transitions the admin panel offers, with the rules made explicit. */
export const ORDER_TRANSITIONS = {
  confirmPayment: { from: ['AWAITING_PAYMENT_REVIEW', 'PAYMENT_UNDER_REVIEW'], to: 'PAYMENT_CONFIRMED' },
  ship: { from: ['PAYMENT_CONFIRMED'], to: 'SHIPPED' },
  deliver: { from: ['SHIPPED'], to: 'DELIVERED' },
  archive: { from: ['DELIVERED', 'CANCELLED', 'AWAITING_PAYMENT_REVIEW'], to: 'ARCHIVED' },
  restore: { from: ['ARCHIVED'], to: 'PAYMENT_CONFIRMED' },
}

export function applyOrderTransition(order, action) {
  const rule = ORDER_TRANSITIONS[action]
  if (!rule) return { ok: false, error: `Unknown action: ${action}` }
  if (!rule.from.includes(order.status)) {
    return { ok: false, error: `${action} needs an order in ${rule.from.join(' or ')}, this one is ${order.status}` }
  }
  order.status = rule.to
  if (action === 'confirmPayment') order.confirmed = true
  if (action === 'archive') order.archived = true
  if (action === 'restore') order.archived = false
  return { ok: true, status: order.status }
}
