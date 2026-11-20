import type { LatLng, PlaceDetails, PlaceSuggestion } from './types'

export const PLACES_ENDPOINT = 'https://places.googleapis.com/v1'
export const AUTOCOMPLETE_FIELD_MASK =
  'suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat'
/** Only location fields, to stay on the Essentials / Pro billing tiers. */
export const DETAILS_FIELD_MASK = 'id,displayName,formattedAddress,location,viewport'
export const MIN_QUERY_LENGTH = 3
/** Places API caps circular location bias at 50 km. */
export const BIAS_RADIUS_M = 50000

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
