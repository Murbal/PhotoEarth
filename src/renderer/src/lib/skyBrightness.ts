/**
 * Artificial night sky brightness: the Light Pollution Atlas's data and color scales,
 * conversions to magnitudes per square arcsecond, and a Bortle class estimate.
 *
 * All brightness here is at the zenith. The atlas models artificial light scattered back down
 * by the atmosphere from VIIRS night lights; it is not a measurement. Its "light pollution
 * index" (here `ratio`) is artificial ÷ natural brightness, with the natural sky taken as
 * 22.0 mag/arcsec².
 */

/** Natural zenith sky brightness the atlas assumes, mag/arcsec². */
export const NATURAL_SKY_MPSAS = 22.0

/** Total zenith brightness (natural + artificial) for an artificial ÷ natural ratio. */
export function ratioToMpsas(ratio: number): number {
  return NATURAL_SKY_MPSAS - 2.5 * Math.log10(1 + Math.max(0, ratio))
}

/** The inverse of `ratioToMpsas`. */
export function mpsasToRatio(mpsas: number): number {
  return Math.max(0, 10 ** ((NATURAL_SKY_MPSAS - mpsas) / 2.5) - 1)
}

// ───────────────────────────── zones ─────────────────────────────

export interface LightPollutionZone {
  /** The atlas's zone name: 0, 1a … 7b. */
  id: string
  /** Ratio range [min, max), artificial ÷ natural. */
  min: number
  max: number
  /** The color the atlas tiles draw it in. */
  rgb: readonly [number, number, number]
}

/**
 * Zone boundaries: each zone is 3× brighter than the one before and each a/b half is √3×,
 * except zone 0, Cinzano's arbitrary floor. Thresholds and colors are those of the atlas's own
 * viewer (djlorenz.github.io/astronomy/lp/overlay/dark.html) and its tile palettes.
 */
const BOUNDS = [0, 0.01, 0.06, 0.11, 0.19, 0.33, 0.58, 1.0, 1.73, 3.0, 5.2, 9.0, 15.59, 27.0, 46.77, Infinity]
const ZONE_IDS = ['0', '1a', '1b', '2a', '2b', '3a', '3b', '4a', '4b', '5a', '5b', '6a', '6b', '7a', '7b']
const ZONE_RGB: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [34, 34, 34],
  [66, 66, 66],
  [20, 47, 114],
  [33, 84, 216],
  [15, 87, 20],
  [31, 161, 42],
  [110, 100, 30],
  [184, 166, 37],
  [191, 100, 30],
  [253, 150, 80],
  [251, 90, 73],
  [251, 153, 138],
  [160, 160, 160],
  [242, 242, 242]
]

export const ZONES: readonly LightPollutionZone[] = ZONE_IDS.map((id, i) => ({
  id,
  min: BOUNDS[i],
  max: BOUNDS[i + 1],
  rgb: ZONE_RGB[i]
}))

export function zoneIndexForRatio(ratio: number): number {
  for (let i = ZONES.length - 1; i > 0; i--) if (ratio >= ZONES[i].min) return i
  return 0
}

export const rgbCss = ([r, g, b]: readonly [number, number, number]): string => `rgb(${r}, ${g}, ${b})`

/**
 * Pure white, the extra top color of the atlas's expanded scale (brighter than 7b's 242 grey),
 * decodes into zone 7b: the atlas doesn't publish its threshold.
 */
const EXTRA_COLORS: ReadonlyArray<{ rgb: readonly [number, number, number]; zone: number }> = [{ rgb: [255, 255, 255], zone: 14 }]

/** How far (RGB distance) a pixel may be from a palette color and still count as it. */
const COLOR_TOLERANCE = 18

/**
 * Maps an atlas tile pixel back to its zone, or null for a color that isn't on the scale
 * (a blended edge, another source's tile). Tiles are 4-bit palette PNGs, so pixels are
 * normally exact palette colors; a small tolerance absorbs color management.
 */
export function decodeZoneColor(r: number, g: number, b: number): number | null {
  let best = -1
  let bestDist = Infinity
  const consider = (rgb: readonly [number, number, number], zone: number) => {
    const d = Math.hypot(r - rgb[0], g - rgb[1], b - rgb[2])
    if (d < bestDist) {
      bestDist = d
      best = zone
    }
  }
  ZONES.forEach((z, i) => consider(z.rgb, i))
  EXTRA_COLORS.forEach((c) => consider(c.rgb, c.zone))
  return bestDist <= COLOR_TOLERANCE ? best : null
}

// ───────────────────────────── Bortle ─────────────────────────────

export interface BortleEstimate {
  /** 1–9; 4.5 is the transition class between rural and suburban skies. */
  value: number
  label: string
  title: string
}

/**
 * Approximate zenith brightness of each Bortle class, darkest first (the commonly quoted
 * SQM ranges, Dark Skies Awareness nomogram via Wikipedia's Bortle scale table). Bortle is a
 * visual whole-sky scale, so this is only a rough correspondence.
 */
export const BORTLE_CLASSES: ReadonlyArray<{ value: number; label: string; title: string; minMpsas: number }> = [
  { value: 1, label: '1', title: 'Excellent dark-sky site', minMpsas: 21.76 },
  { value: 2, label: '2', title: 'Typical truly dark site', minMpsas: 21.6 },
  { value: 3, label: '3', title: 'Rural sky', minMpsas: 21.3 },
  { value: 4, label: '4', title: 'Brighter rural', minMpsas: 20.8 },
  { value: 4.5, label: '4.5', title: 'Semi-suburban / transition', minMpsas: 20.3 },
  { value: 5, label: '5', title: 'Suburban sky', minMpsas: 19.25 },
  { value: 6, label: '6', title: 'Bright suburban sky', minMpsas: 18.5 },
  { value: 7, label: '7', title: 'Suburban / urban transition', minMpsas: 18.0 },
  { value: 8, label: '8–9', title: 'City or inner-city sky', minMpsas: -Infinity }
]

/** Bortle class whose zenith brightness range contains `mpsas`. */
export function bortleFromMpsas(mpsas: number): BortleEstimate {
  const c = BORTLE_CLASSES.find((k) => mpsas >= k.minMpsas) ?? BORTLE_CLASSES[BORTLE_CLASSES.length - 1]
  return { value: c.value, label: c.label, title: c.title }
}

// ───────────────────────────── estimates ─────────────────────────────

export interface SkyEstimate {
  /** Artificial ÷ natural zenith brightness. */
  ratio: number
  /** Total zenith brightness, mag/arcsec² (higher is darker). */
  mpsas: number
  /** When decoded from a color: the zone's brightness range, darkest first. */
  mpsasRange: [number, number] | null
  zone: LightPollutionZone
  bortle: BortleEstimate
  /** `data`: a modeled value for the ~1 km cell; `zone`: only the zone, from a tile color. */
  precision: 'data' | 'zone'
}

export function estimateFromRatio(ratio: number): SkyEstimate {
  const mpsas = ratioToMpsas(ratio)
  return { ratio, mpsas, mpsasRange: null, zone: ZONES[zoneIndexForRatio(ratio)], bortle: bortleFromMpsas(mpsas), precision: 'data' }
}

/** An estimate from a zone alone: the geometric middle of its ratio range (the top zone: its floor). */
export function estimateFromZone(index: number): SkyEstimate {
  const zone = ZONES[index]
  const ratio = index === 0 ? zone.max / 2 : Number.isFinite(zone.max) ? Math.sqrt(zone.min * zone.max) : zone.min
  const mpsas = ratioToMpsas(ratio)
  return {
    ratio,
    mpsas,
    mpsasRange: [ratioToMpsas(zone.min), Number.isFinite(zone.max) ? ratioToMpsas(zone.max) : -Infinity],
    zone,
    bortle: bortleFromMpsas(mpsas),
    precision: 'zone'
  }
}

// ───────────────────────────── atlas data tiles ─────────────────────────────

/**
 * The atlas's point data: gzipped 5° × 5° tiles of 600 × 600 cells (1/120°, ~1 km), from
 * 65° S to 75° N. Tile (1, 1) has its south-west corner at 180° W, 65° S; rows run north.
 */
export const ATLAS_GRID = { west: -180, south: -65, north: 75, tileDegrees: 5, cells: 600 } as const

export interface AtlasCell {
  /** 1-based tile column (from 180° W) and row (from 65° S), as in the file names. */
  tileX: number
  tileY: number
  /** Cell within the tile, from its south-west corner. */
  row: number
  col: number
}

export function atlasCell(longitude: number, latitude: number): AtlasCell | null {
  const { west, south, north, tileDegrees, cells } = ATLAS_GRID
  if (!(latitude >= south && latitude < north) || !Number.isFinite(longitude)) return null
  const fromWest = (((longitude - west) % 360) + 360) % 360
  const fromSouth = latitude - south
  const tileX = Math.floor(fromWest / tileDegrees)
  const tileY = Math.floor(fromSouth / tileDegrees)
  const perDegree = cells / tileDegrees
  const col = Math.min(cells - 1, Math.floor((fromWest - tileX * tileDegrees) * perDegree))
  const row = Math.min(cells - 1, Math.floor((fromSouth - tileY * tileDegrees) * perDegree))
  return { tileX: tileX + 1, tileY: tileY + 1, row, col }
}

/** The atlas's compressed integers → artificial ÷ natural ratio (its `compressed2full`). */
export function compressedToRatio(x: number): number {
  return (5 / 195) * (Math.exp(0.0195 * x) - 1)
}

/**
 * Reads one cell of an (inflated) atlas data tile. The south-west cell is stored as two
 * bytes; every other cell as a signed one-byte step from its neighbor: the first column from
 * the cell south of it, the rest from the cell west of it. So cell (row, col) sums the
 * first column up to `row`, then that row up to `col`.
 */
export function atlasRatioAt(data: Int8Array, row: number, col: number): number {
  const n = ATLAS_GRID.cells
  if (data.length < n * n + 1) throw new Error(`atlas tile too short (${data.length} bytes)`)
  let value = 128 * data[0] + data[1]
  for (let i = 1; i <= row; i++) value += data[n * i + 1]
  const base = n * row + 1
  for (let j = 1; j <= col; j++) value += data[base + j]
  return compressedToRatio(value)
}

// ───────────────────────────── Web Mercator tiles ─────────────────────────────

/** The XYZ tile at `zoom` holding a point, and the pixel within it (tiles of `size` px). */
export function mercatorPixel(
  longitude: number,
  latitude: number,
  zoom: number,
  size: number
): { x: number; y: number; px: number; py: number } {
  const n = 2 ** zoom
  const lat = Math.max(-85.05112878, Math.min(85.05112878, latitude)) * (Math.PI / 180)
  const fx = ((((longitude + 180) / 360) % 1) + 1) % 1
  const fy = (1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2
  const gx = Math.min(n * size - 1, Math.floor(fx * n * size))
  const gy = Math.min(n * size - 1, Math.max(0, Math.floor(fy * n * size)))
  return { x: Math.floor(gx / size), y: Math.floor(gy / size), px: gx % size, py: gy % size }
}
