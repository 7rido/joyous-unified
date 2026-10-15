# Coverage and gaps

What is real, what is authored, and what is still missing. Every number here came from a
command run against the working tree, not from recollection — the point of this file is
that the claims are checkable.

Last verified at `e10bcb4`, suite **295 passed, 0 failed, 0 skipped, 3 blocked**,
18/18 phases.

```sh
node tests/smoke.mjs --python ../.harbor-env/tools/perfect-web-clone/bin/python
```

## The three clients

Route tables, cross-app links and which host serves what: **`TOPOLOGY.md`**.

| | Source | Status |
| --- | --- | --- |
| Member app (`/`) | **their compiled bundle**, 163 chunks | ~100% — captured verbatim |
| Admin panel (`/admin`) | **same bundle**, ~87 extra chunks | Runs their real code; the API behind it is authored |
| Community (`community.*`) | **their compiled bundle**, separate SPA | Client verbatim, API substituted |
| Landing clone (`/app/`) | **authored** React with `_source-original/` beside it | Reimplementation |

**35 member routes** start with `/` in the route table (including `/admin`); **39** further
entries are relative children under `/admin`. 89 API responses were recorded; everything
else the client calls is authored here.

## The community stages

The community work ran in numbered stages, and later sections of this file refer to them
by name, so they are written down here. Stages 1–2 captured and served the client; stage 3
substituted its API in three parts.

| Stage | What it was | State | Commit |
| --- | --- | --- | --- |
| **1** | Capture the forum SPA — shell, 24 assets, 38 avatars | done | `e7e0054` |
| **2** | Serve it on the `community.*` host | done | `e7e0054` |
| **3a** | Substituted API — session and auth | done | `e3475ea` |
| **3b** | Read surface, 18 endpoints, plus the demo seed | done | `074aa62` `e10bcb4` |
| **3c** | Write surface — 13 endpoints, persisted | **done** | this commit |
| **3d** | Discord settings real, connection not | **partial** | this commit |

**3d is split, and the split is the point.** You cannot reproduce somebody else's Discord
bot or a LiveKit SFU locally, so anything requiring an actual conversation with those
services still answers `503 __simulated` and names the missing integration. What IS real
is the configuration surface:

```
real, persists        /mod/discord-bot (GET, PUT, DELETE)   /mod/discord-login (PUT)
                      /mod/connections (GET, POST, PATCH, DELETE)
                      /auth/discord/unlink
still refuses         /mod/connections/:id/test    needs Discord to verify a secret
                      /auth/discord/start          OAuth redirect; 302s back to /settings
                      /live, /live/moderate        needs a LiveKit SFU
```

**Nothing reports itself as connected.** A saved bot token returns `status: 'error'` with
the reason attached, not `connected`, because a stored token is not a live bot and a green
dot would be a lie the UI then repeats. Secrets are stored but never read back — only a
masked preview — so a screenshot cannot leak one.

The earlier blanket `503` was worse than it looked: the client could not tell "no Discord
configured" from "this endpoint is broken", so the page's own honest copy —
*"Signing in with Discord isn't switched on yet"* — was unreachable.

Two things sit **outside** this numbering and are not stage work:

- **No community endpoint returns `501` any more.** The last four reads — `/calendar`,
  `/mod/reports`, `/connections`, `/gifs` — are implemented. What remains is the `/sso`
  handoff above, which is a flow rather than an endpoint.
- **The `/sso` handoff**, wired at both ends but never exercised. The member app POSTs
  `/api/community-handoff`, redirects to `<community>/sso#code=…`, and the client
  exchanges it at `/auth/handoff`. All three pieces exist locally.

## Where the API stands

| Surface | Recorded | Authored | Still empty |
| --- | --- | --- | --- |
| Member (`/api/*`) | 85 samples | login/register synthesised | — |
| Admin (`/api/admin/*`) | **4**, all `public_*` | ~113 paths backed by real routes | **10 endpoints** |
| Community (`/api/community/*`) | 2 public | 18 reads + 13 writes + demo dataset | 4 reads |

There is **no database**. Persistence is JSON overlays written atomically and
re-validated on load: `admin-products.json`, `promo-codes.json`, `newsletter.json`,
`storefront-config.json`, `idempotency-keys.json`, `pack-deals.json`, plus `outbox/` and
`community/uploads/`.

### 10 admin endpoints still hollow, verified by probing each one

Nine return a genuinely **empty shape**:

```
/api/admin/dashboard/awaiting-payment   /api/admin/activity-logs
/api/admin/activity-logs/facets         /api/admin/demand
/api/admin/stock-levels                 /api/admin/users/counts
/api/admin/fees/settlement-wallets      /api/admin/shipstation/carriers
/api/admin/shipstation/allowlist
```

Plus `/api/admin/fees/by-month/:id`, which answers `{}`.

One more is a hardcoded **stub** rather than an empty shape — it returns plausible values
that nothing derives:

```
/api/admin/system/health -> {"configured":false,"ok":true,"database":"ok","storage":"ok",...}
```

That one is arguably worse than empty, because `ok: true` reads as a passing health check
when nothing was checked. All eleven are reads derivable from data that already exists —
the cheapest remaining work on the admin side.

### Community: 501 rather than 200

```
/live, /live/*                     -> 503 __simulated   (needs a LiveKit SFU)
/mod/connections/:id/test          -> 503 __simulated   (needs Discord to verify a secret)
/auth/discord/start, /callback     -> 302 back to /settings with a marker
```

Nothing returns `501` any more: the four unbuilt reads are done.

The distinction is deliberate. `200 {}` renders as an empty screen, which reads as "no
data"; `501` reads as "not built". Discord and LiveKit are real external services and are
refused by name rather than faked.

**Writes are not implemented** — creating posts, replies, reactions, polls and RSVPs.
This is the largest remaining gap in the community surface and the one most likely to be
mistaken for a bug. See **`community/DEMO.md`** for how to run the forum, which accounts to
sign in with, and what the demo seed contains.

**Writes are implemented and persisted** (stage 3c, 13 endpoints). Creating posts,
replying, reacting, voting, RSVPs, reports, marking read, editing and deleting all work,
and survive a server restart. Content lives in `community-content.json`, written
atomically and **re-validated on load** — a hand-edited file cannot inject a reaction count
of -5 or a post with no room, and anything repaired is reported at boot.

Two response shapes are easy to get wrong, and both fail quietly rather than loudly:

- **`POST /reactions` must return `{reacted}`.** The caller treats a null as failure, so a
  200 without that field shows "Couldn't react" despite having stored the reaction.
- **`/polls/:id/vote` and `PUT /events/:id/rsvp` return the WHOLE updated object**, which
  the client drops straight into state. A partial body leaves the UI stale.

Before 3c, a refused write was **silent**: the request fired, got `501`, and produced zero
console errors, no toast and no visible change, because the handlers use `.catch(() => {})`.
That is why a click appeared to do nothing rather than surfacing a refusal.

## Things that were wrong and are now documented

Each of these cost real time and would recur if unwritten.

**Enums must come from the client that sends them.** `storefront-config.mjs` validated
`density` against `['low','medium','high']` while the form offered
`['light','medium','heavy']`, so two of three options produced a 422. The Effects tab
animates a **local preview** from form state, which made a rejected save look successful.
Two other enums had the same defect. The suite now pins every option list against the
bundle.

**Response shapes are wrapper objects, usually.** `/api/admin/support/tickets` wanted
`{tickets, hasMore}` and got a bare array; `/api/admin/discounts` wanted
`{discounts: [...]}` and got a bare array; every `/api/community/*` read is a wrapper and
the client does `data.rooms`, `data.posts`, `data.events`. A bare array where a wrapper is
expected gives `undefined.map` and an error boundary; the reverse gives a silently empty
screen.

**`Content-Length` must count bytes, not code units.** `JSON.stringify(body).length`
counts UTF-16 units while `res.end()` writes UTF-8. One room emoji is 2 units and 4 bytes,
so the header understated the body and Node truncated the JSON mid-string. The API looked
healthy — 200, correct content-type — and the crash surfaced inside a React component.

**An `/api/` request must never receive the SPA shell.** The client parses it as JSON and
dies on `<`. The community host branch's catch-all claimed `/api/` until it was gated.

**A recorded sample will shadow a live value.** `/api/admin/public/notification-banner`
has a sample file, and the generic replay matched it before the dedicated handler — so a
save was written, read back correctly by the admin form, and ignored by the storefront.
Paths whose live value must win are listed in `LIVE_NOT_RECORDED`.

**Assets referenced from JavaScript are not in the HTML.** The community avatar picker
maps a hardcoded array of 38 names to `/avatars/<n>.webp`. A crawl that follows the shell
cannot see them; all 38 404'd and the picker's `.map` threw.

**`const` does not hoist, and import cycles are fatal.** Three separate boot failures from
referencing a binding above its declaration, one of them a circular import between
`community-api` and its seed. The fixture identity now lives in its own module so the
graph is one-way.

## Open items, cheapest first

1. **The `/sso` handoff, end to end** — the only community item left. Everything else is
   built; see below.
2. **The 10 admin reads** — each a thin handler over existing data. Removes the last
   hollow shapes from a member-app route tour.
3. **`danger`** is accepted by `BANNER_STYLES` but no UI path produces it.

**Not on this list, on purpose:** Discord and LiveKit (stage 3d). They answer `503` and
always will.

## Known limits of the harness

- **Auth is a fixture everywhere.** No password is checked or hashed; `ADMIN_VIEW=1` and
  the community session are UI gates, not security boundaries.
- **No health endpoint exists on the server.** The admin one is a hardcoded stub.
- **The suite exits 0 on BLOCKED.** Three checks are permanently blocked and reported as
  such; a CI keyed on exit code alone would treat them as passing.
- **`api-samples-original/`** holds the unredacted capture and is gitignored. The
  sanitised set in `api-samples/` is what the server reads.
