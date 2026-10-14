/**
 * Order milestone events, and the email payloads they produce.
 *
 * NO EMAIL IS EVER SENT. There is no SMTP transport here and no API key. What this
 * does is render the exact payload that WOULD be sent, print it to the console, and
 * write each one to disk so it can be opened and looked at in a browser. That is the
 * whole point: make the message inspectable before any of it is real.
 *
 * Wired to order creation as an event hook, so adding a future milestone means adding
 * a subscriber rather than editing the checkout path:
 *
 *     orderEvents.on('order.created', handler)
 *     orderEvents.emit('order.created', { order })
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/* ------------------------------------------------------------------ brand ---- */

/** Read out of the shipped stylesheet, so the mail matches the site. */
const BRAND = {
  navy: '#0D3364',
  sky: '#79C9F2',
  skyDeep: '#4FB3E8',
  sun: '#FFD93D',
  sunDeep: '#F2C83A',
  ink: '#3B2A20',
  cream: '#F7F8F9',
  mute: '#6B5A50',
  green: '#2FB36B',
  greenSoft: '#7ED9A5',
}

const money = (n) => `$${Number(n ?? 0).toFixed(2)}`

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/* ------------------------------------------------------------- event hook ---- */

class OrderEventBus {
  constructor() {
    this.handlers = new Map()
    this.log = []
  }
  on(event, handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, [])
    this.handlers.get(event).push(handler)
    return () => this.off(event, handler)
  }
  off(event, handler) {
    const list = this.handlers.get(event) ?? []
    const i = list.indexOf(handler)
    if (i >= 0) list.splice(i, 1)
  }
  emit(event, payload) {
    const results = []
    for (const handler of this.handlers.get(event) ?? []) {
      try {
        results.push(handler(payload))
      } catch (e) {
        console.log(`  [events] handler for ${event} threw: ${e.message}`)
      }
    }
    this.log.push({ event, at: new Date().toISOString(), handlers: results.length })
    return results
  }
}

export const orderEvents = new OrderEventBus()

/* ------------------------------------------------------------- email shell -- */

/**
 * Table-based layout with inline styles. Not decoration: mail clients strip
 * <style> blocks and have no flexbox or grid, so this is the only shape that
 * renders the same in Gmail, Outlook and Apple Mail.
 */
function emailShell({ preheader, accent, heading, body, footerNote }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(heading)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.cream};">
<div style="display:none;font-size:1px;color:${BRAND.cream};max-height:0;overflow:hidden;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.cream};padding:28px 12px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 10px rgba(59,42,32,0.10);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">

      <!-- masthead -->
      <tr><td style="background:${BRAND.navy};padding:20px 28px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.3px;">
            Joyous
            <span style="display:inline-block;margin-left:8px;padding:3px 9px;border-radius:999px;background:${BRAND.sun};color:${BRAND.ink};font-size:10px;font-weight:700;letter-spacing:0.6px;vertical-align:middle;">CHOICE PRODUCTS</span>
          </td>
        </tr></table>
      </td></tr>

      <!-- accent rule -->
      <tr><td style="height:5px;background:${accent};font-size:0;line-height:0;">&nbsp;</td></tr>

      <!-- heading -->
      <tr><td style="padding:28px 28px 8px;">
        <h1 style="margin:0;font-size:24px;line-height:1.25;font-weight:800;color:${BRAND.navy};">${esc(heading)}</h1>
      </td></tr>

      ${body}

      <!-- footer -->
      <tr><td style="padding:22px 28px 26px;border-top:1px solid #ECEEF1;">
        <p style="margin:0 0 6px;font-size:11px;line-height:1.5;color:${BRAND.mute};">
          ${esc(footerNote)}
        </p>
        <p style="margin:0;font-size:11px;line-height:1.5;color:${BRAND.mute};">
          Joyous Choice Products &middot; RESEARCH USE ONLY &middot; Not for human or veterinary consumption.
        </p>
      </td></tr>

    </table>
    <p style="margin:14px 0 0;font-size:10px;color:#9AA1A9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
      Rendered locally &middot; no email was sent
    </p>
  </td></tr>
</table>
</body>
</html>`
}

/* ------------------------------------------------- customer: order confirmation */

function itemsTable(order) {
  const rows = (order.items ?? [])
    .map((item) => {
      const qty = item.quantity ?? 1
      const unit = item.pricePerUnit ?? item.unitPrice ?? 0
      return `
      <tr>
        <td style="padding:11px 0;border-bottom:1px solid #EEF0F3;font-size:14px;color:${BRAND.ink};">
          <span style="font-weight:600;">${esc(item.itemName ?? item.name ?? 'Item')}</span>
          <span style="display:block;font-size:11px;color:${BRAND.mute};margin-top:2px;">${qty} &times; ${money(unit)}</span>
        </td>
        <td align="right" style="padding:11px 0;border-bottom:1px solid #EEF0F3;font-size:14px;font-weight:700;color:${BRAND.ink};white-space:nowrap;vertical-align:top;">
          ${money(item.totalPrice ?? unit * qty)}
        </td>
      </tr>`
    })
    .join('')

  return `
      <tr><td style="padding:8px 28px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}
          <tr>
            <td style="padding:12px 0 0;font-size:14px;font-weight:700;color:${BRAND.ink};">Total</td>
            <td align="right" style="padding:12px 0 0;font-size:20px;font-weight:800;color:${BRAND.navy};white-space:nowrap;">
              ${money(order.totalAmount ?? order.total)}
            </td>
          </tr>
        </table>
      </td></tr>`
}

function addressBlock(order) {
  const a = order.shippingAddress ?? order.address ?? order.user?.address ?? null
  if (!a) {
    return `<tr><td style="padding:20px 28px 0;">
      <p style="margin:0;font-size:13px;color:${BRAND.mute};">No shipping address on this order.</p>
    </td></tr>`
  }
  const cityLine = [a.city, a.state].filter(Boolean).join(', ')
  return `
      <tr><td style="padding:20px 28px 0;">
        <p style="margin:0 0 7px;font-size:11px;font-weight:700;letter-spacing:0.7px;text-transform:uppercase;color:${BRAND.mute};">Shipping to</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
               style="background:${BRAND.cream};border-radius:12px;">
          <tr><td style="padding:14px 16px;font-size:13px;line-height:1.6;color:${BRAND.ink};">
            <strong style="font-size:14px;">${esc(a.fullName ?? a.name ?? '')}</strong><br>
            ${esc(a.addressLine1 ?? '')}${a.addressLine2 ? `<br>${esc(a.addressLine2)}` : ''}<br>
            ${esc(cityLine)} ${esc(a.zipCode ?? a.postalCode ?? '')}<br>
            ${esc(a.country ?? '')}
          </td></tr>
        </table>
      </td></tr>`
}

function orderMeta(order) {
  const cell = (label, value) => `
        <td width="50%" style="padding:0 0 12px;">
          <p style="margin:0 0 3px;font-size:10px;font-weight:700;letter-spacing:0.7px;text-transform:uppercase;color:${BRAND.mute};">${esc(label)}</p>
          <p style="margin:0;font-size:14px;font-weight:700;color:${BRAND.ink};">${esc(value)}</p>
        </td>`
  return `
      <tr><td style="padding:6px 28px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            ${cell('Order ID', order.orderNumber ?? order.id)}
            ${cell('Status', String(order.status ?? '').replace(/_/g, ' '))}
          </tr>
        </table>
      </td></tr>`
}

export function renderOrderConfirmation(order) {
  const first = order.customerName?.split(' ')[0] ?? order.user?.firstName ?? 'there'
  const body = `
      <tr><td style="padding:0 28px 6px;">
        <p style="margin:0;font-size:14px;line-height:1.6;color:${BRAND.ink};">
          Hi ${esc(first)}, thanks for your order. We have it and will email again the moment it ships.
        </p>
      </td></tr>
      ${orderMeta(order)}
      ${itemsTable(order)}
      ${addressBlock(order)}
      <tr><td style="padding:22px 28px 26px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="border-radius:999px;background:${BRAND.sun};">
            <a href="https://joyous.is/orders/${esc(order.id)}"
               style="display:inline-block;padding:12px 26px;font-size:14px;font-weight:800;color:${BRAND.ink};text-decoration:none;">
              View your order
            </a>
          </td>
        </tr></table>
      </td></tr>`
  return {
    subject: `Order confirmed — ${order.orderNumber ?? order.id}`,
    html: emailShell({
      preheader: `Order ${order.orderNumber ?? order.id} confirmed. ${money(order.totalAmount ?? order.total)} total.`,
      accent: BRAND.sun,
      heading: 'Your order is confirmed',
      body,
      footerNote: 'You are receiving this because you placed an order at joyous.is.',
    }),
  }
}

/* ------------------------------------------------------ admin: new order alert */

export function renderAdminNewOrder(order) {
  const adminUrl = `https://joyous.is/admin/orders`
  const body = `
      <tr><td style="padding:0 28px 6px;">
        <p style="margin:0;font-size:14px;line-height:1.6;color:${BRAND.ink};">
          A new order just came in. It needs a payment review before it moves to packing.
        </p>
      </td></tr>
      ${orderMeta(order)}
      <tr><td style="padding:6px 28px 0;">
        <p style="margin:0 0 7px;font-size:11px;font-weight:700;letter-spacing:0.7px;text-transform:uppercase;color:${BRAND.mute};">Customer</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.cream};border-radius:12px;">
          <tr><td style="padding:14px 16px;font-size:13px;line-height:1.6;color:${BRAND.ink};">
            <strong>${esc(order.customerName ?? order.user?.firstName ?? 'Unknown')}</strong><br>
            ${esc(order.email ?? order.user?.email ?? '')}
          </td></tr>
        </table>
      </td></tr>
      ${itemsTable(order)}
      <tr><td style="padding:18px 28px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFF8E1;border-left:4px solid ${BRAND.sunDeep};border-radius:8px;">
          <tr><td style="padding:12px 14px;font-size:12px;line-height:1.6;color:${BRAND.ink};">
            <strong>Action required:</strong> verify the payment proof against the amount before fulfilling.
          </td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:20px 28px 26px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="border-radius:999px;background:${BRAND.navy};">
            <a href="${adminUrl}" style="display:inline-block;padding:12px 26px;font-size:14px;font-weight:800;color:#ffffff;text-decoration:none;">
              Open in admin
            </a>
          </td>
        </tr></table>
      </td></tr>`
  return {
    subject: `[New order] ${order.orderNumber ?? order.id} — ${money(order.totalAmount ?? order.total)}`,
    html: emailShell({
      preheader: `New order ${order.orderNumber ?? order.id} from ${order.customerName ?? 'a customer'}.`,
      accent: BRAND.skyDeep,
      heading: 'New order received',
      body,
      footerNote: 'Internal notification. Sent to the orders inbox, not the customer.',
    }),
  }
}

/* ------------------------------------------------------------------ outbox --- */

function outboxDir(outDir) {
  mkdirSync(outDir, { recursive: true })
  return outDir
}

/**
 * Renders both messages, prints a readable summary to the console, and writes the
 * HTML to disk. Returns the payloads so the caller can expose them over HTTP.
 */
export function emitOrderEmails(order, { outDir }) {
  const dir = outboxDir(outDir)
  const stamp = String(order.orderNumber ?? order.id ?? Date.now()).replace(/[^A-Za-z0-9-]/g, '')
  const messages = [
    { to: order.email ?? order.user?.email ?? 'customer@example.com', kind: 'order-confirmation', ...renderOrderConfirmation(order) },
    { to: 'orders@joyous.is', kind: 'admin-new-order', ...renderAdminNewOrder(order) },
  ]

  for (const m of messages) {
    const file = join(dir, `${stamp}.${m.kind}.html`)
    writeFileSync(file, m.html)
    m.file = file
  }

  console.log('')
  console.log('  ┌─ ORDER MILESTONE ────────────────────────────────────────────────')
  console.log(`  │ event    order.created`)
  console.log(`  │ order    ${order.orderNumber ?? order.id}   ${money(order.totalAmount ?? order.total)}   ${order.status ?? ''}`)
  console.log(`  │ items    ${(order.items ?? []).length}`)
  console.log('  ├─ EMAIL PAYLOADS (rendered, NOT sent) ─────────────────────────────')
  for (const m of messages) {
    console.log(`  │ to       ${m.to}`)
    console.log(`  │ subject  ${m.subject}`)
    console.log(`  │ html     ${m.html.length} bytes -> ${m.file}`)
    console.log('  │')
  }
  console.log('  └──────────────────────────────────────────────────────────────────')
  console.log('')

  return messages
}

/**
 * The subscription. Kept here so the checkout path only has to emit an event.
 */
export function wireOrderMilestones({ outDir, history = [] }) {
  orderEvents.on('order.created', ({ order }) => {
    const messages = emitOrderEmails(order, { outDir })
    history.push({
      at: new Date().toISOString(),
      event: 'order.created',
      orderId: order.id,
      orderNumber: order.orderNumber,
      messages: messages.map((m) => ({ to: m.to, subject: m.subject, kind: m.kind, bytes: m.html.length, file: m.file })),
    })
    return messages.length
  })
  return orderEvents
}
