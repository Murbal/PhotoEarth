import type { MapView } from '../lib/webMercator'

/**
 * The mounted Map mode view (components/MapMode.tsx) as the engine and commands see it. The
 * live view changes every frame of a gesture and is committed to settings.map only when the
 * gesture ends, so the engine asks here for the latest.
 */
export interface MapControl {
  view(): MapView
  /** Moves the map, easing there when `animate`. */
  setView(view: MapView, animate: boolean): void
  /** Zooms about the center by whole steps (eased). */
  zoomBy(steps: number): void
}

let control: MapControl | null = null

export function setMapControl(next: MapControl | null): void {
  control = next
}

export function getMapControl(): MapControl | null {
  return control
}
