import type {
  CameraView,
  ImageryType,
  MapMode,
  PaletteId,
  QualityOverrides,
  QualityPreset,
  ScrollGesture,
  Settings
} from './types'

/** Bernese Oberland, looking north-east across the Lauterbrunnen valley towards the Jungfrau. */
export const DEFAULT_VIEW: CameraView = {
  longitude: 7.8,
  latitude: 46.48,
  height: 6500,
  heading: 55,
  pitch: -15,
  roll: 0
}

export const QUALITY_PRESETS: readonly QualityPreset[] = ['low', 'medium', 'high', 'ultra']
export const PALETTES: readonly PaletteId[] = ['terrain', 'viridis', 'spectral', 'magma', 'grayscale']
export const SCROLL_GESTURES: readonly ScrollGesture[] = ['auto', 'pan', 'zoom']
export const IMAGERY_TYPES: readonly ImageryType[] = ['satellite', 'terrain', 'roadmap']
export const CONTOUR_INTERVALS = [10, 20, 50, 100, 200, 500] as const
/** Imperial contour intervals in feet (stored as meters). */
export const CONTOUR_INTERVALS_FT = [25, 50, 100, 200, 500, 1000, 2000] as const
export const MIN_EXAGGERATION = 1
export const MAX_EXAGGERATION = 3

export const EMPTY_OVERRIDES: QualityOverrides = {
  maximumScreenSpaceError: null,
  shadowMapSize: null,
  shadowCascades: null,
  softShadows: null,
  terrainShadowResolution: null,
  msaaSamples: null,
  fxaa: null,
  resolutionScale: null
}

export function defaultSettings(): Settings {
  return {
    version: 1,
    units: 'metric',
    coordFormat: 'decimal',
    theme: 'dark',
    quality: {
      preset: 'high',
      overrides: { ...EMPTY_OVERRIDES },
      devicePixelRatioAware: false,
      showFps: false
    },
    navigation: {
      inertia: 0.8,
      speedMultiplier: 1,
      invertFlyY: false,
      minClearance: 2,
      scrollGesture: 'auto'
    },
    lastCamera: null,
    lastMode: 'photorealistic',
    imagery: 'satellite',
    placeLabels: true,
    elevation: {
      tint: { enabled: true, opacity: 0.55, palette: 'terrain', autoRange: true, min: 0, max: 4500 },
      contours: { enabled: true, interval: 50, width: 1.2, color: '#ffffff', opacity: 0.75 },
      slope: { enabled: false, opacity: 0.6 },
      hillshade: { enabled: true, opacity: 0.5, followSun: true }
    },
    verticalExaggeration: 1,
    lighting: 'sun',
    shadows: true,
    detailShadows: true,
    showSunIndicator: false,
    bookmarkIncludeTime: true,
    onboardingComplete: false
  }
}

type Json = unknown

const isObject = (v: Json): v is Record<string, Json> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const finite = (v: Json): v is number => typeof v === 'number' && Number.isFinite(v)

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

function num(v: Json, fallback: number, min = -Infinity, max = Infinity): number {
  return finite(v) ? clamp(v, min, max) : fallback
}

function bool(v: Json, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function oneOf<T extends string>(v: Json, options: readonly T[], fallback: T): T {
  return typeof v === 'string' && (options as readonly string[]).includes(v) ? (v as T) : fallback
}

function nullableNum(v: Json, min: number, max: number): number | null {
  return finite(v) ? clamp(v, min, max) : null
}

function nullableBool(v: Json): boolean | null {
  return typeof v === 'boolean' ? v : null
}

function color(v: Json, fallback: string): string {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : fallback
}

export function sanitizeCameraView(v: Json): CameraView | null {
  if (!isObject(v)) return null
  const { longitude, latitude, height, heading, pitch, roll } = v
  if (![longitude, latitude, height, heading, pitch, roll].every(finite)) return null
  return {
    longitude: clamp(longitude as number, -180, 180),
    latitude: clamp(latitude as number, -90, 90),
    height: clamp(height as number, -500, 5e7),
    heading: heading as number,
    pitch: clamp(pitch as number, -90, 90),
    roll: roll as number
  }
}

/**
 * Coerces untrusted JSON (from disk or IPC) into a valid Settings object.
 * Unknown keys are dropped; missing or invalid values fall back to defaults.
 */
export function sanitizeSettings(raw: Json): Settings {
  const d = defaultSettings()
  const r = isObject(raw) ? raw : {}
  const q = isObject(r.quality) ? r.quality : {}
  const o = isObject(q.overrides) ? q.overrides : {}
  const n = isObject(r.navigation) ? r.navigation : {}
  const e = isObject(r.elevation) ? r.elevation : {}
  const tint = isObject(e.tint) ? e.tint : {}
  const contours = isObject(e.contours) ? e.contours : {}
  const slope = isObject(e.slope) ? e.slope : {}
  const hill = isObject(e.hillshade) ? e.hillshade : {}
  const modes: readonly MapMode[] = ['photorealistic', 'elevation']
  const cascades = o.shadowCascades === 1 || o.shadowCascades === 4 ? o.shadowCascades : null

  const tintMin = num(tint.min, d.elevation.tint.min, -500, 9000)
  const tintMax = num(tint.max, d.elevation.tint.max, -500, 9000)

  return {
    version: 1,
    units: oneOf(r.units, ['metric', 'imperial'], d.units),
    coordFormat: oneOf(r.coordFormat, ['decimal', 'dms'], d.coordFormat),
    theme: oneOf(r.theme, ['dark', 'light'], d.theme),
    quality: {
      preset: oneOf(q.preset, QUALITY_PRESETS, d.quality.preset),
      overrides: {
        maximumScreenSpaceError: nullableNum(o.maximumScreenSpaceError, 1, 64),
        shadowMapSize: nullableNum(o.shadowMapSize, 512, 8192),
        shadowCascades: cascades,
        softShadows: nullableBool(o.softShadows),
        terrainShadowResolution: nullableNum(o.terrainShadowResolution, 128, 1024),
        msaaSamples: nullableNum(o.msaaSamples, 1, 8),
        fxaa: nullableBool(o.fxaa),
        resolutionScale: nullableNum(o.resolutionScale, 0.25, 2)
      },
      devicePixelRatioAware: bool(q.devicePixelRatioAware, d.quality.devicePixelRatioAware),
      showFps: bool(q.showFps, d.quality.showFps)
    },
    navigation: {
      inertia: num(n.inertia, d.navigation.inertia, 0, 0.95),
      speedMultiplier: num(n.speedMultiplier, d.navigation.speedMultiplier, 0.1, 10),
      invertFlyY: bool(n.invertFlyY, d.navigation.invertFlyY),
      minClearance: num(n.minClearance, d.navigation.minClearance, 0.5, 100),
      scrollGesture: oneOf(n.scrollGesture, SCROLL_GESTURES, d.navigation.scrollGesture)
    },
    lastCamera: sanitizeCameraView(r.lastCamera),
    lastMode: oneOf(r.lastMode, modes, d.lastMode),
    imagery: oneOf(r.imagery, IMAGERY_TYPES, d.imagery),
    placeLabels: bool(r.placeLabels, d.placeLabels),
    elevation: {
      tint: {
        enabled: bool(tint.enabled, d.elevation.tint.enabled),
        opacity: num(tint.opacity, d.elevation.tint.opacity, 0, 1),
        palette: oneOf(tint.palette, PALETTES, d.elevation.tint.palette),
        autoRange: bool(tint.autoRange, d.elevation.tint.autoRange),
        min: Math.min(tintMin, tintMax - 1),
        max: Math.max(tintMax, tintMin + 1)
      },
      contours: {
        enabled: bool(contours.enabled, d.elevation.contours.enabled),
        interval: num(contours.interval, d.elevation.contours.interval, 1, 1000),
        width: num(contours.width, d.elevation.contours.width, 0.5, 6),
        color: color(contours.color, d.elevation.contours.color),
        opacity: num(contours.opacity, d.elevation.contours.opacity, 0, 1)
      },
      slope: {
        enabled: bool(slope.enabled, d.elevation.slope.enabled),
        opacity: num(slope.opacity, d.elevation.slope.opacity, 0, 1)
      },
      hillshade: {
        enabled: bool(hill.enabled, d.elevation.hillshade.enabled),
        opacity: num(hill.opacity, d.elevation.hillshade.opacity, 0, 1),
        followSun: bool(hill.followSun, d.elevation.hillshade.followSun)
      }
    },
    verticalExaggeration: num(r.verticalExaggeration, d.verticalExaggeration, MIN_EXAGGERATION, MAX_EXAGGERATION),
    lighting: oneOf(r.lighting, ['sun', 'flat'], d.lighting),
    shadows: bool(r.shadows, d.shadows),
    detailShadows: bool(r.detailShadows, d.detailShadows),
    showSunIndicator: bool(r.showSunIndicator, d.showSunIndicator),
    bookmarkIncludeTime: bool(r.bookmarkIncludeTime, d.bookmarkIncludeTime),
    onboardingComplete: bool(r.onboardingComplete, d.onboardingComplete)
  }
}
