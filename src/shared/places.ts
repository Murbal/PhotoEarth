import type { CitiesRequest, LatLng, NearbyKind, NearbyPlace, NearbyRequest, PlaceDetails, PlaceSuggestion } from './types'

export const PLACES_ENDPOINT = 'https://places.googleapis.com/v1'
export const AUTOCOMPLETE_FIELD_MASK =
  'suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat'
/** Only location fields, to stay on the Essentials / Pro billing tiers. */
export const DETAILS_FIELD_MASK = 'id,displayName,formattedAddress,location,viewport'
export const MIN_QUERY_LENGTH = 3
/** Places API caps circular location bias at 50 km. */
export const BIAS_RADIUS_M = 50000
/** Map labels need only the name and position (Nearby Search Pro tier). */
// Address components are in the same (Pro) SKU as the display name.
export const NEARBY_FIELD_MASK = 'places.id,places.displayName,places.location,places.addressComponents'
/** Kinds queried in small cells around the view. */
export const NEARBY_KINDS: readonly NearbyKind[] = ['locality', 'mountain_peak']
/** Areas labeled from high up. A circle returns every area it overlaps. */
export const AREA_KINDS: readonly NearbyKind[] = ['administrative_area_level_1', 'country']
export const ALL_NEARBY_KINDS: readonly NearbyKind[] = [...NEARBY_KINDS, ...AREA_KINDS]
export const NEARBY_MAX_RADIUS_M = 50000
export const NEARBY_MAX_RESULTS = 20

interface RawText {
  text?: string
}

interface RawAutocomplete {
  suggestions?: Array<{
    placePrediction?: {
      placeId?: string
      text?: RawText
      structuredFormat?: { mainText?: RawText; secondaryText?: RawText }
    }
  }>
}

export function buildAutocompleteBody(input: string, sessionToken: string, bias?: LatLng): Record<string, unknown> {
  const body: Record<string, unknown> = { input, sessionToken }
  if (bias) {
    body.locationBias = { circle: { center: bias, radius: BIAS_RADIUS_M } }
  }
  return body
}

export function parseAutocomplete(json: unknown): PlaceSuggestion[] {
  const raw = (json ?? {}) as RawAutocomplete
  const out: PlaceSuggestion[] = []
  for (const s of raw.suggestions ?? []) {
    const p = s.placePrediction
    if (!p?.placeId) continue
    const main = p.structuredFormat?.mainText?.text ?? p.text?.text ?? ''
    const secondary = p.structuredFormat?.secondaryText?.text ?? ''
    out.push({ placeId: p.placeId, mainText: main, secondaryText: secondary })
  }
  return out
}

interface RawLatLng {
  latitude?: number
  longitude?: number
}

function latLng(v: RawLatLng | undefined): LatLng | null {
  if (!v || typeof v.latitude !== 'number' || typeof v.longitude !== 'number') return null
  return { latitude: v.latitude, longitude: v.longitude }
}

export function parsePlaceDetails(json: unknown): PlaceDetails | null {
  const raw = (json ?? {}) as {
    id?: string
    displayName?: RawText
    formattedAddress?: string
    location?: RawLatLng
    viewport?: { low?: RawLatLng; high?: RawLatLng }
  }
  const location = latLng(raw.location)
  if (!location) return null
  const low = latLng(raw.viewport?.low)
  const high = latLng(raw.viewport?.high)
  return {
    id: raw.id ?? '',
    name: raw.displayName?.text ?? raw.formattedAddress ?? '',
    formattedAddress: raw.formattedAddress ?? '',
    location,
    viewport: low && high ? { low, high } : undefined
  }
}

export function buildNearbyBody(req: NearbyRequest): Record<string, unknown> {
  return {
    includedTypes: [req.kind],
    maxResultCount: NEARBY_MAX_RESULTS,
    rankPreference: 'POPULARITY',
    languageCode: 'en',
    locationRestriction: {
      circle: {
        center: { latitude: req.center.latitude, longitude: req.center.longitude },
        radius: Math.min(NEARBY_MAX_RADIUS_M, Math.max(100, req.radius))
      }
    }
  }
}

/** A name's words, lowercased and without accents ("Bönigen" → ["bonigen"]). */
export function nameTokens(name: string): string[] {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

/** Whether `inner`'s words appear, in order and adjacent, among `outer`'s. */
export function containsWords(outer: string[], inner: string[]): boolean {
  if (inner.length === 0 || inner.length > outer.length) return false
  for (let i = 0; i + inner.length <= outer.length; i++) {
    if (inner.every((t, j) => outer[i + j] === t)) return true
  }
  return false
}

interface RawAddressComponent {
  longText?: string
  types?: string[]
}

/**
 * 2 when the place shares its name with its state, canton or province ("Bern", Canton of
 * Bern), 1 with its county or district ("Interlaken", Interlaken-Oberhasli District), else
 * 0. Nearby Search has no population or prominence for towns, and its popularity order
 * mostly follows distance from the circle's center; this picks out the main town of an area.
 */
function seatOf(name: string, components: RawAddressComponent[] | undefined): 0 | 1 | 2 {
  const words = nameTokens(name)
  let seat: 0 | 1 | 2 = 0
  for (const c of components ?? []) {
    if (!c.longText || !c.types) continue
    const level = c.types.includes('administrative_area_level_1') ? 2 : c.types.includes('administrative_area_level_2') ? 1 : 0
    if (level > seat && containsWords(nameTokens(c.longText), words)) seat = level
  }
  return seat
}

export const CITIES_FIELD_MASK = 'places.id,places.location,places.addressComponents'
/** Text Search covers a region this big at most (it degrades past a few hundred km). */
export const CITIES_MAX_SPAN_DEG = 8

/**
 * Text Search queries whose results cluster in a region's best-known cities. Places has no
 * population or prominence for towns, but its most relevant stations and attractions sit in
 * the cities people know (New York, Washington, Philadelphia; Zürich, Bern, Luzern).
 */
export const CITY_QUERIES = [
  { textQuery: 'top attractions', includedType: 'tourist_attraction' },
  { textQuery: 'train station', includedType: 'train_station' },
  { textQuery: 'city hall', includedType: 'city_hall' }
] as const

export function buildCitiesBody(query: (typeof CITY_QUERIES)[number], req: CitiesRequest): Record<string, unknown> {
  return {
    ...query,
    strictTypeFiltering: true,
    pageSize: 20,
    languageCode: 'en',
    locationRestriction: {
      rectangle: { low: { latitude: req.south, longitude: req.west }, high: { latitude: req.north, longitude: req.east } }
    }
  }
}

/** Stations and attractions this close together with the same city name are one city. */
const CITY_CLUSTER_M = 25000

/**
 * Groups Text Search results (one response per CITY_QUERIES entry) by the city in their
 * address. The city sits at the mean of its places; the most mentioned cities come first.
 */
export function aggregateCities(responses: unknown[]): NearbyPlace[] {
  interface City {
    name: string
    lat: number
    lon: number
    n: number
    first: number
    seat: 0 | 1 | 2
  }
  const cities: City[] = []
  for (const json of responses) {
    const raw = (json ?? {}) as { places?: Array<{ location?: RawLatLng; addressComponents?: RawAddressComponent[] }> }
    ;(raw.places ?? []).forEach((p, rank) => {
      const location = latLng(p.location)
      const components = p.addressComponents ?? []
      const town = components.find((c) => c.types?.includes('locality')) ?? components.find((c) => c.types?.includes('postal_town'))
      const name = town?.longText?.trim()
      if (!location || !name) return
      const city = cities.find((c) => c.name === name && distance(c.lat / c.n, c.lon / c.n, location) < CITY_CLUSTER_M)
      const seat = seatOf(name, components)
      if (city) {
        city.lat += location.latitude
        city.lon += location.longitude
        city.n++
        city.first = Math.min(city.first, rank)
        city.seat = Math.max(city.seat, seat) as 0 | 1 | 2
      } else {
        cities.push({ name, lat: location.latitude, lon: location.longitude, n: 1, first: rank, seat })
      }
    })
  }
  return cities
    .sort((a, b) => b.n - a.n || a.first - b.first)
    .map((c) => {
      const location = { latitude: c.lat / c.n, longitude: c.lon / c.n }
      return {
        id: `city:${nameTokens(c.name).join('-')}:${location.latitude.toFixed(2)}:${location.longitude.toFixed(2)}`,
        name: c.name,
        location,
        seat: c.seat,
        fame: c.n
      }
    })
}

function distance(lat: number, lon: number, b: LatLng): number {
  const toRad = Math.PI / 180
  const x = (b.longitude - lon) * toRad * Math.cos(((lat + b.latitude) / 2) * toRad)
  const y = (b.latitude - lat) * toRad
  return Math.hypot(x, y) * 6371008.8
}

/** Nearby Search results, in the API's (popularity) order. */
export function parseNearby(json: unknown): NearbyPlace[] {
  const raw = (json ?? {}) as {
    places?: Array<{ id?: string; displayName?: RawText; location?: RawLatLng; addressComponents?: RawAddressComponent[] }>
  }
  const out: NearbyPlace[] = []
  for (const p of raw.places ?? []) {
    const location = latLng(p.location)
    const name = p.displayName?.text?.trim()
    if (!p.id || !location || !name) continue
    out.push({ id: p.id, name, location, seat: seatOf(name, p.addressComponents) })
  }
  return out
}
