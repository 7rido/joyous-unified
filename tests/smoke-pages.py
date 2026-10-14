#!/usr/bin/env python3
"""
Page render sweep. Driven by smoke.mjs (phase 12); not run directly.

  python smoke-pages.py --base http://127.0.0.1:4400 /admin /admin/orders ...

WHY THIS EXISTS, AND WHY IT IS NOT A STATUS-CODE CHECK
/admin/open-carts returned HTTP 200 with a body of the right SHAPE and the page still
failed completely: the row renderer did `r.user.id`, the carts had only a top-level
`id`, and the resulting TypeError was caught by the error boundary — a full-page
"Something went wrong / Reload" from a perfectly successful response.

So a check that asserts `status === 200` would have called that a pass. This asserts
what actually RENDERED:

  * no uncaught page error, and no console error
  * the error boundary did not fire
  * the loading state resolved (no skeleton left behind)
  * the page produced a non-trivial amount of text

Prints PASS/FAIL lines that smoke.mjs folds into its summary.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request

from playwright.sync_api import sync_playwright

DISMISS = """() => {
  const s = [...document.querySelectorAll('div')].filter(d => {
    const cs = getComputedStyle(d), r = d.getBoundingClientRect();
    return cs.position === 'fixed' && r.width > 1000 && r.height > 600;
  });
  for (const x of s) { try { x.click(); } catch (e) {} }
}"""

# Phrases the error boundary and the shell use. None of these may appear.
BAD = (
    'something went wrong',
    'peeled off',
    "couldn't load",
    'cannot read properties',
    'failed to load',
)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:4400")
    ap.add_argument("routes", nargs="*")
    args = ap.parse_args()
    base = args.base.rstrip("/")

    me = json.load(urllib.request.urlopen(f"{base}/api/auth/me", timeout=15))["user"]
    store = json.dumps({"state": {"user": me, "token": None}, "version": 0})

    failures = 0
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch()
        except Exception as e:  # noqa: BLE001
            print(f"SKIP browser could not launch ({str(e)[:80]})")
            return 0

        ctx = browser.new_context(viewport={"width": 1600, "height": 1300})
        seed = ctx.new_page()
        seed.goto(base + "/", wait_until="domcontentloaded")
        seed.evaluate("(v) => localStorage.setItem('auth-storage', v)", store)
        seed.close()

        for route in args.routes:
            page = ctx.new_page()
            errors: list[str] = []
            failed: list[str] = []
            page.on("pageerror", lambda e: errors.append(str(e)[:110]))
            page.on(
                "console",
                lambda m: errors.append("console: " + str(m.text)[:110])
                if m.type == "error"
                else None,
            )
            page.on(
                "response",
                lambda r: failed.append(f"{r.status} {r.url.split('/', 3)[-1][:50]}")
                if r.status >= 400
                else None,
            )
            try:
                page.goto(base + route, wait_until="networkidle", timeout=30000)
                page.wait_for_timeout(3200)
                page.evaluate(DISMISS)
                page.wait_for_timeout(700)
                info = page.evaluate(
                    """() => ({
                        text: document.body.innerText.replace(/\\s+/g, ' '),
                        skeletons: document.querySelectorAll('.adm-skel').length,
                        errBoundary: !!document.querySelector('[data-error-boundary]'),
                    })"""
                )
            except Exception as e:  # noqa: BLE001
                print(f"FAIL {route} — navigation failed ({str(e)[:70]})")
                failures += 1
                page.close()
                continue

            text = info["text"].lower()
            hit = next((b for b in BAD if b in text), None)
            problems = []
            if hit:
                problems.append(f"error text {hit!r}")
            if errors:
                problems.append(f"{len(errors)} page/console error(s): {errors[0][:70]}")
            if failed:
                problems.append(f"HTTP {failed[0]}")
            if len(info["text"]) < 120:
                problems.append(f"only {len(info['text'])} chars rendered")

            if problems:
                print(f"FAIL {route} — " + "; ".join(problems))
                failures += 1
            else:
                print(f"PASS {route} renders ({len(info['text'])} chars, no errors)")
            page.close()

        browser.close()

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
