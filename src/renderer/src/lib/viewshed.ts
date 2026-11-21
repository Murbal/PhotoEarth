// Viewshed analysis overlay (pure, no Cesium): line-of-sight visibility from a selected target
// point across nested local tangent-plane height grids (lib/terrainShadow.ts). Keep the ray
// marching and receiver math in lockstep with engine/viewshed/shaders.ts.
//
// In the local tangent-plane frame centered on the target O = (0, 0) at ellipsoidal height zT,
// an intermediate terrain sample Q at distance s has apparent slope from O:
//   slope(s) = (H(Q) - zT) / s - c * s,   where c = (1 - k) / (2 * R)
// accounting for Earth curvature (Gaussian radius R) and terrestrial refraction (k = 0.13).
// For a surrounding point P at horizontal distance D from O, the minimum ellipsoidal height at P
// that clears every intermediate terrain sample along O -> P is:
//   zMin(P) = zT + D * maxSlope(O -> P) + c * D^2
// A viewer at P with ellipsoidal height H(P) + viewerOffset sees the target iff
//   H(P) + viewerOffset >= zMin(P)
// This relation is symmetric between target and viewer: bulge(s, D) = c * s * (D - s).

import type { Units } from '@shared/types'
import {
  DIST_STEP,
  EARTH_RADIUS,
  heightAt,
  levelCell,
  MAX_RESOLUTION,
  REFRACTION_K,
  smoothstep,
  TOP_STEP,
  type ShadowLevel
} from './terrainShadow'

/** Three nested square grids centered on the viewshed target (fine -> coarse). */
export const VIEWSHED_LEVEL_COUNT = 3
/**
 * Half-width of each nested level as a fraction of the analysis radius. The outermost level
 * extends 12 % past the radius so bilinear lookups and level-edge fades never clip the circle
 * even at the Low quality resolution (256 cells).
 */
export const VIEWSHED_LEVEL_RATIOS = [0.18, 0.48, 1.12] as const
/** Ray-march step parameters, kept in lockstep with engine/viewshed/shaders.ts. */
export const VIEWSHED_STEP_CELL = 0.75
export const VIEWSHED_STEP_GROWTH = 0.004
export const VIEWSHED_MAX_STEPS = 768
/** Clamp zMin above the highest terrain so 16-bit precision stays tight around real heights. */
export const VIEWSHED_HEIGHT_CAP = 1000
/** Minimum distance from the target before occlusion starts (avoids target-cell noise). */
export const VIEWSHED_MIN_NEAR = 15
/** Receiver tolerances (kept tight so Earth curvature and subtle ridgelines stay accurate). */
export const VIEWSHED_RECEIVER_BIAS = 0.5
export const VIEWSHED_RECEIVER_BIAS_PER_CELL = 0.005
export const VIEWSHED_SOFT_MIN = 0.5
export const VIEWSHED_SOFT_PER_CELL = 0.008
/** Cross-fade width between nested viewshed levels, in texels. */
export const VIEWSHED_BLEND_TEXELS = 8

/** Analysis radius presets, meters. */
export const VIEWSHED_RADII = [5000, 15000, 30000, 50000] as const
/** Quick target height-offset presets above ground, meters (ground, eye, tower, tall, drone). */
export const VIEWSHED_TARGET_PRESETS = [0, 1.7, 15, 50, 120] as const
/** Quick viewer height-offset presets above surrounding ground, meters. */
export const VIEWSHED_VIEWER_PRESETS = [0, 1.7, 10, 50] as const

const DEG = 180 / Math.PI
const METERS_PER_MILE = 1609.344

export interface ViewshedTop {
  /** Minimum ellipsoidal height (meters) at the cell with unobstructed line of sight to target. */
  zMin: number
  /** Horizontal distance from the cell back to the controlling occluder, meters (0 if none). */
  occluderDistance: number
}

export interface ViewshedStats {
  /** Visible terrain area within the analysis circle, m^2. */
  visibleAreaM2: number
  /** Total analyzed circular area, m^2. */
  totalAreaM2: number
  /** Fraction of the analysis circle visible (0..1). */
  visibleFraction: number
}

export interface ViewshedPointCheck {
  /** True when the inspected point (with viewerOffset) has unobstructed line of sight to target. */
  visible: boolean
  /** Horizontal distance from the point to the target, meters. */
  distance: number
  /** Compass bearing from the point toward the target, degrees [0, 360). */
  bearingToTarget: number
  /** Apparent elevation angle from the point's viewer eye toward the target, degrees. */
  pitchToTarget: number
  /** Vertical clearance above (positive) or below (negative) the line of sight, meters. */
  clearanceM: number
  /** True when the point lies outside the analysis radius. */
  outsideRadius: boolean
}

/** Curvature-and-refraction drop coefficient: apparent drop is c * d^2. */
export const curvatureDrop = (radius = EARTH_RADIUS): number => (1 - REFRACTION_K) / (2 * radius)

/** Half-widths (meters) of the three nested grids for an analysis radius. */
export function viewshedLevelHalves(radius: number): [number, number, number] {
  return [
    Math.round(radius * VIEWSHED_LEVEL_RATIOS[0]),
    Math.round(radius * VIEWSHED_LEVEL_RATIOS[1]),
    Math.round(radius * VIEWSHED_LEVEL_RATIOS[2])
  ]
}

/** Cells per side for each viewshed level at a quality resolution. */
export function viewshedLevelResolutions(resolution: number): [number, number, number] {
  const n = Math.max(64, Math.min(MAX_RESOLUTION, Math.round(resolution)))
  return [n, n, n]
}

/** Distance from the target below which intermediate samples are skipped. */
export function viewshedNearLimit(levels: readonly (ShadowLevel | null)[]): number {
  for (const l of levels) {
    if (l) return Math.max(VIEWSHED_MIN_NEAR, levelCell(l))
  }
  return VIEWSHED_MIN_NEAR
}

/** Concentric distance ring spacing (meters) suited to the analysis radius and unit system. */
export function viewshedRingInterval(radius: number, units: Units): number {
  if (units === 'imperial') {
    const miles = radius / METERS_PER_MILE
    if (miles <= 4) return METERS_PER_MILE
    if (miles <= 12) return 2 * METERS_PER_MILE
    if (miles <= 25) return 5 * METERS_PER_MILE
    return 10 * METERS_PER_MILE
  }
  if (radius <= 6000) return 1000
  if (radius <= 20000) return 5000
  return 10000
}

/**
 * Marches from the target at (0, 0) toward cell (px, py) through the nested height levels and
 * returns the minimum visible ellipsoidal height `zMin` at (px, py), plus the distance from
 * (px, py) to the controlling occluder. Exact CPU mirror of `VIEWSHED_COMPUTE_FS`.
 */
export function viewshedTop(
  levels: readonly (ShadowLevel | null)[],
  px: number,
  py: number,
  targetHeight: number,
  targetCell: number,
  opts: { radius?: number; maxRadius: number; maxHeight: number; nearLimit?: number }
): ViewshedTop {
  const dist = Math.hypot(px, py)
  const nearLimit = opts.nearLimit ?? viewshedNearLimit(levels)
  if (!(dist > nearLimit && dist <= opts.maxRadius + 2 * targetCell)) {
    return { zMin: Number.NEGATIVE_INFINITY, occluderDistance: 0 }
  }
  const ux = px / dist
  const uy = py / dist
  const c = curvatureDrop(opts.radius ?? EARTH_RADIUS)
  const sEnd = dist - 0.5 * targetCell
  const maxH = opts.maxHeight
  const sStar = maxH < targetHeight ? Math.sqrt((targetHeight - maxH) / c) : 0
  const maxCap = maxH + VIEWSHED_HEIGHT_CAP
  let bestSlope = Number.NEGATIVE_INFINITY
  let bestS = 0
  let s = nearLimit
  for (let i = 0; i < VIEWSHED_MAX_STEPS; i++) {
    if (s >= sEnd) break
    const sample = heightAt(levels, ux * s, uy * s)
    if (!sample) break
    const slope = (sample.height - targetHeight) / s - s * c
    if (slope > bestSlope) {
      bestSlope = slope
      bestS = s
    }
    if (s > sStar && (maxH - targetHeight) / s - s * c < bestSlope) break
    if (targetHeight + dist * bestSlope + dist * dist * c > maxCap) break
    s += Math.max(sample.cell * VIEWSHED_STEP_CELL, s * VIEWSHED_STEP_GROWTH)
  }
  if (!Number.isFinite(bestSlope)) {
    return { zMin: Number.NEGATIVE_INFINITY, occluderDistance: 0 }
  }
  return {
    zMin: Math.min(maxCap, targetHeight + dist * bestSlope + dist * dist * c),
    occluderDistance: Math.max(0, dist - bestS)
  }
}

/** 16-bit fixed-point encodings (RGBA8) of zMin and occluder distance, matching TerrainShadows. */
export function encodeViewshed(zMin: number, occluderDistance: number, base: number): [number, number, number, number] {
  const t = Number.isFinite(zMin) ? Math.min(65535, Math.max(0, Math.floor((zMin - base) / TOP_STEP + 0.5))) : 0
  const dd = Math.min(65535, Math.max(0, Math.floor(occluderDistance / DIST_STEP + 0.5)))
  return [t >> 8, t & 255, dd >> 8, dd & 255]
}

export function decodeViewshed(r: number, g: number, b: number, a: number, base: number): ViewshedTop {
  return { zMin: base + (r * 256 + g) * TOP_STEP, occluderDistance: (b * 256 + a) * DIST_STEP }
}

/**
 * Visibility (0..1) of the target from a receiver at ellipsoidal height `viewerHeight`
 * (ground + viewerOffset) inside a cell of width `cell`. Mirrors `pe_vs_levelVisibility`.
 */
export function viewshedReceiverVisibility(v: ViewshedTop, viewerHeight: number, cell: number): number {
  const soft = VIEWSHED_SOFT_MIN + VIEWSHED_SOFT_PER_CELL * cell
  const bias = VIEWSHED_RECEIVER_BIAS + VIEWSHED_RECEIVER_BIAS_PER_CELL * cell
  return smoothstep(v.zMin - soft, v.zMin + soft, viewerHeight + bias)
}

/**
 * Cached radial sweep used to compute coverage statistics on the CPU without any GPU readback.
 * Re-evaluating `viewshedCoverageStats` after changing `viewerOffset` takes < 0.2 ms.
 */
export interface ViewshedRadialProfile {
  /** Number of azimuth rays. */
  rays: number
  /** Per-sample sector area weight (m^2). */
  area: Float32Array
  /** Ground ellipsoidal height at each sample (m). */
  ground: Float32Array
  /** Minimum visible ellipsoidal height at each sample (m). */
  zMin: Float32Array
  /** Receiver bias at each sample (m). */
  bias: Float32Array
  /** Number of valid samples stored in the typed arrays. */
  count: number
  /** Analysis radius (m). */
  maxRadius: number
}

/**
 * Sweeps `rays` radial lines outward from the target to `maxRadius`, maintaining a running
 * maximum apparent slope along each ray. Runs in ~2 ms on the CPU and avoids GPU readbacks.
 */
export function computeViewshedProfile(
  levels: readonly (ShadowLevel | null)[],
  targetHeight: number,
  maxRadius: number,
  opts: { radius?: number; rays?: number } = {}
): ViewshedRadialProfile {
  const rays = opts.rays ?? 240
  const present = levels.filter((l): l is ShadowLevel => l !== null)
  if (present.length === 0 || maxRadius <= 0) {
    return {
      rays,
      area: new Float32Array(0),
      ground: new Float32Array(0),
      zMin: new Float32Array(0),
      bias: new Float32Array(0),
      count: 0,
      maxRadius
    }
  }
  const c = curvatureDrop(opts.radius ?? EARTH_RADIUS)
  const nearLimit = viewshedNearLimit(present)
  const dTheta = (2 * Math.PI) / rays

  // Pre-allocate conservatively; grow if needed.
  let cap = rays * 192
  let area = new Float32Array(cap)
  let ground = new Float32Array(cap)
  let zMin = new Float32Array(cap)
  let bias = new Float32Array(cap)
  let count = 0

  const ensure = (need: number) => {
    if (need <= cap) return
    cap = Math.max(cap * 2, need)
    const grow = (src: Float32Array) => {
      const dst = new Float32Array(cap)
      dst.set(src)
      return dst
    }
    area = grow(area)
    ground = grow(ground)
    zMin = grow(zMin)
    bias = grow(bias)
  }

  for (let r = 0; r < rays; r++) {
    const az = (r / rays) * 2 * Math.PI
    const ux = Math.sin(az)
    const uy = Math.cos(az)
    let bestSlope = Number.NEGATIVE_INFINITY
    let prevR = 0
    let s = nearLimit
    while (s <= maxRadius) {
      const sample = heightAt(present, ux * s, uy * s)
      if (!sample) break
      const step = Math.max(sample.cell, s * 0.012)
      const nextR = Math.min(maxRadius, s + 0.5 * step)
      const sectorArea = 0.5 * (nextR * nextR - prevR * prevR) * dTheta
      const req = Number.isFinite(bestSlope) ? targetHeight + s * bestSlope + s * s * c : Number.NEGATIVE_INFINITY
      ensure(count + 1)
      area[count] = sectorArea
      ground[count] = sample.height
      zMin[count] = req
      bias[count] = VIEWSHED_RECEIVER_BIAS + VIEWSHED_RECEIVER_BIAS_PER_CELL * sample.cell
      count++

      const slope = (sample.height - targetHeight) / s - s * c
      if (slope > bestSlope) bestSlope = slope
      prevR = nextR
      s += step
    }
  }

  return { rays, area, ground, zMin, bias, count, maxRadius }
}

/** Visible area and coverage percentage for a given viewer height offset above ground. */
export function viewshedCoverageStats(profile: ViewshedRadialProfile, viewerOffset: number): ViewshedStats {
  const totalAreaM2 = Math.PI * profile.maxRadius * profile.maxRadius
  if (profile.count === 0 || totalAreaM2 <= 0) {
    return { visibleAreaM2: 0, totalAreaM2, visibleFraction: 0 }
  }
  let visibleAreaM2 = 0
  let sampledAreaM2 = 0
  for (let i = 0; i < profile.count; i++) {
    const a = profile.area[i]
    sampledAreaM2 += a
    if (profile.ground[i] + viewerOffset + profile.bias[i] >= profile.zMin[i]) {
      visibleAreaM2 += a
    }
  }
  const scale = sampledAreaM2 > 0 ? totalAreaM2 / sampledAreaM2 : 1
  const scaledVisible = Math.min(totalAreaM2, visibleAreaM2 * scale)
  return {
    visibleAreaM2: scaledVisible,
    totalAreaM2,
    visibleFraction: Math.min(1, Math.max(0, scaledVisible / totalAreaM2))
  }
}

/**
 * Evaluates line-of-sight from a point at local offset `(px, py)` and ellipsoidal footing
 * `pointGroundHeight` back to the viewshed target at `(0, 0)` and ellipsoidal height `targetHeight`.
 */
export function checkPointVisibility(
  levels: readonly (ShadowLevel | null)[],
  px: number,
  py: number,
  pointGroundHeight: number,
  targetHeight: number,
  viewerOffset: number,
  maxRadius: number,
  opts: { radius?: number } = {}
): ViewshedPointCheck {
  const dist = Math.hypot(px, py)
  // Vector from point P back toward target O = (-px, -py): compass bearing clockwise from north.
  const bearingToTarget = dist < 1e-3 ? 0 : (((Math.atan2(-px, -py) * DEG) % 360) + 360) % 360
  const viewerHeight = pointGroundHeight + viewerOffset
  const c = curvatureDrop(opts.radius ?? EARTH_RADIUS)
  const pitchToTarget = dist < 1e-3 ? 0 : Math.atan((targetHeight - viewerHeight) / dist - dist * c) * DEG
  const outsideRadius = dist > maxRadius
  const present = levels.filter((l): l is ShadowLevel => l !== null)
  if (present.length === 0) {
    return { visible: false, distance: dist, bearingToTarget, pitchToTarget, clearanceM: 0, outsideRadius }
  }
  const at = heightAt(present, px, py)
  const cell = at?.cell ?? levelCell(present[present.length - 1])
  const maxHeight = Math.max(...present.map((l) => l.maxHeight))
  const top = viewshedTop(present, px, py, targetHeight, cell, {
    radius: opts.radius,
    maxRadius: Math.max(maxRadius, dist),
    maxHeight
  })
  const bias = VIEWSHED_RECEIVER_BIAS + VIEWSHED_RECEIVER_BIAS_PER_CELL * cell
  const clearanceM = Number.isFinite(top.zMin) ? viewerHeight - top.zMin : Number.POSITIVE_INFINITY
  const visible = !outsideRadius && viewerHeight + bias >= top.zMin
  return { visible, distance: dist, bearingToTarget, pitchToTarget, clearanceM, outsideRadius }
}

/** Formats an area in km² or mi² cleanly for display. */
export function formatArea(areaM2: number, units: Units): string {
  if (!Number.isFinite(areaM2) || areaM2 < 0) return '—'
  if (units === 'imperial') {
    const mi2 = areaM2 / (METERS_PER_MILE * METERS_PER_MILE)
    if (mi2 < 0.1) return `${mi2.toFixed(2)} mi²`
    if (mi2 < 10) return `${mi2.toFixed(1)} mi²`
    return `${Math.round(mi2).toLocaleString('en-US')} mi²`
  }
  const km2 = areaM2 / 1_000_000
  if (km2 < 0.1) return `${km2.toFixed(2)} km²`
  if (km2 < 10) return `${km2.toFixed(1)} km²`
  return `${Math.round(km2).toLocaleString('en-US')} km²`
}
