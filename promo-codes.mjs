/**
 * Promo codes.
 *
 * The client posts to /checkout/validate-promo and expects:
 *
 *     { discount: { code, name, discountAmount, freeShipping } }
 *
 * and on failure reads `error.response.data.error` and surfaces it verbatim. So the
 * exact sentence the customer sees is decided HERE, not in the bundle.
 *
 * NOTE ON SCOPE: the codes below are MOCK fixtures, as requested. The recorded
 * catalogue contained no promo codes at all -- /api/admin/discounts was never
 * observable -- so there is no real promo data to honour. WELCOME10 and FREESHIP are
 * invented, and marked __mock so nothing downstream mistakes them for recorded.
 */

/** The mock code table. Keys are matched case-insensitively and trimmed.
 *
 * MUTABLE so the admin screen can manage it, and overlaid from disk at boot so a code
 * created or switched off there survives a restart. `applyPromoOverlay` re-validates on
 * load: a hand-edited file must not inject a 500% discount the admin form would refuse.
 */
export const PROMO_CODES = {
  WELCOME10: {
    code: 'WELCOME10',
    name: 'Welcome 10% off',
    percentOff: 10,
    amountOff: 0,
    freeShipping: false,
    __mock: true,
  },
  FREESHIP: {
    code: 'FREESHIP',
    name: 'Free shipping',
    percentOff: 0,
    amountOff: 0,
    freeShipping: true,
    __mock: true,
  },
}

/** The exact message the bundle shows for an unknown code. */
export const PROMO_NOT_FOUND = 'This promo code does not exist'

/**
 * A code is only usable if it is ACTIVE and inside its window.
 *
 * The engine checked NEITHER before: a code switched off in the admin still discounted,
 * and an expired one still worked. Wiring the admin screen without this would have made
 * the toggle cosmetic — the same "the button reports success and nothing changes" shape
 * as the archive button.
 */
export function promoIsUsable(promo, now = Date.now()) {
  if (!promo || promo.isActive === false) return { ok: false, error: 'This promo code is not active' }
  if (promo.startsAt && new Date(promo.startsAt).getTime() > now) {
    return { ok: false, error: 'This promo code is not active yet' }
  }
  if (promo.expiresAt && new Date(promo.expiresAt).getTime() < now) {
    return { ok: false, error: 'This promo code has expired' }
  }
  return { ok: true }
}

/** Validate a stored code. Unknown fields are ignored; bad values are refused. */
export function validatePromo(input, code = input?.code) {
  const errors = []
  const out = {
    code: String(code ?? '').trim().toUpperCase(),
    name: String(input?.name ?? code ?? '').slice(0, 80),
    percentOff: 0, amountOff: 0, freeShipping: false, isActive: input?.isActive !== false,
    usageLimit: null, perUserLimit: null, minOrderAmount: null, startsAt: null, expiresAt: null,
    __mock: true,
  }
  const pct = Number(input?.percentOff) || 0
  const amt = Number(input?.amountOff) || 0
  if (pct < 0 || pct > 100) errors.push('percentOff must be 0-100')
  if (amt < 0 || amt > 100000) errors.push('amountOff must be 0-100000')
  out.percentOff = pct
  out.amountOff = amt
  out.freeShipping = !!input?.freeShipping
  if (!pct && !amt && !out.freeShipping) errors.push('a code must give a percentage, an amount, or free shipping')
  if (pct > 0 && amt > 0) errors.push('a code cannot be both a percentage and a fixed amount')
  for (const [key, max] of [['usageLimit', 1000000], ['perUserLimit', 1000]]) {
    const raw = input?.[key]
    if (raw === null || raw === undefined || raw === '') continue
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 1 || n > max) errors.push(`${key} must be a whole number 1-${max}`)
    else out[key] = n
  }
  const min = input?.minOrderAmount
  if (min !== null && min !== undefined && min !== '') {
    const n = Number(min)
    if (!Number.isFinite(n) || n < 0) errors.push('minOrderAmount must be 0 or more')
    else out.minOrderAmount = Math.round(n * 100) / 100
  }
  for (const key of ['startsAt', 'expiresAt']) {
    const raw = input?.[key]
    if (!raw) continue
    const d = new Date(raw)
    if (Number.isNaN(d.getTime())) errors.push(`${key} is not a valid date`)
    else out[key] = d.toISOString()
  }
  if (out.startsAt && out.expiresAt && new Date(out.expiresAt) <= new Date(out.startsAt)) {
    errors.push('expiresAt must be after startsAt')
  }
  return { ok: errors.length === 0, errors, value: out }
}

/**
 * Replay a persisted overlay onto the code table, re-validated.
 *
 * Anything failing validation is DROPPED rather than trusted, so hand-editing the file
 * is not a way around the admin form's rules.
 */
export function applyPromoOverlay(table, overlay) {
  const added = []
  const dropped = []
  for (const [rawCode, entry] of Object.entries(overlay?.codes ?? {})) {
    const code = String(rawCode).trim().toUpperCase()
    if (!/^[A-Z0-9_-]{3,24}$/.test(code)) { dropped.push(`${rawCode}: bad code`); continue }
    const v = validatePromo(entry, code)
    if (!v.ok) { dropped.push(`${code}: ${v.errors.join('; ')}`); continue }
    table[code] = v.value
    added.push(code)
  }
  for (const rawCode of overlay?.deleted ?? []) {
    delete table[String(rawCode).trim().toUpperCase()]
  }
  return { added, dropped }
}

/**
 * Look a code up. Returns { ok, promo } or { ok: false, error }.
 * Normalised: trimmed and upper-cased, so "welcome10 " works.
 */
export function findPromo(rawCode) {
  const code = String(rawCode ?? '').trim().toUpperCase()
  if (!code) {
    return { ok: false, error: 'Enter a promo code', code }
  }
  const promo = PROMO_CODES[code]
  if (!promo) {
    return { ok: false, error: PROMO_NOT_FOUND, code }
  }
  return { ok: true, promo, code }
}

/**
 * Discount for one code against a subtotal. Rounded to cents the same way the
 * client rounds, so the summary and the charge agree to the penny.
 *
 * A percentage is capped at the subtotal so a discount can never exceed what is
 * owed, and can never produce a negative total.
 */
export function discountFor(promo, subtotal) {
  const base = Number(subtotal) || 0
  const pct = promo.percentOff > 0 ? Math.round(base * (promo.percentOff / 100) * 100) / 100 : 0
  const flat = promo.amountOff > 0 ? Math.min(promo.amountOff, base) : 0
  const discountAmount = Math.min(pct + flat, base)
  return {
    code: promo.code,
    name: promo.name,
    discountAmount,
    freeShipping: !!promo.freeShipping,
  }
}
