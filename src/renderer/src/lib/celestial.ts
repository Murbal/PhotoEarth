import { sunDay, sunPosition, type SunDay, type SunPosition } from './sun'

/**
 * A body whose position the app can simulate. The sun is the only one today; the moon
 * (future work, §11) can implement the same interface without touching the controller.
 */
export interface CelestialBody {
  id: 'sun' | 'moon'
  label: string
  position(utcMs: number, latitude: number, longitude: number): SunPosition
  day(date: string, timeZone: string, latitude: number, longitude: number): SunDay
}

export const SUN: CelestialBody = {
  id: 'sun',
  label: 'Sun',
  position: sunPosition,
  day: sunDay
}
