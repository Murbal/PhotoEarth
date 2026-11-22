import type { LightPollutionSourceId } from '@shared/types'

/**
 * Tile sources for the light pollution overlay. Each is a Web Mercator XYZ tile set
 * plus, where available, point data for the inspect readout. Adding a source means adding
 * an entry here (and its id to `LIGHT_POLLUTION_SOURCES`, and its origin to the CSP).
 */
export interface LightPollutionSource {
  id: LightPollutionSourceId
  label: string
  /** What the colors mean: modeled sky brightness at the zenith, or light emitted upward. */
  kind: 'sky-brightness' | 'emitted-light'
  imagery: {
    /** `{z}`, `{x}`, `{y}` (XYZ, y from the north) are filled in. */
    url: string
    tileSize: number
    maximumLevel: number
    /** Coverage in degrees; no tiles are requested outside it. */
    bounds: { west: number; south: number; east: number; north: number }
    /** Credit shown while the layer is on screen (HTML). */
    credit: string
  }
  /** Gzipped atlas data tiles (`ATLAS_GRID`): exact modeled values, preferred for readouts. */
  dataUrl?: (tileX: number, tileY: number) => string
  /** The tiles use the atlas zone palette, so a pixel decodes back to its zone. */
  atlasPalette: boolean
  /** Where to read more about the data. */
  info: string
}

const ATLAS_BASE = 'https://djlorenz.github.io/astronomy'
const ATLAS_INFO = 'https://djlorenz.github.io/astronomy/lp/'
export const ATLAS_YEARS = [2025, 2024, 2023, 2022, 2020, 2016] as const

function atlas(year: (typeof ATLAS_YEARS)[number]): LightPollutionSource {
  return {
    id: `atlas-${year}`,
    label: `Light Pollution Atlas ${year}`,
    kind: 'sky-brightness',
    imagery: {
      // 1024 px tiles, native zoom 0–6: ~600 m pixels at the equator (the model's cells are ~1 km).
      url: `${ATLAS_BASE}/image_tiles/tiles${year}/tile_{z}_{x}_{y}.png`,
      tileSize: 1024,
      maximumLevel: 6,
      bounds: { west: -180, south: -65, east: 180, north: 75 },
      credit: `Sky brightness: <a href="${ATLAS_INFO}" target="_blank">Light Pollution Atlas ${year}</a>, D. Lorenz · VIIRS night lights: Earth Observation Group, Colorado School of Mines`
    },
    dataUrl: (x, y) => `${ATLAS_BASE}/binary_tiles/${year}/binary_tile_${x}_${y}.dat.gz`,
    atlasPalette: true,
    info: ATLAS_INFO
  }
}

const BLACK_MARBLE: LightPollutionSource = {
  id: 'black-marble',
  label: 'NASA Black Marble 2016',
  kind: 'emitted-light',
  imagery: {
    url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png',
    tileSize: 256,
    maximumLevel: 8,
    bounds: { west: -180, south: -85.05, east: 180, north: 85.05 },
    credit: 'Night lights: <a href="https://earthobservatory.nasa.gov/features/NightLights" target="_blank">NASA Black Marble 2016</a> (VIIRS), via NASA GIBS'
  },
  atlasPalette: false,
  info: 'https://earthobservatory.nasa.gov/features/NightLights'
}

export const LIGHT_POLLUTION_SOURCE_LIST: readonly LightPollutionSource[] = [...ATLAS_YEARS.map(atlas), BLACK_MARBLE]

export function lightPollutionSource(id: LightPollutionSourceId): LightPollutionSource {
  return LIGHT_POLLUTION_SOURCE_LIST.find((s) => s.id === id) ?? LIGHT_POLLUTION_SOURCE_LIST[0]
}

/**
 * The source point readouts come from: the overlay's own when it has sky brightness data,
 * else the latest atlas (Black Marble shows where light is emitted, not how bright the sky is).
 */
export function readoutSource(id: LightPollutionSourceId): LightPollutionSource {
  const s = lightPollutionSource(id)
  return s.dataUrl || s.atlasPalette ? s : LIGHT_POLLUTION_SOURCE_LIST[0]
}

/** Fills an XYZ template. */
export function tileUrl(template: string, z: number, x: number, y: number): string {
  return template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))
}

// ───────────────────────────── 3D Tiles mosaic ─────────────────────────────

/** Web Mercator's latitude limit, degrees. */
const MERCATOR_MAX_LAT = 85.05112878
const EQUATOR_M = 40_075_016.686
const EARTH_RADIUS_M = 6_371_000
/** Rough longest side of the mosaic, pixels (at least 3 × 3 tiles). */
const MOSAIC_PIXELS = 2048
/** The mosaic covers at least this far around the view center, meters. */
export const MOSAIC_MIN_REACH_M = 150_000

/**
 * The source tiles the overlay on the 3D Tiles is drawn from: a block of tiles around the
 * view center, drawn into one texture. Columns wrap around the antimeridian.
 */
export interface MosaicPlan {
  z: number
  /** First column (0 … 2^z − 1) and row (from the north). */
  x0: number
  y0: number
  /** Tiles across and down. */
  nx: number
  ny: number
  /** The block in world Web Mercator units (0–1 across the world, y from the north): west, north, width, height. */
  rect: [number, number, number, number]
}

/** Tiles across a mosaic of `tileSize`-pixel tiles: odd, so the view center's tile sits in the middle. */
export function mosaicTilesAcross(tileSize: number): number {
  const n = Math.floor(MOSAIC_PIXELS / tileSize)
  return Math.max(3, n % 2 === 1 ? n : n - 1)
}

/** How far the overlay should reach from the view center: to the horizon of a camera `heightAgl` meters up. */
export function mosaicReach(heightAgl: number): number {
  return Math.max(MOSAIC_MIN_REACH_M, Math.sqrt(2 * EARTH_RADIUS_M * Math.max(0, heightAgl)))
}

/** Fractional Web Mercator tile coordinates of a point at zoom `z` (y from the north). */
function mercatorTile(longitude: number, latitude: number, z: number): { x: number; y: number } {
  const n = 2 ** z
  const lat = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, latitude)) * (Math.PI / 180)
  const x = ((((longitude + 180) / 360) % 1) + 1) % 1
  const y = (1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2
  return { x: x * n, y: y * n }
}

/**
 * The most detailed block of tiles that still reaches `reach` meters from the view center in
 * every direction: the tiles on each side of the center's tile span at least that much.
 */
export function planMosaic(
  imagery: Pick<LightPollutionSource['imagery'], 'tileSize' | 'maximumLevel'>,
  longitude: number,
  latitude: number,
  reach: number
): MosaicPlan {
  const across = mosaicTilesAcross(imagery.tileSize)
  const half = (across - 1) / 2
  const cos = Math.max(0.05, Math.cos(Math.min(MERCATOR_MAX_LAT, Math.abs(latitude)) * (Math.PI / 180)))
  const fit = Math.floor(Math.log2((half * EQUATOR_M * cos) / Math.max(1, reach)))
  const z = Math.max(0, Math.min(imagery.maximumLevel, fit))
  const n = 2 ** z
  if (n <= across) return { z, x0: 0, y0: 0, nx: n, ny: n, rect: [0, 0, 1, 1] }
  const t = mercatorTile(longitude, latitude, z)
  const x0 = (((Math.floor(t.x) - half) % n) + n) % n
  const y0 = Math.max(0, Math.min(n - across, Math.floor(t.y) - half))
  return { z, x0, y0, nx: across, ny: across, rect: [x0 / n, y0 / n, across / n, across / n] }
}

/**
 * The overlay's mosaics on the 3D Tiles: `near`, the most detailed block that reaches
 * MOSAIC_MIN_REACH_M around the view center, and `far`, a coarser one out to the horizon,
 * only when the camera is high enough to see past `near`.
 */
export function planOverlay(
  imagery: Pick<LightPollutionSource['imagery'], 'tileSize' | 'maximumLevel'>,
  longitude: number,
  latitude: number,
  heightAgl: number
): { near: MosaicPlan; far: MosaicPlan | null } {
  const near = planMosaic(imagery, longitude, latitude, MOSAIC_MIN_REACH_M)
  const far = planMosaic(imagery, longitude, latitude, mosaicReach(heightAgl))
  return { near, far: far.z < near.z ? far : null }
}

/** Whether row `y` at zoom `z` overlaps the source's latitude coverage (no requests outside it). */
export function tileRowInBounds(z: number, y: number, bounds: LightPollutionSource['imagery']['bounds']): boolean {
  const n = 2 ** z
  const lat = (row: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n))) * 180) / Math.PI
  return lat(y) > bounds.south && lat(y + 1) < bounds.north
}
