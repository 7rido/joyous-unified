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

Implemented: `auth/me` (GET, PATCH), `auth/login`, `auth/logout`, `auth/signup`,
`auth/handoff`, `uploads`, `rooms`, `overview`, `unread`,
`notifications/unread-count`, `notifications`, `events`, `members`, `posts`,
`posts/participants`, `posts/:id`.

Still refusing: `calendar`, `mod/reports`, `connections`, `gifs` → 501.
`live/*`, `auth/discord/*`, `mod/discord*` → 503 simulated.

Writes (creating posts, replies, reactions, polls, RSVPs) are **not implemented**, so
those controls are present but inert.
