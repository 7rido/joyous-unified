/**
 * The community forum's API, served locally.
 *
 * WHY THIS EXISTS
 * `community.localhost:4400` serves the forum's real compiled client, but its API
 * (50 endpoints under /api/community/*) was never captured — the original capture ran
 * without a community session and recorded 2 public endpoints, neither of them this
 * app's. So the client booted, called /api/community/auth/me, got the replay fallback's
 * `{}`, read `data.member` as undefined and correctly showed the sign-in screen.
 *
 * OBSERVED, NOT GUESSED
 * Every shape here was read off `community-DZQlDHLK.js`, and the auth contract was
 * confirmed against the live API:
 *
 *   GET /api/community/auth/me -> 200 {"member": null}      (production, signed out)
 *                             -> 200 {"member": {...}}      (signed in)
 *
 * The client's store does:
 *   try { const {data} = await H.get('/auth/me'); setMember(data.member) }
 *   catch { ready = true }        // ANY failure is also "signed out"
 * so there is no strict handshake to satisfy — but returning the observed shape means we
 * are not relying on that tolerance.
 *
 * Member object: `id`, `displayName` (falling back to `name`), `avatarUrl`, `role`,
 * `emailVerified`, `mutedUntil`. `role` is compared against "MODERATOR" and "ADMIN";
 * `emailVerified && !mutedUntil` is the "may post" gate, so a fixture without it lands
 * the user in a read-only state that looks like a bug.
 *
 * THE SESSION IS A FIXTURE, AND SAYS SO
 * `POST /auth/login` accepts ANY non-empty password for a seeded address. Nothing is
 * verified, nothing is hashed, and no password is stored — this is a replay harness, and
 * hand-rolling credential checking in one would be worse than not having it. The login
 * form is real, the check behind it is not, and `__fixture` marks it.
 */

const SESSION_COOKIE = 'joyous_community_sid'
const SESSIONS = new Map()
let seq = 0

/** The seeded member. Role ADMIN so the moderation surfaces are reachable. */
export const FIXTURE_MEMBER = {
  id: 'comm-member-1',
  displayName: 'Ada',
  name: 'Ada Lovelace',
  username: 'ada',
  email: 'ada.lovelace@example.com',
  avatarUrl: null,
  role: 'ADMIN',
  tier: 'ELITE',
  // Without this the client's `canPost` gate is false and the forum renders read-only.
  emailVerified: true,
  mutedUntil: null,
  bio: 'Seeded community member for the local replay.',
  joinedAt: '2026-01-08T14:20:00.000Z',
  postCount: 0,
  commentCount: 0,
  __fixture: true,
}

/** Addresses that may sign in. Passwords are NOT checked — see the header. */
const ALLOWED = new Set([FIXTURE_MEMBER.email, 'ada@example.com'])

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy() })
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}) } catch { resolve({}) }
    })
  })

function parseCookies(header = '') {
  const out = {}
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

/** The signed-in session for this request, or null. */
function sessionOf(req) {
  const sid = parseCookies(req.headers.cookie ?? '')[SESSION_COOKIE]
  return sid ? SESSIONS.get(sid) ?? null : null
}

function startSession(res, member) {
  const sid = `csid-${++seq}-${Date.now().toString(36)}`
  SESSIONS.set(sid, { member, at: new Date().toISOString() })
  // No Max-Age: a session cookie, so closing the browser signs out — which is what makes
  // the signed-out state easy to reach and test.
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax`)
  return sid
}

const json = (res, code, body) => {
  const payload = JSON.stringify(body)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(payload.length),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

/**
 * Handle a /api/community/* request.
 *
 * Returns true when the request was answered. Unimplemented paths inside the namespace
 * return a JSON 501 rather than falling through, because the replay fallback would answer
 * `{}` with a 200 — and a client that parses `{}` shows an empty screen that looks like
 * "no data" rather than "not implemented".
 */
export async function handleCommunityApi(req, res, pathname) {
  const route = pathname.slice('/api/community'.length) || '/'

  // --- who am I ---------------------------------------------------------
  if (route === '/auth/me' && req.method === 'GET') {
    const session = sessionOf(req)
    json(res, 200, { member: session ? session.member : null })
    return true
  }

  // --- sign in / out ----------------------------------------------------
  if (route === '/auth/login' && req.method === 'POST') {
    const body = await readBody(req)
    const email = String(body.email ?? '').trim().toLowerCase()
    const password = String(body.password ?? '')
    if (!email || !password) {
      json(res, 400, { error: 'Enter your email and password.' })
      return true
    }
    if (!ALLOWED.has(email)) {
      // The real API does not reveal whether an address exists, and neither does this.
      json(res, 401, { error: "That email and password don't match." })
      return true
    }
    startSession(res, { ...FIXTURE_MEMBER, email })
    console.log(`  [community] sign-in (fixture): ${email}`)
    json(res, 200, { member: { ...FIXTURE_MEMBER, email } })
    return true
  }

  if (route === '/auth/logout' && req.method === 'POST') {
    const sid = parseCookies(req.headers.cookie ?? '')[SESSION_COOKIE]
    if (sid) SESSIONS.delete(sid)
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
    json(res, 200, { ok: true })
    return true
  }

  if (route === '/auth/signup' && req.method === 'POST') {
    const body = await readBody(req)
    const email = String(body.email ?? '').trim().toLowerCase()
    if (!email) { json(res, 400, { error: 'Enter your email.' }); return true }
    // The real flow emails a verification link. There is no mail here, so the account is
    // created verified and the email is named in the log rather than silently dropped.
    if (!ALLOWED.has(email)) ALLOWED.add(email)
    console.log(`  [community] signup (fixture, auto-verified): ${email}`)
    json(res, 201, { ok: true, member: { ...FIXTURE_MEMBER, email }, verificationSent: false, __fixture: true })
    return true
  }

  // --- SSO from the member app -----------------------------------------
  // The member app POSTs /api/community-handoff, then redirects to
  // <community>/sso#code=...; the client posts that code here. Both ends are local, so
  // this completes without touching the live site.
  if (route === '/auth/handoff' && req.method === 'POST') {
    const body = await readBody(req)
    const code = String(body.code ?? '').trim()
    if (!code) { json(res, 400, { error: 'That sign-in link has expired — sign in below.' }); return true }
    startSession(res, FIXTURE_MEMBER)
    console.log('  [community] SSO handoff accepted (fixture)')
    json(res, 200, { member: FIXTURE_MEMBER })
    return true
  }

  // --- deliberately absent ---------------------------------------------
  // Discord is a real external service and LiveKit is a real media server. Both are
  // reachable in the UI and neither can be honoured here, so they say so explicitly
  // instead of returning a shape that pretends they worked.
  if (route.startsWith('/auth/discord') || route.startsWith('/mod/discord') || route === '/mod/discord-login') {
    console.log(`  [community] SIMULATED (no Discord here): ${req.method} ${pathname}`)
    json(res, 503, {
      error: 'Discord is not connected in this local replay.',
      __simulated: true,
      integration: 'discord',
    })
    return true
  }
  if (route.startsWith('/live')) {
    console.log(`  [community] SIMULATED (no LiveKit here): ${req.method} ${pathname}`)
    json(res, 503, {
      error: 'Live rooms need a LiveKit server; none is configured here.',
      __simulated: true,
      integration: 'livekit',
    })
    return true
  }

  // --- not written yet --------------------------------------------------
  console.log(`  [community] NOT IMPLEMENTED: ${req.method} ${pathname}`)
  json(res, 501, {
    error: 'This community endpoint is not implemented in the local replay yet.',
    __notImplemented: true,
    route,
  })
  return true
}
