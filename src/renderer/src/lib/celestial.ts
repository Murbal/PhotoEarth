import { galacticCoreDay, galacticCorePosition } from './milkyWay'
import { moonDay, moonPosition } from './moon'
import { sunDay, sunPosition, type SunPosition } from './sun'

/** Where a body stands in the observer's sky. */
export type HorizonPosition = SunPosition

/** A body's rise, transit and set on one local calendar day. Times are UTC instants. */
export interface BodyDay {
  /** Null when the body doesn't rise (or set) on this date. */
  rise: number | null
  set: number | null
  /** Upper culmination (solar noon for the sun); null when it falls on another date. */
  transit: number | null
  /** Apparent altitude at the transit, degrees. */
  transitAltitude: number | null
  /** Above (or below) the horizon all day. */
  polar: 'up' | 'down' | null
}

/**
 * A body whose position the app can simulate. SunController keeps the sun's own model (it
 * also needs twilight times); the moon, Galactic Core and shot-planning tools work on this interface.
 */
export interface CelestialBody {
  id: 'sun' | 'moon' | 'galacticCore'
  label: string
  position(utcMs: number, latitude: number, longitude: number): HorizonPosition
  day(date: string, timeZone: string, latitude: number, longitude: number): BodyDay
}

export const SUN: CelestialBody = {
  id: 'sun',
  label: 'Sun',
  position: sunPosition,
  day(date, timeZone, latitude, longitude) {
    const d = sunDay(date, timeZone, latitude, longitude)
    return {
      rise: d.sunrise,
      set: d.sunset,
      transit: d.solarNoon,
      transitAltitude: d.noonAltitude,
      polar: d.polar === 'day' ? 'up' : d.polar === 'night' ? 'down' : null
    }
  }
}

export const MOON: CelestialBody = {
  id: 'moon',
  label: 'Moon',
  position: moonPosition,
  day: moonDay
}

export const GALACTIC_CORE: CelestialBody = {
  id: 'galacticCore',
  label: 'Galactic Core',
  position: galacticCorePosition,
  day: galacticCoreDay
}
