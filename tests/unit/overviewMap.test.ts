import { describe, expect, it } from 'vitest'
import { defaultSettings, OVERVIEW_ZOOM_OFFSET, sanitizeSettings } from '@shared/settings'
import {
  chooseZoom,
  dragCamera,
  headingVector,
  horizontalFov,
  idealZoom,
  mapBounds,
  mapCenter,
  mapToLonLat,
  MAX_MERCATOR_LAT,
  MAX_OVERVIEW_ZOOM,
  MAX_REACH,
  metersPerPixel,
  MIN_OVERVIEW_ZOOM,
  nearestWrap,
  project,
  tileUrl,
  toMap,
  unproject,
  viewReach,
  visibleTiles,
  wedgePath,
  worldSize
} from '../../src/renderer/src/lib/overviewMap'

const TS = 256

describe('overview map: Web Mercator', () => {
  it('projects known points onto the tile grid', () => {
    expect(project({ longitude: 0, latitude: 0 }, 0, TS)).toEqual({ x: 128, y: 128 })
    const nw = project({ longitude: -180, latitude: MAX_MERCATOR_LAT }, 3, TS)
    expect(nw.x).toBeCloseTo(0, 6)
    expect(nw.y).toBeCloseTo(0, 3)
    // Zermatt: slippy map tile 12/2136/1456 (x = (lon + 180) / 360 · 2^z, y = (1 − asinh(tan φ) / π) / 2 · 2^z).
    const z = project({ longitude: 7.7491, latitude: 46.0207 }, 12, TS)
    expect(Math.floor(z.x / TS)).toBe(2136)
    expect(Math.floor(z.y / TS)).toBe(1456)
    expect(z.y / TS).toBeCloseTo(((1 - Math.asinh(Math.tan((46.0207 * Math.PI) / 180)) / Math.PI) / 2) * 4096, 9)
  })

  it('round-trips through unproject and wraps longitude', () => {
    for (const p of [
      { longitude: 7.75, latitude: 46.02 },
      { longitude: -122.42, latitude: 37.77 },
      { longitude: 179.99, latitude: -45 },
      { longitude: -70, latitude: -80 }
    ]) {
      const back = unproject(project(p, 14, TS), 14, TS)
      expect(back.longitude).toBeCloseTo(p.longitude, 9)
      expect(back.latitude).toBeCloseTo(p.latitude, 9)
    }
    const east = unproject({ x: worldSize(2, TS) + 10, y: 512 }, 2, TS)
    expect(east.longitude).toBeCloseTo(-180 + (10 / 1024) * 360, 9)
  })

  it('has the standard ground resolution', () => {
    // 156 543 m per 256 px tile pixel at zoom 0 on the equator, halving per zoom, × cos(latitude).
    expect(metersPerPixel(0, 0, TS)).toBeCloseTo(156543.03, 1)
    expect(metersPerPixel(60, 10, TS)).toBeCloseTo(156543.03 / 1024 / 2, 1)
  })
})

describe('overview map: camera marker and zoom', () => {
  it('takes the horizontal angle of view from Cesium’s longer-side fov', () => {
    expect(horizontalFov(60, 16 / 9)).toBe(60)
    // Portrait: fov spans the height.
    expect(horizontalFov(60, 0.5)).toBeCloseTo((2 * Math.atan(Math.tan(Math.PI / 6) * 0.5) * 180) / Math.PI, 9)
  })

  it('reaches to the view center when looking down, to the horizon when looking level', () => {
    // 1000 m up, 45° down: the view center is 1000 m ahead.
    expect(viewReach(1000, -45, 60)).toBeCloseTo(1000, 6)
    // Level at 1000 m: the visible horizon, ~113 km.
    expect(viewReach(1000, 0, 60)).toBeCloseTo(Math.sqrt(2 * 6378137 * 1000 + 1e6), 0)
    // Looking up is like level.
    expect(viewReach(1000, 20, 60)).toBe(viewReach(1000, 0, 60))
    // Shallow at altitude: never past the horizon or the cap.
    expect(viewReach(9000, -2, 60)).toBe(MAX_REACH)
    // Top-down: half the footprint, not zero.
    expect(viewReach(2000, -90, 60)).toBeCloseTo(2000 * Math.tan(Math.PI / 6), 6)
    // Standing on the ground still draws something.
    expect(viewReach(0, -10, 60)).toBeGreaterThan(100)
  })

  it('zooms out as the reach grows, and doesn’t flip zooms at a boundary', () => {
    const near = idealZoom(46, 1000, 200, TS)
    const far = idealZoom(46, 64_000, 200, TS)
    expect(near - far).toBeCloseTo(6, 9)
    // At the ideal zoom the reach spans a fixed share of the map.
    const z = idealZoom(46, 5000, 200, TS)
    expect(5000 / metersPerPixel(46, z, TS)).toBeCloseTo(0.42 * 200, 6)

    expect(chooseZoom(12.6, 0, null)).toBe(12)
    expect(chooseZoom(12.6, -2, null)).toBe(10)
    // Hysteresis: small drifts keep the current zoom.
    expect(chooseZoom(11.9, 0, 12)).toBe(12)
    expect(chooseZoom(13.1, 0, 12)).toBe(12)
    expect(chooseZoom(11.6, 0, 12)).toBe(11)
    expect(chooseZoom(13.4, 0, 12)).toBe(13)
    expect(chooseZoom(40, 0, null)).toBe(MAX_OVERVIEW_ZOOM)
    expect(chooseZoom(-3, 0, null)).toBe(MIN_OVERVIEW_ZOOM)
  })

  it('centers ahead of the camera, along its heading', () => {
    const cam = { longitude: 7.75, latitude: 46 }
    const at = project(cam, 12, TS)
    const north = mapCenter(cam, 0, 3000, 12, TS)
    expect(north.x).toBeCloseTo(at.x, 9)
    expect(north.y).toBeLessThan(at.y)
    const east = mapCenter(cam, 90, 3000, 12, TS)
    expect(east.x).toBeGreaterThan(at.x)
    expect(east.y).toBeCloseTo(at.y, 9)
    expect((east.x - at.x) * metersPerPixel(46, 12, TS)).toBeCloseTo(900, 6)
  })

  it('draws the wedge around the heading', () => {
    expect(headingVector(90).x).toBeCloseTo(1, 12)
    expect(headingVector(90).y).toBeCloseTo(0, 12)
    // Facing north with a 90° lens: edges to the north-west and north-east, arc clockwise.
    expect(wedgePath({ x: 100, y: 100 }, 0, 90, 10)).toBe('M100.0 100.0 L92.9 92.9 A10.0 10.0 0 0 1 107.1 92.9 Z')
  })
})

describe('overview map: tiles, clicks and drags', () => {
  it('covers the map with tiles, wrapping columns at the antimeridian', () => {
    const center = project({ longitude: 7.75, latitude: 46 }, 10, TS)
    const tiles = visibleTiles(center, 10, 240, 200, TS)
    // 240 × 200 px needs 2–3 columns and 1–2 rows.
    expect(tiles.length).toBeGreaterThanOrEqual(2)
    expect(tiles.length).toBeLessThanOrEqual(6)
    for (const t of tiles) {
      expect(t.left).toBeLessThan(240)
      expect(t.left + TS).toBeGreaterThan(0)
      expect(t.top).toBeLessThan(200)
      expect(t.top + TS).toBeGreaterThan(0)
    }
    // Every map pixel is under exactly one tile.
    for (const [x, y] of [[0, 0], [239, 199], [120, 100], [0, 199]]) {
      expect(tiles.filter((t) => x >= t.left && x < t.left + TS && y >= t.top && y < t.top + TS)).toHaveLength(1)
    }

    const dateline = visibleTiles(project({ longitude: 179.99, latitude: 0 }, 3, TS), 3, 240, 200, TS)
    expect(dateline.map((t) => t.x).sort()).toEqual([0, 7, 0, 7].sort())
    expect(new Set(dateline.map((t) => t.key)).size).toBe(dateline.length)

    // Near the pole, rows past the world's edge are left out.
    const pole = visibleTiles(project({ longitude: 0, latitude: 85 }, 2, TS), 2, 240, 200, TS)
    expect(pole.every((t) => t.y >= 0)).toBe(true)
  })

  it('maps clicks back to the ground they show', () => {
    const cam = { longitude: 7.75, latitude: 46.02 }
    const center = mapCenter(cam, 30, 4000, 13, TS)
    const size = worldSize(13, TS)
    const px = toMap(project(cam, 13, TS), center, 240, 200, size)
    const back = mapToLonLat(px, center, 240, 200, 13, TS)
    expect(back.longitude).toBeCloseTo(cam.longitude, 9)
    expect(back.latitude).toBeCloseTo(cam.latitude, 9)
    // Across the antimeridian the marker stays next to the map center.
    expect(nearestWrap(10, size - 10, size)).toBe(size + 10)
    const wrapped = toMap(project({ longitude: -179.999, latitude: 0 }, 13, TS), project({ longitude: 179.999, latitude: 0 }, 13, TS), 240, 200, size)
    expect(Math.abs(wrapped.x - 120)).toBeLessThan(20)
  })

  it('a drag carries the camera against the pointer, like grabbing the ground', () => {
    const start = { longitude: 7.75, latitude: 46.02 }
    const moved = dragCamera(start, 50, 0, 12, TS)
    // Dragging the map east shows ground further west: the camera moves west.
    expect(moved.longitude).toBeCloseTo(start.longitude - (50 / worldSize(12, TS)) * 360, 9)
    expect(moved.latitude).toBeCloseTo(start.latitude, 9)
    // Pulling the map up brings the ground to the south into view.
    const south = dragCamera(start, 0, -40, 12, TS)
    expect(south.latitude).toBeLessThan(start.latitude)
    // The camera lands where the map center moved: dragging back returns exactly.
    const back = dragCamera(dragCamera(start, 33, -21, 12, TS), -33, 21, 12, TS)
    expect(back.longitude).toBeCloseTo(start.longitude, 9)
    expect(back.latitude).toBeCloseTo(start.latitude, 9)
  })

  it('bounds the map for the attribution request', () => {
    const center = project({ longitude: 7.75, latitude: 46 }, 10, TS)
    const b = mapBounds(center, 10, 240, 200, TS)
    expect(b.west).toBeLessThan(7.75)
    expect(b.east).toBeGreaterThan(7.75)
    expect(b.south).toBeLessThan(46)
    expect(b.north).toBeGreaterThan(46)
    expect(b.east - b.west).toBeCloseTo((240 / worldSize(10, TS)) * 360, 9)
  })

  it('fills the session’s URL template', () => {
    expect(tileUrl('https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=s&key=k', 5, 16, 11)).toBe(
      'https://tile.googleapis.com/v1/2dtiles/5/16/11?session=s&key=k'
    )
  })
})

describe('overview map settings', () => {
  it('is off by default and sanitized from disk', () => {
    expect(defaultSettings().overviewMap).toEqual({ enabled: false, zoomOffset: 0 })
    expect(sanitizeSettings({ overviewMap: { enabled: true, zoomOffset: 2.4 } }).overviewMap).toEqual({ enabled: true, zoomOffset: 2 })
    expect(sanitizeSettings({ overviewMap: { enabled: 'yes', zoomOffset: 99 } }).overviewMap).toEqual({
      enabled: false,
      zoomOffset: OVERVIEW_ZOOM_OFFSET.max
    })
    expect(sanitizeSettings({ overviewMap: [] }).overviewMap).toEqual(defaultSettings().overviewMap)
  })
})
