/**
 * Storefront configuration: the announcement strip, the login pop-up, and the
 * seasonal effect.
 *
 * WHAT THIS IS
 * The /admin/storefront screen edits three things that the CUSTOMER-side storefront
 * reads back. Two routes existed for each: an /admin one the edit form loads, and an
 * /admin/public one the storefront loads. The admin routes answered `{}`, so every form
 * rendered its defaults instead of the live configuration — the strip on the storefront
 * said one thing and the box that edits it said another.
 *
 * WHY IT PERSISTS
 * Unlike the seeded fixtures, these are settings someone edits on purpose. Writing them
 * to disk is the difference between "I saved my banner" and "I saved my banner until the
 * next restart". It follows the same overlay rule as products and pack deals: atomic
 * write, re-validated on load, so hand-editing the file is not a bypass.
 *
 * FIELD NAMES ARE THE FORM'S, NOT THE STOREFRONT'S
 * The pop-up is read as `spotlightTitle` / `spotlightEnabled` by the admin and as
 * `title` / `enabled` by the storefront, and the badge window (`spotlightNewBadgeDays`)
 * is used by the Products page's "Mark as NEW" action. Both names are mapped here rather
 * than making either side guess.
 */

import { readFileSync, writeFileSync, renameSync } from 'node:fs'

/** Defaults come from the recorded storefront payload, so the forms open on what is
 *  actually being shown rather than on invented values. */
export const DEFAULT_BANNER = {
  enabled: true,
  message: 'Welcome to Joyous, hope you enjoy the new layout and Joyo chat! We have migrated product visibilty to a tiered system with manual approval. ',
  style: 'info',
  speed: 'slow',
  fontSize: 'large',
  glow: false,
  shimmer: true,
  pulse: 'none',
  emoji: '📢',
  bold: true,
  uppercase: true,
}

export const DEFAULT_EFFECT = {
  enabled: false,
  type: 'snow',
  emojis: '❄,❅,❆',
  speed: 'medium',
  density: 'medium',
}

export const DEFAULT_SPOTLIGHT = {
  enabled: true,
  title: 'Updated Stock & Products for testing',
  announcement: "10/06 Update:  Tiered product viewing has been implemented! If you are looking for certain types of products and you don't see them, you can open a support ticket to request.",
  delayMs: 3000,
  newBadgeDays: 14,
  /** Product ids featured in the pop-up. Persisted with the rest of the pop-up. */
  products: [],
}

export const BANNER_STYLES = ['info', 'success', 'warning', 'danger', 'promo']
export const SPEEDS = ['slow', 'medium', 'fast']
export const FONT_SIZES = ['small', 'medium', 'large']
export const PULSES = ['none', 'soft', 'strong']
export const EFFECT_TYPES = ['snow', 'hearts', 'stars', 'confetti', 'leaves', 'none']
export const DENSITIES = ['low', 'medium', 'high']

const clip = (v, n) => String(v ?? '').slice(0, n)

/**
 * Validate and normalise a banner. Unknown enum values are refused rather than
 * silently coerced, so a typo in the form is reported instead of quietly stored.
 */
export function validateBanner(input, base = DEFAULT_BANNER) {
  const out = { ...base }
  const errs = []
  if (input.enabled !== undefined) out.enabled = !!input.enabled
  if (input.message !== undefined) {
    out.message = clip(input.message, 500)
    // An enabled banner with no message is invisible but looks on — the one
    // combination that wastes an admin's time.
    if (out.enabled && !out.message.trim()) errs.push('an enabled banner needs a message')
  }
  if (input.style !== undefined) {
    if (!BANNER_STYLES.includes(input.style)) errs.push(`style must be one of ${BANNER_STYLES.join(', ')}`)
    else out.style = input.style
  }
  if (input.speed !== undefined) {
    if (!SPEEDS.includes(input.speed)) errs.push(`speed must be one of ${SPEEDS.join(', ')}`)
    else out.speed = input.speed
  }
  if (input.fontSize !== undefined) {
    if (!FONT_SIZES.includes(input.fontSize)) errs.push(`fontSize must be one of ${FONT_SIZES.join(', ')}`)
    else out.fontSize = input.fontSize
  }
  if (input.pulse !== undefined) {
    if (!PULSES.includes(input.pulse)) errs.push(`pulse must be one of ${PULSES.join(', ')}`)
    else out.pulse = input.pulse
  }
  for (const k of ['glow', 'shimmer', 'bold', 'uppercase']) {
    if (input[k] !== undefined) out[k] = !!input[k]
  }
  if (input.emoji !== undefined) out.emoji = clip(input.emoji, 8)
  return { ok: errs.length === 0, errors: errs, value: out }
}

export function validateEffect(input, base = DEFAULT_EFFECT) {
  const out = { ...base }
  const errs = []
  if (input.enabled !== undefined) out.enabled = !!input.enabled
  if (input.type !== undefined) {
    if (!EFFECT_TYPES.includes(input.type)) errs.push(`type must be one of ${EFFECT_TYPES.join(', ')}`)
    else out.type = input.type
  }
  if (input.emojis !== undefined) out.emojis = clip(input.emojis, 100)
  if (input.speed !== undefined) {
    if (!SPEEDS.includes(input.speed)) errs.push(`speed must be one of ${SPEEDS.join(', ')}`)
    else out.speed = input.speed
  }
  if (input.density !== undefined) {
    if (!DENSITIES.includes(input.density)) errs.push(`density must be one of ${DENSITIES.join(', ')}`)
    else out.density = input.density
  }
  return { ok: errs.length === 0, errors: errs, value: out }
}

export function validateSpotlight(input, base = DEFAULT_SPOTLIGHT) {
  const out = { ...base }
  const errs = []
  if (input.spotlightEnabled !== undefined) out.enabled = !!input.spotlightEnabled
  if (input.enabled !== undefined) out.enabled = !!input.enabled
  if (input.spotlightTitle !== undefined) out.title = clip(input.spotlightTitle, 200)
  if (input.title !== undefined) out.title = clip(input.title, 200)
  if (input.spotlightAnnouncement !== undefined) out.announcement = clip(input.spotlightAnnouncement, 4000)
  if (input.announcement !== undefined) out.announcement = clip(input.announcement, 4000)
  if (input.spotlightDelayMs !== undefined) {
    const n = Number(input.spotlightDelayMs)
    if (!Number.isFinite(n) || n < 0 || n > 60000) errs.push('spotlightDelayMs must be 0-60000')
    else out.delayMs = Math.round(n)
  }
  if (input.delayMs !== undefined) {
    const n = Number(input.delayMs)
    if (!Number.isFinite(n) || n < 0 || n > 60000) errs.push('delayMs must be 0-60000')
    else out.delayMs = Math.round(n)
  }
  if (input.spotlightNewBadgeDays !== undefined) {
    const n = Number(input.spotlightNewBadgeDays)
    if (!Number.isFinite(n) || n < 1 || n > 365) errs.push('spotlightNewBadgeDays must be 1-365')
    else out.newBadgeDays = Math.round(n)
  }
  if (out.enabled && !out.title.trim()) errs.push('an enabled pop-up needs a title')
  return { ok: errs.length === 0, errors: errs, value: out }
}

/** Read the persisted config, re-validating so a hand-edited file cannot inject a
 *  value the form would have refused. Anything invalid falls back to its default. */
export function readStorefrontConfig(file) {
  let raw = {}
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { banner: { ...DEFAULT_BANNER }, effect: { ...DEFAULT_EFFECT }, spotlight: { ...DEFAULT_SPOTLIGHT } }
  }
  const b = validateBanner(raw.banner ?? {}, DEFAULT_BANNER)
  const e = validateEffect(raw.effect ?? {}, DEFAULT_EFFECT)
  const s = validateSpotlight(raw.spotlight ?? {}, DEFAULT_SPOTLIGHT)
  return {
    banner: b.ok ? b.value : { ...DEFAULT_BANNER },
    effect: e.ok ? e.value : { ...DEFAULT_EFFECT },
    spotlight: s.ok ? s.value : { ...DEFAULT_SPOTLIGHT },
  }
}

/** Atomic write: a partial file would read back as "everything default", silently
 *  discarding whatever the admin had configured. */
export function saveStorefrontConfig(file, config) {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`)
  renameSync(tmp, file)
}

/** The admin form's shape for the pop-up. */
export const spotlightForAdmin = (s) => ({
  spotlightEnabled: s.enabled,
  spotlightTitle: s.title,
  spotlightAnnouncement: s.announcement ?? '',
  spotlightNewBadgeDays: s.newBadgeDays,
  spotlightDelayMs: s.delayMs,
})

/** The storefront's shape for the pop-up — different names for the same values. */
export const spotlightForPublic = (s, products = []) => ({
  enabled: s.enabled,
  title: s.title,
  announcement: s.announcement ?? '',
  delayMs: s.delayMs,
  products,
})
