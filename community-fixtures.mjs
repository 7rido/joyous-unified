/**
 * Shared fixture identity, in its own module to keep the import graph acyclic.
 *
 * `community-api.mjs` defines the routes and `community-demo.mjs` defines the content,
 * and the content needs the member — so seed imported it from api while api imported the
 * content from seed. That cycle left FIXTURE_MEMBER in its temporal dead zone and the
 * server refused to boot ("Cannot access 'FIXTURE_MEMBER' before initialization").
 *
 * A one-way graph is the fix: both modules import from here, and nothing here imports
 * either of them.
 */

/** Roles the client compares against: "MODERATOR" and "ADMIN". */
export const FIXTURE_MEMBER = {
  id: 'comm-member-1',
  displayName: 'Ada',
  name: 'Ada Lovelace',
  username: 'ada',
  email: 'ada.lovelace@example.com',
  avatarUrl: null,
  role: 'ADMIN',
  tier: 'ELITE',
  // Without this the client's `emailVerified && !mutedUntil` canPost gate is false, and
  // the forum renders read-only in a way that looks like a bug rather than a state.
  emailVerified: true,
  mutedUntil: null,
  bio: 'Seeded community member for the local replay.',
  joinedAt: '2026-01-08T14:20:00.000Z',
  postCount: 0,
  commentCount: 0,
  __fixture: true,
}

/** Addresses that may sign in. Passwords are NOT checked — see community-api.mjs. */
export const ALLOWED_EMAILS = new Set([FIXTURE_MEMBER.email, 'ada@example.com'])


/**
 * An ISO timestamp N days (and optionally hours) in the past.
 *
 * Shared, and deliberately not inlined per-module: every timestamp the client parses
 * (`lastActivityAt`, `startsAt`, `createdAt`) must be a real ISO string, because date-fns
 * throws RangeError on a truthy-but-unparseable value rather than rendering blank.
 */
export const chrono = (days = 0, hours = 0) =>
  new Date(Date.now() - days * 86400000 - hours * 3600000).toISOString()
