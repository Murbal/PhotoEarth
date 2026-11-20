// Elevation profile geometry and statistics (pure, no Cesium).

export interface GeoPoint {
  longitude: number
  latitude: number
}

export interface PathSample extends GeoPoint {
  /** Distance from the start along the path, meters. */
  distance: number
}

export interface ProfileSample extends PathSample {
  /** Elevation above sea level, meters (null where the source had no data). */
  elevation: number | null
}

export interface ProfileStats {
  distance: number
  min: number
  max: number
  minIndex: number
  maxIndex: number
  ascent: number
  descent: number
}

const R = 6371008.8
const rad = (d: number) => (d * Math.PI) / 180
const deg = (r: number) => (r * 180) / Math.PI

export function haversine(a: GeoPoint, b: GeoPoint): number {
  const dLat = rad(b.latitude - a.latitude)
  const dLon = rad(b.longitude - a.longitude)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Point at fraction `t` along the great circle from `a` to `b`. */
export function interpolate(a: GeoPoint, b: GeoPoint, t: number): GeoPoint {
  const φ1 = rad(a.latitude)
  const λ1 = rad(a.longitude)
  const φ2 = rad(b.latitude)
  const λ2 = rad(b.longitude)
  const δ = haversine(a, b) / R
  if (δ < 1e-12) return { ...a }
  const A = Math.sin((1 - t) * δ) / Math.sin(δ)
  const B = Math.sin(t * δ) / Math.sin(δ)
  const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2)
  const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2)
  const z = A * Math.sin(φ1) + B * Math.sin(φ2)
  return { latitude: deg(Math.atan2(z, Math.hypot(x, y))), longitude: deg(Math.atan2(y, x)) }
}

export function pathLength(points: GeoPoint[]): number {
  let total = 0
  for (let i = 1; i < points.length; i++) total += haversine(points[i - 1], points[i])
  return total
}

/** Evenly spaced samples along a polyline, always including every vertex. */
export function densifyPath(points: GeoPoint[], targetSamples = 400): PathSample[] {
  if (points.length === 0) return []
  if (points.length === 1) return [{ ...points[0], distance: 0 }]
  const total = pathLength(points)
  const spacing = total / Math.max(1, targetSamples - 1)
  const out: PathSample[] = [{ ...points[0], distance: 0 }]
  let travelled = 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const d = haversine(a, b)
    const n = Math.max(1, Math.ceil(d / (spacing || 1)))
    for (let k = 1; k <= n; k++) {
      const t = k / n
      out.push({ ...(k === n ? b : interpolate(a, b, t)), distance: travelled + d * t })
    }
    travelled += d
  }
  return out
}

/**
 * Min/max and cumulative ascent/descent. `threshold` (meters) ignores
 * oscillations smaller than that, which keeps DEM noise from inflating totals.
 */
export function profileStats(samples: ProfileSample[], threshold = 0): ProfileStats | null {
  const valid = samples.map((s, i) => ({ s, i })).filter((x) => x.s.elevation !== null)
  if (valid.length === 0) return null
  let min = Infinity
  let max = -Infinity
  let minIndex = 0
  let maxIndex = 0
  for (const { s, i } of valid) {
    const e = s.elevation as number
    if (e < min) {
      min = e
      minIndex = i
    }
    if (e > max) {
      max = e
      maxIndex = i
    }
  }
  let ascent = 0
  let descent = 0
  let ref = valid[0].s.elevation as number
  for (const { s } of valid.slice(1)) {
    const diff = (s.elevation as number) - ref
    if (Math.abs(diff) >= threshold) {
      if (diff > 0) ascent += diff
      else descent -= diff
      ref = s.elevation as number
    }
  }
  return {
    distance: samples[samples.length - 1]?.distance ?? 0,
    min,
    max,
    minIndex,
    maxIndex,
    ascent,
    descent
  }
}

/** Index of the sample closest (by distance along the path) to `distance`. */
export function nearestSampleIndex(samples: PathSample[], distance: number): number {
  let lo = 0
  let hi = samples.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (samples[mid].distance < distance) lo = mid
    else hi = mid
  }
  return Math.abs(samples[lo].distance - distance) <= Math.abs(samples[hi].distance - distance) ? lo : hi
}
