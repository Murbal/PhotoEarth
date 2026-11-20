import { getPosition, getTimes } from 'suncalc'
import { addDays, offsetMinutes, utcToZoned, zonedToUtc } from './time'

export interface SunPosition {
  /** Degrees clockwise from true north. */
  azimuth: number
  /** Apparent altitude above the horizon (refraction-corrected), degrees. */
  altitude: number
}

export interface SunDay {
  sunrise: number | null
  sunset: number | null
  solarNoon: number
  /** Civil twilight boundaries (sun at −6°). */
  dawn: number | null
  dusk: number | null
  /** Sun never sets / never rises on this date at this place. */
  polar: 'day' | 'night' | null
  /** Sun altitude at solar noon, degrees. */
  noonAltitude: number
}

/** Sun azimuth/altitude for an instant and location (SunCalc; NOAA-grade accuracy). */
export function sunPosition(utcMs: number, latitude: number, longitude: number): SunPosition {
  const p = getPosition(new Date(utcMs), latitude, longitude)
  return { azimuth: ((p.azimuth % 360) + 360) % 360, altitude: p.altitude }
}

const time = (d: Date | null | undefined): number | null =>
  d instanceof Date && !Number.isNaN(d.getTime()) ? d.getTime() : null

/**
 * Sunrise, solar noon and sunset for the civil date `date` in `timeZone`
 * at the given location. Times are UTC instants.
 */
export function sunDay(date: string, timeZone: string, latitude: number, longitude: number): SunDay {
  const noonUtc = zonedToUtc(date, 720, timeZone)
  const offset = offsetMinutes(noonUtc, timeZone)
  const t = getTimes(new Date(noonUtc), latitude, longitude, 0, offset)
  const solarNoon = time(t.solarNoon) ?? noonUtc
  const noonAltitude = sunPosition(solarNoon, latitude, longitude).altitude
  let polar: SunDay['polar'] = null
  if (t.alwaysUp) polar = 'day'
  else if (t.alwaysDown) polar = 'night'
  return {
    sunrise: time(t.sunrise),
    sunset: time(t.sunset),
    solarNoon,
    dawn: time(t.dawn),
    dusk: time(t.dusk),
    polar,
    noonAltitude
  }
}

export type LightPhase = 'night' | 'astronomical' | 'nautical' | 'civil' | 'day'

export function lightPhase(altitude: number): LightPhase {
  if (altitude >= -0.833) return 'day'
  if (altitude >= -6) return 'civil'
  if (altitude >= -12) return 'nautical'
  if (altitude >= -18) return 'astronomical'
  return 'night'
}

/**
 * Samples the sun altitude across the local day (for shading the time slider).
 * Returns `steps + 1` altitudes from 00:00 to 24:00 local time.
 */
export function altitudeProfile(
  date: string,
  timeZone: string,
  latitude: number,
  longitude: number,
  steps = 96
): number[] {
  const out: number[] = []
  // On a day without a clock change, local minutes map linearly to UTC: two zone conversions
  // instead of one per sample (each costs several Intl calls).
  const start = zonedToUtc(date, 0, timeZone)
  const end = zonedToUtc(addDays(date, 1), 0, timeZone)
  const linear = end - start === 1440 * 60000 && offsetMinutes(start, timeZone) === offsetMinutes(end, timeZone)
  for (let i = 0; i <= steps; i++) {
    const minutes = (i / steps) * 1440
    const utc = linear ? start + minutes * 60000 : zonedToUtc(date, minutes, timeZone)
    out.push(sunPosition(utc, latitude, longitude).altitude)
  }
  return out
}

/** Local minutes-of-day for a UTC instant (helper for slider markers). */
export function markerMinutes(utcMs: number | null, date: string, timeZone: string): number | null {
  if (utcMs === null) return null
  const z = utcToZoned(utcMs, timeZone)
  return z.date === date ? z.minutes : null
}

/** Unit vector toward the sun in the local east-north-up frame. */
export function sunDirectionENU(pos: SunPosition): [number, number, number] {
  const az = (pos.azimuth * Math.PI) / 180
  const alt = (pos.altitude * Math.PI) / 180
  return [Math.sin(az) * Math.cos(alt), Math.cos(az) * Math.cos(alt), Math.sin(alt)]
}
