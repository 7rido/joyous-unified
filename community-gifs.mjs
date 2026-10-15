/**
 * The GIF/sticker catalog for the local replay.
 *
 * WHAT THIS IS NOT
 * The real picker is GIPHY — the panel even carries a "Powered by GIPHY" credit. There is
 * no GIPHY here: it needs an API key, and its terms do not allow scraping the public site
 * to build one. So this is a CURATED, LOCAL set assembled from art already in the project
 * — the 38 captured avatars and the eight sticker PNGs that ship with the storefront.
 *
 * WHAT THAT MEANS IN PRACTICE
 * These are static images. A real GIF animates; nothing here does. The picker, the search,
 * the category chips and the insertion path all work exactly as they do upstream, so the
 * FEATURE is exercised end to end — the content is just not animated, and is not GIPHY's.
 *
 * The categories mirror the client's own chip list, read from the bundle:
 *   ["memes","lol","mind blown","yes","no way","gym","science","sleepy",
 *    "party","thank you","facepalm","wow"]
 * so the chips that exist are the chips the page offers, rather than a list invented here.
 */

const AVATARS = [
  ['01-joyo-wave', 'wave', 'yes'],
  ['02-joyo-cool', 'cool', 'yes'],
  ['03-joyo-lab', 'lab', 'science'],
  ['04-joyo-gym', 'gym', 'gym'],
  ['05-joyo-sleepy', 'sleepy', 'sleepy'],
  ['06-joyo-party', 'party', 'party'],
  ['07-joyo-music', 'music', 'party'],
  ['08-joyo-space', 'space', 'mind blown'],
  ['09-joyo-love', 'love', 'thank you'],
  ['10-corgi', 'corgi', 'memes'],
  ['11-cat', 'cat', 'memes'],
  ['13-sloth', 'sloth', 'sleepy'],
  ['14-red-panda', 'red panda', 'memes'],
  ['15-capsule', 'capsule', 'science'],
  ['16-frog-king', 'frog king', 'lol'],
  ['17-joyo-chef', 'chef', 'thank you'],
  ['18-joyo-pirate', 'pirate', 'memes'],
  ['19-joyo-detective', 'detective', 'mind blown'],
  ['20-joyo-rockstar', 'rockstar', 'party'],
  ['21-joyo-couch', 'couch', 'sleepy'],
  ['22-joyo-office', 'office', 'facepalm'],
  ['23-joyo-suit', 'suit', 'yes'],
  ['24-joyo-lab-coat-friends', 'lab coat friends', 'science'],
  ['25-joyo-surf', 'surfing', 'party'],
  ['26-joyo-snow', 'snow', 'wow'],
  ['27-joyo-gamer', 'gaming', 'lol'],
  ['28-joyo-bookworm', 'bookworm', 'science'],
  ['29-joyo-gardener', 'gardener', 'thank you'],
  ['30-joyo-hero', 'hero', 'yes'],
  ['31-joyo-wizard', 'wizard', 'wow'],
  ['32-joyo-camp', 'camping', 'party'],
  ['33-joyo-painter', 'painting', 'mind blown'],
  ['34-joyo-boxer', 'boxing', 'gym'],
  ['35-joyo-cowboy', 'cowboy', 'memes'],
  ['36-joyo-beach', 'beach', 'party'],
  ['37-joyo-karaoke', 'karaoke', 'party'],
  ['38-joyo-skate', 'skating', 'lol'],
  ['39-joyo-zen', 'zen', 'sleepy'],
]

const STICKERS = [
  ['capsule-blue', 'blue capsule'], ['capsule-yellow', 'yellow capsule'],
  ['drop-pink', 'pink drop'], ['seal-coa', 'sealed COA'],
  ['smiley', 'smiley'], ['sparkle', 'sparkle'],
  ['star-gold', 'gold star'], ['vial', 'vial'],
]

/**
 * Items carry what the picker reads: `id` (React key), `preview` (the <img src>),
 * `title` (tooltip and alt), and `url` — which is what the composer puts in the post, so
 * it must be a usable image URL, not the preview thumbnail.
 */
const avatarItems = () => AVATARS.map(([file, title, category]) => ({
  id: `gif-${file}`,
  url: `/avatars/${file}.webp`,
  preview: `/avatars/${file}.webp`,
  title,
  category,
  kind: 'gifs',
}))

const stickerItems = () => STICKERS.map(([file, title]) => ({
  id: `sticker-${file}`,
  url: `/world/stickers/${file}.png`,
  preview: `/world/stickers/${file}.png`,
  title,
  category: 'stickers',
  kind: 'stickers',
}))

export const GIF_CATEGORIES = [
  'memes', 'lol', 'mind blown', 'yes', 'no way', 'gym', 'science', 'sleepy',
  'party', 'thank you', 'facepalm', 'wow',
]

/**
 * `q` is a free-text search and `kind` is the tab ("gifs" or "stickers"). Both are
 * optional: the panel opens with neither, so an empty query returns everything rather
 * than nothing.
 */
export function searchGifs({ q = '', kind = 'gifs' } = {}) {
  const items = kind === 'stickers' ? stickerItems() : avatarItems()
  const needle = String(q).trim().toLowerCase()
  if (!needle) return { items, __curated: true }
  const matched = items.filter((i) =>
    i.title.toLowerCase().includes(needle) || i.category.toLowerCase().includes(needle))
  return { items: matched, __curated: true }
}
