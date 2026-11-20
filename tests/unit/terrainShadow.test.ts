import { describe, expect, it } from 'vitest'
import { buildShadowMask, gridHeight, type HeightGrid } from '@renderer/lib/terrainShadow'

const DEG = Math.PI / 180

/** 10 km × 10 km flat valley at 1000 m with a 1500 m high north–south ridge in the middle. */
function ridgeGrid(): HeightGrid {
  const nx = 100
  const ny = 100
  const data = new Float32Array(nx * ny)
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) data[j * nx + i] = i >= 48 && i <= 52 ? 2500 : 1000
  const half = 5000 / 6371000
  return {
    west: 8 * DEG - half / Math.cos(46 * DEG),
    east: 8 * DEG + half / Math.cos(46 * DEG),
    south: 46 * DEG - half,
    north: 46 * DEG + half,
    nx,
    ny,
    data,
    maxHeight: 2500
  }
}

describe('terrain shadow ray-marching', () => {
  it('interpolates heights', () => {
    const g = ridgeGrid()
    const cx = (g.west + g.east) / 2
    const cy = (g.south + g.north) / 2
    expect(gridHeight(g, cx, cy)).toBe(2500)
    expect(gridHeight(g, g.west + (g.east - g.west) * 0.1, cy)).toBe(1000)
    expect(Number.isNaN(gridHeight(g, g.west - 0.01, cy))).toBe(true)
  })

  it('shades the side of the ridge facing away from a low sun', () => {
    const g = ridgeGrid()
    // Low evening sun in the west: the east side of the ridge is in shadow.
    const mask = buildShadowMask(g, null, 270, 8)
    const row = 50 * g.nx
    expect(mask[row + 60]).toBe(1) // 1 km east of the ridge: 1500 m / tan(8°) ≈ 10.7 km shadow
    expect(mask[row + 40]).toBe(0) // west side faces the sun
  })

  it('casts shorter shadows when the sun is high', () => {
    const g = ridgeGrid()
    const mask = buildShadowMask(g, null, 270, 70)
    const row = 50 * g.nx
    // 1500 m / tan(70°) ≈ 546 m: one cell (100 m) past the ridge is shaded, 1 km is not.
    expect(mask[row + 54]).toBe(1)
    expect(mask[row + 62]).toBe(0)
  })

  it('is fully dark when the sun is below the horizon', () => {
    expect(buildShadowMask(ridgeGrid(), null, 270, -3).every((v) => v === 1)).toBe(true)
  })
})
