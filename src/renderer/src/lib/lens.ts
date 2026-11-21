// Camera / lens math for the viewfinder (first slice): angle of view from a sensor
// and focal length, the crop frame on screen, and the Cesium field of view that makes that
// frame (not the whole window) show exactly the lens's angle of view. Pure, unit-tested.

import { FOCAL_RANGE } from '@shared/settings'
import type { CompositionGuide, FrameAspect, SensorId, ViewfinderSettings } from '@shared/types'

export interface Sensor {
  id: SensorId
  label: string
  /** For the readout. */
  short: string
  /** Landscape dimensions, mm. */
  width: number
  height: number
  /**
   * The focal length is entered as its 35 mm equivalent (phones are marketed that way: "24 mm
   * main, 13 mm ultra wide"), not as the real focal length of the tiny lens.
   */
  equivalentFocal?: boolean
}

/** Diagonal of a 36 × 24 mm frame: the reference for crop factors and equivalent focal lengths. */
export const FULL_FRAME_DIAGONAL = Math.hypot(36, 24)

export const SENSORS: readonly Sensor[] = [
  { id: 'ff', label: 'Full frame (36 × 24)', short: 'FF', width: 36, height: 24 },
  { id: 'apsc', label: 'APS-C · Nikon, Sony, Fuji (23.5 × 15.6)', short: 'APS-C', width: 23.5, height: 15.6 },
  { id: 'apsc-canon', label: 'APS-C · Canon (22.3 × 14.9)', short: 'APS-C', width: 22.3, height: 14.9 },
  { id: 'm43', label: 'Micro Four Thirds (17.3 × 13)', short: 'MFT', width: 17.3, height: 13 },
  { id: '1in', label: '1-inch (13.2 × 8.8)', short: '1″', width: 13.2, height: 8.8 },
  { id: 'mf44', label: 'Medium format (44 × 33)', short: 'MF', width: 44, height: 33 },
  // A typical 1/1.3″ phone main camera (4:3). Its real focal length is ~6.7 mm for "24 mm".
  { id: 'phone', label: 'Phone main camera (35 mm-equivalent focal length)', short: 'Phone', width: 9.6, height: 7.2, equivalentFocal: true },
  { id: 'custom', label: 'Custom…', short: 'Custom', width: 36, height: 24 }
]

export const ASPECTS: ReadonlyArray<{ id: FrameAspect; label: string; ratio: number | null }> = [
  { id: 'native', label: 'Sensor', ratio: null },
  { id: '3:2', label: '3:2', ratio: 3 / 2 },
  { id: '4:3', label: '4:3', ratio: 4 / 3 },
  { id: '1:1', label: '1:1', ratio: 1 },
  { id: '4:5', label: '4:5', ratio: 4 / 5 },
  { id: '5:4', label: '5:4', ratio: 5 / 4 },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: '65:24', label: '65:24 pano', ratio: 65 / 24 }
]

export const GUIDES: ReadonlyArray<{ id: CompositionGuide; label: string }> = [
  { id: 'none', label: 'None' },
  { id: 'thirds', label: 'Rule of thirds' },
  { id: 'phi', label: 'Golden ratio (phi grid)' },
  { id: 'center', label: 'Center cross' },
  { id: 'diagonals', label: 'Diagonals' }
]

export const FOCAL_MIN = FOCAL_RANGE.min
export const FOCAL_MAX = FOCAL_RANGE.max
export const FOCAL_PRESETS = [14, 24, 35, 50, 85, 135, 200, 400, 600] as const

const DEG = 180 / Math.PI

export function sensorFor(settings: Pick<ViewfinderSettings, 'sensor' | 'customSensor'>): Sensor {
  const base = SENSORS.find((s) => s.id === settings.sensor) ?? SENSORS[0]
  if (base.id !== 'custom') return base
  const { width, height } = settings.customSensor
  return { ...base, short: `${trim(width)}×${trim(height)}`, width, height }
}

function trim(v: number): string {
  return String(Math.round(v * 10) / 10)
}

/** Diagonal crop factor relative to full frame. */
export function cropFactor(sensor: Pick<Sensor, 'width' | 'height'>): number {
  return FULL_FRAME_DIAGONAL / Math.hypot(sensor.width, sensor.height)
}

/** Full angle (radians) that a sensor dimension of `size` mm covers behind a `focal` mm lens. */
export function angleOfView(size: number, focal: number): number {
  return 2 * Math.atan(size / (2 * focal))
}

/**
 * The frame of `aspect` cut from the sensor (the largest rectangle of that ratio on it, as
 * in-camera crop modes do), in mm. Portrait turns the camera 90°: width and height swap.
 */
export function frameOnSensor(sensor: Pick<Sensor, 'width' | 'height'>, aspect: FrameAspect, portrait: boolean): { width: number; height: number } {
  const ratio = ASPECTS.find((a) => a.id === aspect)?.ratio ?? null
  let width = sensor.width
  let height = sensor.height
  if (ratio !== null) {
    if (width / height > ratio) width = height * ratio
    else height = width / ratio
  }
  return portrait ? { width: height, height: width } : { width, height }
}

export interface LensView {
  sensor: Sensor
  crop: number
  /** Real focal length of the lens on this sensor, mm. */
  focal: number
  /** 35 mm-equivalent focal length, mm. */
  equivalent: number
  /** Frame on the sensor, mm. */
  frame: { width: number; height: number }
  /** Frame width / height. */
  ratio: number
  /** Angles of view across the frame, degrees. */
  horizontal: number
  vertical: number
  diagonal: number
}

/** Everything the viewfinder shows and needs, from its settings. */
export function lensView(settings: ViewfinderSettings): LensView {
  const sensor = sensorFor(settings)
  const crop = cropFactor(sensor)
  const dial = settings.focalLength
  const focal = sensor.equivalentFocal ? dial / crop : dial
  const equivalent = sensor.equivalentFocal ? dial : dial * crop
  const frame = frameOnSensor(sensor, settings.aspect, settings.portrait)
  return {
    sensor,
    crop,
    focal,
    equivalent,
    frame,
    ratio: frame.width / frame.height,
    horizontal: angleOfView(frame.width, focal) * DEG,
    vertical: angleOfView(frame.height, focal) * DEG,
    diagonal: angleOfView(Math.hypot(frame.width, frame.height), focal) * DEG
  }
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Margin between the frame and the window edges, CSS px: the frame's bottom edge clears the
 * 30 px status bar. It is symmetric so the frame stays centered on the optical axis (the
 * window center), which a symmetric frustum needs.
 */
export const FRAME_INSET = { x: 12, y: 36 } as const

/** The largest rectangle of `ratio` (width / height) inside the view, centered. */
export function fitFrame(viewWidth: number, viewHeight: number, ratio: number, inset: { x: number; y: number } = { x: 0, y: 0 }): Rect {
  const availW = Math.max(1, viewWidth - 2 * inset.x)
  const availH = Math.max(1, viewHeight - 2 * inset.y)
  let width = availW
  let height = availW / ratio
  if (height > availH) {
    height = availH
    width = availH * ratio
  }
  return { x: (viewWidth - width) / 2, y: (viewHeight - height) / 2, width, height }
}

/** Widest field of view handed to Cesium (radians). */
const MAX_FOV = (170 * Math.PI) / 180

/**
 * The `PerspectiveFrustum.fov` (radians) that makes the centered `frame` span the given angles
 * of view. Cesium applies `fov` across the larger dimension of the view: horizontally when
 * aspectRatio (width / height) > 1, else vertically. The angle across the whole view follows
 * from the frame's share of it on the image plane: tan(full / 2) = tan(frame / 2) · view / frame.
 */
export function cesiumFov(viewWidth: number, viewHeight: number, frame: Pick<Rect, 'width' | 'height'>, horizontalDeg: number, verticalDeg: number): number {
  const across = (aovDeg: number, view: number, size: number) => 2 * Math.atan((Math.tan(aovDeg / DEG / 2) * view) / size)
  const fov = viewWidth / viewHeight > 1 ? across(horizontalDeg, viewWidth, frame.width) : across(verticalDeg, viewHeight, frame.height)
  return Math.min(MAX_FOV, fov)
}

// ───────────── focal length slider (log scale) ─────────────

export function clampFocal(mm: number): number {
  return Math.min(FOCAL_MAX, Math.max(FOCAL_MIN, mm))
}

/** Slider position 0…1 for a focal length (log scale: 14→24 mm gets as much travel as 350→600). */
export function focalToSlider(mm: number): number {
  return Math.log(clampFocal(mm) / FOCAL_MIN) / Math.log(FOCAL_MAX / FOCAL_MIN)
}

/** Focal length for a slider position, rounded to a whole mm (0.5 mm below 20 mm). */
export function sliderToFocal(t: number): number {
  const mm = FOCAL_MIN * Math.pow(FOCAL_MAX / FOCAL_MIN, Math.min(1, Math.max(0, t)))
  return clampFocal(mm < 20 ? Math.round(mm * 2) / 2 : Math.round(mm))
}

/** The next preset focal length up (dir 1) or down (dir -1), or the range end beyond them. */
export function stepFocal(mm: number, dir: 1 | -1): number {
  const stops = [FOCAL_MIN, ...FOCAL_PRESETS, FOCAL_MAX]
  const next = dir > 0 ? stops.find((s) => s > mm + 1e-6) : [...stops].reverse().find((s) => s < mm - 1e-6)
  return next ?? (dir > 0 ? FOCAL_MAX : FOCAL_MIN)
}

/** A fine step: ±5 % (at least 1 mm). */
export function nudgeFocal(mm: number, dir: 1 | -1): number {
  const step = Math.max(1, mm * 0.05)
  return clampFocal(Math.round(mm + dir * step))
}

export function formatFocal(mm: number): string {
  return `${mm < 20 && !Number.isInteger(mm) ? mm.toFixed(1) : Math.round(mm)} mm`
}

// ───────────── composition guides ─────────────

/** A line in frame-relative coordinates (0…1 across, 0…1 down). */
export type GuideLine = [x1: number, y1: number, x2: number, y2: number]

const PHI = (1 + Math.sqrt(5)) / 2

export function guideLines(guide: CompositionGuide): GuideLine[] {
  const grid = (a: number, b: number): GuideLine[] => [
    [a, 0, a, 1],
    [b, 0, b, 1],
    [0, a, 1, a],
    [0, b, 1, b]
  ]
  switch (guide) {
    case 'thirds':
      return grid(1 / 3, 2 / 3)
    case 'phi':
      // Sections at 1/φ² and 1/φ (≈ 0.382 and 0.618).
      return grid(1 - 1 / PHI, 1 / PHI)
    case 'center':
      return [
        [0.5, 0, 0.5, 1],
        [0, 0.5, 1, 0.5]
      ]
    case 'diagonals':
      return [
        [0, 0, 1, 1],
        [1, 0, 0, 1]
      ]
    default:
      return []
  }
}
