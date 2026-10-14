/**
 * Fixture data for the community forum's local API.
 *
 * WHY FIXTURES
 * The forum's API was never captured — the original capture ran without a community
 * session. Every response shape below WAS read off `community-DZQlDHLK.js`, so the
 * contracts are observed; only the CONTENT is invented. It is a private forum, so there
 * is no public data to reflect, and a forum with no posts renders empty states that are
 * indistinguishable from a broken screen.
 *
 * Every record carries `__fixture` so nothing downstream mistakes it for real content.
 * Names use example.com; nothing here represents an actual community member.
 *
 * SHAPES, ALL WRAPPER OBJECTS RATHER THAN BARE ARRAYS
 *   GET /rooms                     -> { rooms: [...] }
 *   GET /posts?page=n              -> { posts: [...], hasMore: bool }
 *   GET /posts/participants?ids=   -> { participants: { [postId]: [member] } }
 *   GET /members                   -> { members: [...] }
 *   GET /overview                  -> { memberCount: n, onlineCount: n }
 *   GET /events                    -> { events: [...] }   (status compared to "LIVE")
 *   GET /notifications/unread-count-> { unread: n }
 *   GET /unread                    -> { total: n, rooms: { [roomId]: n } }
 *
 * A bare array where the client expects `.rooms` is the failure mode this whole project
 * keeps producing: `undefined.map` or a silently empty screen.
 */

import { FIXTURE_MEMBER } from './community-fixtures.mjs'

const at = (daysAgo, hoursAgo = 0) =>
  new Date(Date.now() - daysAgo * 86400000 - hoursAgo * 3600000).toISOString()

export const ROOMS = [
  {
    id: 'room-general',
    slug: 'general',
    name: 'General',
    description: 'Anything community-wide.',
    emoji: '💬',
    postCount: 3,
    memberCount: 5,
    staffOnly: false,
    createdAt: at(180),
    __fixture: true,
  },
  {
    id: 'room-research',
    slug: 'research',
    name: 'Research talk',
    description: 'Papers, protocols and results.',
    emoji: '🔬',
    postCount: 4,
    memberCount: 4,
    staffOnly: false,
    createdAt: at(180),
    __fixture: true,
  },
  {
    id: 'room-news',
    slug: 'news',
    name: 'News',
    description: 'Announcements from the team.',
    emoji: '📣',
    postCount: 1,
    memberCount: 6,
    staffOnly: true,
    createdAt: at(120),
    __fixture: true,
  },
]

/** A second member, so posts are not all authored by the signed-in fixture. */
const OTHER = {
  id: 'comm-member-2',
  displayName: 'Bruno',
  name: 'Bruno Sato',
  username: 'bruno',
  email: 'bruno.sato@example.com',
  avatarUrl: null,
  role: 'MODERATOR',
  emailVerified: true,
  mutedUntil: null,
  joinedAt: at(150),
  viaDiscord: false,
  __fixture: true,
}

const THIRD = {
  id: 'comm-member-3',
  displayName: 'Chen',
  name: 'Chen Wei',
  username: 'chen',
  email: 'chen.wei@example.com',
  avatarUrl: null,
  role: 'MEMBER',
  emailVerified: true,
  mutedUntil: null,
  joinedAt: at(90),
  viaDiscord: false,
  __fixture: true,
}

export const MEMBERS = [FIXTURE_MEMBER, OTHER, THIRD]

const roomRef = (id) => {
  const r = ROOMS.find((x) => x.id === id)
  return r ? { slug: r.slug, emoji: r.emoji, name: r.name } : null
}

/**
 * `room` is an OBJECT {slug, emoji, name} — the client renders `post.room.name` and
 * `post.room.emoji` directly. A flat `roomId` renders blank, and `room: null` is legal
 * (the client treats a null room as "deleted room") which is why it is nullable here.
 *
 * `lastActivityAt` is parsed by date-fns in the topics layout, so a missing or
 * unparseable value throws RangeError rather than rendering blank. Every post carries a
 * real ISO string.
 */
export const POSTS = [
  {
    id: 'post-1',
    title: 'Welcome to the community',
    body: 'Introduce yourself, ask anything. Be kind and keep it on topic.',
    author: FIXTURE_MEMBER,
    createdAt: at(9),
    editedAt: null,
    room: roomRef('room-general'),
    pinned: true,
    locked: false,
    isNew: false,
    newComments: 0,
    truncated: false,
    images: [],
    files: [],
    poll: null,
    reactions: { '👍': 4 },
    myReactions: [],
    commentCount: 2,
    lastActivityAt: at(7),
    __fixture: true,
  },
  {
    id: 'post-2',
    title: 'Reconstitution: what actually works',
    body: 'Bacteriostatic water vs sterile. What are people using, and what have you found stable at room temperature?',
    author: OTHER,
    createdAt: at(6, 3),
    editedAt: at(6, 1),
    room: roomRef('room-research'),
    pinned: false,
    locked: false,
    isNew: true,
    newComments: 2,
    truncated: false,
    images: [],
    files: [],
    // A poll with real options: the client sums `votes` for percentages and keys each
    // option by option.id, and reads myVotes.length on vote.
    poll: {
      id: 'poll-1',
      options: [
        { id: 'opt-1', text: 'Bacteriostatic water', votes: 7 },
        { id: 'opt-2', text: 'Sterile water', votes: 3 },
      ],
      myVotes: [],
      allowMultiple: false,
      closed: false,
      showResults: true,
      totalVoters: 10,
    },
    reactions: { '👍': 8, '🔥': 3 },
    myReactions: ['👍'],
    commentCount: 5,
    lastActivityAt: at(1, 2),
    __fixture: true,
  },
  {
    id: 'post-3',
    title: 'Testing updates are now posted in the GB panel',
    body: 'Group-buy testing updates moved. Details inside the buy panel.',
    author: OTHER,
    createdAt: at(3),
    editedAt: null,
    room: roomRef('room-news'),
    pinned: false,
    locked: false,
    isNew: false,
    newComments: 0,
    truncated: false,
    images: [],
    files: [],
    poll: null,
    reactions: { '👍': 7 },
    myReactions: [],
    commentCount: 1,
    lastActivityAt: at(3),
    __fixture: true,
  },
  {
    id: 'post-4',
    title: 'Storage and shelf life',
    body: 'How is everyone storing lyophilised vials long term? Fridge or freezer?',
    author: THIRD,
    createdAt: at(1, 5),
    editedAt: null,
    room: roomRef('room-general'),
    pinned: false,
    locked: false,
    isNew: true,
    newComments: 1,
    truncated: true,
    images: [],
    files: [],
    poll: null,
    reactions: { '👍': 2 },
    myReactions: [],
    commentCount: 0,
    lastActivityAt: at(0, 3),
    __fixture: true,
  },
]

/**
 * One event is LIVE on purpose: the nav's Live dot is `events.some(e => e.status === "LIVE")`,
 * so without one that indicator is untestable.
 *
 * `startsAt` is ALWAYS formatted with date-fns on non-LIVE cards, so a missing or
 * unparseable value throws RangeError rather than rendering blank. Every event carries a
 * real ISO string, and `kind` is one the client knows.
 */
export const EVENTS = [
  {
    id: 'event-1',
    title: 'Friday research hangout',
    description: 'Open voice room, drop in any time.',
    kind: 'AUDIO',
    status: 'LIVE',
    startsAt: at(0, 1),
    coverUrl: null,
    host: OTHER,
    speakers: [OTHER, THIRD],
    faces: [OTHER, THIRD],
    myRsvp: null,
    going: 4,
    maybe: 1,
    __fixture: true,
  },
  {
    id: 'event-2',
    title: 'Monthly Q&A',
    description: 'Questions for the team, collected in advance.',
    kind: 'VIDEO',
    status: 'SCHEDULED',
    startsAt: at(-4),
    coverUrl: null,
    host: FIXTURE_MEMBER,
    speakers: [FIXTURE_MEMBER],
    faces: [FIXTURE_MEMBER, OTHER],
    myRsvp: 'GOING',
    going: 9,
    maybe: 3,
    __fixture: true,
  },
  {
    id: 'event-3',
    title: "Last month’s journal club",
    description: 'Wrapped.',
    kind: 'VIDEO',
    status: 'ENDED',
    startsAt: at(21),
    coverUrl: null,
    host: OTHER,
    speakers: [OTHER],
    faces: [OTHER],
    myRsvp: null,
    going: 6,
    maybe: 0,
    __fixture: true,
  },
]

export const NOTIFICATIONS = [
  {
    id: 'note-1',
    kind: 'REPLY',
    body: 'Bruno replied to “Welcome to the community”.',
    href: '/p/post-1',
    read: false,
    createdAt: at(0, 2),
    __fixture: true,
  },
  {
    id: 'note-2',
    kind: 'REACTION',
    body: 'Chen reacted to your post.',
    href: '/p/post-2',
    read: false,
    createdAt: at(1),
    __fixture: true,
  },
  {
    id: 'note-3',
    kind: 'MENTION',
    body: 'You were mentioned in Research talk.',
    href: '/r/research',
    read: true,
    createdAt: at(4),
    __fixture: true,
  },
]

/** Thread replies, keyed by post id — the shape `/posts/:id` returns. */
export const COMMENTS = {
  'post-1': [
    { id: 'c1', postId: 'post-1', body: 'Glad to be here.', author: OTHER, member: OTHER, createdAt: at(8), __fixture: true },
    { id: 'c2', postId: 'post-1', body: 'Welcome!', author: THIRD, member: THIRD, createdAt: at(7), __fixture: true },
  ],
  'post-2': [
    { id: 'c3', postId: 'post-2', body: 'Bac water, fridge, wrapped in foil.', author: THIRD, member: THIRD, createdAt: at(5), __fixture: true },
  ],
  'post-3': [],
  'post-4': [],
}

export const unreadCount = () => NOTIFICATIONS.filter((n) => !n.read).length

/** `{ total, rooms: { [roomId]: n } }` — stored whole by the client. */
export const unreadState = () => ({
  total: unreadCount(),
  rooms: { 'room-research': 2, 'room-general': 1 },
})

/**
 * `staff[]` drives a team block gated on `staff.length > 0`; each entry is keyed by `id`
 * and links to /members/:id, so those fields are required rather than decorative.
 */
export const overview = () => ({
  memberCount: MEMBERS.length,
  onlineCount: 2,
  staff: MEMBERS
    .filter((m) => m.role === 'ADMIN' || m.role === 'MODERATOR')
    .map((m) => ({
      id: m.id,
      displayName: m.displayName,
      avatarUrl: m.avatarUrl,
      role: m.role,
      viaDiscord: !!m.viaDiscord,
    })),
  __fixture: true,
})
