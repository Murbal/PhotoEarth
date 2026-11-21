// Camera → Subject shot alignment geometry, line-of-sight evaluation, and reverse
// Sun & Moon ephemeris search (pure, no Cesium).
//
// Vertical elevation angles and line-of-sight heights account for Earth curvature and
// standard terrestrial refraction (k = 0.13), matching lib/panorama.ts and
// lib/terrainShadow.ts so terrain elevation angles compare directly against apparent
// Sun and Moon altitudes.

import { Body, Equator, Observer, SiderealTime } from 'astronomy-engine'
import type { LensView } from './lens'
import { moonPosition, moonState, type MoonPhaseName } from './moon'
import { azDelta, EYE_HEIGHT, MOON_RADIUS, SUN_RADIUS, wrap360 } from './panorama'
import { haversine, type GeoPoint } from './profile'
import { geometricAltitude, skyBand, sunPosition, type SkyBand } from './sun'
import { EARTH_RADIUS, REFRACTION_K } from './terrainShadow'
import { addDays, utcToZoned, zonedToUtc } from './time'

export const DEFAULT_EYE_HEIGHT = EYE_HEIGHT
export const SUN_MEAN_DIAMETER_DEG = 2 * SUN_RADIUS
export const MOON_MEAN_DIAMETER_DEG = 2 * MOON_RADIUS
/** Mean lunar radius, km (IAU). */
export const MOON_RADIUS_KM = 1737.4
/** Approximate lunar apogee / perigee distances, km (for apparent disc range). */
const MOON_APOGEE_KM = 405_500
const MOON_PERIGEE_KM = 363_300

const DEG = 180 / Math.PI
const RAD = Math.PI / 180
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const MIN_MS = 60_000
/** Mean rate at which the Moon's local hour angle advances (hours of HA per UTC hour). */
const LUNAR_HA_RATE = 24 / 24.8412
const PHI_INV = (Math.sqrt(5) - 1) / 2

export interface AlignmentPin {
  longitude: number
  latitude: number
  /** Ellipsoidal surface height, meters. */
  groundHeight: number
  /** Surface height above mean sea level, meters. */
  msl: number
  /** Optional human-readable label (e.g. search result or peak name). */
  label?: string
}

export interface AlignmentGeometry {
  /** True compass bearing from camera to subject, 0–360°. */
  bearing: number
  /** Back azimuth (reverse bearing) from subject to camera, 0–360°. */
  reverseBearing: number
  /** Horizontal great-circle distance, meters. */
  horizontalDistance: number
  /** Straight-line slope distance from camera eye to subject, meters. */
  slopeDistance: number
  /** Subject ellipsoidal height minus camera eye ellipsoidal height, meters. */
  elevationDiff: number
  /** Camera eye ellipsoidal height (groundHeight + eyeHeight), meters. */
  eyeHeightEllipsoid: number
  /** Camera eye height above mean sea level (msl + eyeHeight), meters. */
  eyeHeightMsl: number
  /**
   * Apparent vertical elevation angle (degrees), accounting for Earth curvature and
   * standard terrestrial refraction (k = 0.13), consistent with lib/panorama.ts and
   * lib/terrainShadow.ts. Directly comparable to apparent Sun/Moon altitudes.
   */
  elevationAngle: number
  /**
   * Geometric (unrefracted) elevation angle (degrees) for aiming a 3D Euclidean camera
   * from the camera eye directly at the subject on the globe.
   */
  geometricAngle: number
  /** Mean apparent Sun disc diameter at the subject slope distance, meters. */
  sunDiscWidthM: number
  /** Mean apparent Moon disc diameter at the subject slope distance, meters. */
  moonDiscWidthM: number
  /** Minimum (apogee) apparent Moon disc diameter at the subject distance, meters. */
  moonDiscMinM: number
  /** Maximum (perigee) apparent Moon disc diameter at the subject distance, meters. */
  moonDiscMaxM: number
}

export interface LineOfSightSample {
  longitude: number
  latitude: number
  /** Horizontal distance from camera along the great-circle path, meters. */
  distance: number
  /** Ellipsoidal terrain/surface height, meters (null when unavailable). */
  height: number | null
}

export interface ObstructionPoint {
  longitude: number
  latitude: number
  distance: number
  /** Ellipsoidal height of the terrain at this point, meters. */
  terrainHeight: number
  /** Ellipsoidal height of the refracted sightline at this point, meters. */
  rayHeight: number
  /** Terrain height above the sightline (terrainHeight - rayHeight > 0), meters. */
  intrusion: number
}

export interface LineOfSightResult {
  status: 'clear' | 'obstructed' | 'unknown'
  /** Smallest clearance (rayHeight - terrainHeight) among interior samples, meters. Negative when obstructed. */
  minClearance: number | null
  /** Horizontal distance from camera where minClearance occurs, meters. */
  minClearanceDistance: number | null
  /** Worst obstruction point when status === 'obstructed' (largest intrusion above sightline). */
  obstruction: ObstructionPoint | null
  /** Number of valid interior samples evaluated. */
  sampleCount: number
}

export interface FramingCoverage {
  /** Linear width of the viewfinder frame at the subject distance, meters. */
  frameWidthM: number
  /** Linear height of the viewfinder frame at the subject distance, meters. */
  frameHeightM: number
  /** Mean Sun disc share of frame width, percent. */
  sunWidthPct: number
  /** Mean Sun disc share of frame height, percent. */
  sunHeightPct: number
  /** Moon disc share of frame width, percent. */
  moonWidthPct: number
  /** Moon disc share of frame height, percent. */
  moonHeightPct: number
}

// ───────────────────────────── spherical & sightline geometry ─────────────────────────────

/** True compass initial bearing along the great circle from `from` to `to`, degrees in [0, 360). */
export function initialBearing(from: GeoPoint, to: GeoPoint): number {
  const lat1 = from.latitude * RAD
  const lat2 = to.latitude * RAD
  const dLon = (to.longitude - from.longitude) * RAD
  const y = Math.sin(dLon) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
  return wrap360(Math.atan2(y, x) * DEG)
}

/** Back azimuth (true bearing from `to` back to `from`), degrees in [0, 360). */
export function reverseBearing(from: GeoPoint, to: GeoPoint): number {
  return initialBearing(to, from)
}

/** Destination point at `distanceM` meters along `bearingDeg` from `from` on a sphere of `radius`. */
export function destinationPoint(from: GeoPoint, bearingDeg: number, distanceM: number, radius = EARTH_RADIUS): GeoPoint {
  if (distanceM <= 0) return { longitude: from.longitude, latitude: from.latitude }
  const lat1 = from.latitude * RAD
  const lon1 = from.longitude * RAD
  const brng = bearingDeg * RAD
  const ang = distanceM / radius
  const sinLat2 = Math.sin(lat1) * Math.cos(ang) + Math.cos(lat1) * Math.sin(ang) * Math.cos(brng)
  const lat2 = Math.asin(Math.max(-1, Math.min(1, sinLat2)))
  const lon2 = lon1 + Math.atan2(Math.sin(brng) * Math.sin(ang) * Math.cos(lat1), Math.cos(ang) - Math.sin(lat1) * Math.sin(lat2))
  return {
    latitude: lat2 * DEG,
    longitude: ((((lon2 * DEG + 180) % 360) + 360) % 360) - 180
  }
}

/**
 * Apparent vertical elevation angle (degrees) of a target at ellipsoidal height `targetHeight`
 * and horizontal distance `distanceM` seen from ellipsoidal height `eyeHeight`, accounting for
 * Earth curvature and terrestrial refraction `refractionK` (default 0.13, matching
 * `lib/panorama.ts` and `lib/terrainShadow.ts`).
 */
export function apparentElevationAngle(
  eyeHeight: number,
  targetHeight: number,
  distanceM: number,
  radius = EARTH_RADIUS,
  refractionK = REFRACTION_K
): number {
  if (distanceM < 1e-6) return targetHeight >= eyeHeight ? 90 : -90
  const dropCoeff = (1 - refractionK) / (2 * radius)
  return Math.atan((targetHeight - eyeHeight) / distanceM - distanceM * dropCoeff) * DEG
}

/** Geometric (unrefracted) vertical elevation angle (degrees) on a sphere of `radius`. */
export function geometricElevationAngle(eyeHeight: number, targetHeight: number, distanceM: number, radius = EARTH_RADIUS): number {
  return apparentElevationAngle(eyeHeight, targetHeight, distanceM, radius, 0)
}

/** Apparent linear width (meters) subtended by an angle `angularDiameterDeg` at `distanceM`. */
export function apparentDiscSize(distanceM: number, angularDiameterDeg: number): number {
  if (!(distanceM > 0) || !(angularDiameterDeg > 0)) return 0
  return 2 * distanceM * Math.tan((angularDiameterDeg * RAD) / 2)
}

/** Apparent angular diameter (degrees) of a spherical body of `bodyRadiusKm` at `distanceKm`. */
export function angularDiameterDeg(bodyRadiusKm: number, distanceKm: number): number {
  if (!(distanceKm > bodyRadiusKm) || !(bodyRadiusKm > 0)) return 0
  return 2 * Math.asin(bodyRadiusKm / distanceKm) * DEG
}

/** Full Camera → Subject geometry readout. */
export function computeAlignmentGeometry(
  camera: AlignmentPin,
  subject: AlignmentPin,
  eyeHeight = DEFAULT_EYE_HEIGHT,
  radius = EARTH_RADIUS
): AlignmentGeometry {
  const eyeHeightEllipsoid = camera.groundHeight + eyeHeight
  const eyeHeightMsl = camera.msl + eyeHeight
  const horizontalDistance = haversine(camera, subject)
  const elevationDiff = subject.groundHeight - eyeHeightEllipsoid
  const slopeDistance = Math.hypot(horizontalDistance, elevationDiff)
  const bearing = horizontalDistance > 1e-3 ? initialBearing(camera, subject) : 0
  const revBearing = horizontalDistance > 1e-3 ? reverseBearing(camera, subject) : 180
  const elevationAngle = apparentElevationAngle(eyeHeightEllipsoid, subject.groundHeight, horizontalDistance, radius, REFRACTION_K)
  const geometricAngle = geometricElevationAngle(eyeHeightEllipsoid, subject.groundHeight, horizontalDistance, radius)
  const sunDiscWidthM = apparentDiscSize(slopeDistance, SUN_MEAN_DIAMETER_DEG)
  const moonDiscWidthM = apparentDiscSize(slopeDistance, MOON_MEAN_DIAMETER_DEG)
  const moonDiscMinM = apparentDiscSize(slopeDistance, angularDiameterDeg(MOON_RADIUS_KM, MOON_APOGEE_KM))
  const moonDiscMaxM = apparentDiscSize(slopeDistance, angularDiameterDeg(MOON_RADIUS_KM, MOON_PERIGEE_KM))
  return {
    bearing,
    reverseBearing: revBearing,
    horizontalDistance,
    slopeDistance,
    elevationDiff,
    eyeHeightEllipsoid,
    eyeHeightMsl,
    elevationAngle,
    geometricAngle,
    sunDiscWidthM,
    moonDiscWidthM,
    moonDiscMinM,
    moonDiscMaxM
  }
}

/** Framing width/height and Sun/Moon disc coverage in a given lens at the subject distance. */
export function computeFramingCoverage(
  slopeDistanceM: number,
  lens: Pick<LensView, 'horizontal' | 'vertical'>,
  moonDiameterDeg = MOON_MEAN_DIAMETER_DEG,
  sunDiameterDeg = SUN_MEAN_DIAMETER_DEG
): FramingCoverage {
  const frameWidthM = apparentDiscSize(slopeDistanceM, lens.horizontal)
  const frameHeightM = apparentDiscSize(slopeDistanceM, lens.vertical)
  const sunDiscM = apparentDiscSize(slopeDistanceM, sunDiameterDeg)
  const moonDiscM = apparentDiscSize(slopeDistanceM, moonDiameterDeg)
  return {
    frameWidthM,
    frameHeightM,
    sunWidthPct: frameWidthM > 0 ? (sunDiscM / frameWidthM) * 100 : 0,
    sunHeightPct: frameHeightM > 0 ? (sunDiscM / frameHeightM) * 100 : 0,
    moonWidthPct: frameWidthM > 0 ? (moonDiscM / frameWidthM) * 100 : 0,
    moonHeightPct: frameHeightM > 0 ? (moonDiscM / frameHeightM) * 100 : 0
  }
}

/**
 * Ellipsoidal height of the refracted sightline ray from `eyeHeight` (at d = 0) to
 * `targetHeight` (at d = `totalDistance`), evaluated at intermediate horizontal distance `d`.
 *
 * Derived directly from `apparentElevationAngle`: equal apparent angle along the ray gives
 *   H_ray(d) = eyeHeight + (d / D) * (targetHeight - eyeHeight) - c * d * (D - d)
 * where c = (1 - k) / (2R) is the curvature-and-refraction drop coefficient.
 */
export function sightlineRayHeight(
  eyeHeight: number,
  targetHeight: number,
  totalDistance: number,
  d: number,
  radius = EARTH_RADIUS,
  refractionK = REFRACTION_K
): number {
  if (totalDistance < 1e-6) return eyeHeight
  const t = d / totalDistance
  const dropCoeff = (1 - refractionK) / (2 * radius)
  return eyeHeight + t * (targetHeight - eyeHeight) - dropCoeff * d * (totalDistance - d)
}

export interface LineOfSightOptions {
  /** Ignore samples within this many meters of either endpoint (default min(20, 2% of distance)). */
  endpointMarginM?: number
  radius?: number
  refractionK?: number
}

/**
 * Evaluates terrain/surface clearance along the refracted sightline from Camera eye to Subject.
 * Returns `clear`, `obstructed` (with the worst obstructing point), or `unknown` if no valid
 * interior elevation samples are available.
 */
export function evaluateLineOfSight(
  eyeHeight: number,
  targetHeight: number,
  totalDistance: number,
  samples: readonly LineOfSightSample[],
  opts: LineOfSightOptions = {}
): LineOfSightResult {
  if (!(totalDistance > 0) || samples.length === 0) {
    return { status: 'unknown', minClearance: null, minClearanceDistance: null, obstruction: null, sampleCount: 0 }
  }
  const margin = opts.endpointMarginM ?? Math.min(20, totalDistance * 0.02)
  const radius = opts.radius ?? EARTH_RADIUS
  const refractionK = opts.refractionK ?? REFRACTION_K

  let sampleCount = 0
  let minClearance = Number.POSITIVE_INFINITY
  let minClearanceDistance: number | null = null
  let worst: ObstructionPoint | null = null

  for (const s of samples) {
    if (s.height === null || !Number.isFinite(s.height)) continue
    if (s.distance <= margin || s.distance >= totalDistance - margin) continue
    sampleCount++
    const rayH = sightlineRayHeight(eyeHeight, targetHeight, totalDistance, s.distance, radius, refractionK)
    const clearance = rayH - s.height
    if (clearance < minClearance) {
      minClearance = clearance
      minClearanceDistance = s.distance
    }
    if (clearance < 0) {
      const intrusion = -clearance
      if (!worst || intrusion > worst.intrusion) {
        worst = {
          longitude: s.longitude,
          latitude: s.latitude,
          distance: s.distance,
          terrainHeight: s.height,
          rayHeight: rayH,
          intrusion
        }
      }
    }
  }

  if (sampleCount === 0) {
    return { status: 'unknown', minClearance: null, minClearanceDistance: null, obstruction: null, sampleCount: 0 }
  }
  return {
    status: worst ? 'obstructed' : 'clear',
    minClearance,
    minClearanceDistance,
    obstruction: worst,
    sampleCount
  }
}

// ───────────────────────────── reverse Sun & Moon alignment search ─────────────────────────────

export type AlignmentBody = 'sun' | 'moon'
export type AlignmentBodyFilter = 'both' | 'sun' | 'moon'
export type MoonSkyFilter = 'any' | 'golden-blue' | 'golden' | 'blue' | 'twilight' | 'night' | 'day'

export interface AlignmentSearchOptions {
  latitude: number
  longitude: number
  /** Observer IANA time zone (defines local date boundaries and result formatting). */
  timeZone: string
  /** Target apparent azimuth, degrees clockwise from true north (0–360). */
  targetAzimuth: number
  /** Target apparent elevation angle above horizon, degrees (-90 to +90). */
  targetAltitude: number
  /** Inclusive local start date (YYYY-MM-DD) in `timeZone`. */
  startDate: string
  /** Inclusive local end date (YYYY-MM-DD) in `timeZone`. */
  endDate: string
  /** Bodies to search. Default `'both'`. */
  bodies?: AlignmentBodyFilter
  /** Maximum |body.azimuth - targetAzimuth| in degrees. Default `1.0`. */
  azimuthTolerance?: number
  /** Maximum |body.altitude - targetAltitude| in degrees. Default `1.0`. */
  altitudeTolerance?: number
  /** Minimum Moon illuminated percentage (0–100). Default `0`. */
  minMoonIllumination?: number
  /** Sun-altitude / twilight filter for Moon alignments. Default `'any'`. */
  moonSkyFilter?: MoonSkyFilter
  /** Cap on returned matches. Default `250`. */
  maxResults?: number
}

export interface AlignmentMatch {
  id: string
  body: AlignmentBody
  /** Exact alignment instant, UTC ms. */
  utc: number
  /** Local date (YYYY-MM-DD) in `timeZone`. */
  date: string
  /** Local wall-clock minutes of day in `timeZone`. */
  minutes: number
  /** Apparent body azimuth at `utc`, degrees. */
  azimuth: number
  /** Apparent body altitude at `utc`, degrees. */
  altitude: number
  /** Signed azimuth offset (body.azimuth - targetAzimuth) in [-180, 180), degrees. */
  deltaAz: number
  /** Signed altitude offset (body.altitude - targetAltitude), degrees. */
  deltaAlt: number
  /** Great-circle angular separation between body center and target on the sky, degrees. */
  angularError: number
  /** Apparent angular diameter of the body at `utc`, degrees. */
  angularDiameterDeg: number
  /** Geometric sun altitude at `utc`, degrees. */
  sunAltitude: number
  /** Sky light band from `lib/sun.ts` at `utc`. */
  skyBand: SkyBand
  /** Moon-only metadata. */
  moonIllumination?: number
  moonPhaseName?: MoonPhaseName
  moonPhase?: number
  moonBrightLimb?: number
  moonDistanceKm?: number
}

export interface AlignmentSearchResult {
  matches: AlignmentMatch[]
  truncated: boolean
  unreachable: { sun: boolean; moon: boolean }
  daysSearched: number
}

/** Great-circle angular separation (degrees) between two sky positions. */
export function skySeparation(az1: number, alt1: number, az2: number, alt2: number): number {
  const a1 = alt1 * RAD
  const a2 = alt2 * RAD
  const dAlt = (alt2 - alt1) * RAD
  const dAz = azDelta(az2, az1) * RAD
  const h = Math.sin(dAlt / 2) ** 2 + Math.cos(a1) * Math.cos(a2) * Math.sin(dAz / 2) ** 2
  return 2 * Math.asin(Math.min(1, Math.sqrt(Math.max(0, h)))) * DEG
}

/** Whether a geometric sun altitude satisfies a photographer's Moon sky filter. */
export function matchesMoonSkyFilter(sunAltitudeDeg: number, filter: MoonSkyFilter): boolean {
  switch (filter) {
    case 'any':
      return true
    case 'golden-blue':
      return sunAltitudeDeg >= -6 && sunAltitudeDeg <= 6
    case 'golden':
      return sunAltitudeDeg >= -4 && sunAltitudeDeg <= 6
    case 'blue':
      return sunAltitudeDeg >= -6 && sunAltitudeDeg < -4
    case 'twilight':
      return sunAltitudeDeg >= -18 && sunAltitudeDeg < -0.833
    case 'night':
      return sunAltitudeDeg < -18
    case 'day':
      return sunAltitudeDeg >= -0.833
  }
}

/**
 * Celestial declination (degrees) and local hour angle (hours in [-12, 12)) corresponding to
 * a sky direction `(azimuth, altitude)` seen from `latitude`.
 */
function targetEquatorial(latitude: number, azimuth: number, altitude: number): { decDeg: number; haHours: number } {
  const phi = latitude * RAD
  const az = azimuth * RAD
  const alt = altitude * RAD
  const sinDec = Math.sin(phi) * Math.sin(alt) + Math.cos(phi) * Math.cos(alt) * Math.cos(az)
  const decDeg = Math.asin(Math.max(-1, Math.min(1, sinDec))) * DEG
  const haRad = Math.atan2(-Math.cos(alt) * Math.sin(az), Math.cos(phi) * Math.sin(alt) - Math.sin(phi) * Math.cos(alt) * Math.cos(az))
  return { decDeg, haHours: (haRad * DEG) / 15 }
}

/** Wrap hours into [-12, 12). */
const wrap12 = (hours: number): number => ((((hours + 12) % 24) + 24) % 24) - 12

/** Golden-section minimization of `fn` on `[a, b]` down to `tolMs` (default 1 s). */
function minimize(fn: (t: number) => number, a: number, b: number, tolMs = 1000): number {
  let lo = a
  let hi = b
  let c = hi - PHI_INV * (hi - lo)
  let d = lo + PHI_INV * (hi - lo)
  let fc = fn(c)
  let fd = fn(d)
  while (hi - lo > tolMs) {
    if (fc < fd) {
      hi = d
      d = c
      fd = fc
      c = hi - PHI_INV * (hi - lo)
      fc = fn(c)
    } else {
      lo = c
      c = d
      fc = fd
      d = lo + PHI_INV * (hi - lo)
      fd = fn(d)
    }
  }
  return Math.round((lo + hi) / 2)
}

/**
 * Finds all local minima of `errorAt` on `[scanStart, scanEnd]` sampled at `stepMs`, and
 * refines each to 1-second precision.
 */
function findMinimaInWindow(
  scanStart: number,
  scanEnd: number,
  stepMs: number,
  errorAt: (t: number) => number,
  looseThreshold: number
): number[] {
  const count = Math.max(2, Math.ceil((scanEnd - scanStart) / stepMs))
  const times: number[] = []
  const values: number[] = []
  for (let i = 0; i <= count; i++) {
    const t = i === count ? scanEnd : scanStart + i * stepMs
    times.push(t)
    values.push(errorAt(t))
  }
  const minima: number[] = []
  for (let i = 0; i <= count; i++) {
    const v = values[i]
    if (v > looseThreshold) continue
    const leftOk = i === 0 || v <= values[i - 1]
    const rightOk = i === count || v <= values[i + 1]
    if (!leftOk || !rightOk) continue
    // Avoid refining both endpoints of a flat plateau.
    if (i > 0 && v === values[i - 1]) continue
    const lo = i > 0 ? times[i - 1] : times[0]
    const hi = i < count ? times[i + 1] : times[count]
    minima.push(minimize(errorAt, lo, hi, 1000))
  }
  return minima
}

/**
 * Searches `[startDate, endDate]` (inclusive, in `timeZone`) for instants when the Sun and/or
 * Moon align with `(targetAzimuth, targetAltitude)` from `(latitude, longitude)` within the
 * configured angular tolerances and optional Moon illumination / sky filters.
 */
export function findAlignments(opts: AlignmentSearchOptions): AlignmentSearchResult {
  const latitude = Math.max(-89.99, Math.min(89.99, opts.latitude))
  const longitude = opts.longitude
  const timeZone = opts.timeZone || 'UTC'
  const targetAz = wrap360(opts.targetAzimuth)
  const targetAlt = Math.max(-89.9, Math.min(89.9, opts.targetAltitude))
  const bodies = opts.bodies ?? 'both'
  const azTol = Math.max(0.05, Math.min(30, opts.azimuthTolerance ?? 1.0))
  const altTol = Math.max(0.05, Math.min(30, opts.altitudeTolerance ?? 1.0))
  const minMoonIllum = Math.max(0, Math.min(100, opts.minMoonIllumination ?? 0)) / 100
  const moonSkyFilter = opts.moonSkyFilter ?? 'any'
  const maxResults = Math.max(1, opts.maxResults ?? 250)

  const startUtc = zonedToUtc(opts.startDate, 0, timeZone)
  const endUtc = zonedToUtc(addDays(opts.endDate, 1), 0, timeZone)
  if (!(endUtc > startUtc)) {
    return { matches: [], truncated: false, unreachable: { sun: false, moon: false }, daysSearched: 0 }
  }

  const daysSearched = Math.max(1, Math.round((endUtc - startUtc) / DAY_MS))
  const { decDeg: targetDec, haHours: targetHa } = targetEquatorial(latitude, targetAz, targetAlt)
  const tolSpan = azTol + altTol
  const sunUnreachable = Math.abs(targetDec) > 23.5 + tolSpan + 1.2
  const moonUnreachable = Math.abs(targetDec) > 29.0 + tolSpan + 2.2
  const fullDayScan = Math.abs(latitude) > 66 || Math.abs(targetAlt) > 75 || azTol > 5 || altTol > 5
  const observer = new Observer(latitude, longitude, 0)

  // Scaled error metric: (dAz / azTol)^2 + (dAlt / altTol)^2. Inside the tolerance box,
  // error <= 2. We use a generous loose threshold on the 15-min coarse grid so rapid transit
  // across a narrow tolerance box is never skipped.
  const scaledError = (pos: { azimuth: number; altitude: number }) => {
    const dAz = azDelta(pos.azimuth, targetAz) / azTol
    const dAlt = (pos.altitude - targetAlt) / altTol
    return dAz * dAz + dAlt * dAlt
  }
  const looseStepDeg = 4.5 // body moves at most ~4° in 15 minutes
  const looseLimit = (1 + looseStepDeg / Math.min(azTol, altTol)) ** 2 * 2.5

  const rawSun: Array<{ utc: number; err: number }> = []
  const rawMoon: Array<{ utc: number; err: number }> = []

  // Step in 24 h UTC windows with 1-day padding on each side so crossings near local midnight
  // on startDate or endDate are never missed, then clip strictly to [startUtc, endUtc).
  const firstMid = startUtc - 12 * HOUR_MS
  const lastMid = endUtc + 12 * HOUR_MS

  if ((bodies === 'both' || bodies === 'sun') && !sunUnreachable) {
    const sunDecLimit = 1.6 + tolSpan
    const sunErr = (t: number) => scaledError(sunPosition(t, latitude, longitude))
    for (let tMid = firstMid; tMid <= lastMid; tMid += DAY_MS) {
      const dateObj = new Date(tMid)
      const eq = Equator(Body.Sun, dateObj, observer, true, true)
      if (Math.abs(eq.dec - targetDec) > sunDecLimit) continue
      let scanStart: number
      let scanEnd: number
      if (fullDayScan) {
        scanStart = tMid - 12 * HOUR_MS
        scanEnd = tMid + 12 * HOUR_MS
      } else {
        const haMid = SiderealTime(dateObj) + longitude / 15 - eq.ra
        const tEst = tMid + wrap12(targetHa - haMid) * HOUR_MS
        scanStart = tEst - 150 * MIN_MS
        scanEnd = tEst + 150 * MIN_MS
      }
      for (const t of findMinimaInWindow(scanStart, scanEnd, 15 * MIN_MS, sunErr, looseLimit)) {
        if (t < startUtc || t >= endUtc) continue
        rawSun.push({ utc: t, err: sunErr(t) })
      }
    }
  }

  if ((bodies === 'both' || bodies === 'moon') && !moonUnreachable) {
    const moonDecLimit = 4.5 + tolSpan
    const moonErr = (t: number) => scaledError(moonPosition(t, latitude, longitude))
    for (let tMid = firstMid; tMid <= lastMid; tMid += DAY_MS) {
      const dateObj = new Date(tMid)
      const eq = Equator(Body.Moon, dateObj, observer, true, true)
      if (Math.abs(eq.dec - targetDec) > moonDecLimit) continue
      let scanStart: number
      let scanEnd: number
      if (fullDayScan) {
        scanStart = tMid - 12 * HOUR_MS
        scanEnd = tMid + 12 * HOUR_MS
      } else {
        const haMid = SiderealTime(dateObj) + longitude / 15 - eq.ra
        const tEst = tMid + (wrap12(targetHa - haMid) / LUNAR_HA_RATE) * HOUR_MS
        scanStart = tEst - 150 * MIN_MS
        scanEnd = tEst + 150 * MIN_MS
      }
      for (const t of findMinimaInWindow(scanStart, scanEnd, 15 * MIN_MS, moonErr, looseLimit)) {
        if (t < startUtc || t >= endUtc) continue
        rawMoon.push({ utc: t, err: moonErr(t) })
      }
    }
  }

  // Deduplicate overlapping window detections within 6 hours for the same body, keeping the tighter instant.
  const dedupe = (list: Array<{ utc: number; err: number }>): number[] => {
    list.sort((a, b) => a.utc - b.utc)
    const kept: Array<{ utc: number; err: number }> = []
    for (const item of list) {
      const prev = kept[kept.length - 1]
      if (prev && item.utc - prev.utc < 6 * HOUR_MS) {
        if (item.err < prev.err) kept[kept.length - 1] = item
      } else {
        kept.push(item)
      }
    }
    return kept.map((k) => k.utc)
  }

  const matches: AlignmentMatch[] = []

  for (const utc of dedupe(rawSun)) {
    const pos = sunPosition(utc, latitude, longitude)
    const dAz = azDelta(pos.azimuth, targetAz)
    const dAlt = pos.altitude - targetAlt
    if (Math.abs(dAz) > azTol || Math.abs(dAlt) > altTol) continue
    const zoned = utcToZoned(utc, timeZone)
    const sunAltGeom = geometricAltitude(utc, latitude, longitude)
    matches.push({
      id: `sun-${utc}`,
      body: 'sun',
      utc,
      date: zoned.date,
      minutes: zoned.minutes,
      azimuth: pos.azimuth,
      altitude: pos.altitude,
      deltaAz: dAz,
      deltaAlt: dAlt,
      angularError: skySeparation(pos.azimuth, pos.altitude, targetAz, targetAlt),
      angularDiameterDeg: SUN_MEAN_DIAMETER_DEG,
      sunAltitude: sunAltGeom,
      skyBand: skyBand(sunAltGeom)
    })
  }

  for (const utc of dedupe(rawMoon)) {
    const state = moonState(utc, latitude, longitude)
    const dAz = azDelta(state.azimuth, targetAz)
    const dAlt = state.altitude - targetAlt
    if (Math.abs(dAz) > azTol || Math.abs(dAlt) > altTol) continue
    if (state.illumination + 1e-6 < minMoonIllum) continue
    const sunAltGeom = geometricAltitude(utc, latitude, longitude)
    if (!matchesMoonSkyFilter(sunAltGeom, moonSkyFilter)) continue
    const zoned = utcToZoned(utc, timeZone)
    matches.push({
      id: `moon-${utc}`,
      body: 'moon',
      utc,
      date: zoned.date,
      minutes: zoned.minutes,
      azimuth: state.azimuth,
      altitude: state.altitude,
      deltaAz: dAz,
      deltaAlt: dAlt,
      angularError: skySeparation(state.azimuth, state.altitude, targetAz, targetAlt),
      angularDiameterDeg: angularDiameterDeg(MOON_RADIUS_KM, state.distanceKm),
      sunAltitude: sunAltGeom,
      skyBand: skyBand(sunAltGeom),
      moonIllumination: state.illumination,
      moonPhaseName: state.phaseName,
      moonPhase: state.phase,
      moonBrightLimb: state.brightLimb,
      moonDistanceKm: state.distanceKm
    })
  }

  matches.sort((a, b) => a.utc - b.utc)
  const truncated = matches.length > maxResults
  return {
    matches: truncated ? matches.slice(0, maxResults) : matches,
    truncated,
    unreachable: { sun: sunUnreachable, moon: moonUnreachable },
    daysSearched
  }
}
