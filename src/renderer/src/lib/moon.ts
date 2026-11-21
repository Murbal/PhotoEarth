import {
  Body,
  Equator,
  GeoMoon,
  Horizon,
  Illumination,
  MakeTime,
  MoonPhase as elongation,
  Observer,
  RotateVector,
  Rotation_EQJ_EQD,
  SearchHourAngle,
  SearchMoonPhase,
  SearchRiseSet,
  SiderealTime,
  type AstroTime
} from 'astronomy-engine'
import type { BodyDay, HorizonPosition } from './celestial'
import { addDays, zonedToUtc } from './time'

// Moon math on astronomy-engine (ELP/MPP02-based, arcsecond-level positions). The moon is
// close enough that the observer's place on the Earth shifts it by up to ~1° (parallax), so
// every sky position here is topocentric.

const KM_PER_AU = 149_597_870.7
const DEG = Math.PI / 180
const DAY_MS = 86_400_000
/** Phases are named after the principal one within this many degrees (~±12 h of the instant). */
const PRINCIPAL_WINDOW = 6.1

export type MoonPhaseName =
  | 'New moon'
  | 'Waxing crescent'
  | 'First quarter'
  | 'Waxing gibbous'
  | 'Full moon'
  | 'Waning gibbous'
  | 'Last quarter'
  | 'Waning crescent'

export interface MoonState extends HorizonPosition {
  /** Observer to moon center, km. */
  distanceKm: number
  /** Illuminated fraction of the disc, 0–1. */
  illumination: number
  /** Moon's ecliptic longitude minus the sun's, 0–360: 0 new, 90 first quarter, 180 full. */
  phase: number
  phaseName: MoonPhaseName
  /**
   * Direction of the lit limb as seen in the sky: degrees clockwise from "up" (towards the
   * zenith) on the moon's disc. 90 means lit on the right.
   */
  brightLimb: number
}

const norm360 = (deg: number): number => ((deg % 360) + 360) % 360

/** Apparent (refraction-corrected) topocentric azimuth and altitude of the moon. */
export function moonPosition(utcMs: number, latitude: number, longitude: number): HorizonPosition {
  const date = new Date(utcMs)
  const observer = new Observer(latitude, longitude, 0)
  const eq = Equator(Body.Moon, date, observer, true, true)
  const hor = Horizon(date, observer, eq.ra, eq.dec, 'normal')
  return { azimuth: norm360(hor.azimuth), altitude: hor.altitude }
}

export function phaseName(phase: number): MoonPhaseName {
  const p = norm360(phase)
  const near = (target: number) => Math.abs(((p - target + 540) % 360) - 180) < PRINCIPAL_WINDOW
  if (near(0)) return 'New moon'
  if (near(90)) return 'First quarter'
  if (near(180)) return 'Full moon'
  if (near(270)) return 'Last quarter'
  if (p < 90) return 'Waxing crescent'
  if (p < 180) return 'Waxing gibbous'
  if (p < 270) return 'Waning gibbous'
  return 'Waning crescent'
}

/** Phase summary on a 0–1 cycle, for views that only need the name and lit fraction. */
export interface MoonPhase {
  /** Illuminated fraction, 0–1. */
  fraction: number
  /** 0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter. */
  phase: number
  waxing: boolean
  name: MoonPhaseName
}

/** Geocentric phase of the moon at an instant (same model as `moonState`). */
export function moonPhase(utcMs: number): MoonPhase {
  const date = new Date(utcMs)
  const phase = elongation(date)
  return {
    fraction: Illumination(Body.Moon, date).phase_fraction,
    phase: phase / 360,
    waxing: phase < 180,
    name: phaseName(phase)
  }
}

/**
 * Bearing from one sky position to another on the observer's celestial sphere, degrees
 * clockwise from the zenith direction (azimuth increases to the right for an observer facing
 * the first position).
 */
export function skyBearing(from: HorizonPosition, to: HorizonPosition): number {
  const a1 = from.altitude * DEG
  const a2 = to.altitude * DEG
  const dz = (to.azimuth - from.azimuth) * DEG
  const y = Math.sin(dz) * Math.cos(a2)
  const x = Math.cos(a1) * Math.sin(a2) - Math.sin(a1) * Math.cos(a2) * Math.cos(dz)
  return norm360(Math.atan2(y, x) / DEG)
}

/** Position, distance, phase and orientation of the moon for an instant and place. */
export function moonState(utcMs: number, latitude: number, longitude: number): MoonState {
  const date = new Date(utcMs)
  const observer = new Observer(latitude, longitude, 0)
  const eq = Equator(Body.Moon, date, observer, true, true)
  const apparent = Horizon(date, observer, eq.ra, eq.dec, 'normal')
  // The lit limb faces the sun along the great circle between them (refraction left out:
  // it distorts both equally enough not to matter for the drawing).
  const sunEq = Equator(Body.Sun, date, observer, true, true)
  const moonSky = Horizon(date, observer, eq.ra, eq.dec)
  const sunSky = Horizon(date, observer, sunEq.ra, sunEq.dec)
  const phase = elongation(date)
  return {
    azimuth: norm360(apparent.azimuth),
    altitude: apparent.altitude,
    distanceKm: eq.dist * KM_PER_AU,
    illumination: Illumination(Body.Moon, date).phase_fraction,
    phase,
    phaseName: phaseName(phase),
    brightLimb: skyBearing(moonSky, sunSky)
  }
}

const instant = (t: AstroTime | null | undefined, before: number): number | null => {
  const ms = t?.date.getTime()
  return ms !== undefined && ms < before ? ms : null
}

/**
 * Moonrise, upper transit and moonset on the civil date `date` in `timeZone`. Each is the
 * event within that local day, so one can be missing: the moon rises ~50 minutes later every
 * day and skips one calendar day a month. Rise and set are for the upper limb, with standard
 * refraction, as in published tables.
 */
export function moonDay(date: string, timeZone: string, latitude: number, longitude: number): BodyDay {
  const start = zonedToUtc(date, 0, timeZone)
  const end = zonedToUtc(addDays(date, 1), 0, timeZone)
  const days = (end - start) / DAY_MS
  const observer = new Observer(latitude, longitude, 0)
  const from = new Date(start)
  const rise = instant(SearchRiseSet(Body.Moon, observer, +1, from, days), end)
  const set = instant(SearchRiseSet(Body.Moon, observer, -1, from, days), end)
  const culmination = SearchHourAngle(Body.Moon, observer, 0, from, +1)
  const transit = instant(culmination.time, end)
  let polar: BodyDay['polar'] = null
  if (rise === null && set === null) {
    polar = moonPosition(start + (end - start) / 2, latitude, longitude).altitude > 0 ? 'up' : 'down'
  }
  return {
    rise,
    set,
    transit,
    transitAltitude: transit === null ? null : culmination.hor.altitude,
    polar
  }
}

/** The next new and full moon at or after `utcMs`. */
export function nextPhases(utcMs: number): { newMoon: number | null; fullMoon: number | null } {
  const from = new Date(utcMs)
  return {
    newMoon: SearchMoonPhase(0, from, 32)?.date.getTime() ?? null,
    fullMoon: SearchMoonPhase(180, from, 32)?.date.getTime() ?? null
  }
}

/**
 * Geocentric moon position in Earth-fixed (ECEF) axes, meters: the true equator and equinox
 * of date turned by Greenwich apparent sidereal time. Polar motion (<0.5″) is left out.
 */
export function moonEarthFixed(utcMs: number): [number, number, number] {
  const time = MakeTime(new Date(utcMs))
  const v = RotateVector(Rotation_EQJ_EQD(time), GeoMoon(time))
  const theta = SiderealTime(time) * 15 * DEG
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  const m = KM_PER_AU * 1000
  return [(v.x * c + v.y * s) * m, (-v.x * s + v.y * c) * m, v.z * m]
}
