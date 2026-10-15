# Community demo

The forum's real client, served locally with a substituted API.

```bash
cd joyous-unified && ADMIN_VIEW=1 node server.mjs 4400
# then open:  http://community.localhost:4400
```

Use `http://` explicitly. Chromium force-upgrades `https://localhost`, and this server
speaks plain HTTP — a bare `community.localhost:4400` can resolve to HTTPS and fail with
`ERR_SSL_PROTOCOL_ERROR`.

## Sign in — any password works

| Address | Role | What it shows |
| --- | --- | --- |
| `ada@example.com` | ADMIN | everything, including Moderate |
| `bruno@example.com` | MODERATOR | Moderate visible |
| `chen@example.com` | MEMBER | **no** Moderate — proves the role gate |
| any other seeded address | MEMBER | new accounts sign up via `/join` |

All ten seeded members can sign in. **Passwords are not checked** — nothing is hashed and
no credential is stored. The login form is real; the check behind it is not.

## What is in the seed

```
5 rooms     General · Research talk · Reconstitution & storage · News · Staff room 🔒
10 members  3 named above plus 7 others, each with a captured avatar
12 posts    across the rooms, 6 pages of 2 so "Load more" works
18 replies  real threads, not placeholders
 1 poll     3 options with votes — percentages render, voting is not yet wired
 4 events    one LIVE (drives the nav dot), two SCHEDULED, one ENDED
 5 alerts   3 unread, so the badge shows 3
```

Timestamps are relative to boot, so "2 days ago" stays true rather than drifting.

## The GIF picker is not GIPHY

The picker's panel carries a "Powered by GIPHY" credit upstream. There is no GIPHY here —
it needs an API key and its terms do not allow scraping a catalogue from the public site.
So `/gifs` serves a **curated local set** built from the 38 captured avatars and the eight
storefront stickers. The picker, the search, the category chips and the insertion path all
work; the images are static and are not GIPHY's.

## What is real and what is not

| | |
| --- | --- |
| The client | **Verbatim.** Their compiled bundle, byte-identical to production. |
| The API shapes | **Observed.** Read off the bundle; the signed-out response `{"member":null}` was confirmed against the live API. |
| The content | **Invented.** Marked `__fixture` throughout. A private forum has no public data to reflect. |
| Auth | **A fixture session.** No password checking, no hashing. |
| Discord, LiveKit | **Refused with 503** `__simulated`, naming the missing integration. Never faked. |
| Unbuilt endpoints | **501** `__notImplemented`, never `200 {}` — an empty object renders as "no data" rather than "not built". |

## Endpoints

Reads: `auth/me`, `rooms`, `overview`, `unread`, `notifications`,
`notifications/unread-count`, `events`, `members`, `posts`, `posts/participants`,
`posts/:id`.

Writes: `posts` (POST, PATCH, DELETE), `posts/:id/comments`, `comments/:id` (PATCH,
DELETE), `reactions`, `polls/:id/vote`, `polls/:id/close`, `events` (POST),
`events/:id/rsvp`, `reports`, `read-all`, `notifications/read`, `uploads`, plus
`auth/login`, `auth/logout`, `auth/signup`, `auth/handoff`.

Moderation: `mod/members` (with `?search=`), `mod/rooms`, `mod/discord-bot`,
`mod/discord-login`, `mod/connections` (GET, POST, PATCH, DELETE), `auth/discord/unlink`.

Moderation queue: `mod/reports` (GET with `?status=`, POST `:id` to resolve or dismiss).
Also `calendar` (with `?from=`/`?to=`), `gifs` (with `?q=`/`?kind=`), and `connections`
(staff-only cross-post targets).

Nothing returns `501` any more. What still refuses needs a real external service: `live/*`,
`mod/connections/:id/test` → 503, and `auth/discord/start` redirects with a marker.

`mod/connections/:id/test`, `auth/discord/start`, `live/*` → 503 simulated: they need an
actual Discord or LiveKit connection. Discord and connection *settings* are real and
persist — but nothing reports itself as connected, because nothing here can connect.

**Writes work.** Posting, replying, reacting, voting in polls, closing polls, RSVPs,
creating events, reporting, marking read, and editing or deleting your own posts and
comments. They persist to `community-content.json` and survive a restart.

Reset the forum by deleting that file:

```sh
rm joyous-unified/community-content.json   # back to the demo seed
```

Writes are attributed to the signed-in member, so signing in as different accounts shows
different permissions — `chen@example.com` cannot close a poll, `ada@example.com` can.
