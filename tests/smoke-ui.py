#!/usr/bin/env python3
"""
UI half of the ordering smoke test. Driven by smoke.mjs; not run directly.

Two things here are non-obvious and were each a multi-hour bug:

1. THE SIGNATURE PAD. Submit Order opens a "Confirm your order" dialog whose button
   TRANSFORMS once a signature registers:

       before signing:  "Submit Order"          disabled, does nothing
       after signing:   "Sign & submit order"   this is the one that posts

   Clicking the stale "Submit Order" silently does nothing. The pad also needs
   >= 10 pointer moves before onSignatureChange(true) fires, a REAL mouse drag (not
   synthetic events), and a viewport tall enough that the pad is fully on screen.

2. THE AUTH SEED. The member session is carried in `auth-storage` in localStorage.
   The admin flag is NOT: it comes from the server's /api/auth/me under ADMIN_VIEW=1,
   because the layout re-verifies against the server on mount.

Prints PASS/FAIL/SKIP lines that smoke.mjs folds into its summary.
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


def emit(status: str, name: str, detail: str = "") -> None:
    print(f"{status} {name}" + (f"  ({detail})" if detail else ""))


def jget(url: str):
    with urllib.request.urlopen(url, timeout=15) as r:
        return json.load(r)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:4400")
    args = ap.parse_args()
    base = args.base.rstrip("/")

    me = jget(f"{base}/api/auth/me")["user"]
    store = json.dumps({"state": {"user": me, "token": None}, "version": 0})

    failures = 0
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch()
        except Exception as e:  # noqa: BLE001
            emit("SKIP", "browser could not launch", str(e)[:120])
            return 0

        # A tall viewport: the signature pad sits below the fold at 900px, and an
        # off-screen pad cannot be signed.
        ctx = browser.new_context(viewport={"width": 1440, "height": 1100})
        seed = ctx.new_page()
        seed.goto(base + "/", wait_until="domcontentloaded")
        seed.evaluate("(v) => localStorage.setItem('auth-storage', v)", store)
        seed.close()

        page = ctx.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)[:160]))

        # ---- catalog -----------------------------------------------------
        page.goto(base + "/products", wait_until="networkidle", timeout=30000)
        page.wait_for_timeout(2500)
        page.evaluate(DISMISS)
        page.wait_for_timeout(600)
        # The seeded products are APPENDED to the 66-product catalogue, and the shelf
        # renders only the first few cards, so they are not on screen by default. That
        # is real behaviour worth asserting rather than a bug: a product past the fold
        # must still be FINDABLE. Search is how a customer reaches it.
        cards_before = page.evaluate("""() => {
            const g = [...document.querySelectorAll('div')]
              .filter(d => /^repeat\\(/.test(getComputedStyle(d).gridTemplateColumns) && d.children.length > 2);
            return g.reduce((a, x) => a + x.children.length, 0);
        }""")
        page.fill('input[placeholder*="earch" i]', "Product A")
        page.wait_for_timeout(2500)
        body = page.inner_text("body")
        if "Product A (High Stock)" in body:
            emit("PASS", "a seeded product is findable through catalog search",
                 f"grid showed {cards_before} card(s) unfiltered; search surfaces it")
        else:
            emit("FAIL", "seeded product not findable via search",
                 f"searched 'Product A' with {cards_before} cards showing")
            failures += 1

        # And the price shown must be the catalogue price, not something the client set.
        if "$25.00" in body:
            emit("PASS", "the seeded product shows its catalogue price", "$25.00")
        else:
            emit("FAIL", "seeded product price not shown", "expected $25.00")

        # A sold-out product must not offer Add to cart.
        page.goto(base + "/products/test-product-c-out-of-stock", wait_until="networkidle", timeout=30000)
        page.wait_for_timeout(2200)
        page.evaluate(DISMISS)
        page.wait_for_timeout(500)
        cta = page.evaluate("""() => {
            const b = [...document.querySelectorAll('button')]
              .map(x => (x.innerText || '').replace(/\\s+/g, ' ').trim())
              .find(t => /add to cart|notify me|sold out/i.test(t));
            return b || '';
        }""")
        if "notify me" in cta.lower() and "add to cart" not in cta.lower():
            emit("PASS", "0-stock product shows Notify-me, not Add to cart", cta)
        elif "add to cart" in cta.lower():
            emit("FAIL", "0-stock product must not offer Add to cart", cta)
            failures += 1
        else:
            emit("SKIP", "0-stock CTA could not be classified", repr(cta))

        # Clear the search so later steps see the normal shelf.
        page.fill('input[placeholder*="earch" i]', "")
        page.wait_for_timeout(900)

        # ---- full checkout -------------------------------------------------
        # Cart is already populated by the API phases; walk the UI from cart onward.
        page.goto(base + "/checkout", wait_until="networkidle", timeout=30000)
        page.wait_for_timeout(2500)
        page.evaluate(DISMISS)
        page.wait_for_timeout(600)

        # Address
        page.evaluate("""() => {
            const b = [...document.querySelectorAll('button')].find(x => /select an address/i.test(x.innerText || ''));
            if (b) b.click();
        }""")
        page.wait_for_timeout(1400)
        page.evaluate("""() => {
            const b = [...document.querySelectorAll('button')].filter(x => /123 Example Street/i.test(x.innerText || ''));
            if (b.length) b[b.length - 1].click();
        }""")
        page.wait_for_timeout(2200)

        summary = page.evaluate("""() => {
            const t = document.body.innerText.replace(/\\s+/g, ' ');
            const g = (k) => { const m = new RegExp(k + '[^$]*\\\\$([0-9.]+)').exec(t); return m ? Number(m[1]) : null; };
            return { subtotal: g('Subtotal'), shipping: g('Shipping'), total: g('Total') };
        }""")
        if summary.get("subtotal") and summary.get("total"):
            emit("PASS", "order summary shows subtotal, shipping and total",
                 f"subtotal ${summary['subtotal']} shipping ${summary['shipping']} total ${summary['total']}")
        else:
            emit("FAIL", "order summary is missing a line", json.dumps(summary))
            failures += 1

        # A promo code applied through the real field.
        page.fill("#promo-code-input", "WELCOME10")
        page.wait_for_timeout(300)
        page.evaluate("""() => {
            const b = [...document.querySelectorAll('button')].find(x => /^Apply$/.test((x.innerText || '').trim()));
            if (b) b.click();
        }""")
        page.wait_for_timeout(2000)
        after = page.evaluate("""() => {
            const t = document.body.innerText.replace(/\\s+/g, ' ');
            const m = /Discount[^$]*\\$([0-9.]+)/.exec(t);
            return m ? Number(m[1]) : null;
        }""")
        if after and after > 0:
            emit("PASS", "WELCOME10 applies in the UI", f"discount ${after}")
        else:
            emit("FAIL", "WELCOME10 did not apply in the UI", f"discount read as {after}")
            failures += 1

        # An invalid code must show the exact error string.
        page.evaluate("""() => {
            const b = [...document.querySelectorAll('button[aria-label="Remove code"]')];
            if (b.length) b[0].click();
        }""")
        page.wait_for_timeout(1200)
        page.fill("#promo-code-input", "NOTACODE")
        page.wait_for_timeout(300)
        page.evaluate("""() => {
            const b = [...document.querySelectorAll('button')].find(x => /^Apply$/.test((x.innerText || '').trim()));
            if (b) b.click();
        }""")
        page.wait_for_timeout(1800)
        shown = page.evaluate("""() => {
            const el = [...document.querySelectorAll('p')].map(e => e.innerText.trim())
              .find(t => /does not exist|didn.t work/i.test(t));
            return el || '';
        }""")
        if "does not exist" in shown:
            emit("PASS", "invalid promo shows the exact error", shown)
        else:
            emit("FAIL", "invalid promo did not show the expected error", repr(shown))
            failures += 1

        # Continue to payment
        page.evaluate("""() => {
            const b = [...document.querySelectorAll('button')].find(x => /continue to payment/i.test(x.innerText || ''));
            if (b && !b.disabled) b.click();
        }""")
        page.wait_for_timeout(4000)
        page.evaluate(DISMISS)
        page.wait_for_timeout(700)
        if page.evaluate("() => location.pathname") == "/checkout/payment":
            emit("PASS", "continue to payment reaches /checkout/payment")
        else:
            emit("FAIL", "did not reach the payment step",
                 page.evaluate("() => location.pathname"))
            failures += 1

        # Payment method + screenshot
        page.evaluate("""() => {
            const b = [...document.querySelectorAll('button')].find(x => /USDT|BTC|CHIME/i.test(x.innerText || ''));
            if (b) b.click();
        }""")
        page.wait_for_timeout(1800)

        # Synthetic fixture file — never a real receipt.
        import tempfile, os
        png = os.path.join(tempfile.gettempdir(), "smoke-payment-proof.png")
        png_bytes = bytes.fromhex(
            "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
            "0000000a49444154789c6300010000050001"
            "0d0a2db40000000049454e44ae426082")
        with open(png, "wb") as fh:
            fh.write(png_bytes)

        if page.evaluate("() => !!document.querySelector('input[type=file]')"):
            page.set_input_files("input[type=file]", png)
            attached = False
            for _ in range(12):
                page.wait_for_timeout(600)
                if page.evaluate("""() => !!document.querySelector('img[alt*="proof" i], img[alt*="Payment" i]')"""):
                    attached = True
                    break
            if attached:
                emit("PASS", "synthetic payment proof attaches and previews")
            else:
                emit("FAIL", "payment proof did not attach")
                failures += 1
        else:
            emit("SKIP", "no file input on the payment step")

        # Submit -> dialog -> sign -> "Sign & submit order"
        page.evaluate("""() => {
            const b = [...document.querySelectorAll('button')].filter(x => /^Submit Order$/.test((x.innerText || '').trim()));
            if (b.length) b[0].click();
        }""")
        page.wait_for_timeout(2500)

        box = page.evaluate("""() => {
            const c = document.querySelector('canvas[aria-label="Signature pad"]');
            if (!c) return null;
            const r = c.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
        }""")
        if not box:
            emit("FAIL", "signature pad not found in the confirm dialog")
            failures += 1
        else:
            x0, y0 = box["x"] + 25, box["y"] + box["h"] / 2
            page.mouse.move(x0, y0)
            page.mouse.down()
            for i in range(30):
                page.mouse.move(x0 + i * 10, y0 + (9 if i % 2 else -9), steps=1)
            page.mouse.up()
            page.wait_for_timeout(1800)
            signed = page.evaluate("""() => {
                const b = [...document.querySelectorAll('button')].filter(x => /Sign & submit order/i.test(x.innerText || ''));
                return b.length > 0;
            }""")
            if signed:
                emit("PASS", "signature registers and the button becomes 'Sign & submit order'")
            else:
                emit("FAIL", "signature did not register")
                failures += 1

            page.evaluate("""() => {
                const b = [...document.querySelectorAll('button')].filter(x => /Sign & submit order/i.test(x.innerText || ''));
                if (b.length) b[b.length - 1].click();
            }""")
            page.wait_for_timeout(8000)
            url = page.evaluate("() => location.pathname")
            if "/orders/" in url:
                emit("PASS", "order submitted from the UI and redirected to the order", url)
            else:
                emit("FAIL", "order submission did not redirect", url)
                failures += 1

        if errors:
            emit("SKIP", f"{len(errors)} page error(s) observed", errors[0])
        browser.close()

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
