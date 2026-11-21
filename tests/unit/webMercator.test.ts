import { describe, expect, it } from 'vitest'
import { defaultSettings, sanitizeSettings } from '@shared/settings'
import { sessionBody, viewportKey } from '../../src/renderer/src/engine/googleTiles'
import {
  cameraForView,
  destination,
  fromScreen,
  headingVector,
  horizontalFov,
  MAX_ENTRY_PITCH,
  MAX_MAP_ZOOM,
  MAX_MERCATOR_LAT,
  MAX_REACH,
  metersPerPixel,
  MIN_MAP_ZOOM,
  nearestWrap,
  panBy,
  project,
  sameView,
  TILE,
  backdropZoomFor,
  centerNear,
  tileRange,
  tileUrl,
  tileZoomFor,
  toScreen,
  unproject,
  viewBounds,
  viewFromCamera,
  viewReach,
  wedgePath,
  worldSize,
  wrapColumn,
  zoomAround,
  zoomForMetersPerPixel
} from '../../src/renderer/src/lib/webMercator'

const W = 1440
const H = 900
const ZERMATT = { longitude: 7.7491, latitude: 46.0207 }

/** Great-circle distance in meters (spherical, as `destination`). */
function distance(a: { longitude: number; latitude: number }, b: { longitude: number; latitude: number }): number {
  const r = Math.PI / 180
  const h =
    Math.sin(((b.latitude - a.latitude) * r) / 2) ** 2 +
    Math.cos(a.latitude * r) * Math.cos(b.latitude * r) * Math.sin(((b.longitude - a.longitude) * r) / 2) ** 2
  return 2 * 6378137 * Math.asin(Math.sqrt(h))
}

describe('Web Mercator', () => {
  it('projects onto the slippy-map tile grid', () => {
    expect(project({ longitude: 0, latitude: 0 }, 0)).toEqual({ x: 128, y: 128 })
    const nw = project({ longitude: -180, latitude: MAX_MERCATOR_LAT }, 3)
    expect(nw.x).toBeCloseTo(0, 6)
    expect(nw.y).toBeCloseTo(0, 3)
    // x = (lon + 180) / 360 · 2^z, y = (1 − asinh(tan φ) / π) / 2 · 2^z: tile 12/2136/1456.
    const z = project(ZERMATT, 12)
    expect(Math.floor(z.x / TILE)).toBe(2136)
    expect(z.y / TILE).toBeCloseTo(((1 - Math.asinh(Math.tan((ZERMATT.latitude * Math.PI) / 180)) / Math.PI) / 2) * 4096, 9)
    // Fractional zooms scale continuously.
    expect(project(ZERMATT, 12.5).x).toBeCloseTo(project(ZERMATT, 12).x * Math.SQRT2, 6)
  })

  it('round-trips and wraps longitude', () => {
    for (const p of [ZERMATT, { longitude: -122.42, latitude: 37.77 }, { longitude: 179.99, latitude: -45 }, { longitude: -70, latitude: -80 }]) {
      const back = unproject(project(p, 14.3), 14.3)
      expect(back.longitude).toBeCloseTo(p.longitude, 9)
      expect(back.latitude).toBeCloseTo(p.latitude, 9)
    }
    expect(unproject({ x: worldSize(2) + 10, y: 512 }, 2).longitude).toBeCloseTo(-180 + (10 / 1024) * 360, 9)
  })

  it('has the standard ground resolution, and inverts it', () => {
    expect(metersPerPixel(0, 0)).toBeCloseTo(156543.03, 1)
    expect(metersPerPixel(60, 10)).toBeCloseTo(156543.03 / 1024 / 2, 1)
    expect(zoomForMetersPerPixel(46, metersPerPixel(46, 13.37))).toBeCloseTo(13.37, 9)
  })
})

describe('map view: screen, pan and zoom', () => {
  const view = { ...ZERMATT, zoom: 13.4 }

  it('puts the center in the middle of the screen and maps back', () => {
    const c = toScreen(view, view, W, H)
    expect(c.x).toBeCloseTo(W / 2, 9)
    expect(c.y).toBeCloseTo(H / 2, 9)
    const g = fromScreen({ x: 100, y: 700 }, view, W, H)
    const p = toScreen(g, view, W, H)
    expect(p.x).toBeCloseTo(100, 6)
    expect(p.y).toBeCloseTo(700, 6)
    // Across the antimeridian a point stays next to the view, not a world away.
    const dateline = { longitude: 179.999, latitude: 0, zoom: 10 }
    expect(Math.abs(toScreen({ longitude: -179.999, latitude: 0 }, dateline, W, H).x - W / 2)).toBeLessThan(20)
    expect(nearestWrap(10, worldSize(3) - 10, worldSize(3))).toBe(worldSize(3) + 10)
  })

  it('drags the ground with the pointer', () => {
    const grabbed = fromScreen({ x: 300, y: 200 }, view, W, H)
    const next = panBy(view, 50, -30)
    const at = toScreen(grabbed, next, W, H)
    expect(at.x).toBeCloseTo(350, 6)
    expect(at.y).toBeCloseTo(170, 6)
    expect(next.zoom).toBe(view.zoom)
    // Dragging the map east moves the view west.
    expect(next.longitude).toBeLessThan(view.longitude)
  })

  it('zooms about the cursor, keeping the ground under it', () => {
    const anchor = { x: 1100, y: 250 }
    const ground = fromScreen(anchor, view, W, H)
    for (const zoom of [15.2, 11, 13.4001]) {
      const next = zoomAround(view, zoom, anchor, W, H)
      const p = toScreen(ground, next, W, H)
      expect(p.x).toBeCloseTo(anchor.x, 5)
      expect(p.y).toBeCloseTo(anchor.y, 5)
      expect(next.zoom).toBe(zoom)
    }
    expect(zoomAround(view, 40, anchor, W, H).zoom).toBe(MAX_MAP_ZOOM)
    expect(zoomAround(view, -3, anchor, W, H).zoom).toBe(MIN_MAP_ZOOM)
  })

  it('covers the screen with tiles of the nearest whole zoom', () => {
    expect(tileZoomFor(13.4)).toBe(13)
    expect(tileZoomFor(13.6)).toBe(14)
    // The drawn tile zoom holds until the view is 0.65 past it (no flip-flop at half steps).
    expect(tileZoomFor(13.6, 13)).toBe(13)
    expect(tileZoomFor(12.4, 13)).toBe(13)
    expect(tileZoomFor(13.7, 13)).toBe(14)
    expect(tileZoomFor(12.3, 13)).toBe(12)
    expect(tileZoomFor(16.2, 13)).toBe(16)
    const r = tileRange(view, 13, W, H)
    const scale = 2 ** (view.zoom - 13)
    const c = project(view, 13)
    // The corners of the screen fall inside the range.
    for (const [sx, sy] of [[0, 0], [W, H], [0, H], [W, 0]]) {
      const x = Math.floor((c.x + (sx - W / 2) / scale - (sx === W ? 1e-6 : 0)) / TILE)
      const y = Math.floor((c.y + (sy - H / 2) / scale - (sy === H ? 1e-6 : 0)) / TILE)
      expect(x).toBeGreaterThanOrEqual(r.x0)
      expect(x).toBeLessThanOrEqual(r.x1)
      expect(y).toBeGreaterThanOrEqual(r.y0)
      expect(y).toBeLessThanOrEqual(r.y1)
    }
    // A 1440 × 900 window at 132 % tile size: about 5 × 4 tiles.
    expect((r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1)).toBeLessThanOrEqual(6 * 5)
    // Rows stop at the world's edge; columns continue and wrap for the server.
    const pole = tileRange({ longitude: 0, latitude: 84, zoom: 3 }, 3, W, H)
    expect(pole.y0).toBe(0)
    expect(wrapColumn(-1, 3)).toBe(7)
    expect(wrapColumn(9, 3)).toBe(1)
  })

  it('counts columns in a chosen copy of the world (a world narrower than the window)', () => {
    const world = { longitude: 170, latitude: 0, zoom: 2.3 }
    const size = worldSize(2)
    const c = project(world, 2).x
    // The copy one world to the east: the same tiles, columns shifted by 2^z.
    const east = tileRange(world, 2, W, H, 0, c + size)
    const home = tileRange(world, 2, W, H, 0, c)
    expect(east.x0 - home.x0).toBe(4)
    expect(east.x1 - home.x1).toBe(4)
    // 1440 px of a 1260 px world: more columns than the world has, wrapped for the server.
    expect(home.x1 - home.x0 + 1).toBeGreaterThan(4)
    expect(centerNear(world, 2, c + size + 100)).toBeCloseTo(c + size, 9)
    expect(centerNear(world, 2, c - size * 3)).toBeCloseTo(c - size * 3, 9)
  })

  it('keeps a coarse backdrop three zooms down', () => {
    expect(backdropZoomFor(14)).toBe(11)
    expect(backdropZoomFor(4)).toBe(2)
    expect(backdropZoomFor(2)).toBeNull()
  })

  it('bounds the view for attribution', () => {
    const b = viewBounds(view, W, H)
    expect(b.west).toBeLessThan(view.longitude)
    expect(b.east).toBeGreaterThan(view.longitude)
    expect(b.north).toBeGreaterThan(view.latitude)
    expect(b.south).toBeLessThan(view.latitude)
    expect(b.east - b.west).toBeCloseTo((W / worldSize(view.zoom)) * 360, 9)
  })

  it('tells unmoved views apart from moved ones', () => {
    expect(sameView(view, { ...view })).toBe(true)
    expect(sameView(view, panBy(view, 0.2, 0))).toBe(true)
    expect(sameView(view, panBy(view, 2, 0))).toBe(false)
    expect(sameView(view, { ...view, zoom: view.zoom + 0.1 })).toBe(false)
  })
})

describe('hand-over between the 3D view and the map', () => {
  const pose = { ...ZERMATT, heightAboveGround: 2000, heading: 120, pitch: -30, fov: 60 }

  it('opens the map on the 3D view center at the 3D view’s scale', () => {
    const target = { longitude: 7.8, latitude: 46.0 }
    const view = viewFromCamera(pose, target, W)
    expect(view.longitude).toBe(target.longitude)
    expect(view.latitude).toBe(target.latitude)
    // 3D: the view center is 4000 m away along the ray; 2·4000·tan 30° m span the window.
    const mpp3d = (2 * 4000 * Math.tan(Math.PI / 6)) / W
    expect(metersPerPixel(view.latitude, view.zoom)).toBeCloseTo(mpp3d, 6)
    // Without a measured target, the pitch's ground point over flat terrain.
    const flat = viewFromCamera(pose, null, W)
    expect(distance(pose, flat)).toBeCloseTo(2000 / Math.tan(Math.PI / 6), -1)
  })

  it('opens the map on the camera when the 3D view looks level', () => {
    const level = viewFromCamera({ ...pose, heightAboveGround: 1.7, pitch: 0 }, null, W)
    expect(level.longitude).toBe(pose.longitude)
    expect(level.latitude).toBe(pose.latitude)
    // Its reach (the horizon, ~4.7 km) fits in about a third of the window.
    expect(metersPerPixel(level.latitude, level.zoom) * W * 0.35).toBeCloseTo(viewReach(1.7, 0, 60), 3)
  })

  it('opens the 3D view looking at the map’s center, at the map’s scale', () => {
    const view = { ...ZERMATT, zoom: 14 }
    const cam = cameraForView(view, { heading: 120, pitch: -30, fov: 60 }, W, 1600)
    expect(cam.heading).toBe(120)
    expect(cam.pitch).toBe(-30)
    // The camera stands back along the heading, so its view ray meets the center.
    const range = (metersPerPixel(view.latitude, 14) * W) / (2 * Math.tan(Math.PI / 6))
    expect(cam.height).toBeCloseTo(1600 + range * Math.sin(Math.PI / 6), 6)
    expect(distance(cam, view)).toBeCloseTo(range * Math.cos(Math.PI / 6), -1)
    const ahead = destination(cam, cam.heading, range * Math.cos(Math.PI / 6))
    // (Within meters: a great circle's bearing turns slightly along the way.)
    expect(distance(ahead, view)).toBeLessThan(20)
    // Round trip: the map opened from that 3D view is the same map.
    const again = viewFromCamera({ ...cam, heightAboveGround: cam.height - 1600, fov: 60 }, view, W)
    expect(again.zoom).toBeCloseTo(view.zoom, 6)
  })

  it('looks down at least a little when opening from a level view', () => {
    expect(cameraForView({ ...ZERMATT, zoom: 14 }, { heading: 0, pitch: 0, fov: 60 }, W, 0).pitch).toBe(MAX_ENTRY_PITCH)
    expect(cameraForView({ ...ZERMATT, zoom: 14 }, { heading: 0, pitch: -90, fov: 60 }, W, 0).pitch).toBe(-90)
  })
})

describe('camera on the map', () => {
  it('takes the horizontal angle of view from Cesium’s longer-side fov', () => {
    expect(horizontalFov(60, 16 / 9)).toBe(60)
    expect(horizontalFov(60, 0.5)).toBeCloseTo((2 * Math.atan(Math.tan(Math.PI / 6) * 0.5) * 180) / Math.PI, 9)
  })

  it('reaches to the view center looking down, to the horizon looking level', () => {
    expect(viewReach(1000, -45, 60)).toBeCloseTo(1000, 6)
    expect(viewReach(1000, 0, 60)).toBeCloseTo(Math.sqrt(2 * 6378137 * 1000 + 1e6), 0)
    expect(viewReach(1000, 20, 60)).toBe(viewReach(1000, 0, 60))
    expect(viewReach(9000, -2, 60)).toBe(MAX_REACH)
    expect(viewReach(2000, -90, 60)).toBeCloseTo(2000 * Math.tan(Math.PI / 6), 6)
  })

  it('draws the wedge around the heading', () => {
    expect(headingVector(90).x).toBeCloseTo(1, 12)
    expect(wedgePath({ x: 100, y: 100 }, 0, 90, 10)).toBe('M100.0 100.0 L92.9 92.9 A10.0 10.0 0 0 1 107.1 92.9 Z')
  })

  it('finds points along a bearing', () => {
    const east = destination({ longitude: 0, latitude: 0 }, 90, 111_319.49)
    expect(east.longitude).toBeCloseTo(1, 4)
    expect(east.latitude).toBeCloseTo(0, 9)
  })
})

describe('Map Tiles sessions and settings', () => {
  it('asks for hybrid satellite and 2× tiles', () => {
    expect(sessionBody('roadmap')).toEqual({ mapType: 'roadmap', language: 'en-US', region: 'US' })
    expect(sessionBody('terrain').layerTypes).toEqual(['layerRoadmap'])
    expect(sessionBody('satellite').layerTypes).toBeUndefined()
    expect(sessionBody('satellite', { labels: true }).layerTypes).toEqual(['layerRoadmap'])
    expect(sessionBody('roadmap', { highDpi: true })).toMatchObject({ scale: 'scaleFactor2x', highDpi: true })
    expect(viewportKey({ north: 89, south: -89, east: 1, west: 0 }, 3.6)).toBe('85.0000,-85.0000,1.0000,0.0000@4')
    expect(tileUrl('https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=s&key=k', 5, 16, 11)).toBe(
      'https://tile.googleapis.com/v1/2dtiles/5/16/11?session=s&key=k'
    )
  })

  it('keeps Map mode closed by default and sanitizes its view', () => {
    expect(defaultSettings().map).toMatchObject({ open: false, type: 'roadmap' })
    expect(sanitizeSettings({ map: { open: true, longitude: 7.7, latitude: 46, zoom: 13.5, type: 'satellite' } }).map).toEqual({
      open: true,
      longitude: 7.7,
      latitude: 46,
      zoom: 13.5,
      type: 'satellite'
    })
    expect(sanitizeSettings({ map: { open: 'yes', longitude: 500, latitude: -90, zoom: 99, type: 'hybrid' } }).map).toEqual({
      ...defaultSettings().map,
      longitude: 180,
      latitude: -85,
      zoom: MAX_MAP_ZOOM
    })
    expect(sanitizeSettings({ map: [] }).map).toEqual(defaultSettings().map)
  })
})
