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
