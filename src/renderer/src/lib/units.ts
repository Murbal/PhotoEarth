import type { Units } from '@shared/types'

export const FEET_PER_METER = 3.280839895

/**
 * Whole meters or feet: "1,234 m", "4,049 ft". `grouping: false` drops the thousands
 * separator ("1234 m") for text that is itself comma-separated, like the clipboard.
 */
export function formatElevation(meters: number | null | undefined, units: Units, { grouping = true } = {}): string {
  if (meters === null || meters === undefined || !Number.isFinite(meters)) return '—'
  const value = Math.round(units === 'imperial' ? meters * FEET_PER_METER : meters)
  return `${value.toLocaleString('en-US', { useGrouping: grouping })} ${units === 'imperial' ? 'ft' : 'm'}`
}

export function formatDistance(meters: number, units: Units): string {
  if (!Number.isFinite(meters)) return '—'
  if (units === 'imperial') {
    const feet = meters * FEET_PER_METER
    if (feet < 5280 * 0.25) return `${Math.round(feet).toLocaleString('en-US')} ft`
    const miles = meters / 1609.344
    return `${miles < 10 ? miles.toFixed(2) : miles.toFixed(1)} mi`
  }
  if (meters < 1000) return `${Math.round(meters)} m`
  const km = meters / 1000
  return `${km < 10 ? km.toFixed(2) : km < 100 ? km.toFixed(1) : Math.round(km).toLocaleString('en-US')} km`
}

/** Altitude with sensible precision for large camera heights. */
export function formatAltitude(meters: number | null | undefined, units: Units): string {
  if (meters === null || meters === undefined || !Number.isFinite(meters)) return '—'
  if (Math.abs(meters) >= 100000) return formatDistance(meters, units)
  return formatElevation(meters, units)
}

const NICE = [1, 2, 5]

/**
 * Picks a round scale-bar length no longer than `maxMeters`.
 * Returns the length in meters plus a label in the chosen units.
 */
export function niceScale(maxMeters: number, units: Units): { meters: number; label: string } | null {
  if (!Number.isFinite(maxMeters) || maxMeters <= 0) return null
  const unitMeters = units === 'imperial' ? (maxMeters * FEET_PER_METER < 5280 ? 1 / FEET_PER_METER : 1609.344) : 1
  const max = maxMeters / unitMeters
  const exp = Math.floor(Math.log10(max))
  let best = 0
  for (let e = exp; e >= exp - 1; e--) {
    for (const n of NICE) {
      const v = n * 10 ** e
      if (v <= max && v > best) best = v
    }
  }
  if (best <= 0) return null
  const meters = best * unitMeters
  let label: string
  if (units === 'imperial') label = unitMeters === 1 ? `${best} ft` : `${best} mi`
  else label = best >= 1000 ? `${best / 1000} km` : `${best} m`
  return { meters, label }
}

export function formatAngle(deg: number, digits = 1): string {
  return Number.isFinite(deg) ? `${deg.toFixed(digits)}°` : '—'
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']

export function compassPoint(azimuth: number): string {
  const i = Math.round((((azimuth % 360) + 360) % 360) / 22.5) % 16
  return COMPASS[i]
}

/** Wind speed from m/s: km/h (metric) or mph (imperial), whole numbers. */
export function formatSpeed(metersPerSecond: number | null, units: Units): string {
  if (metersPerSecond === null || !Number.isFinite(metersPerSecond)) return '—'
  return units === 'imperial' ? `${Math.round(metersPerSecond * 2.236936)} mph` : `${Math.round(metersPerSecond * 3.6)} km/h`
}
