/**
 * One-time single-sign-on codes for the member app -> community handoff.
 *
 * WHY THIS MODULE EXISTS
 * Two servers mint and redeem these codes: the member app serves `POST
 * /api/community-handoff` and the community serves `POST /api/community/auth/handoff`.
 * They are the same Node process but different modules, so the store has to live
 * somewhere both can import without creating a cycle. This is that place — it imports
 * neither of them.
 *
 * WHAT WAS WRONG BEFORE
 * The member side answered from a RECORDED SAMPLE, so it returned the same code on every
 * request (gUx5u5dUrjQy_c3Go19ghNS-UKdIw_P3YYHey7LnDD0 — a value sitting in the repo), and
 * the community side accepted ANY non-empty string and signed in the fixture member. So a
 * fabricated code was a working "sign in as the admin" door. That is the thing this fixes.
 *
 * PROPERTIES THAT MATTER
 *   single use    redeemed once, then dead — a code in a URL fragment can be replayed by
 *                 anyone who reads it out of the address bar or browser history
 *   short lived   a code is a bearer token; it should not outlive the redirect
 *   unguessable   random, so the space cannot be walked
 *   member-bound  the redeeming side gets the identity the code was issued FOR, so the
 *                 member host never has to create a community session itself
 */

import { randomBytes } from 'node:crypto'

/** 60 seconds: long enough for a redirect, short enough that a leaked code is stale. */
const TTL_MS = 60_000

/** code -> { memberId, email, issuedAt, expiresAt } */
const CODES = new Map()

let issued = 0
let redeemed = 0
let rejected = 0

/**
 * Issue a code bound to a member. 32 random bytes, base64url — the recorded fixture was
 * 43 characters, so this stays the same shape the client already handles.
 */
export function issueHandoffCode(member) {
  if (!member || !member.id) return null
  const code = randomBytes(32).toString('base64url')
  const now = Date.now()
  CODES.set(code, {
    memberId: member.id,
    email: member.email ?? null,
    issuedAt: new Date(now).toISOString(),
    expiresAt: now + TTL_MS,
  })
  issued += 1
  sweep()
  return code
}

/**
 * Redeem a code. Returns the member it was issued for, or a reason it was refused.
 *
 * The result is deliberately indistinguishable between "never issued" and "already used":
 * telling a caller which one it was lets them probe for valid codes.
 */
export function redeemHandoffCode(code, resolveMember) {
  const key = typeof code === 'string' ? code.trim() : ''
  if (!key) return { error: 'That sign-in link has expired — sign in below.' }

  const entry = CODES.get(key)
  if (!entry) {
    rejected += 1
    return { error: 'That sign-in link has expired — sign in below.' }
  }
  // Delete FIRST, so a second concurrent attempt with the same code cannot also succeed.
  CODES.delete(key)
  if (Date.now() > entry.expiresAt) {
    rejected += 1
    return { error: 'That sign-in link has expired — sign in below.' }
  }
  const member = resolveMember(entry)
  if (!member) {
    rejected += 1
    return { error: 'That account can no longer be found.' }
  }
  redeemed += 1
  return { member }
}

/** Drop anything past its expiry so the map cannot grow without bound. */
function sweep() {
  const now = Date.now()
  for (const [code, entry] of CODES) if (now > entry.expiresAt) CODES.delete(code)
}

export const handoffStats = () => ({
  outstanding: CODES.size, issued, redeemed, rejected,
})
