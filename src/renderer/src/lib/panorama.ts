// Horizon panorama (pure, no Cesium): the terrain skyline around an observer, traced on the
// nested height grids of lib/terrainShadow.ts, and where the sun and moon cross it.
//
// The grids are centered on the observer, in the local tangent-plane frame (x east, y north,
// meters). Seen from eye height e, ground of ellipsoidal height H at horizontal distance d
// appears at the apparent altitude
//   atan((H − e) / d − (1 − k)·d / 2R)
// where the last term is the earth's curvature, reduced by terrestrial refraction k (which
// bends grazing rays down, so distant ridges look a little higher). The skyline at an azimuth
// is the highest such angle along the ray. Body altitudes from SunCalc are apparent
// (refraction-corrected) too, so the two compare directly.

import { EARTH_RADIUS, heightAt, REFRACTION_K, type ShadowLevel } from './terrainShadow'

/** Azimuth resolution of the skyline, degrees. */
export const HORIZON_STEP = 0.25
export const HORIZON_SAMPLES = Math.round(360 / HORIZON_STEP)

/**
 * Nested square grids around the observer, fine to coarse: half-width (m) and cells per
 * side. Cell sizes: 12.5 m, 50 m, 200 m, 800 m, 2.5 km; the outermost reaches ~300 km.
 */
export const HORIZON_LEVELS: ReadonlyArray<{ half: number; n: number }> = [
  { half: 2000, n: 320 },
  { half: 8000, n: 320 },
  { half: 32000, n: 320 },
  { half: 128000, n: 320 },
  { half: 300000, n: 240 }
]

/** Eye height above the clicked surface, meters. */
export const EYE_HEIGHT = 1.7
/**
 * Ground nearer than this is ignored: at heightmap resolution the slope you stand on is
 * mostly interpolation noise, and a few meters of it would otherwise hide half the sky.
 */
export const NEAR_LIMIT = 40
/** Angular radii, degrees. Rise and set are when the upper limb meets the skyline. */
export const SUN_RADIUS = 0.2666
export const MOON_RADIUS = 0.259

const DEG = 180 / Math.PI

export interface Horizon {
  /** Degrees between samples; sample i is at azimuth i · step (clockwise from north). */
  step: number
  /** Apparent altitude of the skyline, degrees. */
  altitude: Float32Array
  /** Horizontal distance to the skyline point, meters. */
  distance: Float32Array
  /** Ellipsoidal height of the skyline point, meters. */
  height: Float32Array
  /** Ellipsoidal eye height of the observer. */
  eye: number
  /** How far the terrain data reaches, meters. */
  reach: number
}

export const wrap360 = (az: number): number => ((az % 360) + 360) % 360
/** Signed difference a − b folded into [−180, 180). */
export const azDelta = (a: number, b: number): number => ((((a - b + 180) % 360) + 360) % 360) - 180

export function createHorizon(eye: number, samples = HORIZON_SAMPLES): Horizon {
  return {
    step: 360 / samples,
    altitude: new Float32Array(samples).fill(Number.NaN),
    distance: new Float32Array(samples),
    height: new Float32Array(samples),
    eye,
    reach: 0
  }
}

export interface TraceOptions {
  radius?: number
  near?: number
}

/** Curvature-and-refraction coefficient: apparent drop of the ground is c · d². */
const dropCoefficient = (radius: number) => (1 - REFRACTION_K) / (2 * radius)

/**
 * Traces skyline samples [from, to) of `h` on `levels` (fine → coarse, nulls skipped). Past
 * the edge of the data the ground is assumed to continue at the coarsest grid's lowest
 * height, so a high observer still sees the earth's curve as the horizon.
 */
export function traceHorizon(h: Horizon, levels: readonly (ShadowLevel | null)[], from = 0, to = h.altitude.length, opts: TraceOptions = {}): void {
  const c = dropCoefficient(opts.radius ?? EARTH_RADIUS)
  const near = opts.near ?? NEAR_LIMIT
  const present = levels.filter((l): l is ShadowLevel => l !== null)
  if (present.length === 0) return
  const coarsest = present[present.length - 1]
  const maxHeight = Math.max(...present.map((l) => l.maxHeight))
  const farHeight = coarsest.minHeight
  const eye = h.eye
  // Ground below eye level can still rise into view beyond this distance (it drops away
  // with the earth's curve only past it), so the march may not stop early before it.
  const dStar = maxHeight < eye ? Math.sqrt((eye - maxHeight) / c) : 0
  let reach = h.reach
  for (let i = from; i < to; i++) {
    const az = (i * h.step) / DEG
    const ux = Math.sin(az)
    const uy = Math.cos(az)
    let best = Number.NEGATIVE_INFINITY
    let bestD = 0
    let bestH = Number.NaN
    let dLast = 0
    let d = near
    for (;;) {
      const s = heightAt(present, ux * d, uy * d)
      if (!s) break
      const t = (s.height - eye) / d - d * c
      if (t > best) {
        best = t
        bestD = d
        bestH = s.height
      }
      dLast = d
      // Nothing farther along can rise above the skyline found so far.
      if (d > dStar && (maxHeight - eye) / d - d * c < best) break
      d += Math.max(s.cell * 0.6, d * 0.001)
    }
    if (dLast > 0) {
      reach = Math.max(reach, dLast)
      const dc = Math.max(Math.sqrt(Math.max(0, eye - farHeight) / c), dLast)
      const t = (farHeight - eye) / dc - dc * c
      if (t > best) {
        best = t
        bestD = dc
        bestH = farHeight
      }
    }
    h.altitude[i] = Number.isFinite(best) ? Math.atan(best) * DEG : Number.NaN
    h.distance[i] = bestD
    h.height[i] = bestH
  }
  h.reach = reach
}

/** Apparent altitude (degrees) of ground at plane offset (x, y) and ellipsoidal height. */
export function apparentAltitude(eye: number, x: number, y: number, height: number, radius = EARTH_RADIUS): number {
  const d = Math.hypot(x, y)
  if (d < 1e-6) return height >= eye ? 90 : -90
  return Math.atan((height - eye) / d - d * dropCoefficient(radius)) * DEG
}

/** Sample index nearest an azimuth. */
export function sampleIndex(h: Horizon, azimuth: number): number {
  return Math.round(wrap360(azimuth) / h.step) % h.altitude.length
}

/** Skyline altitude at an azimuth, linearly interpolated between samples. */
export function horizonAt(h: Horizon, azimuth: number): number {
  const n = h.altitude.length
  const f = wrap360(azimuth) / h.step
  const i = Math.floor(f) % n
  const t = f - Math.floor(f)
  return h.altitude[i] * (1 - t) + h.altitude[(i + 1) % n] * t
}

/** Highest skyline sample within ±halfWidth degrees of an azimuth. */
export function horizonMax(h: Horizon, azimuth: number, halfWidth: number): { altitude: number; index: number } {
  const n = h.altitude.length
  const span = Math.max(0, Math.round(halfWidth / h.step))
  const center = sampleIndex(h, azimuth)
  let best = Number.NEGATIVE_INFINITY
  let index = center
  for (let k = -span; k <= span; k++) {
    const j = (((center + k) % n) + n) % n
    if (h.altitude[j] > best) {
      best = h.altitude[j]
      index = j
    }
  }
  return { altitude: best, index }
}

/** Lowest and highest skyline altitude over an azimuth window (whole circle by default). */
export function horizonRange(h: Horizon, center = 0, span = 360): { min: number; max: number } {
  const n = h.altitude.length
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  const count = span >= 360 ? n : Math.ceil(span / h.step) + 1
  const start = span >= 360 ? 0 : sampleIndex(h, center - span / 2)
  for (let k = 0; k < count; k++) {
    const v = h.altitude[(start + k) % n]
    if (!Number.isFinite(v)) continue
    if (v < min) min = v
    if (v > max) max = v
  }
  return { min, max }
}

export interface SkylineSummit {
  index: number
  azimuth: number
  altitude: number
  distance: number
  /** Ellipsoidal height of the summit. */
  height: number
  /** Angular prominence on the skyline, degrees. */
  prominence: number
}

/**
 * Summits of the skyline: local maxima with at least `minProminence` degrees of angular
 * prominence (how far the skyline dips before rising higher, on the lower of the two
 * sides), most prominent first.
 */
export function skylineSummits(h: Horizon, minProminence = 0.3): SkylineSummit[] {
  const a = h.altitude
  const n = a.length
  let globalMin = Number.POSITIVE_INFINITY
  for (let i = 0; i < n; i++) if (a[i] < globalMin) globalMin = a[i]
  const out: SkylineSummit[] = []
  for (let i = 0; i < n; i++) {
    const v = a[i]
    if (!Number.isFinite(v)) continue
    // Plateaus count once, at their first sample.
    if (!(v > a[(i - 1 + n) % n] && v >= a[(i + 1) % n])) continue
    const walk = (dir: 1 | -1): { min: number; higher: boolean } => {
      let min = v
      for (let k = 1; k < n; k++) {
        const w = a[(((i + dir * k) % n) + n) % n]
        if (w > v) return { min, higher: true }
        if (w < min) min = w
      }
      return { min, higher: false }
    }
    const left = walk(-1)
    const right = walk(1)
    let col: number
    if (left.higher && right.higher) col = Math.max(left.min, right.min)
    else if (left.higher) col = left.min
    else if (right.higher) col = right.min
    else col = globalMin
    const prominence = v - col
    if (prominence < minProminence) continue
    out.push({ index: i, azimuth: i * h.step, altitude: v, distance: h.distance[i], height: h.height[i], prominence })
  }
  return out.sort((x, y) => y.prominence - x.prominence)
}

// ───────────────────────────── named peaks ─────────────────────────────

/** How far (m) a named peak must rise above the ground a few hundred meters around it. */
const MIN_RELIEF = 10

export interface PeakCandidate {
  id: string
  name: string
  /** Plane offset from the observer, meters. */
  x: number
  y: number
}

export interface SkylinePeak {
  id: string
  name: string
  azimuth: number
  /** Apparent altitude of the summit. */
  altitude: number
  distance: number
  /** Ellipsoidal height of the summit (highest ground near the named point). */
  height: number
  /** Plane offset of the summit from the observer. */
  x: number
  y: number
}

/**
 * Named peaks that stand on the skyline (not hidden behind nearer ground). A place's pin is
 * often off the summit itself, so the highest ground within a few hundred meters stands in
 * for it.
 */
export function peaksOnSkyline(
  h: Horizon,
  levels: readonly (ShadowLevel | null)[],
  candidates: readonly PeakCandidate[],
  opts: { radius?: number } = {}
): SkylinePeak[] {
  const present = levels.filter((l): l is ShadowLevel => l !== null)
  const out: SkylinePeak[] = []
  for (const cand of candidates) {
    const d0 = Math.hypot(cand.x, cand.y)
    if (d0 < 300 || d0 > h.reach) continue
    const at = heightAt(present, cand.x, cand.y)
    if (!at) continue
    const search = Math.min(400, Math.max(100, at.cell * 2))
    let top = { x: cand.x, y: cand.y, height: at.height }
    const STEPS = 4
    for (let j = -STEPS; j <= STEPS; j++) {
      for (let i = -STEPS; i <= STEPS; i++) {
        const x = cand.x + (i / STEPS) * search
        const y = cand.y + (j / STEPS) * search
        const s = heightAt(present, x, y)
        if (s && s.height > top.height) top = { x, y, height: s.height }
      }
    }
    // A summit stands out of its surroundings; flat ground at the sea-level horizon doesn't.
    const ring = Math.max(600, 3 * at.cell)
    let low = Number.POSITIVE_INFINITY
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * 2 * Math.PI
      const s = heightAt(present, top.x + Math.sin(a) * ring, top.y + Math.cos(a) * ring)
      if (s) low = Math.min(low, s.height)
    }
    if (!(top.height - low >= MIN_RELIEF)) continue
    const d = Math.hypot(top.x, top.y)
    const azimuth = wrap360(Math.atan2(top.x, top.y) * DEG)
    const altitude = apparentAltitude(h.eye, top.x, top.y, top.height, opts.radius)
    const window = Math.max(h.step, Math.atan(search / d) * DEG)
    const skyline = horizonMax(h, azimuth, window).altitude
    // Visible when it reaches (within the grids' precision) the skyline in its direction.
    const tolerance = Math.max(0.08, Math.atan(25 / d) * DEG)
    if (!(altitude >= skyline - tolerance)) continue
    out.push({ id: cand.id, name: cand.name, azimuth, altitude, distance: d, height: top.height, x: top.x, y: top.y })
  }
  // The same summit under two pins (or two names a few hundred meters apart): keep the higher.
  out.sort((a, b) => b.height - a.height)
  const kept: SkylinePeak[] = []
  for (const p of out) {
    const dup = kept.find((k) => k.name === p.name || (Math.abs(azDelta(k.azimuth, p.azimuth)) < 0.3 && Math.hypot(k.x - p.x, k.y - p.y) < 500))
    if (!dup) kept.push(p)
  }
  return kept
}

// ───────────────────────────── sun & moon ─────────────────────────────

export interface SkyPosition {
  azimuth: number
  altitude: number
}

export type PositionAt = (utcMs: number) => SkyPosition

export interface PathPoint extends SkyPosition {
  utc: number
}

/** Positions from `start` to `end` (inclusive) every `stepMs`. */
export function bodyPath(position: PositionAt, start: number, end: number, stepMs: number): PathPoint[] {
  const out: PathPoint[] = []
  const count = Math.max(1, Math.ceil((end - start) / stepMs))
  for (let k = 0; k <= count; k++) {
    const utc = Math.min(end, start + k * stepMs)
    out.push({ utc, ...position(utc) })
  }
  return out
}

/** Whether a body's upper limb is above the skyline. */
export function aboveSkyline(h: Horizon, p: SkyPosition, radius: number): boolean {
  const skyline = horizonAt(h, p.azimuth)
  return p.altitude + radius > (Number.isFinite(skyline) ? skyline : -0.833 - radius)
}

export interface SkylineEvent extends PathPoint {
  /** 'rise': the upper limb clears the skyline; 'set': it disappears behind it. */
  kind: 'rise' | 'set'
}

export interface SkylineDay {
  events: SkylineEvent[]
  /** Time with the body (its upper limb) above the skyline during [start, end]. */
  visibleMs: number
  /** Whether it is above the skyline at `start`. */
  visibleAtStart: boolean
}

/**
 * When a body appears over and disappears behind the terrain between `start` and `end`.
 * Sampled every `stepMs`, each crossing refined by bisection to about a second.
 */
export function skylineCrossings(h: Horizon, position: PositionAt, start: number, end: number, radius: number, stepMs = 60000): SkylineDay {
  const visible = (t: number) => aboveSkyline(h, position(t), radius)
  const events: SkylineEvent[] = []
  let visibleMs = 0
  let prevT = start
  let prevV = visible(start)
  const visibleAtStart = prevV
  const count = Math.max(1, Math.ceil((end - start) / stepMs))
  for (let k = 1; k <= count; k++) {
    const t = Math.min(end, start + k * stepMs)
    const v = visible(t)
    if (v !== prevV) {
      let lo = prevT
      let hi = t
      while (hi - lo > 1000) {
        const mid = (lo + hi) / 2
        if (visible(mid) === prevV) lo = mid
        else hi = mid
      }
      const at = Math.round((lo + hi) / 2)
      events.push({ utc: at, ...position(at), kind: v ? 'rise' : 'set' })
      if (prevV) visibleMs += at - prevT
      else visibleMs += t - at
    } else if (v) {
      visibleMs += t - prevT
    }
    prevT = t
    prevV = v
  }
  return { events, visibleMs, visibleAtStart }
}

/**
 * Splits a path into runs drawn alike: above or behind the skyline, and never across the
 * chart's azimuth seam (where `x` jumps by more than `maxJump`).
 */
export function pathRuns<T extends PathPoint>(
  points: readonly T[],
  isVisible: (p: T) => boolean,
  x: (p: T) => number,
  maxJump: number
): Array<{ visible: boolean; points: T[] }> {
  const runs: Array<{ visible: boolean; points: T[] }> = []
  let current: { visible: boolean; points: T[] } | null = null
  let lastX = Number.NaN
  for (const p of points) {
    const v = isVisible(p)
    const px = x(p)
    const jump = Math.abs(px - lastX) > maxJump
    if (!current || jump) {
      current = { visible: v, points: [p] }
      runs.push(current)
    } else if (v !== current.visible) {
      // Share the boundary point so the solid and dashed parts join.
      current.points.push(p)
      current = { visible: v, points: [p] }
      runs.push(current)
    } else {
      current.points.push(p)
    }
    lastX = px
  }
  return runs
}
