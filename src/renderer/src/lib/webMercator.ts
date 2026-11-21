import { MAP_ZOOM_RANGE } from '@shared/settings'

/**
 * Math of Map mode (SPEC §5.5): a Web Mercator view (center and fractional zoom), the tiles
 * it needs, panning and zooming about a point, and the hand-over between the 3D camera and
 * the map in both directions. Pure, so it is unit-tested; MapMode.tsx and the engine call it.
 */

/** Tiles are laid out on a 256 px grid (2× tiles for dense displays cover the same cell). */
export const TILE = 256
/** Web Mercator stops at ±85.0511° (the square world of XYZ tiles). */
export const MAX_MERCATOR_LAT = 85.05112878
export const MIN_MAP_ZOOM = MAP_ZOOM_RANGE.min
export const MAX_MAP_ZOOM = MAP_ZOOM_RANGE.max
const EARTH_RADIUS = 6378137
const EARTH_CIRCUMFERENCE = 2 * Math.PI * EARTH_RADIUS
/** Longest view reach drawn by the camera wedge. */
export const MAX_REACH = 120_000
const MIN_REACH = 150
/** Looking down more steeply than this, the 3D view has a view center on the ground. */
export const LOOKING_DOWN = -10
/** The 3D view opened from the map looks down at least this steeply. */
export const MAX_ENTRY_PITCH = -15
const MIN_RANGE = 150
const MAX_RANGE = 4.0e6

export interface Point {
  x: number
  y: number
}

export interface LonLat {
  longitude: number
  latitude: number
}

/** What the map shows: its center and a fractional zoom. */
export interface MapView extends LonLat {
  zoom: number
}

export interface Bounds {
  north: number
  south: number
  east: number
  west: number
}

/** The part of the 3D camera the hand-over needs (degrees, meters). */
export interface CameraPose extends LonLat {
  /** Above the ground below the camera. */
  heightAboveGround: number
  heading: number
  pitch: number
  /** Horizontal angle of view. */
  fov: number
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))
const rad = (d: number) => (d * Math.PI) / 180
const deg = (r: number) => (r * 180) / Math.PI
const wrapLon = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180

export function worldSize(zoom: number): number {
  return TILE * 2 ** zoom
}

export function clampZoom(zoom: number): number {
  return clamp(zoom, MIN_MAP_ZOOM, MAX_MAP_ZOOM)
}

/** Longitude/latitude → world pixels at a (fractional) zoom: x east from −180°, y south from the top. */
export function project(p: LonLat, zoom: number): Point {
  const size = worldSize(zoom)
  const lat = rad(clamp(p.latitude, -MAX_MERCATOR_LAT, MAX_MERCATOR_LAT))
  return {
    x: ((p.longitude + 180) / 360) * size,
    y: (0.5 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / (2 * Math.PI)) * size
  }
}

/** World pixels → longitude (wrapped to [−180, 180)) and latitude. */
export function unproject(p: Point, zoom: number): LonLat {
  const size = worldSize(zoom)
  const n = Math.PI * (1 - (2 * clamp(p.y, 0, size)) / size)
  return { longitude: wrapLon((p.x / size) * 360 - 180), latitude: deg(Math.atan(Math.sinh(n))) }
}

/** Ground meters per map pixel at a latitude. */
export function metersPerPixel(latitude: number, zoom: number): number {
  return (EARTH_CIRCUMFERENCE * Math.cos(rad(clamp(latitude, -MAX_MERCATOR_LAT, MAX_MERCATOR_LAT)))) / worldSize(zoom)
}

/** The zoom at which one map pixel is `mpp` ground meters. */
export function zoomForMetersPerPixel(latitude: number, mpp: number): number {
  return Math.log2((EARTH_CIRCUMFERENCE * Math.cos(rad(clamp(latitude, -MAX_MERCATOR_LAT, MAX_MERCATOR_LAT)))) / (TILE * mpp))
}

/** Shifts a world x by whole worlds so it lands nearest to a reference x (antimeridian). */
export function nearestWrap(x: number, reference: number, size: number): number {
  return x + Math.round((reference - x) / size) * size
}

/** A ground position → screen pixel of a `width` × `height` map showing `view`. */
export function toScreen(p: LonLat, view: MapView, width: number, height: number): Point {
  const c = project(view, view.zoom)
  const w = project(p, view.zoom)
  return { x: nearestWrap(w.x, c.x, worldSize(view.zoom)) - c.x + width / 2, y: w.y - c.y + height / 2 }
}

/** A screen pixel → ground position. */
export function fromScreen(px: Point, view: MapView, width: number, height: number): LonLat {
  const c = project(view, view.zoom)
  return unproject({ x: c.x + px.x - width / 2, y: c.y + px.y - height / 2 }, view.zoom)
}

/** The view after dragging the map by (dx, dy) screen pixels: the ground follows the pointer. */
export function panBy(view: MapView, dx: number, dy: number): MapView {
  const c = project(view, view.zoom)
  const size = worldSize(view.zoom)
  const next = unproject({ x: c.x - dx, y: clamp(c.y - dy, 0, size) }, view.zoom)
  return { ...next, zoom: view.zoom }
}

/**
 * The view at a new zoom that keeps the ground under `anchor` (screen pixel) where it is, as
 * wheel and pinch zooms do.
 */
export function zoomAround(view: MapView, zoom: number, anchor: Point, width: number, height: number): MapView {
  const z = clampZoom(zoom)
  const ground = fromScreen(anchor, view, width, height)
  const g = project(ground, z)
  const size = worldSize(z)
  const center = unproject({ x: g.x - (anchor.x - width / 2), y: clamp(g.y - (anchor.y - height / 2), 0, size) }, z)
  return { ...center, zoom: z }
}

export interface TileRange {
  zoom: number
  /** Unwrapped columns (they continue past the antimeridian) and clamped rows, inclusive. */
  x0: number
  x1: number
  y0: number
  y1: number
}

/** The tiles at whole zoom `tileZoom` covering a `width` × `height` view, plus `margin` tiles. */
export function tileRange(view: MapView, tileZoom: number, width: number, height: number, margin = 0): TileRange {
  const scale = 2 ** (view.zoom - tileZoom)
  const c = project(view, tileZoom)
  const halfW = width / 2 / scale
  const halfH = height / 2 / scale
  const n = 2 ** tileZoom
  return {
    zoom: tileZoom,
    x0: Math.floor((c.x - halfW) / TILE) - margin,
    x1: Math.floor((c.x + halfW - 1e-9) / TILE) + margin,
    y0: Math.max(0, Math.floor((c.y - halfH) / TILE) - margin),
    y1: Math.min(n - 1, Math.floor((c.y + halfH - 1e-9) / TILE) + margin)
  }
}

/**
 * The tile zoom drawn for a fractional view zoom: the nearest whole zoom, but the current one
 * is kept until the view is 0.65 zooms past it (tiles shown at 64–157 %), so an eased zoom
 * near a half step doesn't flip between two tile sets.
 */
export function tileZoomFor(zoom: number, current: number | null = null): number {
  const z = clampZoom(zoom)
  if (current !== null && Math.abs(z - current) <= 0.65) return current
  return Math.round(z)
}

/** Wraps an unwrapped tile column into the server's range. */
export function wrapColumn(x: number, tileZoom: number): number {
  const n = 2 ** tileZoom
  return ((x % n) + n) % n
}

/** Geographic bounds of the view, for the attribution request. */
export function viewBounds(view: MapView, width: number, height: number): Bounds {
  const nw = fromScreen({ x: 0, y: 0 }, view, width, height)
  const se = fromScreen({ x: width, y: height }, view, width, height)
  return { north: nw.latitude, south: se.latitude, west: nw.longitude, east: se.longitude }
}

// ───────────── the camera on the map ─────────────

/**
 * Horizontal angle of view (degrees) of a perspective frustum whose `fov` spans the canvas's
 * longer side (Cesium's PerspectiveFrustum convention).
 */
export function horizontalFov(fovDeg: number, aspectRatio: number): number {
  if (!(aspectRatio > 0) || aspectRatio >= 1) return fovDeg
  return deg(2 * Math.atan(Math.tan(rad(fovDeg) / 2) * aspectRatio))
}

/**
 * How far ahead the camera looks, in ground meters, on flat ground and without picking: to
 * the view center when looking down, to the visible horizon when looking level or up.
 * Top-down views reach half their footprint.
 */
export function viewReach(heightAboveGround: number, pitchDeg: number, hfovDeg: number): number {
  const h = Math.max(heightAboveGround, 1.7)
  const horizon = Math.sqrt(2 * EARTH_RADIUS * h + h * h)
  const footprint = h * Math.tan(rad(clamp(hfovDeg, 1, 170)) / 2)
  const down = -pitchDeg
  const reach = down > 1 ? Math.min(h / Math.tan(rad(Math.min(down, 90))), horizon) : horizon
  return clamp(Math.max(reach, footprint), MIN_REACH, MAX_REACH)
}

/** Unit vector of a compass heading on the north-up map (y grows southwards). */
export function headingVector(headingDeg: number): Point {
  return { x: Math.sin(rad(headingDeg)), y: -Math.cos(rad(headingDeg)) }
}

/**
 * The camera's view wedge as an SVG path in screen pixels: apex at the camera, opening by
 * the horizontal angle of view around the heading, `length` pixels long, closed by an arc.
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

/** The ground point `distance` meters from `from` along a compass bearing (spherical earth). */
export function destination(from: LonLat, bearingDeg: number, distance: number): LonLat {
  const d = distance / EARTH_RADIUS
  const b = rad(bearingDeg)
  const lat1 = rad(from.latitude)
  const lon1 = rad(from.longitude)
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b))
  const lon2 = lon1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2))
  return { longitude: wrapLon(deg(lon2)), latitude: deg(lat2) }
}

/**
 * The map that opens from a 3D view: centered on the view center when looking down (the
 * estimate `target`, else the point the pitch points at over flat ground), at the scale the
 * 3D view has there; looking level or up, centered on the camera with its reach in view.
 */
export function viewFromCamera(cam: CameraPose, target: LonLat | null, width: number): MapView {
  const h = Math.max(cam.heightAboveGround, 1.7)
  const halfFov = rad(clamp(cam.fov, 1, 170)) / 2
  if (cam.pitch < LOOKING_DOWN) {
    const down = rad(-cam.pitch)
    const range = h / Math.sin(down)
    const center = target ?? destination(cam, cam.heading, h / Math.tan(down))
    const mpp = (2 * range * Math.tan(halfFov)) / Math.max(width, 1)
    return { ...center, zoom: clampZoom(zoomForMetersPerPixel(center.latitude, mpp)) }
  }
  const reach = viewReach(h, cam.pitch, cam.fov)
  const mpp = reach / (0.35 * Math.max(width, 1))
  return { longitude: cam.longitude, latitude: cam.latitude, zoom: clampZoom(zoomForMetersPerPixel(cam.latitude, mpp)) }
}

/**
 * The 3D view that opens from the map: looking at the map's center with the given heading and
 * pitch (at least MAX_ENTRY_PITCH down), from the distance at which the 3D view's scale at
 * that point matches the map's. Height is above the ground at the center.
 */
export function cameraForView(
  view: MapView,
  look: { heading: number; pitch: number; fov: number },
  width: number,
  groundHeight: number
): { longitude: number; latitude: number; height: number; heading: number; pitch: number; roll: number } {
  const pitch = clamp(look.pitch, -90, MAX_ENTRY_PITCH)
  const halfFov = rad(clamp(look.fov, 1, 170)) / 2
  const mpp = metersPerPixel(view.latitude, view.zoom)
  const range = clamp((mpp * Math.max(width, 1)) / (2 * Math.tan(halfFov)), MIN_RANGE, MAX_RANGE)
  const down = rad(-pitch)
  const back = destination(view, look.heading + 180, range * Math.cos(down))
  return { ...back, height: groundHeight + range * Math.sin(down), heading: look.heading, pitch, roll: 0 }
}

/** Two views are the same to within a fraction of a pixel. */
export function sameView(a: MapView, b: MapView): boolean {
  if (Math.abs(a.zoom - b.zoom) > 1e-3) return false
  const pa = project(a, a.zoom)
  const pb = project(b, a.zoom)
  return Math.abs(nearestWrap(pa.x, pb.x, worldSize(a.zoom)) - pb.x) < 0.5 && Math.abs(pa.y - pb.y) < 0.5
}

/** The Map Tiles API 2D tile URL for a session template. */
export function tileUrl(template: string, z: number, x: number, y: number): string {
  return template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))
}
