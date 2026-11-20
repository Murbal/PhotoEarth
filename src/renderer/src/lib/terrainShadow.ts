// Heightmap ray-marching for the terrain shadow overlay (pure, unit-tested).

export interface HeightGrid {
  /** Bounds in radians. */
  west: number
  south: number
  east: number
  north: number
  nx: number
  ny: number
  /** Row-major heights in meters, rows from south to north. */
  data: Float32Array
  maxHeight: number
}

const R = 6371000
/** Effective earth radius with standard terrestrial refraction (k ≈ 0.13). */
const R_EFF = R / (1 - 0.13)

/** Bilinear height at (lon, lat) radians, or NaN outside the grid. */
export function gridHeight(g: HeightGrid, lon: number, lat: number): number {
  const fx = ((lon - g.west) / (g.east - g.west)) * g.nx - 0.5
  const fy = ((lat - g.south) / (g.north - g.south)) * g.ny - 0.5
  if (fx < 0 || fy < 0 || fx > g.nx - 1 || fy > g.ny - 1) return Number.NaN
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const x1 = Math.min(x0 + 1, g.nx - 1)
  const y1 = Math.min(y0 + 1, g.ny - 1)
  const tx = fx - x0
  const ty = fy - y0
  const d = g.data
  const a = d[y0 * g.nx + x0]
  const b = d[y0 * g.nx + x1]
  const c = d[y1 * g.nx + x0]
  const e = d[y1 * g.nx + x1]
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty
}

/**
 * For each cell of `inner`, marches toward the sun and returns 1 where terrain (from `inner`,
 * then the wider `outer` grid) rises above the ray, else 0. Earth curvature and standard
 * refraction are included, which matters for ridges tens of kilometers away at low sun.
 */
export function buildShadowMask(
  inner: HeightGrid,
  outer: HeightGrid | null,
  azimuthDeg: number,
  altitudeDeg: number,
  maxDistance = 60000
): Float32Array {
  const { nx, ny } = inner
  const mask = new Float32Array(nx * ny)
  if (altitudeDeg <= -0.5) return mask.fill(1)
  const az = (azimuthDeg * Math.PI) / 180
  const sinAz = Math.sin(az)
  const cosAz = Math.cos(az)
  const tanAlt = Math.tan((Math.max(altitudeDeg, -0.5) * Math.PI) / 180)
  const cellW = (inner.east - inner.west) / nx
  const cellH = (inner.north - inner.south) / ny
  const midLat = (inner.north + inner.south) / 2
  const cell = Math.max(1, Math.min(cellW * R * Math.cos(midLat), cellH * R))
  const maxH = Math.max(inner.maxHeight, outer?.maxHeight ?? -Infinity)

  for (let j = 0; j < ny; j++) {
    const lat0 = inner.south + (j + 0.5) * cellH
    const cosLat = Math.max(0.01, Math.cos(lat0))
    for (let i = 0; i < nx; i++) {
      const lon0 = inner.west + (i + 0.5) * cellW
      const h0 = inner.data[j * nx + i] + 0.5
      const limit = tanAlt > 1e-4 ? Math.min(maxDistance, (maxH - h0) / tanAlt + cell) : maxDistance
      let shadow = 0
      let d = cell
      while (d < limit) {
        const lon = lon0 + (d * sinAz) / (R * cosLat)
        const lat = lat0 + (d * cosAz) / R
        let h = gridHeight(inner, lon, lat)
        if (Number.isNaN(h) && outer) h = gridHeight(outer, lon, lat)
        if (Number.isNaN(h)) break
        const ray = h0 + d * tanAlt + (d * d) / (2 * R_EFF)
        if (h > ray) {
          shadow = 1
          break
        }
        if (ray > maxH) break
        d += Math.max(cell, d * 0.015)
      }
      mask[j * nx + i] = shadow
    }
  }
  return mask
}
