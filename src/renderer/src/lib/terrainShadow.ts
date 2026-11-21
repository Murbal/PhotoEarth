// Heightmap terrain shadows: the geometry shared by the GPU pass (engine/shadows/shaders.ts)
// and its CPU reference implementation here (pure and unit-tested). Keep the two in lockstep.
//
// Heights live on nested square grids ("levels") in a local tangent-plane frame: x east,
// y north, meters, origin on the ellipsoid near the view. A grid cell stores the ellipsoidal
// height of the ground at its nadir point. For each cell the GPU computes a *shadow top*: the
// height above which a point on that vertical is in sunlight. Any receiver (terrain, a roof, a
// cliff face inside the cell) is then shaded by comparing its own height with the shadow top,
// which keeps shadow edges sharp even where the grid is coarser than the geometry.

/** Mean earth radius, meters. */
export const EARTH_RADIUS = 6371000
/** Terrestrial refraction coefficient (standard atmosphere). Bends long, grazing rays down. */
export const REFRACTION_K = 0.13
/** Angular radius of the sun's disc, radians (0.2666°). Sets the penumbra width. */
export const SUN_ANGULAR_RADIUS = 0.004654
/** The march step grows with distance: a far occluder needs less absolute precision. */
export const STEP_GROWTH = 0.008
export const MAX_STEPS = 768
/** Shadow tops more than this far below the receiver's ground can't shade anything. */
export const CARE_BELOW = 300
/** Encoding of the shadow top (16 bits, relative to a base height) and occluder distance. */
export const TOP_STEP = 0.25
export const DIST_STEP = 2
/** Receiver-side tolerances; both scale with the cell size of the level being read. */
export const RECEIVER_BIAS = 1.5
export const RECEIVER_BIAS_PER_CELL = 0.08
export const PENUMBRA_MIN = 1
export const PENUMBRA_MIN_PER_CELL = 0.05
/** Width, in texels, of the cross-fade from a finer level to the next coarser one. */
export const LEVEL_BLEND_TEXELS = 12
/** Below this sun altitude (degrees) every surface is in shadow and the pass is skipped. */
export const SUN_CUTOFF_ALTITUDE = -2.5

/** Half-widths of the three nested levels, meters: fine, medium, coarse. */
export const LEVEL_HALF = [5000, 20000, 80000] as const
export const LEVEL_COUNT = LEVEL_HALF.length
/** Mask textures are allocated once at this size; levels use the lower-left n × n texels. */
export const MAX_RESOLUTION = 1024

export interface ShadowLevel {
  /** Grid center in the local frame, meters. */
  cx: number
  cy: number
  half: number
  /** Cells per side. */
  n: number
  /** n × n ellipsoidal heights, row-major, row 0 at the south (minimum y) edge. */
  heights: Float32Array
  minHeight: number
  maxHeight: number
}

/** Unit vector toward the sun in the local frame (x east, y north, z up at the origin). */
export interface SunVector {
  x: number
  y: number
  z: number
}

export const levelCell = (l: Pick<ShadowLevel, 'half' | 'n'>): number => (2 * l.half) / l.n
export const levelMinX = (l: Pick<ShadowLevel, 'cx' | 'half'>): number => l.cx - l.half
export const levelMinY = (l: Pick<ShadowLevel, 'cy' | 'half'>): number => l.cy - l.half

/** Cells per side for each level at a quality resolution. The coarse level needs fewer. */
export function levelResolutions(resolution: number): number[] {
  const n = Math.max(64, Math.min(MAX_RESOLUTION, Math.round(resolution)))
  return [n, n, Math.max(64, Math.round((n * 0.75) / 8) * 8)]
}

/**
 * Terrain tile level whose vertex spacing roughly matches a cell size. Geographic tiling:
 * a level-L tile spans 180° / 2^L of latitude, and quantized-mesh tiles carry roughly
 * 64 vertices across.
 */
export function terrainLevelFor(cellMeters: number, maxLevel = 16): number {
  const level = Math.round(Math.log2((Math.PI * EARTH_RADIUS) / (64 * cellMeters)))
  return Math.max(0, Math.min(maxLevel, level))
}

/** Snaps a coordinate to a multiple of `step`, so re-centered grids keep their sample phase. */
export const snap = (value: number, step: number): number => Math.round(value / step) * step

/** Whether a level centered at (cx, cy) should re-center on a focus point. */
export function needsRecenter(cx: number, cy: number, half: number, fx: number, fy: number): boolean {
  return Math.hypot(fx - cx, fy - cy) > half * 0.25
}

/**
 * Bilinear height at (x, y), or NaN when (x, y) isn't at least one texel inside the grid.
 * Same margin and filtering as the GPU's hardware-filtered lookup.
 */
export function sampleLevel(l: ShadowLevel, x: number, y: number): number {
  const cell = levelCell(l)
  const ux = (x - levelMinX(l)) / cell
  const uy = (y - levelMinY(l)) / cell
  if (!(ux > 1 && uy > 1 && ux < l.n - 1 && uy < l.n - 1)) return Number.NaN
  const fx = ux - 0.5
  const fy = uy - 0.5
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const tx = fx - x0
  const ty = fy - y0
  const d = l.heights
  const n = l.n
  const a = d[y0 * n + x0]
  const b = d[y0 * n + x0 + 1]
  const c = d[(y0 + 1) * n + x0]
  const e = d[(y0 + 1) * n + x0 + 1]
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty
}

/** Height from the finest level containing (x, y). `levels` is ordered fine → coarse. */
export function heightAt(levels: readonly (ShadowLevel | null)[], x: number, y: number): { height: number; cell: number } | null {
  for (const l of levels) {
    if (!l) continue
    const h = sampleLevel(l, x, y)
    if (!Number.isNaN(h)) return { height: h, cell: levelCell(l) }
  }
  return null
}

export interface ShadowTop {
  /** Height (ellipsoidal, meters) above which the vertical through the cell is sunlit. */
  top: number
  /** Distance to the occluder that sets it, meters (0 when nothing occludes). */
  distance: number
}

/**
 * Marches from a receiver cell toward the sun and returns its shadow top.
 *
 * Along the march, a terrain sample at horizontal distance d raises the shadow top to
 *   v(d) = H(Q) − d·tanα − (2d·(P·u) + d²) / 2R + k·d² / 2R
 * where u is the sun's horizontal direction, α its altitude in the frame, P the receiver's
 * position in the frame, and k the refraction coefficient. The middle terms are the earth's
 * curvature (including the sun appearing higher toward the sun), the last the downward bend
 * of a grazing light ray. Past the edge of the data, the ground is assumed to continue at
 * `farHeight`, so a sun below the horizon still sets behind the earth's curve.
 */
export function shadowTop(
  levels: readonly (ShadowLevel | null)[],
  px: number,
  py: number,
  groundHeight: number,
  receiverCell: number,
  sun: SunVector,
  opts: { radius?: number; farHeight: number; maxHeight: number }
): ShadowTop {
  const radius = opts.radius ?? EARTH_RADIUS
  const horizontal = Math.hypot(sun.x, sun.y)
  if (horizontal < 1e-5) return { top: Number.NEGATIVE_INFINITY, distance: 0 }
  const ux = sun.x / horizontal
  const uy = sun.y / horizontal
  const tanAlt = sun.z / horizontal
  const invR = 1 / radius
  const pd = px * ux + py * uy
  // Sun altitude at the receiver (the frame's horizon tilts away from the origin).
  const tanP = tanAlt + pd * invR
  const c2 = (1 - REFRACTION_K) * 0.5 * invR
  const dStar = tanP < 0 ? -tanP / (2 * c2) : 0
  const threshold = groundHeight - CARE_BELOW
  let best = Number.NEGATIVE_INFINITY
  let bestD = 0
  let dLast = 0
  let d = 0.5 * receiverCell
  for (let i = 0; i < MAX_STEPS; i++) {
    const sample = heightAt(levels, px + ux * d, py + uy * d)
    if (!sample) break
    const v = sample.height - d * tanP - d * d * c2
    if (v > best) {
      best = v
      bestD = d
    }
    dLast = d
    // Nothing further along can reach above what already matters.
    const bound = opts.maxHeight - d * tanP - d * d * c2
    if (d > dStar && bound < Math.max(best, threshold)) break
    d += Math.max(sample.cell, d * STEP_GROWTH)
  }
  if (dLast > 0) {
    const dc = Math.max(dStar, dLast)
    const far = opts.farHeight - dc * tanP - dc * dc * c2
    if (far > best) {
      best = far
      bestD = dc
    }
  }
  return { top: best, distance: bestD }
}

/** 16-bit fixed-point encodings (two RGBA8 channels each) of the shadow top and distance. */
export function encodeShadow(top: number, distance: number, base: number): [number, number, number, number] {
  const t = Number.isFinite(top) ? Math.min(65535, Math.max(0, Math.floor((top - base) / TOP_STEP + 0.5))) : 0
  const dd = Math.min(65535, Math.max(0, Math.floor(distance / DIST_STEP + 0.5)))
  return [t >> 8, t & 255, dd >> 8, dd & 255]
}

export function decodeShadow(r: number, g: number, b: number, a: number, base: number): ShadowTop {
  return { top: base + (r * 256 + g) * TOP_STEP, distance: (b * 256 + a) * DIST_STEP }
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/**
 * Fraction of the sun's disc visible from a receiver at `height` (ellipsoidal) below a cell
 * with the given shadow top. The penumbra widens with occluder distance, as real shadows do.
 */
export function receiverVisibility(s: ShadowTop, height: number, cell: number): number {
  const penumbra = Math.max(PENUMBRA_MIN + PENUMBRA_MIN_PER_CELL * cell, s.distance * SUN_ANGULAR_RADIUS)
  const bias = RECEIVER_BIAS + RECEIVER_BIAS_PER_CELL * cell
  return smoothstep(s.top - penumbra, s.top + penumbra, height + bias)
}

/** Lowest and highest finite height of a grid (NaN cells are unloaded). */
export function heightRange(heights: Float32Array): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (let i = 0; i < heights.length; i++) {
    const h = heights[i]
    if (h < min) min = h
    if (h > max) max = h
  }
  return { min, max }
}

/**
 * Rasterizes a triangle mesh into a grid. Vertex coordinates are in grid units (texel
 * centers at integer + 0.5 → pass `x / cell − 0.5` style values, i.e. cell i's center is i).
 * Cells whose centers fall inside a triangle get its linearly interpolated height.
 */
export function rasterizeTriangles(
  gx: ArrayLike<number>,
  gy: ArrayLike<number>,
  gh: ArrayLike<number>,
  indices: ArrayLike<number>,
  data: Float32Array,
  n: number
): void {
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t]
    const b = indices[t + 1]
    const c = indices[t + 2]
    const x0 = gx[a], y0 = gy[a], x1 = gx[b], y1 = gy[b], x2 = gx[c], y2 = gy[c]
    const minX = Math.max(0, Math.ceil(Math.min(x0, x1, x2)))
    const maxX = Math.min(n - 1, Math.floor(Math.max(x0, x1, x2)))
    const minY = Math.max(0, Math.ceil(Math.min(y0, y1, y2)))
    const maxY = Math.min(n - 1, Math.floor(Math.max(y0, y1, y2)))
    if (minX > maxX || minY > maxY) continue
    const det = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
    if (Math.abs(det) < 1e-12) continue
    const inv = 1 / det
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const w0 = ((y1 - y2) * (x - x2) + (x2 - x1) * (y - y2)) * inv
        const w1 = ((y2 - y0) * (x - x2) + (x0 - x2) * (y - y2)) * inv
        const w2 = 1 - w0 - w1
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue
        data[y * n + x] = w0 * gh[a] + w1 * gh[b] + w2 * gh[c]
      }
    }
  }
}

/**
 * Fills unloaded (NaN) cells: from a coarser level where one covers them, otherwise with the
 * lowest loaded height. Returns the fraction of cells that had data.
 */
export function fillGaps(level: ShadowLevel, coarser: ShadowLevel | null): number {
  const { heights, n } = level
  const cell = levelCell(level)
  const minX = levelMinX(level)
  const minY = levelMinY(level)
  let valid = 0
  let lowest = Number.POSITIVE_INFINITY
  for (let i = 0; i < heights.length; i++) {
    if (!Number.isNaN(heights[i])) {
      valid++
      if (heights[i] < lowest) lowest = heights[i]
    }
  }
  if (!Number.isFinite(lowest)) lowest = 0
  if (valid === heights.length) return 1
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i
      if (!Number.isNaN(heights[k])) continue
      const h = coarser ? sampleLevel(coarser, minX + (i + 0.5) * cell, minY + (j + 0.5) * cell) : Number.NaN
      heights[k] = Number.isNaN(h) ? lowest : h
    }
  }
  return valid / heights.length
}
