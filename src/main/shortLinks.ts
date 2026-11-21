// Resolves Google Maps short links (maps.app.goo.gl/…, goo.gl/maps/…) to the full
// google.com/maps URL they redirect to, then parses that with the shared URL parser.
// Kept free of Electron imports so it can be tested with a mocked fetch; network.ts
// supplies the real one.

import { parseGoogleMapsUrl } from '@shared/coords'
import type { ResolvedMapsLink, Result } from '@shared/types'

/** Redirects followed after the first request; Google uses one or two. */
export const MAX_SHORT_LINK_HOPS = 5
/** For the whole chain, not per hop. */
export const SHORT_LINK_TIMEOUT_MS = 10000
const MAX_INPUT_LENGTH = 500
const MAX_LOCATION_LENGTH = 4000

const SHORT_ID = /^[A-Za-z0-9_-]+\/?$/
// google.com, google.de, google.co.uk, google.com.au, with an optional www. or maps.
const GOOGLE_HOST = /^(?:www\.|maps\.)?google\.(?:com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/

/**
 * The subset of `fetch` this needs, with `redirect: 'manual'` semantics: a redirect comes
 * back as a 3xx response with its `location` header instead of being followed.
 */
export type ManualRedirectFetch = (
  url: string,
  init: { redirect: 'manual'; credentials: 'omit'; signal: AbortSignal }
) => Promise<{ status: number; headers: { get(name: string): string | null }; body?: { cancel(): Promise<void> } | null }>

export interface ResolveOptions {
  fetch: ManualRedirectFetch
  /** Distinguishes "offline" from "could not reach" when a request fails. */
  isOnline?: () => boolean
  maxHops?: number
  timeoutMs?: number
}

function parseUrl(text: string, base?: string): URL | null {
  try {
    return new URL(text, base)
  } catch {
    return null
  }
}

/** Plain https on the default port, no credentials: the only shape followed or accepted. */
function isPlainHttps(url: URL): boolean {
  return url.protocol === 'https:' && url.port === '' && url.username === '' && url.password === ''
}

/** maps.app.goo.gl/<id> or goo.gl/maps/<id>, exact hosts only. */
function isShortLinkUrl(url: URL): boolean {
  if (url.hostname === 'maps.app.goo.gl') return SHORT_ID.test(url.pathname.slice(1))
  if (url.hostname === 'goo.gl') return url.pathname.startsWith('/maps/') && SHORT_ID.test(url.pathname.slice(6))
  return false
}

/** www.google.<tld>/maps…, google.<tld>/maps… or maps.google.<tld>/…, over https. */
export function isGoogleMapsHost(url: URL): boolean {
  if (!isPlainHttps(url) || !GOOGLE_HOST.test(url.hostname)) return false
  return url.hostname.startsWith('maps.') || url.pathname === '/maps' || url.pathname.startsWith('/maps/')
}

/**
 * The https URL to request for user input, or null unless it is a Google Maps short link on
 * an exact short-link host. A missing scheme or http:// becomes https://; the fragment is
 * dropped.
 */
export function normalizeShortLink(input: string): string | null {
  const text = input.trim()
  if (!text || text.length > MAX_INPUT_LENGTH || /\s/.test(text)) return null
  const withScheme = /^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`
  const url = parseUrl(withScheme)
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) return null
  url.protocol = 'https:'
  url.hash = ''
  if (!isPlainHttps(url) || !isShortLinkUrl(url)) return null
  return url.href
}

const fail = (status: 'error' | 'offline', message: string): Result<ResolvedMapsLink> => ({ ok: false, error: { status, message } })

const PASTE_FULL_URL = 'Open it in a browser and paste the full google.com/maps URL instead.'

/**
 * Follows a short link one redirect at a time, accepting only short-link and Google Maps
 * hosts, and stops at the first Google Maps URL that carries coordinates; that URL itself is
 * never requested. Sends no API key, cookie or custom header.
 */
export async function resolveShortLink(input: string, options: ResolveOptions): Promise<Result<ResolvedMapsLink>> {
  const start = normalizeShortLink(input)
  if (!start) return fail('error', 'Not a Google Maps short link (maps.app.goo.gl/… or goo.gl/maps/…).')
  const maxHops = options.maxHops ?? MAX_SHORT_LINK_HOPS
  const signal = AbortSignal.timeout(options.timeoutMs ?? SHORT_LINK_TIMEOUT_MS)

  let current = start
  let reachedMaps = false
  for (let hop = 0; hop <= maxHops; hop++) {
    let res: Awaited<ReturnType<ManualRedirectFetch>>
    try {
      res = await options.fetch(current, { redirect: 'manual', credentials: 'omit', signal })
    } catch {
      if (signal.aborted) return fail('error', 'Google Maps took too long to answer. Try again.')
      return options.isOnline?.() === false
        ? fail('offline', `You appear to be offline. Short links are resolved online. ${PASTE_FULL_URL}`)
        : fail('error', 'Could not reach Google Maps. Check your connection or firewall.')
    }
    // Only the status and location matter; never read the body.
    void res.body?.cancel().catch(() => undefined)

    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
    if (!location) {
      if (reachedMaps) return fail('error', `The link opens Google Maps but doesn’t include coordinates. ${PASTE_FULL_URL}`)
      if (res.status === 404 || res.status === 410) return fail('error', 'This short link doesn’t exist or has expired.')
      if (res.status === 429) return fail('error', 'Google Maps is limiting requests. Try again later.')
      return fail('error', `Unrecognised answer from Google Maps (HTTP ${res.status}). ${PASTE_FULL_URL}`)
    }
    if (location.length > MAX_LOCATION_LENGTH) return fail('error', 'Google Maps answered with an unrecognised redirect.')
    // Relative locations resolve against the URL that answered.
    const next = parseUrl(location, current)
    if (!next) return fail('error', 'Google Maps answered with an unrecognised redirect.')

    if (isGoogleMapsHost(next)) {
      reachedMaps = true
      const parsed = parseGoogleMapsUrl(next.href)
      if (parsed) return { ok: true, data: { url: next.href, location: parsed } }
    } else if (!(isPlainHttps(next) && isShortLinkUrl(next))) {
      // consent.google.com and other pages that aren't the map itself.
      return reachedMaps
        ? fail('error', `The link opens Google Maps but doesn’t include coordinates. ${PASTE_FULL_URL}`)
        : fail('error', 'The short link doesn’t lead to Google Maps.')
    }
    current = next.href
  }
  return fail('error', 'The short link redirects too many times.')
}
