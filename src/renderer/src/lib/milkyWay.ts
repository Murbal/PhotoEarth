// Milky Way / Galactic Core ephemeris and Astro Dark-Window planning (pure, no Cesium).
//
// Positions use astronomy-engine's IAU precession/nutation rotation matrices and standard
// atmospheric refraction. Sagittarius A* (J2000 RA 17h45m40.04s, Dec −29°00′28.1″) marks the
// Galactic Center; the Milky Way arch samples the Galactic Plane (b = 0°) via Rotation_GAL_EQJ.

import {
  Body,
  CombineRotation,
  DefineStar,
  HorizonFromVector,
  Illumination,
  MakeTime,
  Observer,
  RotateVector,
  Rotation_EQJ_HOR,
  Rotation_GAL_EQJ,
  SearchHourAngle,
  SearchRiseSet,
  Vector,
  type AstroTime
} from 'astronomy-engine'
import type { WeatherSeries } from '@shared/types'
import type { BodyDay, HorizonPosition } from './celestial'
import { moonPosition } from './moon'
import { horizonAt, type Horizon } from './panorama'
import { geometricAltitude } from './sun'
import { addDays, zonedToUtc } from './time'
import { totalCloudAt } from './weather'

const DEG = Math.PI / 180
const RAD2DEG = 180 / Math.PI
const DAY_MS = 86_400_000
const MIN_MS = 60_000

/** Galactic Center (Sagittarius A*) J2000 right ascension: 17h 45m 40.04s (sidereal hours). */
export const GALACTIC_CENTER_RA_HOURS = 17 + 45 / 60 + 40.04 / 3600
/** Galactic Center (Sagittarius A*) J2000 declination: −29° 00′ 28.1″ (degrees). */
export const GALACTIC_CENTER_DEC_DEG = -(29 + 0 / 60 + 28.1 / 3600)
/** Distance to the Galactic Center in light-years (parallax is negligible). */
export const GALACTIC_CENTER_DIST_LY = 26_670
/** Bright core stretch along the Galactic Plane: |l| ≤ 55° (Crux/Scorpius through Sagittarius/Scutum). */
export const CORE_REGION_HALF_LON = 55
/** Low-moon illumination ceiling when `allowLowMoon` is enabled (10 %). */
export const LOW_MOON_ILLUMINATION = 0.1

const SGR_A_RA_RAD = GALACTIC_CENTER_RA_HOURS * 15 * DEG
const SGR_A_DEC_RAD = GALACTIC_CENTER_DEC_DEG * DEG
/** Unit vector toward Sagittarius A* in the J2000 mean equatorial frame (EQJ). */
const SGR_A_EQJ = {
  x: Math.cos(SGR_A_DEC_RAD) * Math.cos(SGR_A_RA_RAD),
  y: Math.cos(SGR_A_DEC_RAD) * Math.sin(SGR_A_RA_RAD),
  z: Math.sin(SGR_A_DEC_RAD)
}

/** Constant rotation from IAU 1958 Galactic (GAL) to J2000 equatorial (EQJ). */
const GAL_TO_EQJ = Rotation_GAL_EQJ()

const norm360 = (deg: number): number => ((deg % 360) + 360) % 360
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

function ensureCoreStar(): void {
  DefineStar(Body.Star1, GALACTIC_CENTER_RA_HOURS, GALACTIC_CENTER_DEC_DEG, GALACTIC_CENTER_DIST_LY)
}

export type ArchFraming = 'horizontal' | 'diagonal' | 'vertical'

export interface GalacticCoreState extends HorizonPosition {
  /** Highest altitude of the Galactic Plane (b = 0°) anywhere in the sky right now, 0–90°. */
  archElevation: number
  /** Azimuth of the Galactic Plane's apex, 0–360°. */
  archApexAzimuth: number
  /** Inclination of the Galactic Plane at the Galactic Center relative to horizontal, 0° (flat) – 90° (vertical). */
  coreTilt: number
  /** Practical framing orientation derived from the arch elevation. */
  framing: ArchFraming
}

export interface MilkyWayArchPoint extends HorizonPosition {
  /** Signed galactic longitude in [−180°, +180°] (0° = Galactic Center, ±180° = Anticenter). */
  galacticLon: number
  /** True for the bright Galactic Core region (|galacticLon| ≤ 55°). */
  isCoreRegion: boolean
}

export function archFraming(archElevation: number): ArchFraming {
  if (archElevation < 35) return 'horizontal'
  if (archElevation <= 65) return 'diagonal'
  return 'vertical'
}

export function archFramingLabel(framing: ArchFraming): string {
  switch (framing) {
    case 'horizontal':
      return 'Horizontal pano'
    case 'diagonal':
      return 'Diagonal / pano'
    case 'vertical':
      return 'Vertical / overhead'
  }
}

/** Apparent (refraction-corrected) topocentric azimuth and altitude of the Galactic Center (Sagittarius A*). */
export function galacticCorePosition(utcMs: number, latitude: number, longitude: number): HorizonPosition {
  const time = MakeTime(new Date(utcMs))
  const observer = new Observer(latitude, longitude, 0)
  const rot = Rotation_EQJ_HOR(time, observer)
  const hor = HorizonFromVector(RotateVector(rot, new Vector(SGR_A_EQJ.x, SGR_A_EQJ.y, SGR_A_EQJ.z, time)), 'normal')
  return { azimuth: norm360(hor.lon), altitude: hor.lat }
}

/**
 * Galactic Center position plus Milky Way arch elevation, apex azimuth and tilt at the core.
 * Computed in one horizontal frame transform for zero redundant precession/sidereal work.
 */
export function galacticCoreState(utcMs: number, latitude: number, longitude: number): GalacticCoreState {
  const time = MakeTime(new Date(utcMs))
  const observer = new Observer(latitude, longitude, 0)
  const eqjToHor = Rotation_EQJ_HOR(time, observer)
  const galToHor = CombineRotation(GAL_TO_EQJ, eqjToHor)

  // Sagittarius A* apparent position.
  const coreHor = HorizonFromVector(RotateVector(eqjToHor, new Vector(SGR_A_EQJ.x, SGR_A_EQJ.y, SGR_A_EQJ.z, time)), 'normal')

  // North Galactic Pole (b = +90°) is normal to the Galactic Plane (b = 0°).
  // In HOR (x = North, y = West, z = Up), max plane altitude is acos(|n.z|) = 90° − |h_NGP|.
  const ngp = RotateVector(galToHor, new Vector(0, 0, 1, time))
  const archElevation = Math.acos(clamp(Math.abs(ngp.z), 0, 1)) * RAD2DEG
  const sign = ngp.z >= 0 ? 1 : -1
  // Horizontal projection of apex is (−sign·n.x North, −sign·n.y West) → East = +sign·n.y.
  const archApexAzimuth = Math.hypot(ngp.x, ngp.y) > 1e-9 ? norm360(Math.atan2(sign * ngp.y, -sign * ngp.x) * RAD2DEG) : 0

  // Tangent to the Galactic Plane (d/dl at l = 0, b = 0) projected onto the vertical sky circle at the core.
  const gc = RotateVector(galToHor, new Vector(1, 0, 0, time))
  const tangent = RotateVector(galToHor, new Vector(0, 1, 0, time))
  const cosAlt = Math.hypot(gc.x, gc.y)
  const coreTilt = cosAlt > 1e-6 ? Math.asin(clamp(Math.abs(tangent.z) / cosAlt, 0, 1)) * RAD2DEG : 0

  return {
    azimuth: norm360(coreHor.lon),
    altitude: coreHor.lat,
    archElevation,
    archApexAzimuth,
    coreTilt,
    framing: archFraming(archElevation)
  }
}

/**
 * Polyline along the Galactic Plane (b = 0°) from galactic longitude −180° through 0° (core)
 * to +180° at `utcMs` for the observer. One combined GAL→HOR transform covers every point.
 */
export function milkyWayArch(utcMs: number, latitude: number, longitude: number, stepDeg = 5): MilkyWayArchPoint[] {
  const step = Math.max(1, Math.min(30, stepDeg))
  const time = MakeTime(new Date(utcMs))
  const observer = new Observer(latitude, longitude, 0)
  const galToHor = CombineRotation(GAL_TO_EQJ, Rotation_EQJ_HOR(time, observer))
  const points: MilkyWayArchPoint[] = []
  for (let lon = -180; lon <= 180; lon += step) {
    const rad = lon * DEG
    const hor = HorizonFromVector(RotateVector(galToHor, new Vector(Math.cos(rad), Math.sin(rad), 0, time)), 'normal')
    points.push({
      azimuth: norm360(hor.lon),
      altitude: hor.lat,
      galacticLon: lon,
      isCoreRegion: Math.abs(lon) <= CORE_REGION_HALF_LON
    })
  }
  if (points[points.length - 1]?.galacticLon !== 180) {
    const hor = HorizonFromVector(RotateVector(galToHor, new Vector(-1, 0, 0, time)), 'normal')
    points.push({ azimuth: norm360(hor.lon), altitude: hor.lat, galacticLon: 180, isCoreRegion: false })
  }
  return points
}

const instant = (t: AstroTime | null | undefined, before: number): number | null => {
  const ms = t?.date.getTime()
  return ms !== undefined && ms < before ? ms : null
}

/**
 * Galactic Core (Sagittarius A*) rise, upper transit and set on the civil date `date` in `timeZone`.
 * Handles DST days (23 / 25 h), northern latitudes where the core never rises (`polar: 'down'`),
 * and southern high latitudes where it is circumpolar (`polar: 'up'`).
 */
export function galacticCoreDay(date: string, timeZone: string, latitude: number, longitude: number): BodyDay {
  ensureCoreStar()
  const start = zonedToUtc(date, 0, timeZone)
  const end = zonedToUtc(addDays(date, 1), 0, timeZone)
  const days = (end - start) / DAY_MS
  const observer = new Observer(latitude, longitude, 0)
  const from = new Date(start)
  const rise = instant(SearchRiseSet(Body.Star1, observer, +1, from, days), end)
  const set = instant(SearchRiseSet(Body.Star1, observer, -1, from, days), end)
  const culmination = SearchHourAngle(Body.Star1, observer, 0, from, +1)
  const transit = instant(culmination.time, end)
  let polar: BodyDay['polar'] = null
  if (rise === null && set === null) {
    const probe = transit ?? start + (end - start) / 2
    polar = galacticCorePosition(probe, latitude, longitude).altitude > 0 ? 'up' : 'down'
  }
  return {
    rise,
    set,
    transit,
    transitAltitude: transit === null ? null : culmination.hor.altitude,
    polar
  }
}

// ───────────────────────────── Dark / Astro Window ─────────────────────────────

export interface TimeSpan {
  start: number
  end: number
}

export interface AstroWindowOptions {
  /** Minimum Galactic Core altitude (degrees) for core visibility. Default 5°. */
  minCoreAltitude?: number
  /**
   * Maximum moon illumination fraction (0–1) allowed while the moon is above the horizon.
   * Default 0 (strictly moonless: moon must be below 0°).
   */
  maxMoonIllumination?: number
  /** Traced terrain skyline (from Horizon Panorama) for skyline-aware core visibility. */
  horizon?: Horizon | null
  /** Open-Meteo weather series at the observer for clear-sky assessment. */
  weather?: WeatherSeries | null
  /** Sampling step in minutes (default 5 min; edges refined by bisection to ~15 s). */
  stepMinutes?: number
}

export type SkyClarity = 'clear' | 'mostly-clear' | 'partly-cloudy' | 'cloudy'
export type AstroRating = 'great' | 'good' | 'fair' | 'poor'

export interface AstroCloudSummary {
  /** Mean combined cloud cover over the window, 0–100 %. */
  meanCloud: number
  /** Lowest combined cloud cover over the window, 0–100 %. */
  minCloud: number
  clarity: SkyClarity
  label: string
  /** Clearest instant inside the window (breaking ties by higher core altitude). */
  bestUtc: number | null
  /** Whether the cloud summary was evaluated over core-dark, moonless-dark, or astro-dark spans. */
  scope: 'core' | 'moonless' | 'astro'
}

export interface CorePeak {
  utc: number
  altitude: number
  azimuth: number
}

export interface AstroNight {
  /** Evening calendar date (the night runs from local 12:00 on `date` to 12:00 on `date + 1`). */
  date: string
  nightStart: number
  nightEnd: number
  /** Stretches of astronomical night (geometric sun altitude < −18°). */
  astroDark: TimeSpan[]
  /** Lowest geometric sun altitude reached during the night, degrees. */
  darkestSunAltitude: number
  /** Stretches of astronomical night that are moonless (or within `maxMoonIllumination`). */
  moonlessDark: TimeSpan[]
  /** Stretches of the night when the Galactic Core meets the altitude (and optional skyline) threshold. */
  coreVisible: TimeSpan[]
  /** Intersection of `moonlessDark` and `coreVisible`: the prime Galactic Core dark windows. */
  coreDarkWindows: TimeSpan[]
  /** Highest Galactic Core point inside `coreDarkWindows` (null when `coreDarkWindows` is empty). */
  peakCore: CorePeak | null
  /** Highest Galactic Core point anywhere during the night (for reference when no dark window exists). */
  nightCorePeak: CorePeak | null
  /** Total durations in milliseconds. */
  totalAstroDarkMs: number
  totalMoonlessDarkMs: number
  totalCoreDarkMs: number
  /** True when a Horizon Panorama skyline constrained `coreVisible`. */
  skylineAware: boolean
  /** Cloud-cover assessment across the primary dark window, when Open-Meteo data covers it. */
  clouds: AstroCloudSummary | null
  /** Overall night rating combining dark-window duration, core visibility and cloud cover. */
  rating: AstroRating
}

export function spanDurationMs(spans: readonly TimeSpan[]): number {
  let sum = 0
  for (const s of spans) sum += Math.max(0, s.end - s.start)
  return sum
}

/** Exact intersection of two sorted, non-overlapping interval lists. */
export function intersectSpans(a: readonly TimeSpan[], b: readonly TimeSpan[]): TimeSpan[] {
  const out: TimeSpan[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i].start, b[j].start)
    const end = Math.min(a[i].end, b[j].end)
    if (end > start) out.push({ start, end })
    if (a[i].end < b[j].end) i++
    else j++
  }
  return out
}

/** Scans `[start, end]` every `stepMs` and bisects each predicate edge to within `refineMs`. */
function scanSpans(start: number, end: number, stepMs: number, predicate: (utc: number) => boolean, refineMs = 15_000): TimeSpan[] {
  if (end <= start) return []
  const refine = (lo: number, hi: number, valLo: boolean): number => {
    while (hi - lo > refineMs) {
      const mid = (lo + hi) / 2
      if (predicate(mid) === valLo) lo = mid
      else hi = mid
    }
    return Math.round((lo + hi) / 2)
  }
  const spans: TimeSpan[] = []
  let prevT = start
  let prevV = predicate(start)
  let openAt: number | null = prevV ? start : null
  const steps = Math.max(1, Math.ceil((end - start) / stepMs))
  for (let k = 1; k <= steps; k++) {
    const t = Math.min(end, start + k * stepMs)
    const v = predicate(t)
    if (v !== prevV) {
      const edge = refine(prevT, t, prevV)
      if (v) openAt = edge
      else if (openAt !== null) {
        if (edge > openAt) spans.push({ start: openAt, end: edge })
        openAt = null
      }
    }
    prevT = t
    prevV = v
  }
  if (openAt !== null && end > openAt) spans.push({ start: openAt, end })
  return spans
}

/** Whether the Galactic Core clears `minCoreAltitude` (and the skyline when `horizon` is given). */
export function isCoreAboveThreshold(pos: HorizonPosition, minCoreAltitude: number, horizon?: Horizon | null): boolean {
  if (pos.altitude < minCoreAltitude) return false
  if (horizon) {
    const sky = horizonAt(horizon, pos.azimuth)
    if (Number.isFinite(sky) && pos.altitude <= sky) return false
  }
  return true
}

function classifyClarity(meanCloud: number): { clarity: SkyClarity; label: string } {
  if (meanCloud < 15) return { clarity: 'clear', label: 'Clear' }
  if (meanCloud < 35) return { clarity: 'mostly-clear', label: 'Mostly clear' }
  if (meanCloud < 65) return { clarity: 'partly-cloudy', label: 'Partly cloudy' }
  return { clarity: 'cloudy', label: 'Cloudy' }
}

/** Summarizes Open-Meteo cloud cover across a set of night windows. */
function evaluateClouds(
  weather: WeatherSeries,
  spans: readonly TimeSpan[],
  scope: AstroCloudSummary['scope'],
  latitude: number,
  longitude: number
): AstroCloudSummary | null {
  if (spans.length === 0) return null
  let sum = 0
  let count = 0
  let minCloud = Infinity
  let bestUtc: number | null = null
  let bestCoreAlt = -Infinity
  const sampleStep = 15 * MIN_MS
  for (const s of spans) {
    const n = Math.max(1, Math.ceil((s.end - s.start) / sampleStep))
    for (let k = 0; k <= n; k++) {
      const t = Math.min(s.end, s.start + k * sampleStep)
      const c = totalCloudAt(weather, t)
      if (c === null) continue
      sum += c
      count++
      const coreAlt = galacticCorePosition(t, latitude, longitude).altitude
      if (c < minCloud || (c === minCloud && coreAlt > bestCoreAlt)) {
        minCloud = c
        bestUtc = t
        bestCoreAlt = coreAlt
      }
    }
  }
  if (count === 0) return null
  const meanCloud = Math.round(sum / count)
  const { clarity, label } = classifyClarity(meanCloud)
  return { meanCloud, minCloud: Math.round(minCloud), clarity, label, bestUtc, scope }
}

function findPeakCore(spans: readonly TimeSpan[], latitude: number, longitude: number): CorePeak | null {
  if (spans.length === 0) return null
  let best: CorePeak | null = null
  const sampleStep = 10 * MIN_MS
  let bestSpan: TimeSpan | null = null
  for (const s of spans) {
    const n = Math.max(1, Math.ceil((s.end - s.start) / sampleStep))
    for (let k = 0; k <= n; k++) {
      const t = Math.min(s.end, s.start + k * sampleStep)
      const pos = galacticCorePosition(t, latitude, longitude)
      if (!best || pos.altitude > best.altitude) {
        best = { utc: t, altitude: pos.altitude, azimuth: pos.azimuth }
        bestSpan = s
      }
    }
  }
  if (!best || !bestSpan) return null
  // Refine within ±sampleStep clamped to the containing span (minute-level accuracy).
  let lo = Math.max(bestSpan.start, best.utc - sampleStep)
  let hi = Math.min(bestSpan.end, best.utc + sampleStep)
  for (let i = 0; i < 8 && hi - lo > 30_000; i++) {
    const m1 = lo + (hi - lo) / 3
    const m2 = hi - (hi - lo) / 3
    if (galacticCorePosition(m1, latitude, longitude).altitude < galacticCorePosition(m2, latitude, longitude).altitude) lo = m1
    else hi = m2
  }
  const mid = Math.round((lo + hi) / 2)
  const refined = galacticCorePosition(mid, latitude, longitude)
  return refined.altitude >= best.altitude ? { utc: mid, altitude: refined.altitude, azimuth: refined.azimuth } : best
}

function rateAstroNight(
  totalMoonlessDarkMs: number,
  totalCoreDarkMs: number,
  peakCore: CorePeak | null,
  clouds: AstroCloudSummary | null
): AstroRating {
  if (totalMoonlessDarkMs < 15 * MIN_MS) return 'poor'
  if (totalCoreDarkMs >= 15 * MIN_MS) {
    if (clouds) {
      if (totalCoreDarkMs >= 60 * MIN_MS && clouds.meanCloud < 25) return 'great'
      if (totalCoreDarkMs >= 30 * MIN_MS && clouds.meanCloud < 45) return 'good'
      if (clouds.meanCloud < 65) return 'fair'
      return 'poor'
    }
    if (totalCoreDarkMs >= 90 * MIN_MS && (peakCore?.altitude ?? 0) >= 15) return 'great'
    if (totalCoreDarkMs >= 30 * MIN_MS) return 'good'
    return 'fair'
  }
  // Moonless astronomical night exists, though the Galactic Core is not above threshold.
  if (clouds) return totalMoonlessDarkMs >= 60 * MIN_MS && clouds.meanCloud < 35 ? 'fair' : 'poor'
  return 'fair'
}

/**
 * Computes the astrophotography dark window for the night starting on local `date`
 * (local 12:00 on `date` to local 12:00 on `date + 1` in `timeZone`), intersecting:
 * - Astronomical night (geometric sun altitude < −18°),
 * - Moonless / low-moon sky,
 * - Galactic Core above `minCoreAltitude` (and above the skyline when `horizon` is given),
 * - Optional Open-Meteo cloud cover across the primary window.
 */
export function astroNight(
  date: string,
  timeZone: string,
  latitude: number,
  longitude: number,
  options: AstroWindowOptions = {}
): AstroNight {
  const minCoreAltitude = options.minCoreAltitude ?? 5
  const maxMoonIllumination = options.maxMoonIllumination ?? 0
  const horizon = options.horizon ?? null
  const weather = options.weather ?? null
  const stepMs = Math.max(1, options.stepMinutes ?? 5) * MIN_MS

  const nightStart = zonedToUtc(date, 720, timeZone)
  const nightEnd = zonedToUtc(addDays(date, 1), 720, timeZone)

  let darkestSunAltitude = 90
  const sunDark = (t: number): boolean => {
    const alt = geometricAltitude(t, latitude, longitude)
    if (alt < darkestSunAltitude) darkestSunAltitude = alt
    return alt < -18
  }
  const astroDark = scanSpans(nightStart, nightEnd, stepMs, sunDark)

  // Moon check runs only inside astronomical night spans (skips daytime work).
  const moonlessDark: TimeSpan[] = []
  if (astroDark.length > 0) {
    // Moon illumination changes < 0.01 over a night; sample once at midpoint when low-moon allowance is on.
    const lowMoonOk =
      maxMoonIllumination > 0 && Illumination(Body.Moon, new Date((nightStart + nightEnd) / 2)).phase_fraction <= maxMoonIllumination
    if (lowMoonOk) {
      moonlessDark.push(...astroDark)
    } else {
      const moonDown = (t: number) => moonPosition(t, latitude, longitude).altitude <= 0
      for (const span of astroDark) {
        moonlessDark.push(...scanSpans(span.start, span.end, stepMs, moonDown))
      }
    }
  }

  const coreVisible = scanSpans(nightStart, nightEnd, stepMs, (t) =>
    isCoreAboveThreshold(galacticCorePosition(t, latitude, longitude), minCoreAltitude, horizon)
  )
  const coreDarkWindows = intersectSpans(moonlessDark, coreVisible)
  const peakCore = findPeakCore(coreDarkWindows, latitude, longitude)
  const nightCorePeak = peakCore ?? findPeakCore([{ start: nightStart, end: nightEnd }], latitude, longitude)

  const totalAstroDarkMs = spanDurationMs(astroDark)
  const totalMoonlessDarkMs = spanDurationMs(moonlessDark)
  const totalCoreDarkMs = spanDurationMs(coreDarkWindows)

  let clouds: AstroCloudSummary | null = null
  if (weather) {
    if (coreDarkWindows.length > 0) clouds = evaluateClouds(weather, coreDarkWindows, 'core', latitude, longitude)
    else if (moonlessDark.length > 0) clouds = evaluateClouds(weather, moonlessDark, 'moonless', latitude, longitude)
    else if (astroDark.length > 0) clouds = evaluateClouds(weather, astroDark, 'astro', latitude, longitude)
  }

  const rating = rateAstroNight(totalMoonlessDarkMs, totalCoreDarkMs, peakCore, clouds)
  return {
    date,
    nightStart,
    nightEnd,
    astroDark,
    darkestSunAltitude,
    moonlessDark,
    coreVisible,
    coreDarkWindows,
    peakCore,
    nightCorePeak,
    totalAstroDarkMs,
    totalMoonlessDarkMs,
    totalCoreDarkMs,
    skylineAware: horizon !== null,
    clouds,
    rating
  }
}

export type CoreVisibilityKind = 'visible' | 'low' | 'moonlit' | 'twilight' | 'daylight' | 'below' | 'never'

export interface CoreVisibilityStatus {
  kind: CoreVisibilityKind
  label: string
}

/** Concise live visibility status of the Galactic Core at an instant. */
export function coreVisibilityStatus(
  utcMs: number,
  latitude: number,
  longitude: number,
  options: {
    minCoreAltitude?: number
    maxMoonIllumination?: number
    horizon?: Horizon | null
    polar?: BodyDay['polar']
    corePos?: HorizonPosition
    moonAlt?: number
    moonIllumination?: number
  } = {}
): CoreVisibilityStatus {
  if (options.polar === 'down') return { kind: 'never', label: 'Never rises here' }
  const core = options.corePos ?? galacticCorePosition(utcMs, latitude, longitude)
  const minAlt = options.minCoreAltitude ?? 5
  const horizon = options.horizon ?? null
  if (core.altitude <= 0) return { kind: 'below', label: 'Below horizon' }
  if (horizon) {
    const sky = horizonAt(horizon, core.azimuth)
    if (Number.isFinite(sky) && core.altitude <= sky) return { kind: 'below', label: 'Behind terrain' }
  }
  const sunAlt = geometricAltitude(utcMs, latitude, longitude)
  if (sunAlt >= -0.833) return { kind: 'daylight', label: 'Daylight' }
  if (sunAlt >= -18) return { kind: 'twilight', label: 'Twilight' }
  const moonAlt = options.moonAlt ?? moonPosition(utcMs, latitude, longitude).altitude
  const maxMoon = options.maxMoonIllumination ?? 0
  if (moonAlt > 0) {
    const illum = options.moonIllumination ?? Illumination(Body.Moon, new Date(utcMs)).phase_fraction
    if (illum > maxMoon) return { kind: 'moonlit', label: `Moonlit (${Math.round(illum * 100)}%)` }
  }
  if (core.altitude < minAlt) return { kind: 'low', label: `Dark · low (${core.altitude.toFixed(1)}°)` }
  return { kind: 'visible', label: 'Visible (dark sky)' }
}
