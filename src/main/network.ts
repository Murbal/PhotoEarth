import { net, session } from 'electron'
import { classifyGoogleError, classifyIonError, MISSING, OK } from '@shared/apiErrors'
import {
  aggregateCities,
  AUTOCOMPLETE_FIELD_MASK,
  buildAutocompleteBody,
  buildCitiesBody,
  buildNearbyBody,
  CITIES_FIELD_MASK,
  CITY_QUERIES,
  DETAILS_FIELD_MASK,
  NEARBY_FIELD_MASK,
  parseAutocomplete,
  parseNearby,
  parsePlaceDetails,
  PLACES_ENDPOINT
} from '@shared/places'
import { buildForecastUrl, forecastErrorReason, parseForecast } from '@shared/weather'
import type {
  ApiCheck,
  ApiKeys,
  AutocompleteRequest,
  CitiesRequest,
  NearbyPlace,
  NearbyRequest,
  PlaceDetails,
  PlaceSuggestion,
  Result,
  ValidationResult,
  ResolvedMapsLink,
  WeatherRequest,
  WeatherSeries
} from '@shared/types'
import { resolveShortLink, type ManualRedirectFetch } from './shortLinks'

/**
 * Fixed Referer sent with every Google request (main and renderer). Keys restricted by
 * HTTP referrer must allow `https://photoearth.local/*`; restricting by API is preferred.
 */
export const GOOGLE_REFERER = 'https://photoearth.local/'

interface RawResponse {
  status: number
  body: string
}

async function request(url: string, init: RequestInit = {}, timeoutMs = 10000): Promise<RawResponse> {
  try {
    const res = await net.fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    return { status: res.status, body: await res.text() }
  } catch {
    // status 0 = network failure (offline, DNS, TLS, timeout)
    return { status: 0, body: '' }
  }
}

function googleHeaders(key: string, fieldMask?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Goog-Api-Key': key,
    Referer: GOOGLE_REFERER
  }
  if (fieldMask) headers['X-Goog-FieldMask'] = fieldMask
  return headers
}

const okStatus = (s: number): boolean => s >= 200 && s < 300

async function checkMapTiles(key: string): Promise<ApiCheck> {
  // A 2D roadmap session exercises the Map Tiles API (satellite is restricted for EEA accounts).
  const res = await request(`${MAP_TILES_SESSION_URL}?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Referer: GOOGLE_REFERER },
    body: JSON.stringify({ mapType: 'roadmap', language: 'en-US', region: 'US' })
  })
  return okStatus(res.status) ? OK : classifyGoogleError('Map Tiles API', res.status, res.body, net.isOnline())
}

const MAP_TILES_SESSION_URL = 'https://tile.googleapis.com/v1/createSession'

/**
 * Whether the Map Tiles key needs the fixed Referer: it does unless a request without one
 * succeeds. Uses its own in-memory session, which has no Referer hook. Unknown (offline,
 * quota, other errors) counts as needed, which is always safe.
 */
export async function mapTilesNeedsReferer(key: string): Promise<boolean> {
  try {
    const res = await session.fromPartition('photoearth-referer-probe').fetch(`${MAP_TILES_SESSION_URL}?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mapType: 'roadmap', language: 'en-US', region: 'US' }),
      signal: AbortSignal.timeout(10000)
    })
    return !okStatus(res.status)
  } catch {
    return true
  }
}

async function checkPlaces(key: string): Promise<ApiCheck> {
  const res = await request(`${PLACES_ENDPOINT}/places:autocomplete`, {
    method: 'POST',
    headers: googleHeaders(key, 'suggestions.placePrediction.placeId'),
    body: JSON.stringify({ input: 'Zermatt' })
  })
  return okStatus(res.status) ? OK : classifyGoogleError('Places API (New)', res.status, res.body, net.isOnline())
}

async function checkIon(token: string): Promise<ApiCheck> {
  // Asset 1 = Cesium World Terrain.
  const res = await request(`https://api.cesium.com/v1/assets/1/endpoint?access_token=${encodeURIComponent(token)}`)
  return okStatus(res.status) ? OK : classifyIonError(res.status, res.body, net.isOnline())
}

export async function validateKeys(keys: ApiKeys): Promise<ValidationResult> {
  const google = keys.googleApiKey?.trim()
  const ion = keys.cesiumIonToken?.trim()
  const [mapTiles, places, ionCheck] = await Promise.all([
    google ? checkMapTiles(google) : MISSING,
    google ? checkPlaces(google) : MISSING,
    ion ? checkIon(ion) : MISSING
  ])
  return { mapTiles, places, ion: ionCheck }
}

export async function placesAutocomplete(
  key: string | null,
  req: AutocompleteRequest
): Promise<Result<PlaceSuggestion[]>> {
  if (!key) return { ok: false, error: MISSING }
  const res = await request(`${PLACES_ENDPOINT}/places:autocomplete`, {
    method: 'POST',
    headers: googleHeaders(key, AUTOCOMPLETE_FIELD_MASK),
    body: JSON.stringify(buildAutocompleteBody(req.input.slice(0, 200), req.sessionToken, req.bias))
  })
  if (!okStatus(res.status)) {
    return { ok: false, error: classifyGoogleError('Places API (New)', res.status, res.body, net.isOnline()) }
  }
  try {
    return { ok: true, data: parseAutocomplete(JSON.parse(res.body)) }
  } catch {
    return { ok: false, error: { status: 'error', message: 'Unexpected response from the Places API.' } }
  }
}

export async function placeDetails(
  key: string | null,
  placeId: string,
  sessionToken: string
): Promise<Result<PlaceDetails>> {
  if (!key) return { ok: false, error: MISSING }
  if (!/^[\w-]+$/.test(placeId)) return { ok: false, error: { status: 'error', message: 'Invalid place id.' } }
  const url = `${PLACES_ENDPOINT}/places/${placeId}?sessionToken=${encodeURIComponent(sessionToken)}`
  const res = await request(url, { headers: googleHeaders(key, DETAILS_FIELD_MASK) })
  if (!okStatus(res.status)) {
    return { ok: false, error: classifyGoogleError('Places API (New)', res.status, res.body, net.isOnline()) }
  }
  try {
    const details = parsePlaceDetails(JSON.parse(res.body))
    return details
      ? { ok: true, data: details }
      : { ok: false, error: { status: 'error', message: 'The place has no location.' } }
  } catch {
    return { ok: false, error: { status: 'error', message: 'Unexpected response from the Places API.' } }
  }
}

/** The main cities of a region, from Text Search (see CITY_QUERIES). */
export async function placesCities(key: string | null, req: CitiesRequest): Promise<Result<NearbyPlace[]>> {
  if (!key) return { ok: false, error: MISSING }
  const responses = await Promise.all(
    CITY_QUERIES.map((query) =>
      request(`${PLACES_ENDPOINT}/places:searchText`, {
        method: 'POST',
        headers: googleHeaders(key, CITIES_FIELD_MASK),
        body: JSON.stringify(buildCitiesBody(query, req))
      })
    )
  )
  const failed = responses.find((res) => !okStatus(res.status))
  if (failed) return { ok: false, error: classifyGoogleError('Places API (New)', failed.status, failed.body, net.isOnline()) }
  try {
    return { ok: true, data: aggregateCities(responses.map((res) => JSON.parse(res.body) as unknown)) }
  } catch {
    return { ok: false, error: { status: 'error', message: 'Unexpected response from the Places API.' } }
  }
}

export async function placesNearby(key: string | null, req: NearbyRequest): Promise<Result<NearbyPlace[]>> {
  if (!key) return { ok: false, error: MISSING }
  const res = await request(`${PLACES_ENDPOINT}/places:searchNearby`, {
    method: 'POST',
    headers: googleHeaders(key, NEARBY_FIELD_MASK),
    body: JSON.stringify(buildNearbyBody(req))
  })
  if (!okStatus(res.status)) {
    return { ok: false, error: classifyGoogleError('Places API (New)', res.status, res.body, net.isOnline()) }
  }
  try {
    return { ok: true, data: parseNearby(JSON.parse(res.body)) }
  } catch {
    return { ok: false, error: { status: 'error', message: 'Unexpected response from the Places API.' } }
  }
}

/** Open-Meteo hourly forecast (free, no key; the request carries only the coordinates). */
export async function weatherForecast(req: WeatherRequest): Promise<Result<WeatherSeries[]>> {
  const res = await request(buildForecastUrl(req.points), {}, 15000)
  if (!okStatus(res.status)) {
    if (res.status === 0) {
      return net.isOnline()
        ? { ok: false, error: { status: 'error', message: 'Could not reach Open-Meteo. Check your connection or firewall.' } }
        : { ok: false, error: { status: 'offline', message: 'You appear to be offline.' } }
    }
    if (res.status === 429) return { ok: false, error: { status: 'quota', message: 'Open-Meteo request limit reached. Try again later.' } }
    const reason = forecastErrorReason(res.body)
    return { ok: false, error: { status: 'error', message: `Open-Meteo error ${res.status}${reason ? `: ${reason}` : ''}` } }
  }
  try {
    const series = parseForecast(JSON.parse(res.body), req.points.length)
    if (series) return { ok: true, data: series }
  } catch {
    /* fall through */
  }
  return { ok: false, error: { status: 'error', message: 'Unexpected response from Open-Meteo.' } }
}

/**
 * One request that stops at the first redirect, reporting it as a 3xx with its `location`.
 * `net.fetch` can't do this (in Electron, `redirect: 'manual'` rejects with "Redirect was
 * cancelled"), so this uses `net.request`, the same network stack. Runs in its own in-memory
 * session: no cookies, no Referer hook, no headers of ours. Aborts as soon as the headers
 * arrive, so no response body is ever read.
 */
const singleHopFetch: ManualRedirectFetch = (url, { signal }) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const req = net.request({
      url,
      session: session.fromPartition('photoearth-short-links'),
      redirect: 'manual',
      credentials: 'omit',
      useSessionCookies: false,
      cache: 'no-store'
    })
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      fn()
      req.abort()
    }
    const headers = (location: string | null) => ({ get: (name: string) => (name.toLowerCase() === 'location' ? location : null) })
    const onAbort = () => settle(() => reject(signal.reason))
    signal.addEventListener('abort', onAbort, { once: true })
    req.on('redirect', (status, _method, redirectUrl) => settle(() => resolve({ status, headers: headers(redirectUrl) })))
    req.on('response', (res) => {
      const location = res.headers.location
      settle(() => resolve({ status: res.statusCode, headers: headers(Array.isArray(location) ? location[0] : (location ?? null)) }))
    })
    req.on('error', (err) => settle(() => reject(err)))
    req.end()
  })

/** Resolves a Google Maps short link online (see shortLinks.ts); never sends an API key. */
export function mapsShortLink(url: string): Promise<Result<ResolvedMapsLink>> {
  return resolveShortLink(url, { fetch: singleHopFetch, isOnline: () => net.isOnline() })
}
