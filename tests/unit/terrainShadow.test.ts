import { describe, expect, it } from 'vitest'
import {
  decodeShadow,
  encodeShadow,
  fillGaps,
  heightRange,
  levelCell,
  levelResolutions,
  rasterizeTriangles,
  receiverVisibility,
  sampleLevel,
  shadowTop,
  terrainLevelFor,
  type ShadowLevel,
  type SunVector
} from '@renderer/lib/terrainShadow'

const DEG = Math.PI / 180

function level(half: number, n: number, height: (x: number, y: number) => number, cx = 0, cy = 0): ShadowLevel {
  const heights = new Float32Array(n * n)
  const cell = (2 * half) / n
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) heights[j * n + i] = height(cx - half + (i + 0.5) * cell, cy - half + (j + 0.5) * cell)
  }
  const { min, max } = heightRange(heights)
  return { cx, cy, half, n, heights, minHeight: min, maxHeight: max }
}

function sunFrom(azimuthDeg: number, altitudeDeg: number): SunVector {
  const az = azimuthDeg * DEG
  const alt = altitudeDeg * DEG
  return { x: Math.sin(az) * Math.cos(alt), y: Math.cos(az) * Math.cos(alt), z: Math.sin(alt) }
}

/** 10 km × 10 km valley at 1000 m with a 1500 m high north–south ridge 200 m wide at x = 0. */
const ridge = (x: number) => (Math.abs(x) <= 100 ? 2500 : 1000)

function visibilityAt(levels: ShadowLevel[], x: number, y: number, sun: SunVector, height?: number): number {
  const l = levels[0]
  const ground = sampleLevel(l, x, y)
  const s = shadowTop(levels, x, y, ground, levelCell(l), sun, { farHeight: 1000, maxHeight: 2500 })
  return receiverVisibility(s, height ?? ground, levelCell(l))
}

describe('terrain shadow geometry', () => {
  it('samples bilinearly and only well inside the grid', () => {
    const l = level(1000, 20, (x) => x)
    expect(sampleLevel(l, 0, 0)).toBeCloseTo(0, 6)
    expect(sampleLevel(l, 333, -200)).toBeCloseTo(333, 3)
    expect(Number.isNaN(sampleLevel(l, 990, 0))).toBe(true)
    expect(Number.isNaN(sampleLevel(l, 0, -1200))).toBe(true)
  })

  it('shades the lee side of a ridge under a low sun, with the right shadow length', () => {
    const levels = [level(5000, 250, ridge)]
    const sun = sunFrom(270, 10) // low evening sun in the west
    // 1500 m / tan(10°) ≈ 8.5 km of shadow east of the ridge.
    expect(visibilityAt(levels, 1000, 0, sun)).toBe(0)
    expect(visibilityAt(levels, 4500, 0, sun)).toBe(0)
    expect(visibilityAt(levels, -1000, 0, sun)).toBe(1)
    const high = sunFrom(270, 70) // 1500 m / tan(70°) ≈ 546 m
    expect(visibilityAt(levels, 400, 0, high)).toBe(0)
    expect(visibilityAt(levels, 800, 0, high)).toBe(1)
  })

  it('lets tall receivers rise out of a shadow', () => {
    const levels = [level(5000, 250, ridge)]
    const sun = sunFrom(270, 10)
    // 2 km east of the ridge the ray clears 2500 − 2000·tan(10°) − 100·tan(10°) ≈ 2130 m.
    expect(visibilityAt(levels, 2000, 0, sun, 1050)).toBe(0)
    expect(visibilityAt(levels, 2000, 0, sun, 2200)).toBe(1)
  })

  it('records the occluder distance for the penumbra', () => {
    const levels = [level(5000, 250, ridge)]
    const s = shadowTop(levels, 3000, 0, 1000, 40, sunFrom(270, 10), { farHeight: 1000, maxHeight: 2500 })
    expect(s.distance).toBeGreaterThan(2850)
    expect(s.distance).toBeLessThan(3150)
    // Wider penumbra far from the caster than right behind it.
    const near = shadowTop(levels, 300, 0, 1000, 40, sunFrom(270, 10), { farHeight: 1000, maxHeight: 2500 })
    expect(near.distance).toBeLessThan(s.distance)
  })

  it('finds casters on coarser levels beyond the fine grid', () => {
    // A 3000 m peak 15 km west, outside the ±5 km fine grid but inside the ±20 km one.
    const peak = (x: number, y: number) => (Math.hypot(x + 15000, y) < 600 ? 3000 : 500)
    const fine = level(5000, 200, peak)
    const coarse = level(20000, 200, peak)
    const sun = sunFrom(270, 8) // 2500 m / tan(8°) ≈ 17.8 km long shadow
    const s = shadowTop([fine, coarse], 0, 0, 500, levelCell(fine), sun, { farHeight: 500, maxHeight: 3000 })
    expect(receiverVisibility(s, 500, levelCell(fine))).toBe(0)
    expect(s.distance).toBeGreaterThan(14000)
    const onlyFine = shadowTop([fine, null], 0, 0, 500, levelCell(fine), sun, { farHeight: 500, maxHeight: 500 })
    expect(receiverVisibility(onlyFine, 500, levelCell(fine))).toBe(1)
  })

  it('accounts for earth curvature: a sun just below the horizon still lights high ground', () => {
    const flat = [level(5000, 100, () => 0)]
    // Center 0.6° below the horizon: even the upper limb (−0.33°) has set at sea level.
    const sun = sunFrom(270, -0.6)
    const opts = { farHeight: 0, maxHeight: 0 }
    const low = shadowTop(flat, 0, 0, 0, 100, sun, opts)
    expect(receiverVisibility(low, 0, 100)).toBe(0)
    // Horizon dip from 1000 m with refraction ≈ 0.95°: the sun is visible.
    expect(receiverVisibility(low, 1000, 100)).toBe(1)
  })

  it('round-trips the 16-bit encoding', () => {
    const base = -500
    const [r, g, b, a] = encodeShadow(2345.37, 18234, base)
    const d = decodeShadow(r, g, b, a, base)
    expect(d.top).toBeCloseTo(2345.37, 0)
    expect(Math.abs(d.top - 2345.37)).toBeLessThanOrEqual(0.125)
    expect(Math.abs(d.distance - 18234)).toBeLessThanOrEqual(1)
    expect(decodeShadow(...encodeShadow(Number.NEGATIVE_INFINITY, 0, base), base).top).toBe(base)
    expect(decodeShadow(...encodeShadow(1e9, 1e9, base), base).top).toBe(base + 65535 * 0.25)
  })

  it('rasterizes triangles with interpolated heights', () => {
    const n = 16
    const data = new Float32Array(n * n).fill(Number.NaN)
    // Two triangles covering the whole grid; height = 10·x (grid units).
    const gx = [-1, n, n, -1]
    const gy = [-1, -1, n, n]
    const gh = gx.map((x) => 10 * x)
    rasterizeTriangles(gx, gy, gh, [0, 1, 2, 0, 2, 3], data, n)
    expect(data.every((v) => !Number.isNaN(v))).toBe(true)
    expect(data[5 * n + 3]).toBeCloseTo(30, 4)
    expect(data[0]).toBeCloseTo(0, 4)
  })

  it('fills gaps from the coarser level', () => {
    const coarse = level(4000, 40, (x) => x + 100)
    const fine = level(1000, 20, () => 5)
    fine.heights[7 * 20 + 3] = Number.NaN
    expect(fillGaps(fine, coarse)).toBeCloseTo(399 / 400, 6)
    const x = -1000 + 3.5 * 100
    expect(fine.heights[7 * 20 + 3]).toBeCloseTo(x + 100, 3)
  })

  it('picks grid resolutions and terrain tile levels', () => {
    expect(levelResolutions(512)).toEqual([512, 512, 384])
    expect(levelResolutions(5000)[0]).toBe(1024)
    expect(terrainLevelFor(19.5)).toBe(14)
    expect(terrainLevelFor(78)).toBe(12)
    expect(terrainLevelFor(417)).toBe(10)
  })
})
