/**
 * Newsletter subscribers and campaigns.
 *
 * WHY THIS IS SEEDED, AND WHY IT IS LABELLED
 * The admin Newsletter page has no data behind it: the recording contains no subscriber
 * list, no drafts and no campaigns, so every tab rendered an empty state and every
 * counter read 0. Unlike the discount codes — where a real promo engine already existed
 * and only needed exposing — there is nothing here to expose. The people have to be
 * invented or the screen stays blank.
 *
 * So they are invented, and EVERY ROW SAYS SO. Each carries `__seed`, and the addresses
 * use example.com so nobody mistakes them for a real list. A screen that shows confident
 * numbers about people who do not exist is worse than an empty one; a screen that shows
 * numbers and says "these are fixtures" is honest and useful.
 *
 * WHAT IS *NOT* INVENTED
 * The sending path. `send`, `test-send` and `preview` render real HTML through the same
 * outbox the order emails already use, and write real files to outbox/. Those are
 * genuinely verifiable — you can open the file that was produced.
 */

export const SUBSCRIBER_MARK = '__seed'

/**
 * Twelve subscribers, deliberately mixed:
 *   - both tiers, so the VIP+ / Elite audience selector has someone in each bucket
 *   - some inactive, so the Active/Paused filter has both
 *   - some with no name, because real lists have those and the UI must not blank out
 *   - two `unsubscribed` so the status filter has a third value to show
 * Dates spread over months so "joined" ordering is meaningful.
 */
const PEOPLE = [
  { email: 'ada.reyes@example.com', name: 'Ada Reyes', tier: 'ELITE', active: true, source: 'checkout', days: 7 },
  { email: 'bruno.sato@example.com', name: 'Bruno Sato', tier: 'VIP', active: true, source: 'checkout', days: 21 },
  { email: 'chen.wei@example.com', name: 'Chen Wei', tier: 'VIP', active: true, source: 'admin', days: 34 },
  { email: 'dara.okafor@example.com', name: 'Dara Okafor', tier: 'ELITE', active: true, source: 'checkout', days: 48 },
  { email: 'gita.nair@example.com', name: 'Gita Nair', tier: 'VIP', active: false, source: 'import', days: 62 },
  { email: 'hana.kim@example.com', name: 'Hana Kim', tier: 'ELITE', active: true, source: 'checkout', days: 75 },
  { email: 'juno.alvarez@example.com', name: 'Juno Alvarez', tier: 'VIP', active: true, source: 'admin', days: 90 },
  { email: 'farid.haddad@example.com', name: 'Farid Haddad', tier: 'USER', active: true, source: 'checkout', days: 104 },
  { email: 'no-reply-fan@example.com', name: '', tier: 'USER', active: true, source: 'import', days: 120 },
  { email: 'quiet.reader@example.com', name: '', tier: 'USER', active: false, source: 'import', days: 140 },
  { email: 'left.us@example.com', name: 'Pat Former', tier: 'VIP', active: false, unsubscribed: true, source: 'checkout', days: 165 },
  { email: 'bounced@example.com', name: 'Sam Bounce', tier: 'USER', active: false, unsubscribed: true, source: 'import', days: 190 },
]

export function seedSubscribers() {
  return PEOPLE.map((p, i) => ({
    id: `seed-sub-${i + 1}`,
    email: p.email,
    name: p.name,
    firstName: p.name ? p.name.split(' ')[0] : '',
    lastName: p.name ? (p.name.split(' ')[1] ?? '') : '',
    tier: p.tier,
    // `active` and `status` are DIFFERENT axes, and conflating them hid a chip:
    //   PAUSED        -> an admin switched them off; can be switched back on
    //   UNSUBSCRIBED  -> they opted out of promotions; still a valid account
    // A subscriber who opted out is still an ACTIVE account, which is why `active`
    // stays true for them. Setting it false meant the page's "Opted out" chip — shown
    // only when `active && suppressed` — could never render on any row.
    active: p.unsubscribed ? true : p.active,
    status: p.unsubscribed ? 'UNSUBSCRIBED' : (p.active ? 'ACTIVE' : 'PAUSED'),
    suppressed: !!p.unsubscribed,
    source: p.source,
    // `subscribedAt` / `createdAt` both, because the page sorts and renders on one and
    // some tables read the other. Keeping them equal means they cannot disagree.
    subscribedAt: new Date(Date.now() - p.days * 86400000).toISOString(),
    createdAt: new Date(Date.now() - p.days * 86400000).toISOString(),
    [SUBSCRIBER_MARK]: true,
  }))
}

/**
 * Past campaigns. These are a RECORD of sends, so they carry real counts — but they
 * describe emails that were never actually sent anywhere, which is why they are marked.
 */
const CAMPAIGNS = [
  { name: 'October restock', subject: 'October restock is live', audience: 'everyone', sentDaysAgo: 4, recipients: 9, opens: 6, clicks: 3 },
  { name: 'Aqualyx shipped', subject: 'Your Aqualyx buy has shipped', audience: 'groupbuy', sentDaysAgo: 12, recipients: 6, opens: 5, clicks: 2 },
  { name: 'Elite early access', subject: 'Early access for Elite members', audience: 'elite', sentDaysAgo: 26, recipients: 3, opens: 3, clicks: 1 },
  { name: 'New arrivals — April', subject: 'New arrivals this week', audience: 'everyone', sentDaysAgo: 41, recipients: 8, opens: 4, clicks: 0 },
  { name: 'Welcome sequence', subject: 'Welcome to Joyous', audience: 'everyone', sentDaysAgo: 70, recipients: 11, opens: 9, clicks: 4 },
]

export function seedCampaigns() {
  return CAMPAIGNS.map((c, i) => ({
    id: `seed-camp-${i + 1}`,
    name: c.name,
    subject: c.subject,
    // `audienceTier` is what the campaigns table reads and indexes into a 3-key map;
    // `audience` kept for readability. The seed values are already USER/VIP/ELITE.
    audienceTier: c.audience === 'elite' ? 'ELITE' : (c.audience === 'groupbuy' || c.audience === 'vip' ? 'VIP' : 'USER'),
    audience: c.audience,
    htmlContent: `<h2>${c.subject}</h2><p>${c.name} — sent ${c.sentDaysAgo} days ago.</p>`,
    status: 'SENT',
    sentAt: new Date(Date.now() - c.sentDaysAgo * 86400000).toISOString(),
    createdAt: new Date(Date.now() - c.sentDaysAgo * 86400000).toISOString(),
    recipientCount: c.recipients,
    recipients: c.recipients,
    openCount: c.opens,
    opens: c.opens,
    clickCount: c.clicks,
    clicks: c.clicks,
    [SUBSCRIBER_MARK]: true,
  }))
}

/** The three audiences the compose screen offers, and who each one reaches. */
export const AUDIENCES = {
  everyone: () => true,
  // VIP and above. The page's own label is "VIP+".
  vip: (s) => ['VIP', 'ELITE'].includes(s.tier),
  elite: (s) => s.tier === 'ELITE',
}

/**
 * Who a send reaches.
 *
 * Only ACTIVE subscribers. A send that reached paused or unsubscribed people would be
 * a real bug in a real product, and the count on the compose screen has to match the
 * number of messages actually produced — otherwise the screen confidently reports
 * "reaches 0" or "reaches 12" and neither is what happened.
 */
export function reachable(subscribers, audience) {
  const match = AUDIENCES[audience] ?? AUDIENCES.everyone
  // ACTIVE status only: a PAUSED admin switch and an UNSUBSCRIBED opt-out both exclude
  // a subscriber, even though an unsubscribed one is still an active account.
  return subscribers.filter((s) => s.active === true && s.status === 'ACTIVE' && !s.suppressed && match(s))
}

/** Audience labels for the UI and the stats breakdown. */
export function audienceCounts(subscribers) {
  return {
    everyone: reachable(subscribers, 'everyone').length,
    vip: reachable(subscribers, 'vip').length,
    elite: reachable(subscribers, 'elite').length,
  }
}
