/**
 * Math of the 2D overview map (SPEC §5.5): Web Mercator tiles laid out as plain DOM images,
 * the camera marker with its view wedge, and the inverse mapping for clicks and drags.
 * Pure, so it is unit-tested; the component and the engine only call into it.
 */

/** Web Mercator stops at ±85.0511° (the square world of XYZ tiles). */
export const MAX_MERCATOR_LAT = 85.05112878
const EARTH_RADIUS = 6378137
const EARTH_CIRCUMFERENCE = 2 * Math.PI * EARTH_RADIUS
export const MIN_OVERVIEW_ZOOM = 1
export const MAX_OVERVIEW_ZOOM = 19
/** Longest view reach drawn (far beyond this the wedge is just "towards the horizon"). */
export const MAX_REACH = 120_000
const MIN_REACH = 150
/** Fraction of the map's shorter side the view reach should span at the automatic zoom. */
const REACH_FILL = 0.42
/** How far ahead of the camera the map centers, as a fraction of the reach. */
const CENTER_AHEAD = 0.3

export interface Point {
  x: number
  y: number
}

export interface LonLat {
  longitude: number
  latitude: number
}

export interface TilePlacement {
  key: string
  z: number
  /** Wrapped tile column (what the tile server is asked for). */
  x: number
  /** Unwrapped column: which copy of the world the tile is drawn in. */
  column: number
  y: number
  /** Position of the tile's top-left corner in map pixels. */
  left: number
  top: number
}

export interface Bounds {
  north: number
  south: number
  east: number
  west: number
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))
const rad = (d: number) => (d * Math.PI) / 180
const deg = (r: number) => (r * 180) / Math.PI

export function worldSize(zoom: number, tileSize: number): number {
  return tileSize * 2 ** zoom
}

/** Longitude/latitude → world pixels at a zoom (x east from −180°, y south from the top). */
export function project(p: LonLat, zoom: number, tileSize: number): Point {
  const size = worldSize(zoom, tileSize)
  const lat = rad(clamp(p.latitude, -MAX_MERCATOR_LAT, MAX_MERCATOR_LAT))
  return {
    x: ((p.longitude + 180) / 360) * size,
    y: (0.5 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / (2 * Math.PI)) * size
  }
}

/** World pixels → longitude (wrapped to [−180, 180)) and latitude. */
export function unproject(p: Point, zoom: number, tileSize: number): LonLat {
  const size = worldSize(zoom, tileSize)
  const lon = (p.x / size) * 360 - 180
  const n = Math.PI * (1 - (2 * clamp(p.y, 0, size)) / size)
  return { longitude: ((((lon + 180) % 360) + 360) % 360) - 180, latitude: deg(Math.atan(Math.sinh(n))) }
}

/** Ground meters per map pixel at a latitude. */
export function metersPerPixel(latitude: number, zoom: number, tileSize: number): number {
  return (EARTH_CIRCUMFERENCE * Math.cos(rad(clamp(latitude, -MAX_MERCATOR_LAT, MAX_MERCATOR_LAT)))) / worldSize(zoom, tileSize)
}

/**
 * Horizontal angle of view (degrees) of a perspective frustum whose `fov` spans the canvas's
 * longer side (Cesium's PerspectiveFrustum convention).
 */
export function horizontalFov(fovDeg: number, aspectRatio: number): number {
  if (!(aspectRatio > 0)) return fovDeg
  if (aspectRatio >= 1) return fovDeg
  return deg(2 * Math.atan(Math.tan(rad(fovDeg) / 2) * aspectRatio))
}

/**
 * How far ahead the camera looks, in ground meters, from its height above the ground and its
 * pitch, on flat ground and without picking (§5.3): to the view center when looking down,
 * to the visible horizon when looking level or up. Top-down views reach half their footprint.
 */
export function viewReach(heightAboveGround: number, pitchDeg: number, hfovDeg: number): number {
  const h = Math.max(heightAboveGround, 1.7)
  const horizon = Math.sqrt(2 * EARTH_RADIUS * h + h * h)
  const footprint = h * Math.tan(rad(clamp(hfovDeg, 1, 170)) / 2)
  const down = -pitchDeg
  const reach = down > 1 ? Math.min(h / Math.tan(rad(Math.min(down, 90))), horizon) : horizon
  return clamp(Math.max(reach, footprint), MIN_REACH, MAX_REACH)
}

/** The fractional zoom at which the reach spans REACH_FILL of the map's shorter side. */
export function idealZoom(latitude: number, reach: number, mapPixels: number, tileSize: number): number {
  const mpp = Math.max(reach, MIN_REACH) / Math.max(1, REACH_FILL * mapPixels)
  const circumference = EARTH_CIRCUMFERENCE * Math.cos(rad(clamp(latitude, -MAX_MERCATOR_LAT, MAX_MERCATOR_LAT)))
  return Math.log2(circumference / (tileSize * mpp))
}

/**
 * Integer tile zoom for an ideal zoom plus the user's offset. The current zoom is kept while
 * the target stays within a band around it, so a camera drifting up and down doesn't swap
 * every tile back and forth at a boundary.
 */
export function chooseZoom(ideal: number, offset: number, current: number | null): number {
  const target = ideal + offset
  if (current !== null && target >= current - 0.25 && target < current + 1.25) {
    return clamp(current, MIN_OVERVIEW_ZOOM, MAX_OVERVIEW_ZOOM)
  }
  return clamp(Math.floor(target), MIN_OVERVIEW_ZOOM, MAX_OVERVIEW_ZOOM)
}

/** Unit vector of a compass heading on the north-up map (y grows southwards). */
export function headingVector(headingDeg: number): Point {
  return { x: Math.sin(rad(headingDeg)), y: -Math.cos(rad(headingDeg)) }
}

/**
 * The map's center in world pixels: a little ahead of the camera along its heading, so the
 * view wedge gets more of the map than what lies behind the camera.
 */
export function mapCenter(camera: LonLat, headingDeg: number, reach: number, zoom: number, tileSize: number): Point {
  const at = project(camera, zoom, tileSize)
  const ahead = (reach * CENTER_AHEAD) / metersPerPixel(camera.latitude, zoom, tileSize)
  const v = headingVector(headingDeg)
  return { x: at.x + v.x * ahead, y: at.y + v.y * ahead }
}

/** Shifts a world x by whole worlds so it lands nearest to a reference x (antimeridian). */
export function nearestWrap(x: number, reference: number, size: number): number {
  return x + Math.round((reference - x) / size) * size
}

/**
 * The tiles covering a map of `width` × `height` pixels centered on world pixel `center`.
 * Columns wrap around the antimeridian; rows outside the world are left out.
 */
export function visibleTiles(center: Point, zoom: number, width: number, height: number, tileSize: number): TilePlacement[] {
  const n = 2 ** zoom
  const left = center.x - width / 2
  const top = center.y - height / 2
  const x0 = Math.floor(left / tileSize)
  const x1 = Math.floor((left + width - 1e-9) / tileSize)
  const y0 = Math.max(0, Math.floor(top / tileSize))
  const y1 = Math.min(n - 1, Math.floor((top + height - 1e-9) / tileSize))
  const tiles: TilePlacement[] = []
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const x = ((tx % n) + n) % n
      tiles.push({
        key: `${zoom}/${tx}/${ty}`,
        z: zoom,
        x,
        column: tx,
        y: ty,
        left: Math.round(tx * tileSize - left),
        top: Math.round(ty * tileSize - top)
      })
    }
  }
  return tiles
}

/** A world pixel → map pixel (relative to the map's top-left corner). */
export function toMap(world: Point, center: Point, width: number, height: number, worldPixels: number): Point {
  return { x: nearestWrap(world.x, center.x, worldPixels) - center.x + width / 2, y: world.y - center.y + height / 2 }
}

/** A map pixel → longitude/latitude. */
export function mapToLonLat(px: Point, center: Point, width: number, height: number, zoom: number, tileSize: number): LonLat {
  return unproject({ x: center.x + px.x - width / 2, y: center.y + px.y - height / 2 }, zoom, tileSize)
}

/**
 * Where a map drag ("grab the ground") puts the camera: the ground under the pointer stays
 * under it, so the camera moves against the pointer by the same map distance.
 */
export function dragCamera(start: LonLat, dx: number, dy: number, zoom: number, tileSize: number): LonLat {
  const p = project(start, zoom, tileSize)
  return unproject({ x: p.x - dx, y: p.y - dy }, zoom, tileSize)
}

/**
 * The view wedge as an SVG path in map pixels: apex at the camera, opening by the horizontal
 * angle of view around the heading, `length` pixels long, closed by an arc.
 */
export function wedgePath(apex: Point, headingDeg: number, hfovDeg: number, length: number): string {
  const half = clamp(hfovDeg, 1, 170) / 2
  const a = headingVector(headingDeg - half)
  const b = headingVector(headingDeg + half)
  const f = (v: number) => v.toFixed(1)
  const p1 = { x: apex.x + a.x * length, y: apex.y + a.y * length }
  const p2 = { x: apex.x + b.x * length, y: apex.y + b.y * length }
  return `M${f(apex.x)} ${f(apex.y)} L${f(p1.x)} ${f(p1.y)} A${f(length)} ${f(length)} 0 0 1 ${f(p2.x)} ${f(p2.y)} Z`
}

/** Geographic bounds of the map, for the attribution query. */
export function mapBounds(center: Point, zoom: number, width: number, height: number, tileSize: number): Bounds {
  const nw = mapToLonLat({ x: 0, y: 0 }, center, width, height, zoom, tileSize)
  const se = mapToLonLat({ x: width, y: height }, center, width, height, zoom, tileSize)
  return { north: nw.latitude, south: se.latitude, west: nw.longitude, east: se.longitude }
}

/** The Map Tiles API 2D tile URL for a session. */
export function tileUrl(template: string, z: number, x: number, y: number): string {
  return template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))
}
