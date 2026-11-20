import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  HeightReference,
  Math as CesiumMath,
  RequestErrorEvent,
  type Scene
} from 'cesium'
import type { CameraView } from '@shared/types'

export const toDeg = CesiumMath.toDegrees
export const toRad = CesiumMath.toRadians

export function cartographicDeg(position: Cartesian3): { longitude: number; latitude: number; height: number } | null {
  const c = Cartographic.fromCartesian(position)
  if (!c) return null
  return { longitude: toDeg(c.longitude), latitude: toDeg(c.latitude), height: c.height }
}

/**
 * Surface height (terrain and/or 3D tiles with collision) at a position, from data that is
 * already loaded. Wraps Scene#getHeight, which Cesium marks private but keeps stable.
 */
export function surfaceHeight(scene: Scene, longitude: number, latitude: number): number | undefined {
  const getHeight = (scene as unknown as {
    getHeight?: (c: Cartographic, ref?: HeightReference) => number | undefined
  }).getHeight
  if (!getHeight) return undefined
  const h = getHeight.call(scene, Cartographic.fromDegrees(longitude, latitude), HeightReference.CLAMP_TO_GROUND)
  // Coarse, not-yet-refined globe tiles sag far below the ellipsoid; no real surface is
  // lower than ~-450 m (Dead Sea shore), so treat such values as unknown.
  return h !== undefined && Number.isFinite(h) && h > -1000 ? h : undefined
}

/** World position under a window pixel: depth pick first, then globe/ellipsoid. */
export function pickSurface(scene: Scene, x: number, y: number): Cartesian3 | undefined {
  const p = new Cartesian2(x, y)
  if (scene.pickPositionSupported) {
    try {
      const hit = scene.pickPosition(p)
      if (hit && Number.isFinite(hit.x) && Cartesian3.magnitude(hit) > 6.0e6) return hit
    } catch {
      /* depth not available yet */
    }
  }
  const ray = scene.camera.getPickRay(p)
  if (ray && scene.globe.show) {
    const g = scene.globe.pick(ray, scene)
    if (g) return g
  }
  return scene.camera.pickEllipsoid(p, scene.ellipsoid) ?? undefined
}

/** The point the camera looks at (screen center), or the point below the camera. */
export function cameraTarget(scene: Scene): Cartesian3 {
  const canvas = scene.canvas
  const hit = pickSurface(scene, canvas.clientWidth / 2, canvas.clientHeight / 2)
  if (hit) return hit
  const c = Cartographic.fromCartesian(scene.camera.positionWC)
  return Cartesian3.fromRadians(c.longitude, c.latitude, 0)
}

export function currentView(scene: Scene): CameraView {
  const cam = scene.camera
  const c = Cartographic.fromCartesian(cam.positionWC)
  return {
    longitude: toDeg(c.longitude),
    latitude: toDeg(c.latitude),
    height: c.height,
    heading: toDeg(cam.heading),
    pitch: toDeg(cam.pitch),
    roll: toDeg(cam.roll)
  }
}

export function httpStatusOf(error: unknown): number | undefined {
  if (error instanceof RequestErrorEvent) return error.statusCode
  const e = error as { statusCode?: number; error?: { statusCode?: number } } | undefined
  return e?.statusCode ?? e?.error?.statusCode
}

export function responseTextOf(error: unknown): string {
  const e = error as { response?: unknown; error?: { response?: unknown }; message?: string } | undefined
  const r = e?.response ?? e?.error?.response
  if (typeof r === 'string') return r
  if (r instanceof ArrayBuffer) return new TextDecoder().decode(r)
  if (r && typeof r === 'object') {
    try {
      return JSON.stringify(r)
    } catch {
      return ''
    }
  }
  return e?.message ?? ''
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}
