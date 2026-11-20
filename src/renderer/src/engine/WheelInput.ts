/** The parts of a WheelEvent the classifier looks at (plain object so it can be unit tested). */
export interface WheelSample {
  deltaX: number
  deltaY: number
  /** 0 = pixels, 1 = lines, 2 = pages. */
  deltaMode: number
  ctrlKey: boolean
  /** Chromium's legacy wheelDelta: 120 per wheel notch. */
  wheelDeltaY?: number
  timeStamp: number
}

export type WheelDevice = 'mouse' | 'trackpad'

/**
 * Chromium on macOS reports a mouse-wheel notch as a multiple of this (0.1 line × 40 px, in
 * float), even with scroll acceleration. Trackpads report whole pixels.
 */
const MAC_WHEEL_QUANTUM = 4.000244140625

/** Mouse notches on Windows / Linux are at least this many pixels. */
const MIN_NOTCH_PIXELS = 50

/** A pause longer than this ends a gesture (trackpad momentum keeps events coming). */
export const GESTURE_GAP_MS = 250

function isMultipleOf(value: number, quantum: number): boolean {
  const n = Math.abs(value) / quantum
  return Math.abs(n - Math.round(n)) < 1e-4
}

/** Best guess for a single event: does this come from a trackpad (or other touch surface)? */
export function looksLikeTrackpad(e: WheelSample): boolean {
  // Line / page deltas only come from wheels.
  if (e.deltaMode !== 0) return false
  // Wheels move one axis at a time.
  if (e.deltaX !== 0 && e.deltaY !== 0) return true
  const value = e.deltaY !== 0 ? e.deltaY : e.deltaX
  if (value === 0) return false
  if (isMultipleOf(value, MAC_WHEEL_QUANTUM)) return false
  // A pinch synthesizes ctrl+wheel with fractional deltas (a ctrl+wheel notch is whole).
  if (e.ctrlKey && !Number.isInteger(value)) return true
  // Whole notches (wheelDelta a multiple of 120) of a reasonable size are a wheel.
  const wholeNotches = e.deltaY !== 0 && e.wheelDeltaY ? e.wheelDeltaY % 120 === 0 : Number.isInteger(value)
  if (wholeNotches && Math.abs(value) >= MIN_NOTCH_PIXELS) return false
  return true
}

/**
 * Classifies wheel events per gesture: once a gesture looks like a trackpad it stays one
 * (momentum events can have wheel-like values), and a gesture that started out looking like a
 * wheel switches to trackpad as soon as an event gives it away.
 */
export class WheelClassifier {
  private device: WheelDevice | null = null
  private last = Number.NEGATIVE_INFINITY

  classify(e: WheelSample): WheelDevice {
    const fresh = e.timeStamp - this.last > GESTURE_GAP_MS
    this.last = e.timeStamp
    if (fresh) this.device = null
    if (this.device !== 'trackpad') this.device = looksLikeTrackpad(e) ? 'trackpad' : 'mouse'
    return this.device
  }
}
