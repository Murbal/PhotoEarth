import { Cartesian2, Cartesian3, Cartographic, type Scene } from 'cesium'
import { toMsl } from '../lib/geoid'
import { niceScale } from '../lib/units'
import { appState } from '../store/appStore'
import { cameraTarget, pickSurface, surfaceHeight, toDeg } from './util'

/**
 * Status-bar readouts: cursor position and elevation, camera altitude (MSL / AGL),
 * heading/pitch, scale bar and the camera target used by the sun simulation.
 */
export class Readouts {
  private cursorTimer: number | null = null
  private pendingCursor: Cartesian2 | null = null
  private lastCamera = { pos: new Cartesian3(), dir: new Cartesian3() }
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

  /** Cursor sampling is throttled: picking reads back the depth buffer. */
  onMouseMove(position: Cartesian2): void {
    this.pendingCursor = Cartesian2.clone(position)
    if (this.cursorTimer !== null) return
    this.cursorTimer = window.setTimeout(() => {
      this.cursorTimer = null
      const p = this.pendingCursor
      if (!p) return
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
    }, 70)
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
      this.updateTarget()
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
    const ground = surfaceHeight(this.scene, longitude, latitude)
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
      scale: this.computeScale()
    })
  }

  private updateTarget(): void {
    const target = cameraTarget(this.scene)
    const c = Cartographic.fromCartesian(target)
    if (!c) return
    const next = { longitude: toDeg(c.longitude), latitude: toDeg(c.latitude) }
    const prev = appState().target
    if (!prev || Math.abs(prev.longitude - next.longitude) > 1e-4 || Math.abs(prev.latitude - next.latitude) > 1e-4) {
      appState().set({ target: next })
    }
    this.onTarget(target)
  }

  private computeScale(): { pixels: number; label: string } | null {
    const canvas = this.scene.canvas
    const y = canvas.clientHeight - 60
    const x = canvas.clientWidth / 2
    const a = pickSurface(this.scene, x - 50, y)
    const b = pickSurface(this.scene, x + 50, y)
    if (!a || !b) return null
    const metersPerPixel = Cartesian3.distance(a, b) / 100
    if (!Number.isFinite(metersPerPixel) || metersPerPixel <= 0) return null
    const nice = niceScale(metersPerPixel * 120, appState().settings.units)
    return nice ? { pixels: nice.meters / metersPerPixel, label: nice.label } : null
  }
}
