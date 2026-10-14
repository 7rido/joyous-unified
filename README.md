# Joyous — combined deployment

One origin serving two clients behind a recorded API.

```
/            the member app      their compiled client, 29 routes
/app/        the landing clone   authored React, 1 route
/api/*       22 recorded responses
```

## Run

```sh
node server.mjs 4400        # http://127.0.0.1:4400
UNIFIED_LOG=1 node server.mjs 4400   # log every request
```

No build step: `dist/` is committed complete, because half of it cannot be rebuilt.

## Why the landing clone is at /app/

Both clients emit root-relative asset URLs under `/assets/`, and the member client
is a prebuilt bundle that hardcodes its own. Two immovable namespaces cannot both
own `/assets/`, so the half we *can* rebuild moves. Vite rebases everything it
emits via `base: '/app/'`, and `scripts/rebase-assets.mjs` handles the two cases it
cannot: files copied verbatim from `public/` (theme.css) and `/assets/...` string
literals in our own JSX.

The landing clone's root links still resolve: `/` is served the member client.

## Why the two index.html files stay separate

They load different bundles. Merging them would load both clients at once.

## Coverage

**34 / 34 public routes** render with zero 404s, zero missing images and no error
boundary. Verified after driving every route and watching the network:

```
/ /products /products/:handle
/groupbuys /groupbuys/:id (x4 campaigns) /groupbuys/orders
/sales /cart /checkout /checkout/payment
/coas /dashboard /orders /payments /wishlist /support
/disclaimer /privacy /terms /shipping
/elite /vip /member-details /email-preferences
/login /register /forgot-password /reset-password /unsubscribe /verify-email
/app/  (the landing clone)
```

**Every endpoint the app requests is recorded.** 565 requests were logged across the
route sweep and the server reported zero unrecorded `/api/*` calls.

### Admin runs their real chunks too

The live site answers every `/admin/*` route with "Admins only" for this session — VIP
but not an admin. That gate is on the **server**, not in the bundle: the admin chunks
ship in the public JavaScript just like the member chunks.

So the admin panel runs the same way the member app does, on their compiled code:

```sh
ADMIN_VIEW=1 node server.mjs 4400      # then open /admin
```

**33/33 of their admin routes render the real panel.**

The gate is `!!user.isAdmin` plus a re-verification against `GET /auth/me` on mount,
so a localStorage flag is not sufficient — under `ADMIN_VIEW=1` the recorded `/auth/me`
response itself carries `isAdmin: true`, marked `__localAdminSeed`. It is off by
default and grants nothing real.

**The admin API is AUTHORED, not recorded** — and that distinction has grown teeth as
more of it was built. No `/api/admin/*` response was ever observed, so every admin
endpoint here is somebody's inference of a shape from the client that reads it.

Where nothing is implemented the server answers a derived **empty shape**, not `{}`. The
distinction matters: `{}` killed three pages on *shape* rather than data —
`J.filter is not a function` because the page did `l(y.data || [])` and filtered a
non-array, and `reading 'configured'` because the health payload's nested groups are read
without optional chaining.

Since then the heavily-trafficked ones were implemented properly and serve derived real
data: products, orders, users, support tickets, campaigns, the Today dashboard, reports,
fee settlement, discount codes, newsletter and the storefront settings. **Ten endpoints
are still hollow** — nine return an empty shape and `/api/admin/system/health` returns a
hardcoded stub whose `ok: true` asserts nothing was checked.

-> **`COVERAGE.md`** has the full picture: what is recorded versus authored, every
remaining gap, the bugs worth not repeating, and the harness's own limits.

### Auth is synthesised, not recorded

`POST /api/auth/login` and `/api/auth/register` return a session built from the
sanitised `/api/auth/me` record. These are the two endpoints that cannot be
recorded: a recorded login is a snapshot and the client needs a live response to
establish a session. Without it, login returned `{}` with HTTP 200, the client read
`data.user`, found undefined, and bounced back to `/login`.

**No credential is checked** — any email and password are accepted. This is a UI
gate, not a security boundary. The real API still requires a genuine session.

## The community forum

`community.joyous.is` is a **separate Vite React SPA** — one route prefix
(`/api/community/*`) on the same backend, not a separate service. Its client is captured
verbatim into `community/` and served on its own host:

```sh
ADMIN_VIEW=1 node server.mjs 4400
# http://community.localhost:4400     <- use http:// explicitly
```

Use `http://`. Chromium force-upgrades `https://localhost` and this server speaks plain
HTTP, so a bare `community.localhost:4400` can resolve to HTTPS and fail with
`ERR_SSL_PROTOCOL_ERROR`.

Served on its **own host rather than a path prefix**, because its bundle uses
root-relative `/assets/` URLs — 21 of its asset filenames collide with the member app's,
and all 21 are byte-identical, so host routing needs zero changes to their bytes.

Its API **is** substituted locally, including a demo dataset. See `community/DEMO.md` for
how to sign in and an explicit account of what is real (the client, the shapes) versus
invented (the content, the session).

## What is in dist/

| | |
| --- | --- |
| `dist/` | the member client: entry bundles, 70 route chunks, ~110 images |
| `dist/app/` | the landing clone build |
| `api-samples/` | 22 recorded API responses, **sanitised** |

Verified: **26/26 member routes render with zero 404s and no missing images**, and
the landing clone renders clean. Also checked directly: no account identifiers
appear in the rendered DOM.

## Sanitised

The recorded samples originally carried the real account — email, name, home
address, phone. Those are replaced with synthetic values that keep every key, type
and shape identical (see `joyous-recon/tools/sanitize-samples.py`). Product,
variant and group-buy data is untouched: it is catalogue content, and the
detail routes resolve themselves by id.

## Licence note

`dist/app/theme.css` is the design system extracted from the live site, and
`dist/` contains that site's own client bundle. Treat their licences as you would
the original site's, separate from any code authored here.

## Rebuilding

- **Member client** — cannot be rebuilt from this repo. It is the served bundle,
  preserved as-is.
- **Landing clone** — source lives in its own repo; `dist/app/` here is its build
  output with `base: '/app/'`.
