/**
 * DEMO seed for the local community forum.
 *
 * WHAT THIS IS
 * Named accounts, rooms, threads, replies, polls, events and notifications — enough that
 * every screen has something in it and every feature is reachable. It is FIXTURE DATA:
 * every record carries `__fixture`, addresses use example.com, and nobody here is a real
 * member. This is a private forum, so there is no public content to reflect, and a forum
 * with nothing in it shows empty states that look identical to a broken screen.
 *
 * SHAPES ARE OBSERVED, CONTENT IS INVENTED
 * Every response shape was read off `community-DZQlDHLK.js`. The constraints that bite:
 *   - every endpoint returns a WRAPPER OBJECT, never a bare array
 *   - `posts[].room` is an OBJECT {slug, emoji, name}, not an id
 *   - `lastActivityAt` and `events[].startsAt` are parsed by date-fns, so they must be
 *     real ISO strings — a bad one throws RangeError, not a blank cell
 *   - `unread.rooms` is a MAP keyed by room id, not an array
 *   - member sub-objects are read as {id, displayName, avatarUrl, role, viaDiscord}
 *
 * SIGN IN WITH ANY OF THESE (any non-empty password — passwords are not checked):
 *   ada@example.com     ADMIN       full moderation surfaces
 *   bruno@example.com   MODERATOR   /mod reachable
 *   chen@example.com    MEMBER      /mod hidden — proves the role gate works
 */

import { chrono } from './community-fixtures.mjs'

const A = (n) => `/avatars/${n}.webp`
const at = (days = 0, hours = 0) => chrono(days, hours)

/* --------------------------------------------------------------- members --- */

const m = (id, displayName, username, role, avatar, joinedDays, bio) => ({
  id,
  displayName,
  name: displayName,
  username,
  email: `${username}@example.com`,
  avatarUrl: A(avatar),
  role,
  tier: role === 'MEMBER' ? 'USER' : 'ELITE',
  // The client gates posting on `emailVerified && !mutedUntil`. Without both a member
  // renders read-only in a way that looks like a bug rather than a state.
  emailVerified: true,
  mutedUntil: null,
  viaDiscord: false,
  bio,
  joinedAt: at(joinedDays),
  __fixture: true,
})

export const ADA = m('comm-1', 'Ada', 'ada', 'ADMIN', '03-joyo-lab', 210,
  'Runs the place. Research use only, be kind, no selling.')
export const BRUNO = m('comm-2', 'Bruno', 'bruno', 'MODERATOR', '02-joyo-cool', 195,
  'Moderator. Mostly here for the peptide chemistry threads.')
export const CHEN = m('comm-3', 'Chen', 'chen', 'MEMBER', '08-joyo-space', 160,
  'Reconstitution and storage nerd.')
export const DARA = m('comm-4', 'Dara', 'dara', 'MEMBER', '11-joyo-read', 140,
  'Lab background, glad to help with protocols.')
export const ELIF = m('comm-5', 'Elif', 'elif', 'MEMBER', '06-joyo-party', 120,
  'New here. Reading everything.')
export const FARID = m('comm-6', 'Farid', 'farid', 'MEMBER', '04-joyo-gym', 95,
  'Training and recovery.')
export const GITA = m('comm-7', 'Gita', 'gita', 'MEMBER', '10-corgi', 80,
  'Mostly lurking, occasionally posting links.')
export const HANA = m('comm-8', 'Hana', 'hana', 'MEMBER', '37-joyo-karaoke', 60,
  'Long-time lurker, first-time poster.')
export const IVAN = m('comm-9', 'Ivan', 'ivan', 'MEMBER', '39-joyo-zen', 45,
  'Here for the journal club.')
export const JUNO = m('comm-10', 'Juno', 'juno', 'MEMBER', '33-joyo-painter', 30,
  'Just joined. Hello!')

export const MEMBERS = [ADA, BRUNO, CHEN, DARA, ELIF, FARID, GITA, HANA, IVAN, JUNO]
export const STAFF = [ADA, BRUNO]

/** Only these may sign in. Passwords are NOT checked — see community-api.mjs. */
export const LOGIN_INDEX = new Map(MEMBERS.map((x) => [x.email, x]))

/* ----------------------------------------------------------------- rooms --- */

export const ROOMS = [
  { id: 'room-general', slug: 'general', name: 'General', emoji: '💬',
    description: 'Anything community-wide. Say hello.', staffOnly: false, position: 0,
    memberCount: 10, createdAt: at(300), __fixture: true },
  { id: 'room-research', slug: 'research', name: 'Research talk', emoji: '🔬',
    description: 'Papers, protocols and results. Cite where you can.', staffOnly: false, position: 1,
    memberCount: 8, createdAt: at(300), __fixture: true },
  { id: 'room-recon', slug: 'reconstitution', name: 'Reconstitution & storage', emoji: '🧪',
    description: 'Solvents, concentrations, fridge vs freezer.', staffOnly: false, position: 2,
    memberCount: 7, createdAt: at(240), __fixture: true },
  { id: 'room-news', slug: 'news', name: 'News', emoji: '📣',
    description: 'Announcements from the team.', staffOnly: false, position: 3,
    memberCount: 10, createdAt: at(200), __fixture: true },
  { id: 'room-staff', slug: 'staff', name: 'Staff room', emoji: '🔒',
    description: 'Moderators only.', staffOnly: true, position: 4,
    memberCount: 2, createdAt: at(200), __fixture: true },
]

const room = (slug) => {
  const r = ROOMS.find((x) => x.slug === slug)
  return r ? { slug: r.slug, emoji: r.emoji, name: r.name } : null
}

/* ----------------------------------------------------------------- posts --- */

const p = (o) => ({
  editedAt: null, pinned: false, locked: false, isNew: false, newComments: 0,
  truncated: false, images: [], files: [], poll: null, reactions: {}, myReactions: [],
  commentCount: 0, ...o, __fixture: true,
})

export const POSTS = [
  p({ id: 'post-1', room: room('news'), author: ADA,
      title: 'Welcome — read this first',
      body: 'A few ground rules.\n\n1. Research use only. Nothing here is medical advice.\n2. No selling, no sourcing, no pricing talk in the open rooms.\n3. Cite where you can — a link beats a recollection.\n4. Be kind. Questions are welcome however basic they feel.\n\nUse the rooms on the left. If you need a hand, open a ticket and someone will pick it up.',
      createdAt: at(9), lastActivityAt: at(2), pinned: true,
      reactions: { '👍': 18, '🙏': 4 }, commentCount: 3 }),

  p({ id: 'post-2', room: room('research'), author: BRUNO,
      title: 'Reconstitution: what actually works',
      body: 'Bacteriostatic water vs sterile water keeps coming up, so let us settle it.\n\nBacteriostatic contains 0.9% benzyl alcohol, which is what stops microbial growth once the vial is punctured. Sterile water has no preservative, so a multi-dose vial is a countdown once you break the seal.\n\nFor anything you will draw from more than once, bac water. For a single-use reconstitution, sterile is fine and marginally gentler.',
      createdAt: at(7), lastActivityAt: at(0, 4),
      reactions: { '👍': 12, '🔥': 5, '🤔': 2 }, myReactions: ['👍'],
      poll: {
        id: 'poll-1', allowMultiple: false, closed: false, showResults: true, totalVoters: 23, myVotes: [],
        options: [
          { id: 'opt-1', text: 'Bacteriostatic water', votes: 17 },
          { id: 'opt-2', text: 'Sterile water', votes: 4 },
          { id: 'opt-3', text: 'Depends on the compound', votes: 2 },
        ],
      }, commentCount: 3 }),

  p({ id: 'post-3', room: room('recon'), author: CHEN,
      title: 'Freezer or fridge for lyophilised vials?',
      body: 'Conventional answer is -20°C for long term, fridge for whatever is in play this month. The thing people get wrong is condensation: pulling a cold vial out and letting it warm with the stopper exposed pulls moisture straight in.\n\nLet it come to room temperature sealed, then wipe the stopper with an alcohol swab before you draw.',
      createdAt: at(6), lastActivityAt: at(1, 6),
      reactions: { '👍': 9, '💡': 6 }, commentCount: 2 }),

  p({ id: 'post-4', room: room('research'), author: DARA,
      title: 'Reading a COA properly',
      body: 'A certificate is only worth what the method behind it is worth. Things I check in order:\n\n- Is the lot number on the COA the lot number on my vial?\n- HPLC purity is not the same as content. 99% pure of what?\n- Mass spec confirms identity — no MS, no identity claim.\n- Who ran it, and when. A two-year-old COA on a new lot is a copy, not a test.',
      createdAt: at(5), lastActivityAt: at(3),
      reactions: { '👍': 14, '🙏': 7, '🔥': 3 }, commentCount: 2 }),

  p({ id: 'post-5', room: room('general'), author: ELIF,
      title: 'New here — where should I start?',
      body: 'Joined last week and honestly a bit overwhelmed by the number of rooms. I have read the welcome post. What would you tell someone to read next?',
      createdAt: at(4), lastActivityAt: at(0, 2),
      reactions: { '👋': 11, '👍': 3 }, commentCount: 3 }),

  p({ id: 'post-6', room: room('news'), author: ADA,
      title: 'Group-buy testing updates have moved',
      body: 'Testing updates now live inside each buy panel rather than as separate posts, so the status sits next to the thing it describes. Nothing is lost — previous updates stay where they were.',
      createdAt: at(3), lastActivityAt: at(3),
      reactions: { '👍': 8 }, commentCount: 1 }),

  p({ id: 'post-7', room: room('research'), author: FARID,
      title: 'Does timing of administration matter?',
      body: 'Curious whether anyone has found a meaningful difference between morning and evening for compounds with a shorter half-life. Anecdotes welcome, but say so if it is an anecdote.',
      createdAt: at(2, 6), lastActivityAt: at(0, 8),
      reactions: { '🤔': 5, '👍': 2 }, commentCount: 2 }),

  p({ id: 'post-8', room: room('recon'), author: CHEN,
      title: 'Concentration maths, once and for all',
      body: 'mg ÷ mL = mg/mL. That is the whole thing.\n\nA 5mg vial with 2mL added is 2.5 mg/mL. Want 250mcg? That is 0.25mg, so 0.1mL. Write the units down every time and you will not slip a decimal.',
      createdAt: at(2), lastActivityAt: at(1, 2),
      reactions: { '👍': 13, '💡': 9 }, commentCount: 1 }),

  p({ id: 'post-9', room: room('general'), author: GITA,
      title: 'Useful reading, collected',
      body: 'Keeping a running list of things worth reading. Adding as I go rather than posting each one separately.',
      createdAt: at(1, 8), lastActivityAt: at(1, 8),
      reactions: { '👍': 6 }, commentCount: 0 }),

  p({ id: 'post-10', room: room('general'), author: HANA,
      title: 'Long-time lurker, finally saying hello',
      body: 'Been reading for about a year and never posted. The welcome thread convinced me. Hello everyone.',
      createdAt: at(1, 2), lastActivityAt: at(0, 6),
      reactions: { '👋': 15, '🎉': 4 }, commentCount: 2, isNew: true }),

  p({ id: 'post-11', room: room('research'), author: IVAN,
      title: 'Journal club — nominations for next month',
      body: 'Post what you would like to go through. Anything with a decent methods section, ideally open access so everyone can read it.',
      createdAt: at(0, 10), lastActivityAt: at(0, 10),
      reactions: { '👍': 4 }, commentCount: 0, isNew: true }),

  p({ id: 'post-12', room: room('news'), author: ADA,
      title: 'Quiet week, short update',
      body: 'Nothing to report beyond the usual. Thread is open if you want to raise anything.',
      createdAt: at(0, 4), lastActivityAt: at(0, 4),
      reactions: {}, commentCount: 0, isNew: true, truncated: true }),
]

/* -------------------------------------------------------------- comments --- */

const c = (id, postId, author, body, days, hours = 0) => ({
  id, postId, author, member: author, body, createdAt: at(days, hours), editedAt: null, __fixture: true,
})

export const COMMENTS = {
  'post-1': [
    c('c-1', 'post-1', CHEN, 'Thanks — the "no pricing talk" rule is worth pinning, it comes up constantly.', 8),
    c('c-2', 'post-1', ELIF, 'Appreciate the welcome. Clear rules make it easier to post.', 5),
    c('c-3', 'post-1', ADA, 'Added that to the pinned copy. Thanks Chen.', 2),
  ],
  'post-2': [
    c('c-4', 'post-2', CHEN, 'Agree on bac water for multi-dose. One caveat: worth flagging if anyone reacts to the preservative, because that is a real thing and not always obvious.', 6),
    c('c-5', 'post-2', BRUNO, 'Good point, adding it to the body. Benzyl alcohol sensitivity is uncommon but it is not nothing.', 5),
    c('c-6', 'post-2', DARA, 'Voted "depends". For something I will use within the week, sterile has been fine.', 0, 4),
  ],
  'post-3': [
    c('c-7', 'post-3', DARA, 'The condensation point is the one people miss. Sealed and to room temperature, every time.', 5),
    c('c-8', 'post-3', FARID, 'Does that apply if it is going straight back in? I have been pulling and re-freezing.', 1, 6),
  ],
  'post-4': [
    c('c-9', 'post-4', BRUNO, 'Lot number matching is the step everyone skips. Good list.', 4),
    c('c-10', 'post-4', IVAN, 'Adding: check the date against the lot, not against the order.', 3),
  ],
  'post-5': [
    c('c-11', 'post-5', ADA, 'Start with the reconstitution room — it answers most of the first-week questions.', 3, 20),
    c('c-12', 'post-5', CHEN, 'And the concentration maths thread once you have a vial in hand.', 3, 18),
    c('c-13', 'post-5', HANA, 'Same position as you a year ago. It gets clearer fast.', 0, 2),
  ],
  'post-6': [
    c('c-14', 'post-6', GITA, 'Much easier to follow now that it sits with the buy.', 3),
  ],
  'post-7': [
    c('c-15', 'post-7', BRUNO, 'Anecdote: no difference I could tell. Flagging it as an anecdote.', 2, 2),
    c('c-16', 'post-7', DARA, 'Half-life argues for more frequent rather than a specific clock time, for what that is worth.', 0, 8),
  ],
  'post-8': [
    c('c-17', 'post-8', ELIF, 'Writing the units down is the bit I needed. Thank you.', 1, 2),
  ],
  'post-10': [
    c('c-18', 'post-10', GITA, 'Welcome!', 1),
    c('c-19', 'post-10', JUNO, 'Also new, also nervous about posting. Hi.', 0, 6),
  ],
}

/* ---------------------------------------------------------------- events --- */

/**
 * One LIVE event on purpose: the nav dot is `events.some(e => e.status === "LIVE")`, and
 * the RSVP controls only render for LIVE or SCHEDULED. `startsAt` is parsed by date-fns
 * on every non-LIVE card, so it must be a real ISO string.
 */
export const EVENTS = [
  { id: 'event-1', title: 'Friday research hangout', description: 'Open voice room. Drop in, no agenda.',
    kind: 'AUDIO', status: 'LIVE', startsAt: at(0, 1), coverUrl: null,
    host: BRUNO, speakers: [BRUNO, CHEN, DARA], faces: [BRUNO, CHEN, DARA, ELIF],
    myRsvp: null, going: 6, maybe: 2, __fixture: true },
  { id: 'event-2', title: 'Monthly Q&A with the team', description: 'Collect questions in advance; we work through them live.',
    kind: 'VIDEO', status: 'SCHEDULED', startsAt: at(-4), coverUrl: null,
    host: ADA, speakers: [ADA], faces: [ADA, BRUNO, IVAN, HANA],
    myRsvp: 'GOING', going: 14, maybe: 5, __fixture: true },
  { id: 'event-3', title: 'Journal club: methods sections', description: 'Bring one paper and read the methods out loud.',
    kind: 'VIDEO', status: 'SCHEDULED', startsAt: at(-11), coverUrl: null,
    host: IVAN, speakers: [IVAN, DARA], faces: [IVAN],
    myRsvp: 'MAYBE', going: 7, maybe: 4, __fixture: true },
  { id: 'event-4', title: 'Last month’s journal club', description: 'Wrapped. Recording in the thread.',
    kind: 'VIDEO', status: 'ENDED', startsAt: at(26), coverUrl: null,
    host: IVAN, speakers: [IVAN], faces: [IVAN, CHEN],
    myRsvp: null, going: 9, maybe: 0, __fixture: true },
]

/* --------------------------------------------------------- notifications --- */

export const NOTIFICATIONS = [
  { id: 'note-1', kind: 'REPLY', body: 'Bruno replied to “Reconstitution: what actually works”.',
    href: '/p/post-2', read: false, createdAt: at(0, 4), actor: BRUNO, __fixture: true },
  { id: 'note-2', kind: 'MENTION', body: 'Dara mentioned you in Research talk.',
    href: '/r/research', read: false, createdAt: at(0, 9), actor: DARA, __fixture: true },
  { id: 'note-3', kind: 'REACTION', body: 'Hana reacted 👋 to your welcome post.',
    href: '/p/post-1', read: false, createdAt: at(1, 3), actor: HANA, __fixture: true },
  { id: 'note-4', kind: 'REPLY', body: 'Chen replied in Reconstitution & storage.',
    href: '/p/post-3', read: true, createdAt: at(2), actor: CHEN, __fixture: true },
  { id: 'note-5', kind: 'EVENT', body: 'Monthly Q&A starts in four days.',
    href: '/live', read: true, createdAt: at(3), actor: ADA, __fixture: true },
]

/* ---------------------------------------------------------------- derived --- */

export const unreadCount = () => NOTIFICATIONS.filter((n) => !n.read).length

/** `rooms` is a MAP keyed by room ID — the client looks up `o.rooms[room.id]`. */
export const unreadState = () => {
  const rooms = {}
  const postRoom = (id) => POSTS.find((x) => x.id === id)?.room?.slug
  for (const n of NOTIFICATIONS.filter((x) => !x.read)) {
    const slug = postRoom(String(n.href || '').replace('/p/', ''))
    const r = ROOMS.find((x) => x.slug === slug)
    if (r) rooms[r.id] = (rooms[r.id] || 0) + 1
  }
  return { total: unreadCount(), rooms }
}

export const overview = () => ({
  memberCount: MEMBERS.length,
  onlineCount: 4,
  staff: STAFF.map((x) => ({
    id: x.id, displayName: x.displayName, avatarUrl: x.avatarUrl,
    role: x.role, viaDiscord: false,
  })),
  __fixture: true,
})

/** `{ participants: { [postId]: Member[] } }` — merged into a map by the client. */
export const participantsFor = (ids) => {
  const out = {}
  for (const id of ids) {
    const post = POSTS.find((x) => x.id === id)
    if (post) out[id] = [post.author]
  }
  return out
}

export const postById = (id) => POSTS.find((x) => x.id === id) || null
export const commentsFor = (id) => COMMENTS[id] ?? []
