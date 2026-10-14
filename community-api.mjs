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

import { FIXTURE_MEMBER } from './community-fixtures.mjs'
import {
  ROOMS, POSTS, MEMBERS, EVENTS, NOTIFICATIONS, COMMENTS, LOGIN_INDEX,
  overview, unreadState, unreadCount, participantsFor, postById, commentsFor,
} from './community-demo.mjs'

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SESSION_COOKIE = 'joyous_community_sid'
const SESSIONS = new Map()
let seq = 0

/** Re-exported so callers have one place to look; defined in community-fixtures.mjs. */
export { FIXTURE_MEMBER }

/**
 * Accept a multipart upload and write it under community/uploads/.
 *
 * Deliberately a real file rather than a URL that 404s: the client puts the returned URL
 * into an <img src>, so a placeholder string produces a broken image and looks like a
 * rendering bug. Parsed by hand because this project has no dependencies, which is also
 * why the parsing is this blunt — one file part, CRLF-delimited, no nested multipart.
 */
const UPLOAD_DIR = new URL('./community/uploads/', import.meta.url).pathname

async function receiveUpload(req) {
  const raw = await new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })
  const type = String(req.headers['content-type'] ?? '')
  const boundary = /boundary=([^;]+)/.exec(type)?.[1]
  if (!boundary) return null

  const parts = raw.split(Buffer.from(`--${boundary}`))
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n')
    if (headerEnd < 0) continue
    const head = part.slice(0, headerEnd).toString('utf8')
    if (!/name="file"/.test(head)) continue
    const filename = /filename="([^"]*)"/.exec(head)?.[1] ?? 'upload'
    const mime = /Content-Type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim() ?? 'application/octet-stream'
    // Trailing CRLF belongs to the delimiter, not the file.
    let body = part.slice(headerEnd + 4)
    if (body.slice(-2).toString() === '\r\n') body = body.slice(0, -2)
    const ext = (/\.([a-z0-9]+)$/i.exec(filename)?.[1] ?? 'bin').toLowerCase()
    const safe = `up-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    mkdirSync(UPLOAD_DIR, { recursive: true })
    writeFileSync(join(UPLOAD_DIR, safe), body)
    return `/uploads/${safe}`
  }
  return null
}

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

/**
 * Send JSON.
 *
 * NO Content-Length, deliberately. `JSON.stringify(...).length` counts UTF-16 code
 * units, but `res.end()` writes UTF-8 bytes — and a single emoji is 2 units and 4 bytes.
 * Setting the header from `.length` therefore UNDERSTATES the body, and Node truncates
 * the response at that byte count, cutting the JSON mid-string:
 *
 *   {"rooms":[{"name":"General","emoji":"💬",...   <- cut here, no closing braces
 *
 * The client sees `Unexpected end of JSON input` and the whole app falls to its error
 * boundary. Omitting the header lets Node compute the byte length itself, which is what
 * the server's own sendJson does.
 */
const json = (res, code, body) => {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(body))
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
    // Seeded addresses only. The real API does not reveal whether an address exists, and
    // neither does this: an unknown address and a wrong password answer identically.
    const member = LOGIN_INDEX.get(email) ?? (email === 'ada@example.com' ? FIXTURE_MEMBER : null)
    if (!member) {
      json(res, 401, { error: "That email and password don't match." })
      return true
    }
    startSession(res, member)
    console.log(`  [community] sign-in (fixture): ${email} role=${member.role}`)
    json(res, 200, { member })
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
    // A signup is a plain MEMBER — never staff. The real flow emails a verification
    // link; there is no mail here, so the account is created verified and the address is
    // named in the log rather than silently discarded.
    const created = {
      ...FIXTURE_MEMBER,
      id: `comm-new-${Date.now().toString(36)}`,
      email,
      displayName: String(body.displayName ?? email.split('@')[0]).slice(0, 40),
      username: email.split('@')[0].slice(0, 30),
      avatarUrl: null,
      role: 'MEMBER',
      // The client shows a "pick a display name" step when this is set.
      needsDisplayName: !body.displayName,
      __fixture: true,
    }
    LOGIN_INDEX.set(email, created)
    console.log(`  [community] signup (fixture, auto-verified): ${email}`)
    json(res, 201, { ok: true, member: created, verificationSent: false, __fixture: true })
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

  // --- the signed-in member, editable -----------------------------------
  // The client PATCHes its own profile and reads `{member}` back.
  if (route === '/auth/me' && req.method === 'PATCH') {
    const session = sessionOf(req)
    if (!session) { json(res, 401, { error: 'Please sign in.' }); return true }
    const body = await readBody(req)
    const next = { ...session.member }
    if (body.displayName !== undefined) next.displayName = String(body.displayName).slice(0, 40)
    if (body.avatarUrl !== undefined) next.avatarUrl = body.avatarUrl || null
    if (body.bio !== undefined) next.bio = String(body.bio).slice(0, 300)
    delete next.needsDisplayName
    session.member = next
    json(res, 200, { member: next })
    return true
  }

  // Image upload. There is no object store here, so the bytes are written under
  // community/uploads/ and served back from the same host — a real file you can open,
  // rather than a URL that 404s.
  if (route === '/uploads' && req.method === 'POST') {
    const url = await receiveUpload(req)
    console.log(`  [community] upload -> ${url}`)
    json(res, 200, { url })
    return true
  }

  // --- the read surface --------------------------------------------------
  // Shapes read off the bundle. Note ALL of these are wrapper objects, not bare arrays:
  // the client does `data.rooms`, `data.posts`, `data.events`, so a bare array would
  // give it `undefined` and render an empty screen indistinguishable from "no data".
  const page = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('page') ?? 1) || 1

  if (route === '/rooms' && req.method === 'GET') {
    json(res, 200, { rooms: ROOMS, __fixture: true })
    return true
  }
  if (route === '/overview' && req.method === 'GET') {
    json(res, 200, overview())
    return true
  }
  if (route === '/unread' && req.method === 'GET') {
    json(res, 200, unreadState())
    return true
  }
  if (route === '/notifications/unread-count' && req.method === 'GET') {
    json(res, 200, { unread: unreadCount() })
    return true
  }
  if (route === '/events' && req.method === 'GET') {
    json(res, 200, { events: EVENTS, __fixture: true })
    return true
  }
  if (route === '/members' && req.method === 'GET') {
    json(res, 200, { members: MEMBERS, total: MEMBERS.length, __fixture: true })
    return true
  }
  if (route === '/notifications' && req.method === 'GET') {
    json(res, 200, { notifications: NOTIFICATIONS, total: NOTIFICATIONS.length, __fixture: true })
    return true
  }

  // Paginated: the client reads `posts` AND `hasMore`, and on page>1 appends rather than
  // replacing. hasMore must be a real boolean or the "load more" control never settles.
  if (route === '/posts' && req.method === 'GET') {
    // `room` is the room SLUG, not its id — the client passes the route's :slug straight
    // through. Filtering on id silently returned nothing for every room page.
    const slug = new URL(req.url ?? '/', 'http://x').searchParams.get('room')
    const scoped = slug ? POSTS.filter((post) => post.room?.slug === slug) : POSTS
    const PER = 2
    const start = (page - 1) * PER
    const slice = scoped.slice(start, start + PER)
    // `hasMore` and nothing else: the client reads only that for pagination — it keeps
    // its own page counter and never looks at a total.
    json(res, 200, { posts: slice, hasMore: start + PER < scoped.length, __fixture: true })
    return true
  }

  // `{ participants: { [postId]: [member] } }` — merged into a map by the client.
  if (route === '/posts/participants' && req.method === 'GET') {
    const ids = String(new URL(req.url ?? '/', 'http://x').searchParams.get('ids') ?? '')
      .split(',').map((x) => x.trim()).filter(Boolean)
    json(res, 200, { participants: participantsFor(ids) })
    return true
  }

  const postMatch = new RegExp('^/posts/([^/]+)$').exec(route)
  if (postMatch && req.method === 'GET') {
    const post = postById(decodeURIComponent(postMatch[1]))
    if (!post) { json(res, 404, { error: 'That post no longer exists.' }); return true }
    json(res, 200, { post, comments: commentsFor(post.id), __fixture: true })
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
