import { Cartesian2, Cartesian3, Cartographic, Ellipsoid, IntersectionTests, Ray, type Scene } from 'cesium'
import { toMsl } from '../lib/geoid'
import { niceScale } from '../lib/units'
import { appState } from '../store/appStore'
import { cameraTarget, pickSurface, surfaceHeight, toDeg } from './util'

/** The cursor readout waits this long after the view stops moving (picking stalls the GPU). */
const CURSOR_SETTLE_MS = 120

const scratchRay = new Ray()
const scratchPixel = new Cartesian2()
const scratchScreen = new Cartesian2()

/**
 * Status-bar readouts: cursor position and elevation, camera altitude (MSL / AGL),
 * heading/pitch, scale bar and the camera target used by the sun simulation.
 */
export class Readouts {
  private cursorTimer: number | null = null
  private pendingCursor: Cartesian2 | null = null
  private lastCamera = { pos: new Cartesian3(), dir: new Cartesian3() }
  /** Camera of the previous rendered frame, to tell when the view is moving. */
  private prevFrame = { pos: new Cartesian3(), dir: new Cartesian3() }
  private lastMoveAt = Number.NEGATIVE_INFINITY
  private targetHeight: number | null = null
  private lastCameraUpdate = 0
  private lastTargetUpdate = 0
  private frames = 0
  private fpsWindowStart = performance.now()
  private lastFrame = performance.now()
  private fpsTimer: number

  constructor(
    private readonly scene: Scene,
    private readonly onTarget: (position: Cartesian3) => void
  ) {
    scene.postRender.addEventListener(() => this.onPostRender())
    // Report "idle" when request-render mode stops drawing frames.
    this.fpsTimer = window.setInterval(() => {
      if (!appState().settings.quality.showFps) return
      if (performance.now() - this.lastFrame > 1000 && appState().fps !== 0) appState().set({ fps: 0 })
    }, 500)
  }

  destroy(): void {
    window.clearInterval(this.fpsTimer)
    if (this.cursorTimer !== null) window.clearTimeout(this.cursorTimer)
  }

  /**
   * Cursor sampling is throttled, and paused while the view moves: picking reads back the
   * depth buffer, which stalls until the GPU has finished the frame.
   */
  onMouseMove(position: Cartesian2): void {
    this.pendingCursor = Cartesian2.clone(position)
    this.scheduleCursor(70)
  }

  private scheduleCursor(delay: number): void {
    if (this.cursorTimer !== null) return
    this.cursorTimer = window.setTimeout(() => {
      this.cursorTimer = null
      const p = this.pendingCursor
      if (!p) return
      const sinceMove = performance.now() - this.lastMoveAt
      if (sinceMove < CURSOR_SETTLE_MS) {
        this.scheduleCursor(CURSOR_SETTLE_MS - sinceMove)
        return
      }
      const hit = pickSurface(this.scene, p.x, p.y)
      if (!hit) {
        appState().set({ cursor: null })
        return
      }
      const c = Cartographic.fromCartesian(hit)
      const longitude = toDeg(c.longitude)
      const latitude = toDeg(c.latitude)
      const ex = this.scene.verticalExaggeration
      const rel = this.scene.verticalExaggerationRelativeHeight
      const real = (c.height - rel) / ex + rel
      appState().set({ cursor: { longitude, latitude, elevation: toMsl(latitude, longitude, real) } })
    }, delay)
  }

  onMouseLeave(): void {
    this.pendingCursor = null
    appState().set({ cursor: null })
  }

  private onPostRender(): void {
    const now = performance.now()
    this.lastFrame = now
    if (appState().settings.quality.showFps) {
      this.frames++
      if (now - this.fpsWindowStart >= 500) {
        appState().set({ fps: Math.round((this.frames * 1000) / (now - this.fpsWindowStart)) })
        this.frames = 0
        this.fpsWindowStart = now
      }
    }
    const cam = this.scene.camera
    const prev = this.prevFrame
    if (!Cartesian3.equalsEpsilon(cam.positionWC, prev.pos, 0, 0.01) || !Cartesian3.equalsEpsilon(cam.directionWC, prev.dir, 1e-6)) {
      this.lastMoveAt = now
      Cartesian3.clone(cam.positionWC, prev.pos)
      Cartesian3.clone(cam.directionWC, prev.dir)
    }
    const moved =
      !Cartesian3.equalsEpsilon(cam.positionWC, this.lastCamera.pos, 0, 0.01) ||
      !Cartesian3.equalsEpsilon(cam.directionWC, this.lastCamera.dir, 1e-6)
    if (!moved || now - this.lastCameraUpdate < 100) return
    this.lastCameraUpdate = now
    Cartesian3.clone(cam.positionWC, this.lastCamera.pos)
    Cartesian3.clone(cam.directionWC, this.lastCamera.dir)
    this.updateCamera()
    if (now - this.lastTargetUpdate > 300) {
      this.lastTargetUpdate = now
      // While moving: no depth readback (it stalls every slow frame); refresh() on move end
      // picks precisely.
      this.updateTarget(true)
    }
  }

  /** Called on camera move end for an exact final state. */
  refresh(): void {
    this.updateCamera()
    this.updateTarget()
  }

  private updateCamera(): void {
    const cam = this.scene.camera
    const c = Cartographic.fromCartesian(cam.positionWC)
    if (!c) return
    const longitude = toDeg(c.longitude)
    const latitude = toDeg(c.latitude)
    // Cesium already sampled the surface below the camera for this frame (its collision
    // check); sampling again would cast another ray through the 3D tiles.
    const sampled = this.scene.globeHeight
    const ground =
      sampled !== undefined && Number.isFinite(sampled) && sampled > -1000 ? sampled : surfaceHeight(this.scene, longitude, latitude)
    appState().set({
      camera: {
        longitude,
        latitude,
        height: c.height,
        heightMsl: toMsl(latitude, longitude, c.height),
        heightAgl: ground !== undefined ? c.height - ground : null,
        heading: (toDeg(cam.heading) + 360) % 360,
        pitch: toDeg(cam.pitch)
      },
      scale: this.computeScale(ground ?? this.targetHeight ?? 0)
    })
  }

  private updateTarget(fast = false): void {
    const target = fast ? this.estimateTarget() : cameraTarget(this.scene)
    if (!target) return
    const c = Cartographic.fromCartesian(target)
    if (!c) return
    const next = { longitude: toDeg(c.longitude), latitude: toDeg(c.latitude) }
    this.targetHeight = c.height
    const prev = appState().target
    if (!prev || Math.abs(prev.longitude - next.longitude) > 1e-4 || Math.abs(prev.latitude - next.latitude) > 1e-4) {
      appState().set({ target: next })
    }
    this.onTarget(target)
  }

  /**
   * While the view moves: the view center on the ellipsoid raised to the last measured target
   * height. Ray casting through the 3D tiles every few frames costs milliseconds; this is
   * close enough for the sun, time zone and shadow grids until the precise pick on move end.
   */
  private estimateTarget(): Cartesian3 | undefined {
    const h = this.targetHeight
    if (h === null) return cameraTarget(this.scene, true)
    const canvas = this.scene.canvas
    const ray = this.scene.camera.getPickRay(Cartesian2.fromElements(canvas.clientWidth / 2, canvas.clientHeight / 2, scratchScreen), scratchRay)
    if (!ray) return undefined
    const r = this.scene.ellipsoid.radii
    const hit = IntersectionTests.rayEllipsoid(ray, new Ellipsoid(r.x + h, r.y + h, r.z + h))
    // Missed (looking at the sky), or the camera is below that height: keep the last target.
    if (!hit || hit.start <= 0) return undefined
    return Ray.getPoint(ray, hit.start, new Cartesian3())
  }

  /**
   * Scale at the bottom of the view, without picking: the ray through the bar's pixel meets
   * the ellipsoid raised to the ground height near the camera, and a pixel's footprint at
   * that depth follows from the frustum.
   */
  private computeScale(groundHeight: number): { pixels: number; label: string } | null {
    const scene = this.scene
    const canvas = scene.canvas
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (!w || !h) return null
    const cam = scene.camera
    const ray = cam.getPickRay(Cartesian2.fromElements(w / 2, h - 60, scratchScreen), scratchRay)
    if (!ray) return null
    const r = scene.ellipsoid.radii
    const surface = new Ellipsoid(r.x + groundHeight, r.y + groundHeight, r.z + groundHeight)
    const hit = IntersectionTests.rayEllipsoid(ray, surface)
    // No hit (sky), or the camera is below the estimated surface.
    if (!hit || hit.start <= 0) return null
    const depth = hit.start * Cartesian3.dot(ray.direction, cam.directionWC)
    if (!(depth > 0)) return null
    const metersPerPixel = cam.frustum.getPixelDimensions(w, h, depth, 1, scratchPixel).x
    if (!Number.isFinite(metersPerPixel) || metersPerPixel <= 0) return null
    const nice = niceScale(metersPerPixel * 120, appState().settings.units)
    return nice ? { pixels: nice.meters / metersPerPixel, label: nice.label } : null
  }
}
