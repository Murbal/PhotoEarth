import { net } from 'electron'
import { classifyGoogleError, classifyIonError, MISSING, OK } from '@shared/apiErrors'
import {
  AUTOCOMPLETE_FIELD_MASK,
  buildAutocompleteBody,
  DETAILS_FIELD_MASK,
  parseAutocomplete,
  parsePlaceDetails,
  PLACES_ENDPOINT
} from '@shared/places'
import type {
  ApiCheck,
  ApiKeys,
  AutocompleteRequest,
  PlaceDetails,
  PlaceSuggestion,
  Result,
  ValidationResult
} from '@shared/types'

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
  // A 2D session request exercises the Map Tiles API without a billable 3D root request.
  const res = await request(`https://tile.googleapis.com/v1/createSession?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Referer: GOOGLE_REFERER },
    body: JSON.stringify({ mapType: 'satellite', language: 'en-US', region: 'US' })
  })
  return okStatus(res.status) ? OK : classifyGoogleError('Map Tiles API', res.status, res.body, net.isOnline())
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
