/**
 * Mutable content state for the community forum, persisted to disk.
 *
 * WHY THIS EXISTS
 * community-demo.mjs is immutable seed data — good for reading, useless for writing. The
 * write endpoints need state that survives a restart, so this module holds the live
 * content and persists it after every mutation.
 *
 * PERSISTENCE FOLLOWS THE PROJECT'S OVERLAY PATTERN
 * Write to a temp file, then rename. rename is atomic within a filesystem, so a crash
 * mid-write leaves the previous good file rather than a half-written one. The same
 * approach as newsletter.json and promo-codes.json in server.mjs.
 *
 * ON LOAD THE FILE IS RE-VALIDATED, NOT TRUSTED
 * A hand-edited file must not be able to inject something the API would have refused —
 * a reaction count of -5, a poll with no options, a post with no author. Anything that
 * fails validation is repaired or dropped, and the repair is reported at boot so it is
 * visible rather than silent.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ROOMS, MEMBERS, STAFF, POSTS, COMMENTS, EVENTS, NOTIFICATIONS, ADA,
} from './community-demo.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FILE = join(HERE, 'community-content.json')

/**
 * The identity writes are attributed to.
 *
 * This is NOT a constant. The role checks downstream have to distinguish an ADMIN from a
 * MEMBER, so the request handler sets it from the session before any store call. It starts
 * as the fixture admin only so a direct call in a test still works.
 */
export const ME = ADA

let actor = ADA

/**
 * Point the store at the signed-in member for this request.
 *
 * Called by the API handler as soon as it has a session, and reset afterwards, because
 * Node serves requests on one thread and a store that remembers the last caller would
 * attribute the next anonymous write to them.
 */
export function setActor(member) {
  actor = member ?? ADA
  return actor
}

export const whoami = () => actor
const isStaff = () => actor.role === 'ADMIN' || actor.role === 'MODERATOR'
const isAdmin = () => actor.role === 'ADMIN'

const clone = (v) => JSON.parse(JSON.stringify(v))
const iso = () => new Date().toISOString()

/* ------------------------------------------------------------------ seed --- */

const seed = () => ({
  /** Bumped when the seed shape changes, so a stale file is discarded, not misread. */
  seedVersion: 2,
  posts: clone(POSTS),
  comments: clone(COMMENTS),
  events: clone(EVENTS),
  notifications: clone(NOTIFICATIONS),
  /** postId/commentId -> { counts: {emoji:n}, mine: [emoji] } */
  reactions: {},
  /** pollId -> { optionIds: [...], closed: bool } — the fixture member's own votes */
  pollVotes: {},
  /** postId/commentId -> true, for the unread calculation */
  read: {},
  reports: [],
  /**
   * Discord integration SETTINGS. There is no Discord here, so these record what an admin
   * configured — a bot token, an SSO client secret, chat bridges — and report the
   * connection as unreachable. Nothing pretends a bot is online.
   */
  discord: { botToken: null, loginSecret: null, clientId: null, updatedAt: null },
  connections: [],
  connectionSeq: 1,
  seq: 1,
})

/* -------------------------------------------------------------- validating --- */

const isStr = (v) => typeof v === 'string'
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const isArr = Array.isArray
const isBool = (v) => typeof v === 'boolean'

/**
 * Repair a loaded file. Returns the repaired state plus a list of what was wrong, so boot
 * can print it. Deliberately permissive about *extra* fields and strict about the ones the
 * client reads — an unknown key is harmless, a missing `id` corrupts every React key.
 */
function validate(raw) {
  const problems = []
  const note = (m) => problems.push(m)

  if (!raw || typeof raw !== 'object') return { state: seed(), problems: ['file was not an object'] }
  if (raw.seedVersion !== 2) return { state: seed(), problems: [`seedVersion ${raw.seedVersion} != 2`] }

  const posts = (isArr(raw.posts) ? raw.posts : []).filter((p) => {
    if (!p || !isStr(p.id) || !isStr(p.title)) { note('dropped a post with no id/title'); return false }
    // Every post the client renders needs a room OBJECT and a parseable lastActivityAt,
    // or date-fns throws RangeError and takes the page to the error boundary.
    if (p.room && !isStr(p.room.slug)) { note(`post ${p.id}: room had no slug`); p.room = null }
    if (!isStr(p.lastActivityAt) || Number.isNaN(Date.parse(p.lastActivityAt))) {
      note(`post ${p.id}: unparseable lastActivityAt, reset`)
      p.lastActivityAt = p.createdAt ?? iso()
    }
    if (!isStr(p.createdAt) || Number.isNaN(Date.parse(p.createdAt))) p.createdAt = iso()
    if (!isArr(p.images)) p.images = []
    if (!isArr(p.files)) p.files = []
    if (!isNum(p.commentCount) || p.commentCount < 0) p.commentCount = 0
    if (!p.reactions || typeof p.reactions !== 'object' || isArr(p.reactions)) p.reactions = {}
    if (!isArr(p.myReactions)) p.myReactions = []
    // Counts are rendered as-is; a negative or non-numeric one would show garbage.
    for (const [e, n] of Object.entries(p.reactions)) {
      if (!isNum(n) || n < 0) { note(`post ${p.id}: dropped reaction ${e}=${n}`); delete p.reactions[e] }
    }
    return true
  })
  const postIds = new Set(posts.map((p) => p.id))

  const comments = {}
  for (const [postId, list] of Object.entries(
    raw.comments && typeof raw.comments === 'object' && !isArr(raw.comments) ? raw.comments : {},
  )) {
    if (!postIds.has(postId)) { note(`dropped comments for unknown post ${postId}`); continue }
    comments[postId] = (isArr(list) ? list : []).filter((c) => {
      if (!c || !isStr(c.id) || !isStr(c.body)) { note(`post ${postId}: dropped a comment with no id/body`); return false }
      if (c.reactions && (typeof c.reactions !== 'object' || isArr(c.reactions))) c.reactions = {}
      if (!isArr(c.myReactions)) c.myReactions = []
      if (!isStr(c.createdAt) || Number.isNaN(Date.parse(c.createdAt))) c.createdAt = iso()
      return true
    })
  }

  const events = (isArr(raw.events) ? raw.events : []).filter((e) => {
    if (!e || !isStr(e.id) || !isStr(e.title)) { note('dropped an event with no id/title'); return false }
    // startsAt is ALWAYS formatted by date-fns on non-LIVE cards — a bad one throws.
    if (!isStr(e.startsAt) || Number.isNaN(Date.parse(e.startsAt))) {
      note(`event ${e.id}: unparseable startsAt, dropped`); return false
    }
    if (!isNum(e.going) || e.going < 0) e.going = 0
    if (!isNum(e.maybe) || e.maybe < 0) e.maybe = 0
    if (!isArr(e.speakers)) e.speakers = []
    if (!isArr(e.faces)) e.faces = []
    if (e.myRsvp !== null && !['GOING', 'MAYBE'].includes(e.myRsvp)) e.myRsvp = null
    return true
  })

  const notifications = (isArr(raw.notifications) ? raw.notifications : []).filter((n) => {
    if (!n || !isStr(n.id)) { note('dropped a notification with no id'); return false }
    n.read = !!n.read
    return true
  })

  const reactions = {}
  for (const [id, r] of Object.entries(
    raw.reactions && typeof raw.reactions === 'object' && !isArr(raw.reactions) ? raw.reactions : {},
  )) {
    if (!r || typeof r !== 'object') continue
    const counts = {}
    for (const [e, n] of Object.entries(r.counts && typeof r.counts === 'object' ? r.counts : {})) {
      if (isNum(n) && n > 0) counts[e] = Math.floor(n)
      else note(`reaction ${id}: dropped ${e}=${n}`)
    }
    reactions[id] = { counts, mine: isArr(r.mine) ? r.mine.filter(isStr) : [] }
  }

  const pollVotes = {}
  for (const [id, v] of Object.entries(
    raw.pollVotes && typeof raw.pollVotes === 'object' && !isArr(raw.pollVotes) ? raw.pollVotes : {},
  )) {
    if (!v || typeof v !== 'object') continue
    pollVotes[id] = { optionIds: isArr(v.optionIds) ? v.optionIds.filter(isStr) : [], closed: !!v.closed }
  }

  const read = {}
  for (const [k, v] of Object.entries(raw.read && typeof raw.read === 'object' ? raw.read : {})) {
    if (v) read[k] = true
  }

  const reports = (isArr(raw.reports) ? raw.reports : []).filter((r) => r && isStr(r.id))
  const seq = isNum(raw.seq) && raw.seq > 0 ? Math.floor(raw.seq) : 1

  const rawDiscord = raw.discord && typeof raw.discord === 'object' ? raw.discord : {}
  const discord = {
    botToken: isStr(rawDiscord.botToken) && rawDiscord.botToken ? rawDiscord.botToken : null,
    loginSecret: isStr(rawDiscord.loginSecret) && rawDiscord.loginSecret ? rawDiscord.loginSecret : null,
    clientId: isStr(rawDiscord.clientId) && rawDiscord.clientId ? rawDiscord.clientId : null,
    updatedAt: isStr(rawDiscord.updatedAt) ? rawDiscord.updatedAt : null,
  }

  const connections = (isArr(raw.connections) ? raw.connections : []).filter((c) => {
    if (!c || !isStr(c.id) || !isStr(c.label)) { note('dropped a connection with no id/label'); return false }
    if (!isStr(c.secret) || !c.secret) { note(`connection ${c.id}: no secret, dropped`); return false }
    c.platform = isStr(c.platform) ? c.platform : 'DISCORD'
    c.room = c.room && isStr(c.room.id) ? { id: c.room.id, name: isStr(c.room.name) ? c.room.name : '', slug: isStr(c.room.slug) ? c.room.slug : '' } : null
    return true
  })
  const connectionSeq = isNum(raw.connectionSeq) && raw.connectionSeq > 0 ? Math.floor(raw.connectionSeq) : 1

  return {
    state: {
      seedVersion: 2, posts, comments, events, notifications, reactions, pollVotes,
      read, reports, discord, connections, connectionSeq, seq,
    },
    problems,
  }
}

/* ------------------------------------------------------------------ state --- */

let state
let problems = []

if (existsSync(FILE)) {
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8'))
    const res = validate(parsed)
    state = res.state
    problems = res.problems
  } catch (err) {
    state = seed()
    problems = [`file was unreadable (${err.message}) — started from the seed instead`]
  }
} else {
  state = seed()
}

if (problems.length) {
  console.log(`  [community] content file repaired on load (${problems.length} issue(s)):`)
  for (const p of problems.slice(0, 8)) console.log(`      ${p}`)
  persist()
}

/** Atomic: temp file then rename, so a crash leaves the previous good file. */
function persist() {
  try {
    mkdirSync(dirname(FILE), { recursive: true })
    const tmp = `${FILE}.tmp-${process.pid}`
    writeFileSync(tmp, `${JSON.stringify(state, null, 1)}\n`)
    renameSync(tmp, FILE)
  } catch (err) {
    // A failed write must not corrupt the in-memory state or crash a request.
    console.log(`  [community] WARNING: could not persist content — ${err.message}`)
  }
}

const nextId = (prefix) => `${prefix}-${(state.seq++).toString(36)}${Date.now().toString(36).slice(-4)}`

/* -------------------------------------------------------------- reactions --- */

/**
 * Toggle a reaction and report the RESULTING state, not the delta.
 *
 * The client reads `{reacted}` and uses it to add or subtract one locally:
 *   `(ee.reactions[K] || 0) + (reacted ? 1 : -1)`
 * so a wrong boolean silently corrupts the count in the UI rather than throwing.
 */
export function toggleReaction(target, emoji) {
  if (!isStr(emoji) || !emoji || emoji.length > 8) return { error: 'emoji must be a short string' }
  const post = target.postId ? state.posts.find((p) => p.id === target.postId) : null
  if (target.postId && !post) return { error: 'That post no longer exists.' }
  let holder = post
  if (target.commentId) {
    holder = Object.values(state.comments).flat().find((c) => c.id === target.commentId)
    if (!holder) return { error: 'That comment no longer exists.' }
  }
  if (!holder) return { error: 'Nothing to react to.' }

  const id = post ? post.id : target.commentId
  const rec = state.reactions[id] ?? {
    counts: { ...(holder.reactions ?? {}) }, mine: [ ...(holder.myReactions ?? []) ],
  }
  const has = rec.mine.includes(emoji)
  if (has) {
    rec.mine = rec.mine.filter((e) => e !== emoji)
    rec.counts[emoji] = Math.max(0, (rec.counts[emoji] ?? 1) - 1)
    if (rec.counts[emoji] === 0) delete rec.counts[emoji]
  } else {
    rec.mine = [...rec.mine, emoji]
    rec.counts[emoji] = (rec.counts[emoji] ?? 0) + 1
  }
  state.reactions[id] = rec
  // Keep the holder in sync so reads that do not consult `reactions` still agree.
  holder.reactions = rec.counts
  holder.myReactions = rec.mine
  persist()
  return { reacted: !has }
}

/** Applied on read so a feed always reflects the latest toggles. */
export function applyReactions(list) {
  for (const item of list) {
    const rec = state.reactions[item.id]
    if (rec) { item.reactions = { ...rec.counts }; item.myReactions = [...rec.mine] }
  }
  return list
}

/* ------------------------------------------------------------------ posts --- */

const withStats = (post) => {
  const c = state.comments[post.id] ?? []
  return { ...post, commentCount: c.length, lastActivityAt: c.length ? c[c.length - 1].createdAt : post.lastActivityAt }
}

export const listPosts = (slug) => {
  const scoped = slug ? state.posts.filter((p) => p.room?.slug === slug) : state.posts
  return applyReactions(scoped.map(withStats))
}

export const getPost = (id) => {
  const p = state.posts.find((x) => x.id === id)
  return p ? applyReactions([withStats(p)])[0] : null
}

export const commentsOf = (id) => applyReactions(state.comments[id] ?? [])

export function createPost(body) {
  const roomId = isStr(body.roomId) ? body.roomId : null
  const room = ROOMS.find((r) => r.id === roomId)
  if (!room) return { error: 'Pick a room first.' }
  const title = isStr(body.title) ? body.title.trim() : ''
  const text = isStr(body.body) ? body.body.trim() : ''
  if (!title && !text) return { error: 'A post needs a title or a body.' }
  if (title.length > 200) return { error: 'That title is too long.' }
  if (text.length > 20000) return { error: 'That post is too long.' }

  const id = nextId('post')
  const post = {
    id, title: title || text.slice(0, 60), body: text,
    author: actor, createdAt: iso(), editedAt: null,
    room: { slug: room.slug, emoji: room.emoji, name: room.name },
    pinned: false, locked: false, isNew: false, newComments: 0, truncated: false,
    images: isArr(body.images) ? body.images.filter(isStr) : [],
    files: isArr(body.files) ? body.files.filter((f) => f && isStr(f.url)) : [],
    poll: null, reactions: {}, myReactions: [], commentCount: 0,
    lastActivityAt: iso(), __fixture: true,
  }

  if (body.poll && isArr(body.poll.options)) {
    const options = body.poll.options.map((t) => String(t).trim()).filter(Boolean)
    if (options.length < 2) return { error: 'A poll needs at least 2 options' }
    post.poll = {
      id: nextId('poll'),
      options: options.map((text_, i) => ({ id: `${id}-opt-${i + 1}`, text: text_, votes: 0 })),
      myVotes: [], allowMultiple: !!body.poll.allowMultiple,
      closed: false, showResults: true, totalVoters: 0,
    }
  }

  state.posts.unshift(post)
  persist()
  return { post: applyReactions([withStats(post)])[0] }
}

export function patchPost(id, body) {
  const post = state.posts.find((p) => p.id === id)
  if (!post) return { error: 'That post no longer exists.' }
  if (isStr(body.title)) post.title = body.title.trim().slice(0, 200)
  if (isStr(body.body)) post.body = body.body
  if (isBool(body.pinned)) post.pinned = body.pinned
  if (isBool(body.locked)) post.locked = body.locked
  post.editedAt = iso()
  persist()
  return { post: applyReactions([withStats(post)])[0] }
}

export function deletePost(id) {
  const i = state.posts.findIndex((p) => p.id === id)
  if (i < 0) return { error: 'That post no longer exists.' }
  if (state.posts[i].author?.id !== actor.id && !isAdmin()) {
    return { error: 'You can only delete your own posts.' }
  }
  state.posts.splice(i, 1)
  delete state.comments[id]
  persist()
  return { ok: true }
}

/* --------------------------------------------------------------- comments --- */

export function addComment(postId, body) {
  const post = state.posts.find((p) => p.id === postId)
  if (!post) return { error: 'That post no longer exists.' }
  if (post.locked) return { error: 'That thread is locked.' }
  const text = isStr(body.body) ? body.body.trim() : ''
  const images = isArr(body.images) ? body.images.filter(isStr) : []
  const files = isArr(body.files) ? body.files.filter((f) => f && isStr(f.url)) : []
  if (!text && !images.length && !files.length) return { error: 'Write something first.' }
  if (text.length > 10000) return { error: 'That comment is too long.' }

  const parentId = isStr(body.parentId) && body.parentId ? body.parentId : null
  if (parentId) {
    const parent = (state.comments[postId] ?? []).find((c) => c.id === parentId)
    if (!parent) return { error: 'That comment no longer exists.' }
  }

  const comment = {
    id: nextId('c'), postId, parentId, author: actor, member: actor, body: text,
    images, files, createdAt: iso(), editedAt: null,
    reactions: {}, myReactions: [], __fixture: true,
  }
  ;(state.comments[postId] ??= []).push(comment)
  post.lastActivityAt = comment.createdAt
  delete state.read[postId]
  persist()
  return { comment: applyReactions([comment])[0] }
}

export function patchComment(id, body) {
  for (const list of Object.values(state.comments)) {
    const c = list.find((x) => x.id === id)
    if (!c) continue
    if (c.author?.id !== actor.id && !isAdmin()) return { error: 'You can only edit your own comments.' }
    if (isStr(body.body)) c.body = body.body.trim()
    c.editedAt = iso()
    persist()
    return { comment: applyReactions([c])[0] }
  }
  return { error: 'That comment no longer exists.' }
}

export function deleteComment(id) {
  for (const [postId, list] of Object.entries(state.comments)) {
    const i = list.findIndex((x) => x.id === id)
    if (i < 0) continue
    if (list[i].author?.id !== actor.id && !isAdmin()) return { error: 'You can only delete your own comments.' }
    list.splice(i, 1)
    if (!list.length) delete state.comments[postId]
    persist()
    return { ok: true }
  }
  return { error: 'That comment no longer exists.' }
}

/* ------------------------------------------------------------------ polls --- */

const findPoll = (pollId) => {
  for (const post of state.posts) if (post.poll?.id === pollId) return { post, poll: post.poll }
  return null
}

export function votePoll(pollId, body) {
  const found = findPoll(pollId)
  if (!found) return { error: 'That poll no longer exists.' }
  const { poll } = found
  if (poll.closed) return { error: 'That poll is closed.' }
  let ids = isArr(body.optionIds) ? body.optionIds.filter(isStr) : []
  if (!poll.allowMultiple) ids = ids.slice(0, 1)
  const valid = new Set(poll.options.map((o) => o.id))
  if (ids.some((i) => !valid.has(i))) return { error: 'Unknown poll option.' }

  const before = state.pollVotes[pollId]?.optionIds ?? poll.myVotes ?? []
  const beforeVoters = state.pollVotes[pollId] ? poll.totalVoters : poll.totalVoters
  // Undo the previous vote, then apply the new one, so changing a vote is not a double count.
  for (const o of poll.options) {
    if (before.includes(o.id)) o.votes = Math.max(0, o.votes - 1)
    if (ids.includes(o.id)) o.votes += 1
  }
  const wasVoter = before.length > 0
  const isVoter = ids.length > 0
  poll.totalVoters = Math.max(0, beforeVoters + (isVoter ? 1 : 0) - (wasVoter ? 1 : 0))
  poll.myVotes = ids
  state.pollVotes[pollId] = { optionIds: ids, closed: !!poll.closed }
  persist()
  return { poll }
}

export function closePoll(pollId) {
  const found = findPoll(pollId)
  if (!found) return { error: 'That poll no longer exists.' }
  if (!isStaff()) return { error: 'Only staff can close a poll.' }
  found.poll.closed = true
  state.pollVotes[pollId] = { optionIds: state.pollVotes[pollId]?.optionIds ?? [], closed: true }
  persist()
  return { poll: found.poll }
}

/* ----------------------------------------------------------------- events --- */

export const listEvents = () => state.events

export function rsvp(eventId, body) {
  const ev = state.events.find((e) => e.id === eventId)
  if (!ev) return { error: 'That event no longer exists.' }
  if (!['SCHEDULED', 'LIVE'].includes(ev.status)) return { error: 'That event has ended.' }
  const next = body.status === null || body.status === undefined ? null : body.status
  if (next !== null && !['GOING', 'MAYBE'].includes(next)) return { error: 'Unknown RSVP.' }

  const prev = ev.myRsvp
  if (prev === 'GOING') ev.going = Math.max(0, ev.going - 1)
  if (prev === 'MAYBE') ev.maybe = Math.max(0, ev.maybe - 1)
  if (next === 'GOING') ev.going += 1
  if (next === 'MAYBE') ev.maybe += 1
  ev.myRsvp = next
  persist()
  return { event: ev }
}

export function createEvent(body) {
  const title = isStr(body.title) ? body.title.trim() : ''
  const startsAt = isStr(body.startsAt) ? body.startsAt : ''
  if (!title) return { error: 'An event needs a title.' }
  // The client always formats this with date-fns, so an unparseable value would throw on
  // render rather than showing blank.
  if (Number.isNaN(Date.parse(startsAt))) return { error: 'Pick a date and time.' }
  const kind = ['VIDEO', 'AUDIO', 'OTHER'].includes(body.kind) ? body.kind : 'OTHER'

  const ev = {
    id: nextId('event'), title,
    description: isStr(body.description) && body.description.trim() ? body.description.trim() : null,
    kind, status: 'SCHEDULED', startsAt, coverUrl: isStr(body.coverUrl) ? body.coverUrl : null,
    durationMin: isNum(Number(body.durationMin)) ? Number(body.durationMin) : null,
    host: actor,
    speakers: isArr(body.speakerIds)
      ? body.speakerIds.map((id) => MEMBERS.find((m) => m.id === id)).filter(Boolean).map((m) => ({ ...m }))
      : [],
    faces: [], myRsvp: null, going: 0, maybe: 0, __fixture: true,
  }
  state.events.unshift(ev)
  persist()
  return { event: ev }
}

/* ----------------------------------------------------- reads and reports --- */

export function markRead(body) {
  const slug = isStr(body.room) ? body.room : null
  for (const post of state.posts) {
    if (slug && post.room?.slug !== slug) continue
    state.read[post.id] = true
    for (const c of state.comments[post.id] ?? []) state.read[c.id] = true
  }
  persist()
  return { ok: true }
}

export function markNotificationsRead() {
  for (const n of state.notifications) n.read = true
  persist()
  return { ok: true }
}

export function listNotifications() {
  return { notifications: state.notifications, unread: state.notifications.filter((n) => !n.read).length }
}

export function fileReport(body) {
  const reason = isStr(body.reason) ? body.reason.trim() : ''
  if (reason.length < 3) return { error: 'Tell us what is wrong.' }
  const report = {
    id: nextId('report'),
    postId: isStr(body.postId) ? body.postId : null,
    commentId: isStr(body.commentId) ? body.commentId : null,
    reason, reporterId: actor.id, reporterName: actor.displayName,
    status: 'OPEN', createdAt: iso(), __fixture: true,
  }
  state.reports.push(report)
  persist()
  return { message: 'Thanks — a moderator will take a look.', report }
}

/**
 * The moderation queue.
 *
 * Reports are STORED flat (`postId`, `commentId`, `reporterId`) and RESHAPED here into what
 * the page reads: `reporter` as a member object, and `target` as `{kind, author, postId,
 * title, excerpt, deleted}`. The client dereferences `a.target.author.displayName` and
 * `a.target.kind` without optional chaining, so a report whose target has been deleted
 * still needs a target object — hence `deleted: true` rather than a missing field.
 */
export function listReports(status = 'OPEN') {
  const want = ['OPEN', 'RESOLVED', 'DISMISSED'].includes(status) ? status : 'OPEN'
  const reports = state.reports
    .filter((r) => (r.status ?? 'OPEN') === want)
    // The page renders `a.reporter.displayName` with NO optional chaining, so a report
    // whose reporter cannot be resolved would take the whole tab to the error boundary.
    // Dropping it is the lesser failure — and it can only happen if the members seed
    // changed under an existing queue.
    .filter((r) => {
      if (MEMBERS.some((m) => m.id === r.reporterId)) return true
      console.log(`  [community] hiding report ${r.id}: reporter ${r.reporterId} is unknown`)
      return false
    })
    .map((r) => {
      const reporter = MEMBERS.find((m) => m.id === r.reporterId) ?? null
      const post = r.postId ? state.posts.find((x) => x.id === r.postId) : null
      const comment = r.commentId
        ? Object.values(state.comments).flat().find((c) => c.id === r.commentId)
        : null

      let target
      if (comment) {
        const owner = state.posts.find((x) => x.id === comment.postId)
        target = {
          kind: 'comment', postId: comment.postId, commentId: comment.id,
          title: owner?.title ?? null,
          excerpt: String(comment.body ?? '').slice(0, 180),
          author: comment.author ?? null, deleted: false,
        }
      } else if (post) {
        target = {
          kind: 'post', postId: post.id, commentId: null,
          title: post.title, excerpt: String(post.body ?? '').slice(0, 180),
          author: post.author ?? null, deleted: false,
        }
      } else {
        // The target is gone. The page still renders the card, so keep a well-formed
        // object rather than nulling it — `deleted` is what drives the "(already deleted)"
        // label.
        target = {
          kind: 'post', postId: r.postId ?? null, commentId: r.commentId ?? null,
          title: null, excerpt: '(the reported content no longer exists)',
          author: null, deleted: true,
        }
      }

      return {
        id: r.id, reason: r.reason, status: r.status ?? 'OPEN',
        createdAt: r.createdAt, reporter, target,
      }
    })
  return { reports }
}

export function setReportStatus(id, status) {
  if (!['OPEN', 'RESOLVED', 'DISMISSED'].includes(status)) {
    return { error: 'Unknown status.' }
  }
  const r = state.reports.find((x) => x.id === id)
  if (!r) return { error: 'That report no longer exists.' }
  r.status = status
  r.handledAt = iso()
  r.handledBy = actor.id
  persist()
  return { report: { id: r.id, status: r.status, handledAt: r.handledAt } }
}

/** Kept for the smoke suite, which reads the raw queue rather than the reshaped view. */
export const rawReports = () => state.reports

/* --------------------------------------------------------------- discord --- */
/**
 * The bot's status is OBSERVED, not aspirational.
 *
 * There is no Discord gateway to connect to here, so a saved token cannot produce a live
 * bot. Reporting `connected` would be a lie the UI then repeats in green, so a stored
 * token reports `error` with the reason attached, and the page renders "Not connected"
 * next to it. The token really is stored — that part is not a fiction.
 */
const NO_GATEWAY = 'Saved locally, but there is no Discord gateway here to connect to.'

const botState = () => (state.discord.botToken
  ? {
    status: 'error',
    label: 'Not connected',
    detail: NO_GATEWAY,
    configuredAt: state.discord.updatedAt,
    // The token itself is never returned. A UI that can read a secret back is a UI that
    // can leak it through a screenshot; masking is what the real thing does too.
    tokenPreview: `${state.discord.botToken.slice(0, 6)}…`,
  }
  : { status: 'off', label: 'Off', detail: 'No bot token saved.', tokenPreview: null })

const loginState = () => ({
  configured: !!(state.discord.loginSecret && state.discord.clientId),
  // Read back by the setup instructions on the page.
  clientId: state.discord.clientId,
  redirectUri: '/api/community/auth/discord/callback',
  // Never the secret.
  secretSaved: !!state.discord.loginSecret,
})

export const getDiscord = () => ({ bot: botState(), login: loginState() })

export function setBotToken(token) {
  const t = isStr(token) ? token.trim() : ''
  if (t.length < 20) return { error: 'That does not look like a bot token.' }
  state.discord.botToken = t
  state.discord.updatedAt = iso()
  persist()
  return { bot: botState() }
}

export function clearBotToken() {
  state.discord.botToken = null
  state.discord.updatedAt = iso()
  persist()
  return { bot: botState() }
}

export function setDiscordLogin(body) {
  const secret = isStr(body.secret) ? body.secret.trim() : ''
  const clientId = isStr(body.clientId) ? body.clientId.trim() : state.discord.clientId
  if (secret) state.discord.loginSecret = secret
  if (clientId) state.discord.clientId = clientId
  if (!state.discord.loginSecret || !state.discord.clientId) {
    // The form offers a secret field plus a separate client id; without both, Discord
    // cannot redirect back, so say which is missing rather than silently half-enabling.
    return { error: !state.discord.clientId ? 'A Discord client ID is required.' : 'A client secret is required.' }
  }
  state.discord.updatedAt = iso()
  persist()
  return { login: loginState() }
}

export function unlinkDiscord() {
  // The fixture session is not Discord-linked, so this is a no-op that reports the
  // resulting member rather than claiming an unlink that never happened.
  return { member: actor }
}

/* ----------------------------------------------------------- connections --- */
const connView = (c) => ({
  id: c.id, platform: c.platform, label: c.label, room: c.room,
  secretPreview: `${c.secret.slice(0, 4)}…`,
  // Same reasoning as the bot: a stored bridge is not a working bridge.
  status: 'error',
  detail: NO_GATEWAY,
  createdAt: c.createdAt,
})

export const listConnections = () => ({ connections: state.connections.map(connView) })

export function createConnection(body) {
  const label = isStr(body.label) ? body.label.trim() : ''
  const secret = isStr(body.secret) ? body.secret.trim() : ''
  if (!label) return { error: 'Give the connection a name.' }
  if (secret.length < 8) return { error: 'That does not look like a valid secret.' }
  const roomId = isStr(body.roomId) && body.roomId ? body.roomId : null
  const room = roomId ? ROOMS.find((r) => r.id === roomId) : null
  if (roomId && !room) return { error: 'Unknown room.' }
  const conn = {
    id: `conn-${(state.connectionSeq++).toString(36)}${Date.now().toString(36).slice(-3)}`,
    platform: 'DISCORD', label, secret,
    room: room ? { id: room.id, name: room.name, slug: room.slug } : null,
    createdAt: iso(),
  }
  state.connections.push(conn)
  persist()
  return { connection: connView(conn) }
}

export function updateConnection(id, body) {
  const c = state.connections.find((x) => x.id === id)
  if (!c) return { error: 'That connection no longer exists.' }
  if (isStr(body.label) && body.label.trim()) c.label = body.label.trim()
  if (isStr(body.secret) && body.secret.trim()) c.secret = body.secret.trim()
  if (body.roomId !== undefined) {
    const room = body.roomId ? ROOMS.find((r) => r.id === body.roomId) : null
    if (body.roomId && !room) return { error: 'Unknown room.' }
    c.room = room ? { id: room.id, name: room.name, slug: room.slug } : null
  }
  persist()
  return { connection: connView(c) }
}

export function deleteConnection(id) {
  const i = state.connections.findIndex((x) => x.id === id)
  if (i < 0) return { error: 'That connection no longer exists.' }
  state.connections.splice(i, 1)
  persist()
  return { ok: true }
}

/* ------------------------------------------------------------- moderation --- */

/**
 * The moderation member list. Same member shape as `/members`, plus the search the page
 * debounces into a query param. Kept here rather than reusing MEMBERS directly so a
 * future role change is reflected without touching the seed.
 */
export function modMembers(search) {
  const q = isStr(search) ? search.trim().toLowerCase() : ''
  const list = MEMBERS
    .filter((m) => !q
      || m.displayName.toLowerCase().includes(q)
      || m.username.toLowerCase().includes(q)
      || m.email.toLowerCase().includes(q))
    .map((m) => ({
      id: m.id, displayName: m.displayName, username: m.username, email: m.email,
      avatarUrl: m.avatarUrl, role: m.role, tier: m.tier,
      emailVerified: m.emailVerified, mutedUntil: m.mutedUntil,
      bio: m.bio, joinedAt: m.joinedAt, viaDiscord: !!m.viaDiscord,
    }))
  return { members: list }
}

export const modRooms = () => ({ rooms: ROOMS.map((r) => ({ ...r })) })

/* --------------------------------------------------------------- counters --- */

/**
 * Unread is derived from `read`, not from the notification list: marking a room read must
 * clear its badge, and the two are independent.
 */
export function unreadCount() {
  return state.notifications.filter((n) => !n.read).length
}

export function unreadState() {
  const rooms = {}
  for (const post of state.posts) {
    if (state.read[post.id]) continue
    const c = state.comments[post.id] ?? []
    const unreadComments = c.filter((x) => !state.read[x.id]).length
    if (unreadComments > 0 && post.room) {
      const r = ROOMS.find((x) => x.slug === post.room.slug)
      if (r) rooms[r.id] = (rooms[r.id] ?? 0) + unreadComments
    }
  }
  const total = Object.values(rooms).reduce((a, b) => a + b, 0)
  return { total: unreadCount() + total, rooms }
}

export function overview() {
  return {
    memberCount: MEMBERS.length,
    onlineCount: 4,
    staff: STAFF.map((m) => ({
      id: m.id, displayName: m.displayName, avatarUrl: m.avatarUrl,
      role: m.role, viaDiscord: false,
    })),
    __fixture: true,
  }
}

export const postsByRoom = (slug) => listPosts(slug)

/** Used by the boot log so it is obvious whether state is fresh or restored. */
console.log(
  `  [community] content ${existsSync(FILE) ? 'restored' : 'seeded'}`
  + ` — ${state.posts.length} posts, ${Object.values(state.comments).reduce((a, l) => a + l.length, 0)} comments,`
  + ` ${state.reports.length} report(s)`
  + `, discord ${state.discord.botToken ? 'token set' : 'unconfigured'}, ${state.connections.length} connection(s)`,
)

export const stats = () => ({
  posts: state.posts.length,
  comments: Object.values(state.comments).reduce((a, l) => a + l.length, 0),
  events: state.events.length,
  reports: state.reports.length,
  file: FILE,
  loaded: existsSync(FILE),
})
