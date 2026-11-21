// Terrain-aware sunrise and sunset ("first light / last light") for a single point.
//
// SunCalc's rise and set times assume a flat horizon. Here the skyline around the point is
// traced on the same heightmap levels and with the same geometry (earth curvature, terrestrial
// refraction, the ground continuing past the data) as the terrain shadow pass, then crossed
// with the sun's path for a date. The skyline doesn't depend on the date, so it is traced once
// per point and changing the date only re-runs the cheap crossing.

import { sunPosition, type SunPosition } from './sun'
import {
  EARTH_RADIUS,
  heightAt,
  RECEIVER_BIAS,
  RECEIVER_BIAS_PER_CELL,
  REFRACTION_K,
  STEP_GROWTH,
  MAX_STEPS,
  type ShadowLevel
} from './terrainShadow'
import { addDays, MINUTES_PER_DAY, utcToZoned, zonedToUtc } from './time'

/** Azimuth bins of a skyline (0.25°): about a cell's width at the outer edge of the data. */
export const HORIZON_BINS = 1440
/** Skylines below this (degrees) never matter: the sun is that low only in deep twilight. */
export const HORIZON_FLOOR = -5
/** Time step of the sun-path scan, minutes; crossings are then refined to about a second. */
export const SCAN_STEP_MINUTES = 2

const DEG = Math.PI / 180

export interface HorizonOptions {
  radius?: number
  /** Height the ground is assumed to continue at past the edge of the data. */
  farHeight: number
  /** Highest height in the levels (bounds the march). */
  maxHeight: number
}

/** Receiver height for a point on the ground, with the same tolerance the shader uses. */
export function receiverHeight(ground: number, cell: number): number {
  return ground + RECEIVER_BIAS + RECEIVER_BIAS_PER_CELL * cell
}

/**
 * Apparent elevation angle of the skyline (degrees) seen from height `height` at (px, py),
 * looking along `azimuth` (degrees clockwise from the frame's north).
 *
 * This is `shadowTop` turned around: a sample at distance d with height H blocks the sun when
 *   tan(sun altitude) < (H − height) / d − (1 − k)·d / 2R
 * so the skyline is the largest value of the right-hand side along the ray. `px, py` should be
 * near the frame's origin, where the frame's horizontal is the point's.
 */
export function horizonAngle(
  levels: readonly (ShadowLevel | null)[],
  px: number,
  py: number,
  height: number,
  azimuth: number,
  opts: HorizonOptions
): number {
  const radius = opts.radius ?? EARTH_RADIUS
  const c2 = ((1 - REFRACTION_K) * 0.5) / radius
  const ux = Math.sin(azimuth * DEG)
  const uy = Math.cos(azimuth * DEG)
  const floor = Math.tan(HORIZON_FLOOR * DEG)
  // Beyond this distance a ground at `maxHeight` only sinks further below the line of sight.
  const boundPeak = opts.maxHeight < height ? Math.sqrt((height - opts.maxHeight) / c2) : 0
  const start = heightAt(levels, px, py)
  let best = Number.NEGATIVE_INFINITY
  let dLast = 0
  let d = 0.5 * (start?.cell ?? 1)
  for (let i = 0; i < MAX_STEPS; i++) {
    const sample = heightAt(levels, px + ux * d, py + uy * d)
    if (!sample) break
    const t = (sample.height - height) / d - d * c2
    if (t > best) best = t
    dLast = d
    const bound = (opts.maxHeight - height) / d - d * c2
    if (d > boundPeak && bound < Math.max(best, floor)) break
    d += Math.max(sample.cell, d * STEP_GROWTH)
  }
  if (dLast > 0) {
    // The ground past the data, at `farHeight`, sets the sea-horizon dip seen from high up.
    const dStar = opts.farHeight < height ? Math.sqrt((height - opts.farHeight) / c2) : 0
    const dc = Math.max(dStar, dLast)
    const far = (opts.farHeight - height) / dc - dc * c2
    if (far > best) best = far
  }
  return Number.isFinite(best) ? Math.atan(best) / DEG : HORIZON_FLOOR
}

/** Skyline around a point: `bins` apparent elevation angles, bin i at azimuth i · 360° / bins. */
export function horizonProfile(
  levels: readonly (ShadowLevel | null)[],
  px: number,
  py: number,
  height: number,
  opts: HorizonOptions,
  bins = HORIZON_BINS,
  from = 0,
  to = bins,
  out = new Float32Array(bins)
): Float32Array {
  for (let i = from; i < to; i++) out[i] = horizonAngle(levels, px, py, height, (i * 360) / bins, opts)
  return out
}

/** Skyline elevation (degrees) at any azimuth, interpolated between bins. */
export function skylineAt(profile: ArrayLike<number>, azimuth: number): number {
  const n = profile.length
  const u = ((((azimuth % 360) + 360) % 360) / 360) * n
  const i = Math.floor(u) % n
  const t = u - Math.floor(u)
  return profile[i] * (1 - t) + profile[(i + 1) % n] * t
}

export interface SunlitSpan {
  start: number
  end: number
}

export interface SunlitDay {
  /** Periods of direct sun within the local day (UTC instants), clipped to the day. */
  spans: SunlitSpan[]
  /** The sun first clears the skyline (null when it never does, or is already up at 00:00). */
  firstLight: number | null
  /** The sun last drops behind the skyline (null when it never does, or is still up at 24:00). */
  lastLight: number | null
  /** Total direct sun, milliseconds. */
  sunlitMs: number
}

/**
 * When the sun is above a skyline during the civil date `date` in `timeZone`. "Above" means
 * the center of the disc, which is where the rendered shadow edge sits (half the penumbra).
 */
export function sunlitDay(
  profile: ArrayLike<number>,
  date: string,
  timeZone: string,
  latitude: number,
  longitude: number,
  position: (utc: number, latitude: number, longitude: number) => SunPosition = sunPosition
): SunlitDay {
  const dayStart = zonedToUtc(date, 0, timeZone)
  const dayEnd = zonedToUtc(addDays(date, 1), 0, timeZone)
  const lit = (utc: number): boolean => {
    const p = position(utc, latitude, longitude)
    return p.altitude > HORIZON_FLOOR && p.altitude > skylineAt(profile, p.azimuth)
  }
  /** First lit instant in (a, b], given lit(a) !== lit(b). */
  const refine = (a: number, b: number, litA: boolean): number => {
    while (b - a > 1000) {
      const m = (a + b) / 2
      if (lit(m) === litA) a = m
      else b = m
    }
    return b
  }
  const step = SCAN_STEP_MINUTES * 60000
  const litAtStart = lit(dayStart)
  const spans: SunlitSpan[] = []
  let prevT = dayStart
  let prevLit = litAtStart
  let openAt: number | null = litAtStart ? dayStart : null
  for (let t = Math.min(dayEnd, dayStart + step); ; t = Math.min(dayEnd, t + step)) {
    const now = lit(t)
    if (now !== prevLit) {
      const edge = refine(prevT, t, prevLit)
      if (now) openAt = edge
      else {
        spans.push({ start: openAt ?? dayStart, end: edge })
        openAt = null
      }
    }
    prevT = t
    prevLit = now
    if (t >= dayEnd) break
  }
  const litAtEnd = openAt !== null
  if (openAt !== null) spans.push({ start: openAt, end: dayEnd })
  // A rise or set only counts when the day starts / ends in shade (polar summer has neither).
  const firstLight = !litAtStart && spans.length ? spans[0].start : null
  const lastLight = !litAtEnd && spans.length ? spans[spans.length - 1].end : null
  const sunlitMs = spans.reduce((sum, s) => sum + s.end - s.start, 0)
  return { spans, firstLight, lastLight, sunlitMs }
}

/**
 * Sunlit periods as local minutes of day [start, end) within `date` in `timeZone`, for
 * drawing on a 0–1440 time-of-day track. Periods running to midnight end at 1440.
 */
export function sunlitBands(spans: readonly SunlitSpan[], date: string, timeZone: string): Array<[number, number]> {
  const local = (utc: number, fallback: number): number => {
    const z = utcToZoned(utc, timeZone)
    return z.date === date ? z.minutes : fallback
  }
  return spans.map((s) => [local(s.start, 0), local(s.end, MINUTES_PER_DAY)] as [number, number]).filter(([a, b]) => b > a)
}
