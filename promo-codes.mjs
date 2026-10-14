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

/** The mock code table. Keys are matched case-insensitively and trimmed. */
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
