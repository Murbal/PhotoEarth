import { MIN_QUERY_LENGTH } from '@shared/places'
import type { LatLng, PlaceDetails, PlaceSuggestion, Result } from '@shared/types'

/**
 * One search session = one session token: every autocomplete keystroke plus the final
 * Place Details call is billed as a single search (§3.3). Requests go through the main
 * process so the key stays out of renderer network logs and CORS doesn't apply.
 */
export class PlacesSession {
  private token = crypto.randomUUID()
  private seq = 0

  async autocomplete(input: string, bias?: LatLng): Promise<Result<PlaceSuggestion[]> | null> {
    const query = input.trim()
    if (query.length < MIN_QUERY_LENGTH) return { ok: true, data: [] }
    const id = ++this.seq
    const res = await window.photoearth.places.autocomplete({ input: query, sessionToken: this.token, bias })
    // Drop responses that arrive after a newer keystroke.
    return id === this.seq ? res : null
  }

  async details(placeId: string): Promise<Result<PlaceDetails>> {
    const res = await window.photoearth.places.details(placeId, this.token)
    this.token = crypto.randomUUID()
    return res
  }
}

export const DEBOUNCE_MS = 250
