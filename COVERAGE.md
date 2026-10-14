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

## Where the API stands

| Surface | Recorded | Authored | Still empty |
| --- | --- | --- | --- |
| Member (`/api/*`) | 85 samples | login/register synthesised | — |
| Admin (`/api/admin/*`) | **4**, all `public_*` | ~113 paths backed by real routes | **12 distinct endpoints** |
| Community (`/api/community/*`) | 2 public | 18 endpoints + demo dataset | 4 reads; writes not built |

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
/calendar  /mod/reports  /connections  /gifs      -> 501 __notImplemented
/live, /live/*  auth/discord/*  mod/discord*      -> 503 __simulated
```

The distinction is deliberate. `200 {}` renders as an empty screen, which reads as "no
data"; `501` reads as "not built". Discord and LiveKit are real external services and are
refused by name rather than faked.

**Writes are not implemented** — creating posts, replies, reactions, polls and RSVPs.
The controls render and do nothing. This is the largest remaining gap in the community
surface and the one most likely to be mistaken for a bug. See **`community/DEMO.md`** for
how to run the forum, which accounts to sign in with, and what the demo seed contains.

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

1. **The 12 admin reads above** — each a thin handler over existing data. Removes the last
   empty shapes from a route tour.
2. **Community's four unimplemented reads** — `/calendar`, `/mod/reports`, `/connections`,
   `/gifs`.
3. **Community writes (Stage 3c)** — posts, replies, reactions, polls, RSVPs. Needs
   persistence following the overlay pattern.
4. **The `/sso` handoff, end to end.** Wired but never exercised: the member app POSTs
   `/api/community-handoff`, redirects to `<community>/sso#code=…`, and the client
   exchanges it at `/api/community/auth/handoff`. Both ends exist locally.
5. **`danger`** is accepted by `BANNER_STYLES` but no UI path produces it.

## Known limits of the harness

- **Auth is a fixture everywhere.** No password is checked or hashed; `ADMIN_VIEW=1` and
  the community session are UI gates, not security boundaries.
- **No health endpoint exists on the server.** The admin one is a hardcoded stub.
- **The suite exits 0 on BLOCKED.** Three checks are permanently blocked and reported as
  such; a CI keyed on exit code alone would treat them as passing.
- **`api-samples-original/`** holds the unredacted capture and is gitignored. The
  sanitised set in `api-samples/` is what the server reads.
