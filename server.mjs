/**
 * Unified server: landing clone + member app, one origin.
 *
 * ROUTING
 *   /app/*      the landing clone (authored React, its own /assets/ and theme.css)
 *   /api/*      recorded responses
 *   everything else
 *               the member client, with SPA fallback
 *
 * WHY the landing clone is not at `/`
 * Both clients emit root-relative asset URLs under /assets/, and the member client
 * is a prebuilt bundle that hardcodes its own. Two immovable namespaces cannot both
 * own `/assets/`, so the landing clone — the half we can rebuild — moves to /app/.
 * Its root links still work: `/` is caught here and served the member client.
 *
 * WHY the two index.html files are kept separate
 * They load different bundles. Merging them would load both clients at once.
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = join(HERE, 'dist')
const SAMPLES = join(HERE, 'api-samples')
const PORT = Number(process.argv[2] ?? 4400)
const VERBOSE = process.env.UNIFIED_LOG === '1'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
}

/** Resolve a regular file under `base`, refusing directories and traversal. */
function resolveFile(base, rel) {
  const clean = normalize(rel).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]/, '')
  const candidate = join(base, clean)
  if (!candidate.startsWith(base)) return null
  try {
    return statSync(candidate).isFile() ? candidate : null
  } catch {
    return null
  }
}

/** Map an API path to its recorded sample: `/api/auth/me` -> api_auth_me.json */
function sampleFileFor(pathname) {
  const name = pathname.replace(/\/+$/, '').replace(/^\//, '').replace(/\//g, '_')
  return name.length === 0 ? null : join(SAMPLES, `${name}.json`)
}

async function sendFile(res, file, { cache, range, req } = {}) {
  const body = await readFile(file)
  const type = TYPES[extname(file)] ?? 'application/octet-stream'
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes' }

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (m) {
      const [, s, e] = m
      const start = s === '' ? Math.max(body.length - Number(e), 0) : Number(s)
      const end = s === '' || e === '' ? body.length - 1 : Math.min(Number(e), body.length - 1)
      if (start <= end && start < body.length) {
        const slice = body.subarray(start, end + 1)
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': String(slice.length) })
        res.end(slice)
        return
      }
    }
  }
  res.writeHead(200, { ...headers, 'Content-Length': String(body.length), ...(cache ? { 'Cache-Control': cache } : {}) })
  res.end(body)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  const pathname = decodeURIComponent(url.pathname)
  if (VERBOSE) console.log(`  <- ${req.method} ${pathname}`)

  // --- API ---------------------------------------------------------------
  if (pathname.startsWith('/api/')) {
    // --- Auth is synthesised, not recorded -------------------------------
    // These are the only endpoints that CANNOT be recorded: a recorded login
    // response is a snapshot, and the client needs a live one to establish a
    // session. Without this, POST /auth/login returns {} with a 200, the client
    // reads `data.user`, finds undefined, and bounces straight back to /login.
    //
    // The client only requires `user` in the response shape the /auth/me sample
    // already uses, so the same object is returned for login, register and me.
    // NO CREDENTIAL IS CHECKED - any email and password are accepted, because
    // there is no backend behind this.
    if (pathname === '/api/auth/login' || pathname === '/api/auth/register') {
      let user = null
      try {
        user = JSON.parse(await readFile(join(SAMPLES, 'api_auth_me.json'), 'utf8')).user
      } catch { /* fall through */ }
      if (user) {
        console.log(`  [auth] ${pathname} -> synthetic session for ${user.email}`)
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ user, token: 'placeholder-token' }))
        return
      }
    }
    if (pathname === '/api/auth/logout') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
      return
    }

    const file = sampleFileFor(pathname)
    if (file && existsSync(file)) {
      const body = await readFile(file)
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(body)
      return
    }
    // Unrecorded: answer an empty object and say so, so gaps stay visible.
    console.log(`  [api] not recorded: ${pathname} -> {}`)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{}')
    return
  }

  // --- landing clone, mounted at /app/ -----------------------------------
  if (pathname === '/app' || pathname.startsWith('/app/')) {
    const rel = pathname.replace(/^\/app\/?/, '')
    let file = rel === '' ? join(DIST, 'app', 'index.html') : resolveFile(join(DIST, 'app'), rel)
    if (file === null) {
      // SPA fallback within the mounted app, but never for a missing asset.
      if (/\.[a-z0-9]+$/i.test(rel)) {
        console.log(`  [app] MISSING ${pathname}`)
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found')
        return
      }
      file = join(DIST, 'app', 'index.html')
    }
    await sendFile(res, file, { cache: rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' , range: req.headers.range, req })
    return
  }

  // --- member client at the root ----------------------------------------
  const rel = pathname.replace(/^\//, '')
  let file = rel === '' ? join(DIST, 'index.html') : resolveFile(DIST, rel)
  if (file === null) {
    if (rel.startsWith('assets/') || /\.[a-z0-9]+$/i.test(rel)) {
      console.log(`  [asset] MISSING ${pathname}`)
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found')
      return
    }
    file = join(DIST, 'index.html') // SPA fallback: member routes
  }
  await sendFile(res, file, { cache: rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache', range: req.headers.range, req })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`unified server on http://127.0.0.1:${PORT}`)
  console.log(`  /            member client  (${existsSync(join(DIST,'index.html')) ? 'present' : 'MISSING'})`)
  console.log(`  /app/        landing clone  (${existsSync(join(DIST,'app','index.html')) ? 'present' : 'MISSING'})`)
  console.log(`  /api/*       ${existsSync(SAMPLES) ? 'recorded samples' : 'MISSING'}`)
})
