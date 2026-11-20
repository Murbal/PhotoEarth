import { Cartesian3, GeographicTilingScheme, type TerrainProvider } from 'cesium'
import { describe, expect, it } from 'vitest'
import { HeightField, LocalFrame } from '@renderer/engine/shadows/HeightField'
import { levelCell } from '@renderer/lib/terrainShadow'

const DEG = Math.PI / 180

/** Terrain whose height is a known function of lon/lat: a tilted plane plus a ridge. */
const heightAt = (lon: number, lat: number) => 1200 + (lon - 8 * DEG) * 4.0e5 - (lat - 46 * DEG) * 2.5e5

/** A provider serving one quad (two triangles) per tile, quantized like quantized-mesh. */
function fakeProvider(failLevel = -1): TerrainProvider & { requests: number } {
  const tilingScheme = new GeographicTilingScheme()
  const provider = {
    tilingScheme,
    requests: 0,
    getTileDataAvailable: () => true,
    requestTileGeometry(x: number, y: number, level: number) {
      provider.requests++
      if (level === failLevel) return Promise.reject(new Error('404'))
      const r = tilingScheme.tileXYToRectangle(x, y, level)
      // 9 × 9 vertices so the tilted plane is exact under linear interpolation.
      const k = 9
      const u: number[] = []
      const v: number[] = []
      const h: number[] = []
      for (let j = 0; j < k; j++) {
        for (let i = 0; i < k; i++) {
          u.push(Math.round((i / (k - 1)) * 32767))
          v.push(Math.round((j / (k - 1)) * 32767))
          h.push(heightAt(r.west + (i / (k - 1)) * (r.east - r.west), r.south + (j / (k - 1)) * (r.north - r.south)))
        }
      }
      const minH = Math.min(...h)
      const maxH = Math.max(...h)
      const q = new Uint16Array([...u, ...v, ...h.map((x) => Math.round(((x - minH) / (maxH - minH || 1)) * 32767))])
      const indices: number[] = []
      for (let j = 0; j < k - 1; j++) {
        for (let i = 0; i < k - 1; i++) {
          const a = j * k + i
          indices.push(a, a + 1, a + k + 1, a, a + k + 1, a + k)
        }
      }
      return Promise.resolve({ _quantizedVertices: q, _indices: new Uint16Array(indices), _minimumHeight: minH, _maximumHeight: maxH })
    }
  }
  return provider as unknown as TerrainProvider & { requests: number }
}

describe('height field loading', () => {
  it('projects frame coordinates and back', () => {
    const frame = new LocalFrame(8 * DEG, 46 * DEG)
    const c = frame.toCartographic(3000, -4000)
    const p = frame.toLocal(c.longitude, c.latitude)
    expect(p.x).toBeCloseTo(3000, 3)
    expect(p.y).toBeCloseTo(-4000, 3)
    // Up at the origin is the frame's +z.
    const up = frame.directionToLocal(Cartesian3.normalize(Cartesian3.fromRadians(8 * DEG, 46 * DEG, 0), new Cartesian3()))
    expect(up.z).toBeGreaterThan(0.99)
    expect(frame.radius).toBeGreaterThan(6.36e6)
    expect(frame.radius).toBeLessThan(6.40e6)
  })

  it('fills a level with the terrain under each cell', async () => {
    const field = new HeightField(fakeProvider())
    const frame = new LocalFrame(8 * DEG, 46 * DEG)
    const level = await field.loadLevel(frame, 1000, -500, 5000, 64, null, () => false)
    expect(level).not.toBeNull()
    const cell = levelCell(level!)
    let worst = 0
    for (let j = 0; j < 64; j += 7) {
      for (let i = 0; i < 64; i += 7) {
        const c = frame.toCartographic(1000 - 5000 + (i + 0.5) * cell, -500 - 5000 + (j + 0.5) * cell)
        worst = Math.max(worst, Math.abs(level!.heights[j * 64 + i] - heightAt(c.longitude, c.latitude)))
      }
    }
    expect(worst).toBeLessThan(1)
    expect(level!.minHeight).toBeLessThan(level!.maxHeight)
  })

  it('falls back to parent tiles when a level is missing and reuses cached tiles', async () => {
    const provider = fakeProvider(14)
    const field = new HeightField(provider)
    const frame = new LocalFrame(8 * DEG, 46 * DEG)
    const a = await field.loadLevel(frame, 0, 0, 5000, 256, null, () => false)
    expect(a).not.toBeNull()
    const requests = provider.requests
    await field.loadLevel(frame, 0, 0, 5000, 256, null, () => false)
    expect(provider.requests).toBe(requests)
  })

  it('stops when cancelled', async () => {
    const field = new HeightField(fakeProvider())
    const frame = new LocalFrame(8 * DEG, 46 * DEG)
    expect(await field.loadLevel(frame, 0, 0, 5000, 64, null, () => true)).toBeNull()
  })
})
