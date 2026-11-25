import { describe, expect, it } from 'vitest'
import { defaultSettings, LIGHT_POLLUTION_ORIGINS, LIGHT_POLLUTION_SOURCES, sanitizeSettings } from '@shared/settings'
import {
  LIGHT_POLLUTION_SOURCE_LIST,
  lightPollutionSource,
  MOSAIC_MIN_REACH_M,
  mosaicReach,
  mosaicTilesAcross,
  planMosaic,
  planOverlay,
  readoutSource,
  tileRowInBounds,
  tileUrl
} from '../../src/renderer/src/lib/lightPollutionSources'
import {
  ATLAS_GRID,
  atlasCell,
  atlasRatioAt,
  compressedToRatio,
  decodeZoneColor,
  estimateFromRatio,
  estimateFromZone,
  mercatorPixel,
  mpsasToRatio,
  NATURAL_SKY_MPSAS,
  ratioToMpsas,
  zoneIndexForRatio,
  ZONES
} from '../../src/renderer/src/lib/skyBrightness'

describe('zenith brightness', () => {
  it('converts the light pollution ratio to mag/arcsec² and back', () => {
    expect(ratioToMpsas(0)).toBe(NATURAL_SKY_MPSAS)
    // Artificial = natural: twice as bright, 0.75 mag brighter.
    expect(ratioToMpsas(1)).toBeCloseTo(22 - 2.5 * Math.log10(2), 10)
    // A city: 50× natural.
    expect(ratioToMpsas(50)).toBeCloseTo(17.731, 3)
    for (const r of [0, 0.01, 0.3, 1, 7.5, 120]) expect(mpsasToRatio(ratioToMpsas(r))).toBeCloseTo(r, 9)
    expect(ratioToMpsas(-1)).toBe(NATURAL_SKY_MPSAS)
  })
})

describe('light pollution zones', () => {
  it('tile the ratio axis without gaps, each a/b step ~√3× from 2a up', () => {
    expect(ZONES[0].min).toBe(0)
    expect(ZONES[ZONES.length - 1].max).toBe(Infinity)
    for (let i = 1; i < ZONES.length; i++) {
      expect(ZONES[i].min).toBe(ZONES[i - 1].max)
      if (i >= 3 && Number.isFinite(ZONES[i].max)) expect(ZONES[i].max / ZONES[i].min).toBeCloseTo(Math.sqrt(3), 1)
    }
    expect(ZONES.map((z) => z.id)).toEqual(['0', '1a', '1b', '2a', '2b', '3a', '3b', '4a', '4b', '5a', '5b', '6a', '6b', '7a', '7b'])
  })

  it('finds the zone of a ratio, boundaries going to the brighter zone', () => {
    expect(ZONES[zoneIndexForRatio(0)].id).toBe('0')
    expect(ZONES[zoneIndexForRatio(0.0099)].id).toBe('0')
    expect(ZONES[zoneIndexForRatio(0.01)].id).toBe('1a')
    expect(ZONES[zoneIndexForRatio(0.999)].id).toBe('3b')
    expect(ZONES[zoneIndexForRatio(1)].id).toBe('4a')
    expect(ZONES[zoneIndexForRatio(46.77)].id).toBe('7b')
    expect(ZONES[zoneIndexForRatio(1e4)].id).toBe('7b')
  })
})

describe('tile color decoding', () => {
  it('maps every palette color back to its zone', () => {
    ZONES.forEach((z, i) => expect(decodeZoneColor(...z.rgb)).toBe(i))
  })

  it('maps the expanded scale’s extra white into the top zone', () => {
    expect(decodeZoneColor(255, 255, 255)).toBe(ZONES.length - 1)
  })

  it('tolerates small color shifts but rejects colors off the scale', () => {
    // 4b (184,166,37), nudged by color management.
    expect(decodeZoneColor(187, 163, 40)).toBe(8)
    // The darkest greys stay apart: 0 (0,0,0) vs 1a (34,34,34).
    expect(decodeZoneColor(6, 6, 6)).toBe(0)
    expect(decodeZoneColor(30, 30, 30)).toBe(1)
    expect(decodeZoneColor(128, 0, 128)).toBeNull()
    expect(decodeZoneColor(90, 140, 200)).toBeNull()
  })

  it('has palette colors far enough apart for the tolerance', () => {
    for (let i = 0; i < ZONES.length; i++)
      for (let j = i + 1; j < ZONES.length; j++) {
        const [a, b] = [ZONES[i].rgb, ZONES[j].rgb]
        expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeGreaterThan(2 * 18)
      }
  })
})

describe('Sky estimates', () => {
  it('estimates from a modeled value', () => {
    // Zermatt village in the 2025 atlas: 1.29× natural.
    const e = estimateFromRatio(1.291)
    expect(e.zone.id).toBe('4a')
    expect(e.mpsas).toBeCloseTo(21.1, 1)
    expect(e.precision).toBe('data')
    expect(e.mpsasRange).toBeNull()
    // A pristine sky is the natural 22.0.
    expect(estimateFromRatio(0).mpsas).toBeCloseTo(22.0, 5)
  })

  it('estimates from a zone alone, inside that zone', () => {
    ZONES.forEach((z, i) => {
      const e = estimateFromZone(i)
      expect(e.zone).toBe(z)
      expect(e.precision).toBe('zone')
      expect(zoneIndexForRatio(e.ratio)).toBe(i)
      const [dark, bright] = e.mpsasRange!
      expect(e.mpsas).toBeLessThanOrEqual(dark)
      expect(e.mpsas).toBeGreaterThanOrEqual(bright)
    })
  })
})

// ───────────────────────────── atlas data tiles ─────────────────────────────

/**
 * The atlas viewer's own lookup (djlorenz.github.io/astronomy/lp/overlay/dark.html), kept
 * as written apart from types, as the reference for `atlasCell` and `atlasRatioAt`.
 */
function referenceLookup(lng: number, lat: number, tiles: (x: number, y: number) => Int8Array): number | null {
  const mod = (n: number, m: number) => ((n % m) + m) % m
  const lonFromDateLine = mod(lng + 180.0, 360.0)
  const latFromStart = lat + 65.0
  const tilex = Math.floor(lonFromDateLine / 5.0) + 1
  const tiley = Math.floor(latFromStart / 5.0) + 1
  if (!(tiley >= 1 && tiley <= 28)) return null
  const data_array = tiles(tilex, tiley)
  const ix = Math.round(120 * (lonFromDateLine - 5.0 * (tilex - 1) + 1 / 240))
  const iy = Math.round(120 * (latFromStart - 5.0 * (tiley - 1) + 1 / 240))
  const first_number = 128 * Number(data_array[0]) + Number(data_array[1])
  let change = 0.0
  for (let i = 1; i < iy; i++) change += Number(data_array[600 * i + 1])
  for (let i = 1; i < ix; i++) change += Number(data_array[600 * (iy - 1) + 1 + i])
  return (5.0 / 195.0) * (Math.exp(0.0195 * (first_number + change)) - 1.0)
}

/** Encodes a grid of compressed values (row 0 = south) the way the atlas stores it. */
function encodeTile(values: (row: number, col: number) => number): Int8Array {
  const n = ATLAS_GRID.cells
  const out = new Int8Array(n * n + 1)
  const v0 = values(0, 0)
  out[0] = Math.floor(v0 / 128)
  out[1] = v0 - 128 * out[0]
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      if (r === 0 && c === 0) continue
      const prev = c === 0 ? values(r - 1, 0) : values(r, c - 1)
      out[n * r + c + 1] = values(r, c) - prev
    }
  return out
}

/** A smooth synthetic field with steps that fit in a signed byte. */
const field = (seed: number) => (r: number, c: number) => Math.round(40 + 30 * Math.sin((r + seed) / 37) + 25 * Math.cos((c - seed) / 23) + (r * c) / 4000)

describe('atlas data tiles', () => {
  it('locate a point’s tile and cell, rows running north', () => {
    expect(atlasCell(-180, -65)).toEqual({ tileX: 1, tileY: 1, row: 0, col: 0 })
    // Zurich: tile 38_23, as the atlas viewer requests it.
    expect(atlasCell(8.5417, 47.3769)).toMatchObject({ tileX: 38, tileY: 23, row: 285, col: 425 })
    expect(atlasCell(179.999, 74.999)).toEqual({ tileX: 72, tileY: 28, row: 599, col: 599 })
    // Longitudes wrap.
    expect(atlasCell(181, 10)).toEqual(atlasCell(-179, 10))
    expect(atlasCell(0, 75)).toBeNull()
    expect(atlasCell(0, -65.01)).toBeNull()
    expect(atlasCell(Number.NaN, 0)).toBeNull()
  })

  it('decode a cell from the first value and its steps', () => {
    const values = field(3)
    const tile = encodeTile(values)
    for (const [r, c] of [
      [0, 0],
      [0, 1],
      [1, 0],
      [299, 450],
      [599, 599]
    ]) {
      expect(atlasRatioAt(tile, r, c)).toBeCloseTo(compressedToRatio(values(r, c)), 12)
    }
    expect(() => atlasRatioAt(new Int8Array(100), 0, 0)).toThrow(/too short/)
  })

  it('agree with the atlas viewer’s lookup anywhere', () => {
    // Three distinct tiles, reused across the globe (encoding one takes a while).
    const tiles = [0, 1, 2].map((k) => encodeTile(field(k * 101)))
    const get = (x: number, y: number) => tiles[(x * 7 + y) % 3]
    let state = 12345
    const rand = () => ((state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
    for (let k = 0; k < 400; k++) {
      const lon = -180 + 360 * rand()
      const lat = -65 + 140 * rand() * 0.9999
      const cell = atlasCell(lon, lat)!
      const ours = atlasRatioAt(get(cell.tileX, cell.tileY), cell.row, cell.col)
      expect(ours).toBeCloseTo(referenceLookup(lon, lat, get)!, 12)
    }
  })

  it('expand compressed integers like the atlas', () => {
    expect(compressedToRatio(0)).toBe(0)
    expect(compressedToRatio(100)).toBeCloseTo((5 / 195) * (Math.exp(1.95) - 1), 12)
    expect(compressedToRatio(200)).toBeGreaterThan(compressedToRatio(199))
  })
})

describe('Web Mercator tiles', () => {
  it('find the tile and pixel of a point', () => {
    expect(mercatorPixel(0, 0, 0, 256)).toEqual({ x: 0, y: 0, px: 128, py: 128 })
    expect(mercatorPixel(-180, 85.06, 2, 256)).toEqual({ x: 0, y: 0, px: 0, py: 0 })
    expect(mercatorPixel(179.9999, -85.06, 2, 256)).toEqual({ x: 3, y: 3, px: 255, py: 255 })
    // Zurich on the atlas's 1024 px zoom-6 tile 33_22.
    const p = mercatorPixel(8.5417, 47.3769, 6, 1024)
    expect([p.x, p.y]).toEqual([33, 22])
  })
})

describe('light pollution sources', () => {
  it('have one definition per setting id', () => {
    expect(LIGHT_POLLUTION_SOURCE_LIST.map((s) => s.id)).toEqual([...LIGHT_POLLUTION_SOURCES])
    for (const id of LIGHT_POLLUTION_SOURCES) expect(lightPollutionSource(id).id).toBe(id)
  })

  it('read points from sky brightness data, never from Black Marble', () => {
    expect(readoutSource('atlas-2016').id).toBe('atlas-2016')
    expect(readoutSource('black-marble').id).toBe('atlas-2025')
    expect(lightPollutionSource('atlas-2023').dataUrl!(38, 23)).toBe(
      'https://djlorenz.github.io/astronomy/binary_tiles/2023/binary_tile_38_23.dat.gz'
    )
  })

  it('fill tile templates', () => {
    expect(tileUrl(lightPollutionSource('atlas-2025').imagery.url, 6, 33, 22)).toBe(
      'https://djlorenz.github.io/astronomy/image_tiles/tiles2025/tile_6_33_22.png'
    )
    // WMTS order: matrix / row / column.
    expect(tileUrl(lightPollutionSource('black-marble').imagery.url, 5, 16, 11)).toMatch(/\/5\/11\/16\.png$/)
  })

  it('are hosted on origins the content security policy allows', () => {
    for (const s of LIGHT_POLLUTION_SOURCE_LIST) {
      const urls = [s.imagery.url, ...(s.dataUrl ? [s.dataUrl(1, 1)] : [])]
      for (const url of urls) expect(LIGHT_POLLUTION_ORIGINS).toContain(new URL(tileUrl(url, 0, 0, 0)).origin)
    }
  })

  it('settings sanitize', () => {
    expect(defaultSettings().lightPollution).toEqual({ enabled: false, opacity: 0.6, source: 'atlas-2025' })
    expect(sanitizeSettings({ lightPollution: { enabled: true, opacity: 3, source: 'falchi' } }).lightPollution).toEqual({
      enabled: true,
      opacity: 1,
      source: 'atlas-2025'
    })
    expect(sanitizeSettings({ lightPollution: { source: 'black-marble' } }).lightPollution.source).toBe('black-marble')
  })
})

describe('light pollution on the 3D Tiles', () => {
  const atlas = lightPollutionSource('atlas-2025').imagery
  const marble = lightPollutionSource('black-marble').imagery
  const EQUATOR = 40_075_016.686
  /** Meters from a point to the nearest edge of the plan's block, along the parallel and the meridian. */
  function margin(plan: ReturnType<typeof planMosaic>, longitude: number, latitude: number): number {
    const n = 2 ** plan.z
    const lat = (latitude * Math.PI) / 180
    const x = ((longitude + 180) / 360) * n
    const y = ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n
    const dx = (((x - plan.x0) % n) + n) % n
    const tile = (EQUATOR * Math.cos(lat)) / n
    return tile * Math.min(dx, plan.nx - dx, y - plan.y0, plan.y0 + plan.ny - y)
  }

  it('uses an odd number of tiles across, about 2048 px', () => {
    expect(mosaicTilesAcross(1024)).toBe(3)
    expect(mosaicTilesAcross(512)).toBe(3)
    expect(mosaicTilesAcross(256)).toBe(7)
  })

  it('reaches the horizon, and at least 150 km', () => {
    expect(mosaicReach(0)).toBe(MOSAIC_MIN_REACH_M)
    expect(mosaicReach(-20)).toBe(MOSAIC_MIN_REACH_M)
    expect(mosaicReach(6500) / 1000).toBeCloseTo(287.8, 0)
  })

  it('puts the view center in the middle tile at the most detailed zoom near the ground', () => {
    const plan = planMosaic(atlas, 7.75, 46, mosaicReach(2000))
    expect(plan).toEqual({ z: 6, x0: 32, y0: 21, nx: 3, ny: 3, rect: [32 / 64, 21 / 64, 3 / 64, 3 / 64] })
    expect(planMosaic(marble, 7.75, 46, mosaicReach(2000)).z).toBe(8)
  })

  it('reaches as far as asked, at the most detailed zoom that does', () => {
    for (const [lon, lat] of [[7.75, 46], [-122.4, 37.8], [151.2, -33.9], [18.9, 69.6], [-68.3, -54.8], [0.01, 0.01]]) {
      for (const height of [0, 2000, 30_000, 400_000, 3_000_000]) {
        for (const imagery of [atlas, marble]) {
          const reach = mosaicReach(height)
          const plan = planMosaic(imagery, lon, lat, reach)
          if (plan.nx === 2 ** plan.z) continue
          // The block contains the point with at least `reach` around it…
          expect(margin(plan, lon, lat)).toBeGreaterThanOrEqual(reach * 0.999)
          // …and no more detailed zoom would.
          if (plan.z < imagery.maximumLevel) {
            const half = (mosaicTilesAcross(imagery.tileSize) - 1) / 2
            expect((half * EQUATOR * Math.cos((lat * Math.PI) / 180)) / 2 ** (plan.z + 1)).toBeLessThan(reach)
          }
        }
      }
    }
  })

  it('wraps columns around the antimeridian', () => {
    const plan = planMosaic(atlas, 179.9, -17, MOSAIC_MIN_REACH_M)
    expect([plan.z, plan.x0, plan.nx]).toEqual([6, 62, 3])
    expect(plan.rect[0]).toBeCloseTo(62 / 64)
    expect(planMosaic(atlas, -179.9, -17, MOSAIC_MIN_REACH_M).x0).toBe(63)
  })

  it('keeps rows inside the world near the poles', () => {
    const north = planMosaic(atlas, 15, 84, MOSAIC_MIN_REACH_M)
    expect(north.y0).toBe(0)
    const south = planMosaic(atlas, 15, -84, MOSAIC_MIN_REACH_M)
    expect(south.y0 + south.ny).toBe(2 ** south.z)
  })

  it('takes the whole world when the view is that wide', () => {
    expect(planMosaic(atlas, 7.75, 46, mosaicReach(20_000_000))).toEqual({ z: 0, x0: 0, y0: 0, nx: 1, ny: 1, rect: [0, 0, 1, 1] })
    const world = planMosaic(marble, 7.75, 46, 12_000_000)
    expect([world.z, world.nx, world.ny, world.rect]).toEqual([2, 4, 4, [0, 0, 1, 1]])
  })

  it('adds a coarser level out to the horizon only when the camera is high', () => {
    expect(planOverlay(atlas, 7.75, 46, 2000)).toEqual({ near: planMosaic(atlas, 7.75, 46, MOSAIC_MIN_REACH_M), far: null })
    expect(planOverlay(atlas, 7.75, 46, 10_000).far).toBeNull()
    const high = planOverlay(atlas, 7.75, 46, 520_000)
    expect([high.near.z, high.far?.z]).toEqual([6, 3])
    expect(planOverlay(marble, 7.75, 46, 20_000).far?.z).toBe(7)
  })

  it('requests no rows outside the source coverage', () => {
    // Atlas: 65° S – 75° N. Row 0 at zoom 6 is above 84° N; row 32 starts at the equator.
    expect(tileRowInBounds(6, 0, atlas.bounds)).toBe(false)
    expect(tileRowInBounds(6, 32, atlas.bounds)).toBe(true)
    expect(tileRowInBounds(6, 63, atlas.bounds)).toBe(false)
    expect(tileRowInBounds(6, 0, marble.bounds)).toBe(true)
    // A row straddling the edge is requested.
    const n = 64
    const rowOf = (lat: number) => Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n)
    expect(tileRowInBounds(6, rowOf(75), atlas.bounds)).toBe(true)
  })
})
