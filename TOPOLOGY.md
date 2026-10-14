# Route and link topology

How the three surfaces relate: what routes each declares, who links to whom, and which
host serves what. Every table came from reading the bundles or probing the live hosts;
the few inferences are marked as such.

Read alongside `COVERAGE.md` (what is built) and `community/DEMO.md` (how to run it).

## The three surfaces

| Surface | Served at | Source | Route table |
| --- | --- | --- | --- |
| Member app | `/` on any host | their compiled bundle (`dist/assets/`) | **35** absolute paths |
| Admin panel | `/admin` on any host | **the same bundle** | **39** relative children |
| Community forum | `community.*` host | separate SPA (`community/assets/`) | **19** paths |
| Landing clone | `/app/` | authored React | 1 path |

Admin is not a separate app. It is a route subtree inside the member SPA, sharing one
React tree and one axios instance (`baseURL: "/api"`).

## Member app — 35 absolute routes

```
/  /products  /products/:handle  /groupbuys  /groupbuys/:id  /groupbuys/orders
/sales  /sales/:id  /cart  /checkout  /checkout/payment
/coas  /play  /vip  /elite  /member-details
/dashboard  /orders  /orders/:id  /payments  /wishlist
/support  /support/tickets/:id
/login  /register  /verify-email  /forgot-password  /reset-password
/unsubscribe  /email-preferences
/disclaimer  /terms  /privacy  /shipping
/admin
```

## Admin — 39 relative children under `/admin`

```
activity-log  categories  collections  collections/:id  crypto-pending
demand  discounts  effects  fees  groupbuys  groupbuys/:id  groupbuys/new
inventory  newsletter  notifications  open-carts  orders  orders/:id
organize  payments  products  products-hub  products/:id/edit  products/new
reports  sales  sales/:id  sales/new  settings  shipping  shipping-services
spotlight  storefront  support  tags  tickets  users  users/:id
users/:userId/history
```

## Community — 19 routes

Split by an auth wrapper. `/mod` is guarded **twice**: the nav hides the link for
non-staff, and the route component redirects independently.

```
── public ──────────────────────────────────────────────────────────
/login  /join            same component
/verify  /sso  /forgot-password  /reset-password

── authenticated (layout: nav + rooms sidebar) ─────────────────────
/  /r/:slug              home feed, one component two entries
/p/:id  /calendar  /notifications  /members  /members/:id  /settings
/live  /live/lounge  /live/:id
/mod                     guarded: staff ? children : <Navigate to="/" replace>

── terminal ────────────────────────────────────────────────────────
*                        <Navigate to="/" replace>
```

## The server is not route-aware — only host-aware

37 identical paths were probed on both live hosts. **Every one returns that host's shell**,
whatever the path:

```
                              joyous.is          community.joyous.is
/  /products  /cart  ...      200 MEMBER-shell   200 COMMUNITY-shell
/admin  /admin/products       200 MEMBER-shell   200 COMMUNITY-shell
/r/general  /p/post-1         200 MEMBER-shell   200 COMMUNITY-shell
/sitemap.xml                  404                 200 COMMUNITY-shell
/nonexistent-xyz              200 MEMBER-shell   200 COMMUNITY-shell
```

Consequences worth knowing:

- **Neither host can return a meaningful 404.** A path that exists only in the *other*
  app still answers 200 with the wrong shell — so `/r/general` on `joyous.is` looks valid
  to a crawler or link checker and renders a router catch-all.
- **Routing is entirely client-side.** The host alone selects the application.
- Both shells carry `noindex, nofollow`, and `joyous.is/robots.txt` blocks all engines.
  `community.joyous.is/sitemap.xml` returns the community shell rather than a sitemap.

**The one exception**, and it is not the SPA:

```
GET https://joyous.is/live  ->  301  location: /live/
GET https://joyous.is/live/ ->  403 Forbidden
```

A server-level redirect. The member bundle never declares `/live`, so this is unrelated
to the client.

## Cross-app links

| From | To | Mechanism | Gated on |
| --- | --- | --- | --- |
| member | admin | `<Link to="/admin">` in the account dropdown | `user.isAdmin` |
| member | community | POST `/community-handoff` → redirect `<community>/sso#code=…` | approved |
| admin | member `/play` | `<Link aria-label="Play">` | in-panel |
| admin | member `/` | `<Link aria-label="Back to store">` | in-panel |
| admin | member | `GET /admin/preview/:kind/:id` | `isAdmin` |
| admin | community | **none** | — |
| community | member | `https://joyous.is` (or `localhost`) | always |

**The asymmetry:** community links out to the shop unconditionally, but nothing links
*into* community except the member account dropdown's SSO flow. **Admin and community have
no direct relationship at all** — they meet only through the member app.

Both bundles derive the peer origin from `window.location` and fall back to production:

```js
community → shop     endsWith('localhost') ? `${proto}//localhost:${port}` : 'https://joyous.is'
member  → community  === 'localhost'|'127.0.0.1' ? `${proto}//community.localhost:${port}`
                                               : 'https://community.joyous.is'
```

That is why the local harness works: `community.localhost:4400` and `localhost:4400` are
exactly the shapes these functions build.

## Group-buy and the calendar are unconnected

Worth recording because the two look related and are not.

```
                            member app     admin      community
"calendar"                       0        2 (icons)      16
"groupbuy"/"groupBuy"          42+12        yes           0
```

- The member bundle — which **owns** group-buys — has no calendar at all.
- The community bundle — which **owns** the calendar — has no group-buy vocabulary.
- The admin's two hits are a **lucide icon** (`calendar-clock`) and a **date-picker**
  `aria-label`. There is no admin calendar.
- No group-buy screen links to a calendar, and no calendar links to a group-buy.

The calendar is a community feature with its own endpoint:

```js
GET /api/community/calendar?from=ISO&to=ISO
  -> { events: [...], store: [...], spans: [...] }

events[]  { id, startsAt, title }   ours: true    community's own
store[]   { id, at, title }         ours: false   a commerce feed
spans[]   { id, from, to }                        date RANGES
```

`store[]` IDs carry `-open`/`-close`/`-start`/`-end` suffixes and are deduped against a
matching span — the shape of a **windowed sale**.

> **Inference, not verified:** those windows are almost certainly group-buy runs. The
> shape fits and the `spans` reduce open/close pairs into one range, but the community
> bundle never names them, and this endpoint is one of the four left returning `501`, so
> the live response has not been observed.

Structurally the community app **cannot** see group-buys directly: all **62** of its API
calls are rooted at its single axios instance, `baseURL: "/api/community"`, and none
addresses another base. If the calendar shows sale windows, the join happens **inside the
community backend's `/calendar` handler**, reading commerce tables and projecting them
into the community feed. **The two front-ends never meet.**

Confirming it needs one authenticated call to the live `/api/community/calendar` over a
range covering a known group-buy window.

## One observation I did not verify

The shared request interceptor attaches a "view as" header with **no path guard**:

```js
O.interceptors.request.use(e => {
  /* …Authorization from auth-storage… */
  return al() && (e.headers["X-View-As-Tier"] = Fr()), e
})
```

I checked for a `startsWith`/`includes`/`test()` scoping and found none, so while preview
mode is active the header rides along on **every** request through that client — and that
client serves both the member and admin surfaces.

Reported as an observation, **not** a vulnerability claim: I have not tested whether the
server honours the header on admin routes, and it may ignore it entirely. A header whose
only purpose is impersonating a customer tier being attached to privileged calls is worth
a look on their side, nothing more.

## External hosts reached from the admin chunks

```
https://t.17track.net/en             carrier tracking lookup
https://link.clover.com/             payment provider
https://bit.ly/3cXEKWf               shortened link in a template
https://prosemirror.net/docs/guide/  editor documentation
```

The tracking and payment hosts are real integrations — the same class as LiveKit and
Discord on the community side, i.e. **the ones that cannot be reproduced locally.**

Also note `NewsletterPage` builds **absolute production URLs** to embed in emails:

```js
const he = "https://joyous.is"
const oe = `${he}/products/${x.id}`   // product link in the newsletter body
```

Correct for an email, but a newsletter rendered from the local harness still links to the
live site.
