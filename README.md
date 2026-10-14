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
