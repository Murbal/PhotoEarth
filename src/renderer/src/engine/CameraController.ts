import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cartographic,
  CameraEventType,
  EasingFunction,
  HeadingPitchRange,
  KeyboardEventModifier,
  Math as CesiumMath,
  Matrix3,
  Matrix4,
  Quaternion,
  type Scene
} from 'cesium'
import type { CameraView, NavigationSettings } from '@shared/types'
import { cameraTarget, clamp, pickSurface, surfaceHeight, toDeg, toRad } from './util'

/** Standing eye height for eye-level mode, meters. */
export const EYE_HEIGHT = 1.7

const MOVEMENT_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])

export interface CameraCallbacks {
  onFlyModeChange: (active: boolean) => void
  onEyeLevelChange: (active: boolean) => void
  /** Any direct camera input (used to cancel flights and dismiss transient UI). */
  onUserInput: () => void
  /** Return false to ignore keyboard movement (e.g. while a dialog has focus). */
  keyboardEnabled: () => boolean
  /** Precise ground height (ellipsoidal) at a location, from the active surface source. */
  sampleGround: (longitude: number, latitude: number) => Promise<number | undefined>
}

export interface FlyToLocationOptions {
  /** Distance from the point, meters. */
  range?: number
  /** Camera altitude above ground, meters (camera placed *at* the location). */
  altitude?: number
  heading?: number
  /** Pitch in degrees (negative looks down). */
  pitch?: number
  /** Ground height above the ellipsoid if known. */
  groundHeight?: number
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

const scratchMatrix = new Matrix3()
const scratchQuat = new Quaternion()

/**
 * Navigation per spec §6: Cesium's ScreenSpaceCameraController handles grab-pan, orbit and
 * cursor-anchored zoom (remapped to the Orbit scheme); this class adds heading rotation around
 * the cursor point, keyboard / fly mode, eye-level mode, ground clearance and smooth resets.
 */
export class CameraController {
  private readonly keys = new Set<string>()
  private shift = false
  private alt = false
  private raf: number | null = null
  private lastTick = 0
  private flyMode = false
  private eyeLevel = false
  private settings: NavigationSettings = { inertia: 0.8, speedMultiplier: 1, invertFlyY: false, minClearance: 2 }
  private headingDrag: { pivot: Cartesian3; lastX: number; pointerId: number } | null = null
  private headingVelocity = 0
  private headingPivot: Cartesian3 | null = null
  private animationToken = 0
  private mouse: { x: number; y: number } | null = null
  private readonly disposers: Array<() => void> = []

  constructor(
    private readonly scene: Scene,
    private readonly callbacks: CameraCallbacks
  ) {
    const c = scene.screenSpaceCameraController
    // Orbit scheme (§6.1). LEFT_DRAG on the globe in 3D keeps the grabbed point under the cursor.
    c.rotateEventTypes = CameraEventType.LEFT_DRAG
    c.tiltEventTypes = [CameraEventType.RIGHT_DRAG, { eventType: CameraEventType.LEFT_DRAG, modifier: KeyboardEventModifier.CTRL }]
    // Chromium reports trackpad pinch as ctrl+wheel.
    c.zoomEventTypes = [CameraEventType.WHEEL, CameraEventType.PINCH, { eventType: CameraEventType.WHEEL, modifier: KeyboardEventModifier.CTRL }]
    c.translateEventTypes = []
    c.lookEventTypes = []
    c.enableCollisionDetection = true
    c.maximumZoomDistance = 4.0e7
    c.zoomFactor = 4
    this.attach()
  }

  get isFlyMode(): boolean {
    return this.flyMode
  }

  get isEyeLevel(): boolean {
    return this.eyeLevel
  }

  configure(settings: NavigationSettings): void {
    this.settings = settings
    const c = this.scene.screenSpaceCameraController
    const inertia = clamp(settings.inertia, 0, 0.95)
    c.inertiaSpin = inertia
    c.inertiaTranslate = inertia
    c.inertiaZoom = Math.min(inertia, 0.85)
    c.minimumZoomDistance = this.eyeLevel ? EYE_HEIGHT * 0.8 : settings.minClearance
  }

  // ───────────────────────────── input wiring ─────────────────────────────

  private listen<K extends keyof WindowEventMap>(target: Window, type: K, fn: (e: WindowEventMap[K]) => void): void
  private listen<K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void): void
  private listen<K extends keyof DocumentEventMap>(target: Document, type: K, fn: (e: DocumentEventMap[K]) => void): void
  private listen(target: EventTarget, type: string, fn: (e: Event) => void): void {
    const opts = { capture: true }
    target.addEventListener(type, fn, opts)
    this.disposers.push(() => target.removeEventListener(type, fn, opts))
  }

  private attach(): void {
    const canvas = this.scene.canvas
    this.listen(window, 'keydown', (e) => this.onKey(e, true))
    this.listen(window, 'keyup', (e) => this.onKey(e, false))
    this.listen(window, 'blur', () => this.keys.clear())
    this.listen(canvas, 'pointerdown', (e) => this.onPointerDown(e))
    this.listen(window, 'pointermove', (e) => this.onPointerMove(e))
    this.listen(window, 'pointerup', (e) => this.onPointerUp(e))
    this.listen(canvas, 'wheel', () => this.userInput({ exitEyeLevel: true }))
    this.listen(canvas, 'mousemove', (e) => {
      this.mouse = { x: e.offsetX, y: e.offsetY }
    })
    this.listen(canvas, 'mouseleave', () => {
      this.mouse = null
    })
    this.listen(document, 'pointerlockchange', () => this.onPointerLockChange())
    this.listen(document, 'mousemove', (e) => this.onFlyLook(e))
    // Middle-click autoscroll would fight the heading drag.
    this.listen(canvas, 'mousedown', (e) => {
      if (e.button === 1) e.preventDefault()
    })
  }

  destroy(): void {
    this.disposers.forEach((d) => d())
    if (this.raf !== null) cancelAnimationFrame(this.raf)
  }

  private userInput({ exitEyeLevel = false } = {}): void {
    this.scene.camera.cancelFlight()
    this.animationToken++
    if (exitEyeLevel) this.setEyeLevel(false)
    this.callbacks.onUserInput()
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    this.shift = e.shiftKey
    this.alt = e.altKey
    if (!MOVEMENT_KEYS.has(e.code)) return
    if (down && (isTyping(e.target) || !this.callbacks.keyboardEnabled() || e.ctrlKey || e.metaKey)) return
    if (down) {
      e.preventDefault()
      if (!this.keys.has(e.code)) {
        this.userInput({ exitEyeLevel: e.code === 'KeyQ' || e.code === 'KeyE' })
      }
      this.keys.add(e.code)
      this.startLoop()
    } else {
      this.keys.delete(e.code)
    }
  }

  private onPointerDown(e: PointerEvent): void {
    const exit = e.button === 2 || (e.button === 0 && e.ctrlKey) || e.button === 1
    this.userInput({ exitEyeLevel: exit })
    this.headingVelocity = 0
    // Middle-drag or Shift+Left-drag: rotate heading around the point under the cursor.
    if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
      const rect = this.scene.canvas.getBoundingClientRect()
      const pivot = pickSurface(this.scene, e.clientX - rect.left, e.clientY - rect.top)
      if (pivot) {
        this.headingDrag = { pivot, lastX: e.clientX, pointerId: e.pointerId }
        this.headingPivot = pivot
        this.scene.canvas.setPointerCapture?.(e.pointerId)
      }
    }
  }

  private onPointerMove(e: PointerEvent): void {
    const drag = this.headingDrag
    if (!drag || e.pointerId !== drag.pointerId) return
    const dx = e.clientX - drag.lastX
    drag.lastX = e.clientX
    // Same direction convention as Cesium's orbit: drag right turns the view right.
    const angle = (-dx / Math.max(1, this.scene.canvas.clientWidth)) * Math.PI * 2
    this.rotateAroundUp(drag.pivot, angle)
    this.headingVelocity = angle
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.headingDrag || e.pointerId !== this.headingDrag.pointerId) return
    this.headingDrag = null
    if (Math.abs(this.headingVelocity) > 1e-4 && this.settings.inertia > 0) this.startLoop()
    else this.headingVelocity = 0
  }

  // ───────────────────────────── fly mode ─────────────────────────────

  toggleFlyMode(): void {
    if (this.flyMode) {
      document.exitPointerLock()
    } else {
      this.userInput({ exitEyeLevel: false })
      void this.scene.canvas.requestPointerLock()
    }
  }

  private onPointerLockChange(): void {
    const active = document.pointerLockElement === this.scene.canvas
    if (active === this.flyMode) return
    this.flyMode = active
    this.scene.screenSpaceCameraController.enableInputs = !active
    if (!active) this.keys.clear()
    this.callbacks.onFlyModeChange(active)
  }

  private onFlyLook(e: MouseEvent): void {
    if (!this.flyMode) return
    const sensitivity = 0.0022
    // Mouse right turns right (clockwise from above = negative about the local up axis).
    this.turn(this.localUp(), -e.movementX * sensitivity)
    const dy = (this.settings.invertFlyY ? 1 : -1) * e.movementY * sensitivity
    this.pitchBy(dy)
  }

  // ───────────────────────────── per-frame movement ─────────────────────────────

  private startLoop(): void {
    if (this.raf !== null) return
    this.lastTick = performance.now()
    const step = (now: number) => {
      const dt = Math.min(0.1, (now - this.lastTick) / 1000)
      this.lastTick = now
      const active = this.tick(dt)
      this.raf = active ? requestAnimationFrame(step) : null
    }
    this.raf = requestAnimationFrame(step)
  }

  private localUp(position = this.scene.camera.positionWC): Cartesian3 {
    return this.scene.ellipsoid.geodeticSurfaceNormal(position, new Cartesian3())
  }

  /**
   * Rotates the view in place about `axis` by `angle` using the right-hand rule.
   * (Cesium's Camera#look rotates by -angle, which is easy to get backwards.)
   */
  private turn(axis: Cartesian3, angle: number): void {
    this.scene.camera.look(axis, -angle)
  }

  /** Positive delta pitches up; clamped short of straight up/down so heading stays defined. */
  private pitchBy(delta: number): void {
    const cam = this.scene.camera
    const next = clamp(cam.pitch + delta, -CesiumMath.PI_OVER_TWO + 0.01, CesiumMath.PI_OVER_TWO - 0.01)
    this.turn(Cartesian3.clone(cam.rightWC), next - cam.pitch)
  }

  /** Returns true while there is still something to animate. */
  private tick(dt: number): boolean {
    const cam = this.scene.camera
    let active = false

    // Heading inertia after a heading drag.
    if (!this.headingDrag && Math.abs(this.headingVelocity) > 1e-5 && this.headingPivot) {
      this.rotateAroundUp(this.headingPivot, this.headingVelocity)
      this.headingVelocity *= Math.pow(this.settings.inertia * 0.94, dt * 60)
      active = true
    } else if (!this.headingDrag) {
      this.headingVelocity = 0
    }

    if (this.keys.size === 0) return active
    active = true
    if (!Matrix4.equals(cam.transform, Matrix4.IDENTITY)) cam.lookAtTransform(Matrix4.IDENTITY)

    const k = (code: string) => (this.keys.has(code) ? 1 : 0)
    const carto = Cartographic.fromCartesian(cam.positionWC)
    const lon = toDeg(carto.longitude)
    const lat = toDeg(carto.latitude)
    const ground = surfaceHeight(this.scene, lon, lat) ?? 0
    const agl = Math.max(carto.height - ground, 1)
    const boost = this.shift ? 4 : this.alt ? 0.2 : 1
    const mult = this.settings.speedMultiplier * boost
    const speed = (this.eyeLevel ? 6 : clamp(agl * 1.1, 4, 4.0e6)) * mult

    const up = this.localUp()
    let forward: Cartesian3
    let right: Cartesian3
    if (this.flyMode) {
      forward = Cartesian3.clone(cam.directionWC)
      right = Cartesian3.clone(cam.rightWC)
    } else {
      // Ground-relative: move parallel to the surface regardless of tilt.
      const dir = Math.abs(Cartesian3.dot(cam.directionWC, up)) > 0.98 ? cam.upWC : cam.directionWC
      forward = Cartesian3.subtract(dir, Cartesian3.multiplyByScalar(up, Cartesian3.dot(dir, up), new Cartesian3()), new Cartesian3())
      Cartesian3.normalize(forward, forward)
      right = Cartesian3.normalize(Cartesian3.cross(forward, up, new Cartesian3()), new Cartesian3())
    }
    const f = k('KeyW') - k('KeyS')
    const r = k('KeyD') - k('KeyA')
    const v = k('KeyE') - k('KeyQ')
    const move = new Cartesian3()
    Cartesian3.add(move, Cartesian3.multiplyByScalar(forward, f, new Cartesian3()), move)
    Cartesian3.add(move, Cartesian3.multiplyByScalar(right, r, new Cartesian3()), move)
    if (Cartesian3.magnitude(move) > 1) Cartesian3.normalize(move, move)
    Cartesian3.multiplyByScalar(move, speed * dt, move)
    Cartesian3.add(move, Cartesian3.multiplyByScalar(up, v * speed * dt, new Cartesian3()), move)
    Cartesian3.add(cam.position, move, cam.position)

    // Arrow keys look around (heading around the local vertical keeps the horizon level).
    const lookRate = (this.shift ? 120 : this.alt ? 20 : 60) * (Math.PI / 180) * dt
    const yaw = k('ArrowLeft') - k('ArrowRight')
    if (yaw) this.turn(this.localUp(), yaw * lookRate)
    const pitch = k('ArrowUp') - k('ArrowDown')
    if (pitch) this.pitchBy(pitch * lookRate)

    this.enforceClearance(f !== 0 || r !== 0)
    return active
  }

  /** Keeps the camera above the surface; in eye-level mode, follows the ground. */
  private enforceClearance(movedHorizontally: boolean): void {
    const cam = this.scene.camera
    const c = Cartographic.fromCartesian(cam.positionWC)
    const ground = surfaceHeight(this.scene, toDeg(c.longitude), toDeg(c.latitude))
    if (ground === undefined) return
    const minHeight = ground + (this.eyeLevel ? EYE_HEIGHT : this.settings.minClearance)
    if (this.eyeLevel && movedHorizontally) c.height = ground + EYE_HEIGHT
    else if (c.height < minHeight) c.height = minHeight
    else return
    Cartographic.toCartesian(c, this.scene.ellipsoid, cam.position)
  }

  // ───────────────────────────── orbit helpers ─────────────────────────────

  /** Rotates the camera rigidly about `axis` through `pivot` (right-hand rule). */
  private orbit(pivot: Cartesian3, axis: Cartesian3, angle: number): void {
    const cam = this.scene.camera
    if (!Matrix4.equals(cam.transform, Matrix4.IDENTITY)) cam.lookAtTransform(Matrix4.IDENTITY)
    const m = Matrix3.fromQuaternion(Quaternion.fromAxisAngle(axis, angle, scratchQuat), scratchMatrix)
    const rel = Cartesian3.subtract(cam.position, pivot, new Cartesian3())
    Matrix3.multiplyByVector(m, rel, rel)
    Cartesian3.add(pivot, rel, cam.position)
    Matrix3.multiplyByVector(m, cam.direction, cam.direction)
    Matrix3.multiplyByVector(m, cam.up, cam.up)
    Matrix3.multiplyByVector(m, cam.right, cam.right)
  }

  private rotateAroundUp(pivot: Cartesian3, angle: number): void {
    this.orbit(pivot, this.localUp(pivot), angle)
  }

  /** Runs `frame(progress)` with easing over `ms`; cancelled by any user input. */
  private animate(ms: number, frame: (eased: number, prevEased: number) => void): Promise<void> {
    const token = ++this.animationToken
    const start = performance.now()
    let prev = 0
    return new Promise((resolve) => {
      const step = (now: number) => {
        if (token !== this.animationToken) return resolve()
        const t = Math.min(1, (now - start) / ms)
        const eased = EasingFunction.QUADRATIC_IN_OUT(t)
        frame(eased, prev)
        prev = eased
        if (t < 1) requestAnimationFrame(step)
        else resolve()
      }
      requestAnimationFrame(step)
    })
  }

  private pivot(): Cartesian3 {
    return cameraTarget(this.scene)
  }

  /** N: face north, orbiting around the point at the screen center. */
  resetNorth(): Promise<void> {
    this.scene.camera.cancelFlight()
    const pivot = this.pivot()
    let heading = this.scene.camera.heading
    if (heading > Math.PI) heading -= 2 * Math.PI
    return this.animate(450, (e, p) => this.rotateAroundUp(pivot, heading * (e - p)))
  }

  rotateHeadingBy(angle: number): void {
    this.rotateAroundUp(this.pivot(), angle)
  }

  /** U: look straight down at the point at the screen center. */
  resetTilt(): Promise<void> {
    return this.tiltTo(-90)
  }

  /** Tilt widget: toggles top-down / oblique. */
  toggleTilt(): Promise<void> {
    return this.tiltTo(toDeg(this.scene.camera.pitch) < -80 ? -35 : -90)
  }

  private tiltTo(pitchDeg: number): Promise<void> {
    this.scene.camera.cancelFlight()
    this.setEyeLevel(false)
    const cam = this.scene.camera
    const pivot = this.pivot()
    const delta = toRad(pitchDeg) - cam.pitch
    const axis = Cartesian3.clone(cam.rightWC)
    return this.animate(500, (e, p) => {
      this.orbit(pivot, axis, delta * (e - p))
      this.enforceClearance(false)
    })
  }

  /** R: level the horizon at the current position. */
  levelHorizon(): Promise<void> {
    const cam = this.scene.camera
    cam.cancelFlight()
    const start = cam.pitch
    // Track the absolute target so clamping near straight-down can't accumulate error.
    return this.animate(450, (e) => this.pitchBy(start * (1 - e) - cam.pitch))
  }

  zoomBy(factor: number): Promise<void> {
    this.scene.camera.cancelFlight()
    this.setEyeLevel(false)
    const cam = this.scene.camera
    const pivot = this.pivot()
    const start = Cartesian3.clone(cam.positionWC)
    const offset = Cartesian3.subtract(start, pivot, new Cartesian3())
    const minDist = this.settings.minClearance * 2
    const dist = Cartesian3.magnitude(offset)
    const target = Math.max(minDist, dist * factor)
    return this.animate(350, (e) => {
      const d = dist + (target - dist) * e
      const pos = Cartesian3.add(pivot, Cartesian3.multiplyByScalar(Cartesian3.normalize(offset, new Cartesian3()), d, new Cartesian3()), new Cartesian3())
      Cartesian3.clone(pos, cam.position)
      this.enforceClearance(false)
    })
  }

  // ───────────────────────────── eye level ─────────────────────────────

  private setEyeLevel(active: boolean): void {
    if (this.eyeLevel === active) return
    this.eyeLevel = active
    this.scene.screenSpaceCameraController.minimumZoomDistance = active ? EYE_HEIGHT * 0.8 : this.settings.minClearance
    this.callbacks.onEyeLevelChange(active)
  }

  /**
   * Drops the camera to standing height at the point under the cursor (or screen center)
   * and levels the horizon — "what would I see from here".
   */
  async goToEyeLevel(): Promise<void> {
    const canvas = this.scene.canvas
    const at = this.mouse ?? { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 }
    const hit = pickSurface(this.scene, at.x, at.y) ?? this.pivot()
    const c = Cartographic.fromCartesian(hit)
    let ground = c.height
    try {
      const precise = await this.callbacks.sampleGround(toDeg(c.longitude), toDeg(c.latitude))
      if (precise !== undefined && Number.isFinite(precise)) ground = precise
    } catch {
      /* keep the picked height */
    }
    const cam = this.scene.camera
    const controller = this.scene.screenSpaceCameraController
    controller.minimumZoomDistance = EYE_HEIGHT * 0.8
    // Keep the heading so the view looks across the point, in the direction you were facing.
    const arrived = await new Promise<boolean>((resolve) => {
      cam.flyTo({
        destination: Cartesian3.fromRadians(c.longitude, c.latitude, ground + EYE_HEIGHT),
        orientation: { heading: cam.heading, pitch: 0, roll: 0 },
        duration: 1.6,
        complete: () => resolve(true),
        cancel: () => resolve(false)
      })
    })
    if (arrived) this.setEyeLevel(true)
    else controller.minimumZoomDistance = this.settings.minClearance
  }

  // ───────────────────────────── flights ─────────────────────────────

  private flightDuration(destination: Cartesian3): number {
    const d = Cartesian3.distance(this.scene.camera.positionWC, destination)
    return clamp(0.8 + Math.log10(1 + d / 500) * 0.9, 0.8, 5)
  }

  flyToView(view: CameraView, duration?: number): Promise<void> {
    this.setEyeLevel(false)
    const destination = Cartesian3.fromDegrees(view.longitude, view.latitude, view.height)
    return new Promise((resolve) => {
      this.scene.camera.flyTo({
        destination,
        orientation: { heading: toRad(view.heading), pitch: toRad(view.pitch), roll: toRad(view.roll) },
        duration: duration ?? this.flightDuration(destination),
        complete: () => resolve(),
        cancel: () => resolve()
      })
    })
  }

  setView(view: CameraView): void {
    this.scene.camera.setView({
      destination: Cartesian3.fromDegrees(view.longitude, view.latitude, view.height),
      orientation: { heading: toRad(view.heading), pitch: toRad(view.pitch), roll: toRad(view.roll) }
    })
  }

  /** Flies to a geographic location with an eased arc (§6.4). */
  flyToLocation(latitude: number, longitude: number, opts: FlyToLocationOptions = {}): Promise<void> {
    this.setEyeLevel(false)
    const ground = opts.groundHeight ?? 0
    const cam = this.scene.camera
    if (opts.altitude !== undefined) {
      return this.flyToView({
        longitude,
        latitude,
        height: ground + Math.max(opts.altitude, EYE_HEIGHT),
        heading: opts.heading ?? 0,
        pitch: opts.pitch ?? -20,
        roll: 0
      })
    }
    const center = Cartesian3.fromDegrees(longitude, latitude, ground)
    const range = Math.max(opts.range ?? 6000, 50)
    const heading = opts.heading !== undefined ? toRad(opts.heading) : cam.heading
    const pitch = toRad(opts.pitch ?? -38)
    return new Promise((resolve) => {
      cam.flyToBoundingSphere(new BoundingSphere(center, 0), {
        offset: new HeadingPitchRange(heading, pitch, range),
        duration: this.flightDuration(center),
        complete: () => resolve(),
        cancel: () => resolve()
      })
    })
  }

  /** Double-click: fly closer to the clicked point, keeping the heading. */
  flyToPoint(windowPosition: Cartesian2): void {
    const hit = pickSurface(this.scene, windowPosition.x, windowPosition.y)
    if (!hit) return
    this.setEyeLevel(false)
    const cam = this.scene.camera
    const distance = Cartesian3.distance(cam.positionWC, hit)
    const range = Math.max(distance * 0.4, 40)
    const pitch = Math.min(cam.pitch, toRad(-25))
    cam.flyToBoundingSphere(new BoundingSphere(hit, 0), {
      offset: new HeadingPitchRange(cam.heading, pitch, range),
      duration: clamp(0.6 + Math.log10(1 + distance / 1000) * 0.6, 0.6, 2.5)
    })
  }
}
