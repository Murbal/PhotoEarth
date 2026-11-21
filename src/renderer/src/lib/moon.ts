import { getMoonIllumination, getMoonPosition } from 'suncalc'
import type { SunPosition } from './sun'

/** Moon azimuth/altitude (apparent, refraction-corrected) for an instant and location. */
export function moonPosition(utcMs: number, latitude: number, longitude: number): SunPosition {
  const p = getMoonPosition(new Date(utcMs), latitude, longitude)
  return { azimuth: ((p.azimuth % 360) + 360) % 360, altitude: p.altitude }
}

export interface MoonPhase {
  /** Illuminated fraction, 0–1. */
  fraction: number
  /** 0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter. */
  phase: number
  waxing: boolean
  name: string
}

const NAMES = ['New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent']

export function moonPhase(utcMs: number): MoonPhase {
  const m = getMoonIllumination(new Date(utcMs))
  return { fraction: m.fraction, phase: m.phase, waxing: m.waxing, name: NAMES[Math.round(m.phase * 8) % 8] }
}
