import tzlookup from '@photostructure/tz-lookup'

/**
 * IANA time zone for a coordinate, resolved offline. Oceans resolve to the nautical
 * Etc/GMT±N zones. Falls back to UTC for invalid input.
 */
export function lookupTimeZone(latitude: number, longitude: number): string {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return 'UTC'
  const lat = Math.max(-90, Math.min(90, latitude))
  const lon = ((((longitude + 180) % 360) + 360) % 360) - 180
  try {
    return tzlookup(lat, lon)
  } catch {
    return 'UTC'
  }
}
