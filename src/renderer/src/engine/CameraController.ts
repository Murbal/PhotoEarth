import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cartographic,
  CameraEventType,
  EasingFunction,
  HeadingPitchRange,
  IntersectionTests,
  KeyboardEventModifier,
  Math as CesiumMath,
  Matrix3,
  Matrix4,
  PerspectiveFrustum,
  Quaternion,
  Ray,
  type Scene
} from 'cesium'
import type { CameraView, NavigationSettings } from '@shared/types'
import { MovementSpeed } from './MovementSpeed'
import { cameraTarget, clamp, pickSurface, pickSurfaceCpu, raycastSurface, surfaceHeight, toDeg, toRad } from './util'
import { GESTURE_GAP_MS, WheelClassifier } from './WheelInput'

/** followPointer while an overview map drag carries the camera (never a real pointer id). */
const GLIDE_POINTER = -1

/** Standing eye height for eye-level mode, meters. */
export const EYE_HEIGHT = 1.7
/** Standing within this of a pin counts as standing at it (eye-level toggle). */
const PIN_REACHED_M = 5
/** Higher above ground than this, the camera has left eye level. */
const EYE_LEVEL_MAX_AGL = 30

/**
 * Field of view across the long side of the view (how Cesium applies `fov`) for a
 * 35 mm-equivalent focal length: a full-frame sensor is 36 mm wide.
 */
export function focalLengthToFov(mm: number): number {
  return 2 * Math.atan(18 / mm)
}

/** Fly mode uses a wide 20 mm lens for a first-person feel; orbit keeps Cesium's 60°. */
export const FLY_FOCAL_LENGTH = 20
export const ORBIT_FOV = CesiumMath.toRadians(60)
const FOV_EASE_MS = 300

/** How often the distance ahead (a CPU ray cast) is re-measured during keyboard movement. */
const AHEAD_PROBE_MS = 100

/** Longest time step of keyboard movement and inertia. */
const MAX_TICK_SECONDS = 0.25

/** Outside fly mode, the view can't pitch further up than this (looking straight up breaks zoom and movement). */
const MAX_ORBIT_PITCH_UP = CesiumMath.toRadians(60)

/** Pinch zoom: log of the zoom factor per unit of ctrl+wheel delta (Chromium sends ~100 × log of the pinch scale). */
const PINCH_RATE = 0.012

/** Trackpad panning moves the grabbed point at most this fraction of its distance per event (near the horizon a pixel spans kilometers). */
const MAX_PAN_STEP = 0.25

/** Trackpad orbiting can't tilt the view above this pitch (the camera would sink below the pivot). */
const MAX_ORBIT_TILT = CesiumMath.toRadians(-1)

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
  /** Ground height found by the previous tick's clearance check (saves a second sample). */
  private tickGround: number | undefined
  private readonly speed = new MovementSpeed()
  /** Distance to the first surface along the direction of travel, and when it was measured. */
  private ahead: number | null = null
  private aheadAt = Number.NEGATIVE_INFINITY
  /** Last known height above the ground below, kept while the ground is briefly unknown. */
  private lastAgl: number | null = null
  private flyMode = false
  private eyeLevel = false
  /** The view before dropping to eye level, and where we stood, for leaving it again. */
  private eyeLevelReturn: { position: Cartesian3; heading: number; pitch: number; roll: number; spot: Cartesian3 } | null = null
  private settings: NavigationSettings = { inertia: 0.8, speedMultiplier: 1, invertFlyY: false, minClearance: 2, scrollGesture: 'auto' }
  private headingDrag: { pivot: Cartesian3; lastX: number; pointerId: number } | null = null
  private headingVelocity = 0
  private headingPivot: Cartesian3 | null = null
  private animationToken = 0
  private fovRaf: number | null = null
  /** A field of view that replaces the orbit / fly default (viewfinder mode), radians. */
  private fovOverride: number | null = null
  /**
   * Terrain following during drags, their inertia and keyboard movement: the height above
   * ground to keep (null: off; NaN: record it on the next frame). These all move the camera
   * at a constant altitude, so rising ground would otherwise push it down to the minimum
   * clearance and leave it there.
   */
  private followAgl: number | null = null
  /** Pointer of the drag that started following. */
  private followPointer: number | null = null
  /** Ground height and camera position seen on the previous following frame. */
  private followGround = 0
  private readonly followPosition = new Cartesian3()
  private mouse: { x: number; y: number } | null = null
  private readonly wheel = new WheelClassifier()
  /**
   * The current two-finger trackpad gesture: the surface point under the cursor when it began
   * (null over the sky), where the cursor was, and the time of its last event.
   */
  private touchpad: { anchor: Cartesian3 | null; x: number; y: number; time: number } | null = null
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
    // After Cesium's camera controller has moved the camera, before the frame renders.
    this.disposers.push(
      scene.preUpdate.addEventListener(() => this.followTerrain()),
      scene.camera.moveEnd.addEventListener(() => {
        // Drag or zoom inertia and keyboard movement have come to rest.
        if (this.followPointer === null && this.keys.size === 0) this.endFollow()
      })
    )
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

  private listen<K extends keyof WindowEventMap>(target: Window, type: K, fn: (e: WindowEventMap[K]) => void, passive?: boolean): void
  private listen<K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void): void
  private listen<K extends keyof DocumentEventMap>(target: Document, type: K, fn: (e: DocumentEventMap[K]) => void): void
  private listen(target: EventTarget, type: string, fn: (e: Event) => void, passive?: boolean): void {
    const opts = { capture: true, passive }
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
    // On the window in the capture phase, so trackpad gestures can be kept from Cesium's own
    // wheel zoom on the canvas. Window wheel listeners are passive unless told otherwise.
    this.listen(window, 'wheel', (e) => this.onWheel(e), false)
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
    if (this.fovRaf !== null) cancelAnimationFrame(this.fovRaf)
  }

  private userInput({ exitEyeLevel = false, keepFollow = false } = {}): void {
    this.scene.camera.cancelFlight()
    this.animationToken++
    if (!keepFollow) this.endFollow()
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
        // Another key during movement keeps the height being followed (re-recording it on
        // every press would let it creep down).
        this.userInput({ exitEyeLevel: e.code === 'KeyQ' || e.code === 'KeyE', keepFollow: true })
      }
      this.keys.add(e.code)
      if (this.followAgl === null) this.startFollow()
      this.startLoop()
    } else {
      this.keys.delete(e.code)
    }
  }

  private onPointerDown(e: PointerEvent): void {
    const exit = e.button === 2 || (e.button === 0 && e.ctrlKey) || e.button === 1
    this.userInput({ exitEyeLevel: exit })
    this.headingVelocity = 0
    // Left-drag (pan), Shift+Left and middle-drag (heading orbit) keep the altitude; right and
    // Ctrl+Left tilt, which changes the height on purpose.
    if ((e.button === 0 && !e.ctrlKey) || e.button === 1) {
      this.startFollow()
      this.followPointer = e.pointerId
    }
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
    if (e.pointerId === this.followPointer) this.followPointer = null
    if (!this.headingDrag || e.pointerId !== this.headingDrag.pointerId) return
    this.headingDrag = null
    if (Math.abs(this.headingVelocity) > 1e-4 && this.settings.inertia > 0) this.startLoop()
    else this.headingVelocity = 0
  }

  // ───────────────────────────── wheel / trackpad ─────────────────────────────

  /**
   * Mouse wheel: Cesium zooms toward the cursor. Trackpad (§6.1): two-finger scroll pans
   * (looks around at eye level), pinch zooms toward the cursor and Alt/⌥ + scroll orbits.
   */
  private onWheel(e: WheelEvent): void {
    const canvas = this.scene.canvas
    if (e.target !== canvas) return
    if (this.flyMode) return
    const device = this.wheel.classify(e)
    const gesture = this.settings.scrollGesture
    const trackpad = e.ctrlKey ? device === 'trackpad' : gesture === 'pan' || (gesture === 'auto' && device === 'trackpad')
    if (!trackpad) {
      this.userInput({ exitEyeLevel: true })
      // Zooming out backs away along the view, which descends when looking up: keep the
      // height above ground. Zooming in descends on purpose.
      if (e.deltaY > 0) this.startFollow()
      return
    }
    e.preventDefault()
    e.stopPropagation()

    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const scale = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? canvas.clientHeight : 1
    const dx = e.deltaX * scale
    const dy = e.deltaY * scale
    const g = this.touchpad
    const fresh = !g || e.timeStamp - g.time > GESTURE_GAP_MS || Math.hypot(x - g.x, y - g.y) > 4
    if (fresh) this.touchpad = { anchor: pickSurfaceCpu(this.scene, x, y) ?? null, x, y, time: e.timeStamp }
    else g.time = e.timeStamp
    const anchor = this.touchpad!.anchor
    const cam = this.scene.camera
    if (!Matrix4.equals(cam.transform, Matrix4.IDENTITY)) cam.lookAtTransform(Matrix4.IDENTITY)

    if (e.ctrlKey) {
      this.userInput({ exitEyeLevel: true })
      this.pinchZoom(x, y, dy, anchor)
    } else if (this.eyeLevel) {
      this.userInput()
      this.lookBy(dx, dy)
    } else if (e.altKey) {
      this.userInput()
      this.orbitBy(dx, dy, anchor ?? cameraTarget(this.scene, true))
    } else {
      // Panning keeps the height above ground, like a left-drag.
      this.userInput({ keepFollow: !fresh })
      if (fresh || this.followAgl === null) this.startFollow()
      this.panBy(x, y, dx, dy, anchor)
    }
  }

  /**
   * Moves the view so the ground follows the fingers: the point under the cursor + delta comes
   * to the cursor. Rotates the camera about the Earth's center, on a sphere through the grabbed
   * point, so it works from street level to the whole globe.
   */
  private panBy(x: number, y: number, dx: number, dy: number, anchor: Cartesian3 | null): void {
    const cam = this.scene.camera
    const radius = anchor ? Cartesian3.magnitude(anchor) : 0
    if (anchor && radius < Cartesian3.magnitude(cam.positionWC) - 0.5) {
      const sphere = new BoundingSphere(Cartesian3.ZERO, radius)
      const hit = (px: number, py: number): Cartesian3 | undefined => {
        const ray = cam.getPickRay(new Cartesian2(px, py))
        const t = ray && IntersectionTests.raySphere(ray, sphere)
        return ray && t && t.start > 0 ? Ray.getPoint(ray, t.start) : undefined
      }
      const a = hit(x, y)
      const b = hit(x + dx, y + dy)
      if (a && b) {
        const axis = Cartesian3.cross(a, b, new Cartesian3())
        if (Cartesian3.magnitudeSquared(axis) === 0) return
        let angle = Cartesian3.angleBetween(a, b)
        const step = Cartesian3.distance(a, b)
        const maxStep = MAX_PAN_STEP * Cartesian3.distance(cam.positionWC, a)
        if (step > maxStep) angle *= maxStep / step
        this.orbit(Cartesian3.ZERO, Cartesian3.normalize(axis, axis), angle)
        this.levelRoll()
        this.enforceClearance(false)
        return
      }
    }
    // Over the sky: slide along the ground at a rate set by the height above it.
    const c = Cartographic.fromCartesian(cam.positionWC)
    const ground = this.scene.globeHeight
    const agl = Math.max(1, ground !== undefined && Number.isFinite(ground) ? c.height - ground : c.height)
    const fov = cam.frustum instanceof PerspectiveFrustum ? (cam.frustum.fov ?? ORBIT_FOV) : ORBIT_FOV
    const canvas = this.scene.canvas
    const perPixel = (2 * agl * Math.tan(fov / 2)) / Math.max(1, canvas.clientWidth, canvas.clientHeight)
    const up = this.localUp()
    const dir = Math.abs(Cartesian3.dot(cam.directionWC, up)) > 0.98 ? cam.upWC : cam.directionWC
    const forward = Cartesian3.subtract(dir, Cartesian3.multiplyByScalar(up, Cartesian3.dot(dir, up), new Cartesian3()), new Cartesian3())
    Cartesian3.normalize(forward, forward)
    const right = Cartesian3.normalize(Cartesian3.cross(forward, up, new Cartesian3()), new Cartesian3())
    const move = Cartesian3.multiplyByScalar(right, dx * perPixel, new Cartesian3())
    Cartesian3.add(move, Cartesian3.multiplyByScalar(forward, -dy * perPixel, new Cartesian3()), move)
    Cartesian3.add(cam.position, move, cam.position)
    this.enforceClearance(false)
  }

  /** Pinch: zoom toward the grabbed point (or along the ray to the cursor over the sky). */
  private pinchZoom(x: number, y: number, delta: number, anchor: Cartesian3 | null): void {
    const cam = this.scene.camera
    const factor = Math.exp(clamp(delta * PINCH_RATE, -0.5, 0.5))
    let target = anchor
    if (!target) {
      const ray = cam.getPickRay(new Cartesian2(x, y))
      if (!ray) return
      const c = Cartographic.fromCartesian(cam.positionWC)
      target = Ray.getPoint(ray, Math.max(50, c.height - (this.scene.globeHeight ?? 0)))
    }
    const offset = Cartesian3.subtract(cam.positionWC, target, new Cartesian3())
    const distance = Cartesian3.magnitude(offset)
    if (distance === 0) return
    const next = Math.max(distance * factor, Math.min(distance, this.settings.minClearance))
    const position = Cartesian3.add(target, Cartesian3.multiplyByScalar(offset, next / distance, offset), new Cartesian3())
    const height = Cartographic.fromCartesian(position)?.height ?? 0
    if (factor > 1 && height > this.scene.screenSpaceCameraController.maximumZoomDistance) return
    Cartesian3.clone(position, cam.position)
    this.enforceClearance(false)
  }

  /** Alt/⌥ + scroll: sideways turns the heading, up/down tilts, both around the grabbed point. */
  private orbitBy(dx: number, dy: number, pivot: Cartesian3): void {
    const cam = this.scene.camera
    const canvas = this.scene.canvas
    // Natural scrolling: the fingers move opposite to the deltas. Like a drag, fingers right
    // turn the view right and fingers up tilt it toward the horizon.
    const heading = (dx / Math.max(1, canvas.clientWidth)) * Math.PI * 2
    if (heading !== 0) this.rotateAroundUp(pivot, heading)
    const pitch = clamp(cam.pitch + (dy / Math.max(1, canvas.clientHeight)) * Math.PI, -CesiumMath.PI_OVER_TWO + 0.001, Math.max(MAX_ORBIT_TILT, cam.pitch))
    if (pitch !== cam.pitch) this.orbit(pivot, Cartesian3.clone(cam.rightWC), pitch - cam.pitch)
    this.enforceClearance(false)
  }

  /** Eye level: scroll drags the view like a panorama. */
  private lookBy(dx: number, dy: number): void {
    const frustum = this.scene.camera.frustum
    const fov = frustum instanceof PerspectiveFrustum ? (frustum.fov ?? ORBIT_FOV) : ORBIT_FOV
    const perPixel = fov / Math.max(1, this.scene.canvas.clientWidth)
    this.turn(this.localUp(), -dx * perPixel)
    this.pitchBy(-dy * perPixel)
  }

  /** Clears the slight roll that rotating about the Earth's center leaves on an ellipsoid. */
  private levelRoll(): void {
    const cam = this.scene.camera
    const roll = CesiumMath.negativePiToPi(cam.roll)
    if (Math.abs(roll) < 1e-6 || Math.abs(roll) > 0.02 || Math.abs(cam.pitch) > CesiumMath.toRadians(88)) return
    cam.setView({ orientation: { heading: cam.heading, pitch: cam.pitch, roll: 0 } })
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
    this.endFollow()
    this.scene.screenSpaceCameraController.enableInputs = !active
    if (!active) this.keys.clear()
    this.easeFov(this.targetFov())
    this.callbacks.onFlyModeChange(active)
  }

  /** The field of view of the current navigation mode, without an override (radians). */
  private defaultFov(): number {
    return this.flyMode ? focalLengthToFov(FLY_FOCAL_LENGTH) : ORBIT_FOV
  }

  private targetFov(): number {
    return this.fovOverride ?? this.defaultFov()
  }

  /**
   * Viewfinder mode: holds the field of view at `fov` (radians, Cesium's `fov`: across the
   * longer side of the view) through fly mode changes; null returns to the mode's default.
   * Eases when asked (switching on / off), else snaps (dragging the focal length, resizing).
   */
  setFovOverride(fov: number | null, ease: boolean): void {
    this.fovOverride = fov
    if (ease) {
      this.easeFov(this.targetFov())
      return
    }
    if (this.fovRaf !== null) cancelAnimationFrame(this.fovRaf)
    this.fovRaf = null
    const frustum = this.scene.camera.frustum
    if (frustum instanceof PerspectiveFrustum) frustum.fov = this.targetFov()
    this.scene.requestRender()
  }

  /**
   * Looking around turns the view by a fixed angle per pixel or second: through a long lens
   * that is far too fast, so it slows down in proportion to the narrower field of view.
   */
  private lookScale(): number {
    const frustum = this.scene.camera.frustum
    const fov = frustum instanceof PerspectiveFrustum ? (frustum.fov ?? ORBIT_FOV) : ORBIT_FOV
    return Math.min(1, fov / this.defaultFov())
  }

  /** Eases the field of view to `target` (radians) instead of snapping. */
  private easeFov(target: number): void {
    const frustum = this.scene.camera.frustum
    if (!(frustum instanceof PerspectiveFrustum)) return
    if (this.fovRaf !== null) cancelAnimationFrame(this.fovRaf)
    const from = frustum.fov ?? ORBIT_FOV
    const start = performance.now()
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / FOV_EASE_MS)
      // The last frame lands on the target exactly (from + (target − from) can be off by an ulp).
      frustum.fov = t < 1 ? from + (target - from) * EasingFunction.QUADRATIC_IN_OUT(t) : target
      this.scene.requestRender()
      this.fovRaf = t < 1 ? requestAnimationFrame(step) : null
    }
    this.fovRaf = requestAnimationFrame(step)
  }

  private onFlyLook(e: MouseEvent): void {
    if (!this.flyMode) return
    const sensitivity = 0.0022 * this.lookScale()
    // Mouse right turns right (clockwise from above = negative about the local up axis).
    this.turn(this.localUp(), -e.movementX * sensitivity)
    const dy = (this.settings.invertFlyY ? 1 : -1) * e.movementY * sensitivity
    this.pitchBy(dy)
  }

  // ───────────────────────────── per-frame movement ─────────────────────────────

  private startLoop(): void {
    if (this.raf !== null) return
    this.lastTick = performance.now()
    this.tickGround = undefined
    this.speed.reset()
    this.ahead = null
    this.lastAgl = null
    const step = (now: number) => {
      // Real elapsed time, so speed doesn't drop with the frame rate; capped so a stall (a
      // blocked main thread) doesn't turn into one big jump.
      const dt = Math.min(MAX_TICK_SECONDS, (now - this.lastTick) / 1000)
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

  /**
   * Positive delta pitches up; clamped short of straight up/down so heading stays defined,
   * and outside fly mode to MAX_ORBIT_PITCH_UP (a view already above it can only come down).
   */
  private pitchBy(delta: number): void {
    const cam = this.scene.camera
    const up = this.flyMode ? CesiumMath.PI_OVER_TWO - 0.01 : Math.max(MAX_ORBIT_PITCH_UP, cam.pitch)
    const next = clamp(cam.pitch + delta, -CesiumMath.PI_OVER_TWO + 0.01, up)
    this.turn(Cartesian3.clone(cam.rightWC), next - cam.pitch)
  }

  // ───────────────────────────── terrain following ─────────────────────────────

  /** Records the height above ground to keep (now if the ground is known, else next frame). */
  private startFollow(): void {
    this.followAgl = Number.NaN
    this.followTerrain()
  }

  private endFollow(): void {
    this.followAgl = null
    this.followPointer = null
  }

  /** Lifts the camera back to the recorded height above ground where the ground rose. */
  private followTerrain(): void {
    if (this.followAgl === null || this.flyMode) return
    const cam = this.scene.camera
    // Cesium already samples the surface below the camera every frame (for its own collision).
    const ground = this.scene.globeHeight
    if (ground === undefined || !Number.isFinite(ground) || ground < -1000) return
    if (!Matrix4.equals(cam.transform, Matrix4.IDENTITY)) return
    const c = Cartographic.fromCartesian(cam.positionWC)
    if (!c) return
    const minimum = this.eyeLevel ? EYE_HEIGHT : this.settings.minClearance
    const rise = ground - this.followGround
    const moved = Cartesian3.distance(cam.positionWC, this.followPosition)
    this.followGround = ground
    Cartesian3.clone(cam.positionWC, this.followPosition)
    // Recording, or the ground jumped up far more than the camera moved: finer tiles replaced
    // coarse ones (which sag below the real surface), not ground rising along the path. Keep
    // the height above the corrected ground instead of lifting the camera by the correction.
    if (Number.isNaN(this.followAgl) || rise > Math.max(1, 2 * moved)) {
      this.followAgl = Math.max(c.height - ground, minimum)
      return
    }
    const height = ground + this.followAgl
    if (c.height >= height - 0.05) return
    c.height = height
    Cartographic.toCartesian(c, this.scene.ellipsoid, cam.position)
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

    if (this.keys.size === 0) {
      this.tickGround = undefined
      return active
    }
    active = true
    if (!Matrix4.equals(cam.transform, Matrix4.IDENTITY)) cam.lookAtTransform(Matrix4.IDENTITY)

    const k = (code: string) => (this.keys.has(code) ? 1 : 0)
    const carto = Cartographic.fromCartesian(cam.positionWC)
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
    const travel = Cartesian3.multiplyByScalar(forward, f, new Cartesian3())
    Cartesian3.add(travel, Cartesian3.multiplyByScalar(right, r, new Cartesian3()), travel)
    Cartesian3.add(travel, Cartesian3.multiplyByScalar(up, v, new Cartesian3()), travel)
    const moving = Cartesian3.magnitudeSquared(travel) > 1e-12
    if (moving) Cartesian3.normalize(travel, travel)
    const boost = this.shift ? 4 : this.alt ? 0.2 : 1
    const mult = this.settings.speedMultiplier * boost
    let speed = 6 * mult
    if (!this.eyeLevel) {
      const reference = this.speed.update(this.measureClearance(carto, moving ? travel : null), dt)
      speed = MovementSpeed.speedFor(reference ?? Math.max(carto.height, 1)) * mult
    }
    // Climbing or descending on purpose: follow the ground at the new height.
    if (v !== 0 && this.followAgl !== null) this.followAgl = Number.NaN
    const move = new Cartesian3()
    Cartesian3.add(move, Cartesian3.multiplyByScalar(forward, f, new Cartesian3()), move)
    Cartesian3.add(move, Cartesian3.multiplyByScalar(right, r, new Cartesian3()), move)
    if (Cartesian3.magnitude(move) > 1) Cartesian3.normalize(move, move)
    Cartesian3.multiplyByScalar(move, speed * dt, move)
    Cartesian3.add(move, Cartesian3.multiplyByScalar(up, v * speed * dt, new Cartesian3()), move)
    Cartesian3.add(cam.position, move, cam.position)

    // Arrow keys look around (heading around the local vertical keeps the horizon level).
    const lookRate = (this.shift ? 120 : this.alt ? 20 : 60) * (Math.PI / 180) * dt * this.lookScale()
    const yaw = k('ArrowLeft') - k('ArrowRight')
    if (yaw) this.turn(this.localUp(), yaw * lookRate)
    const pitch = k('ArrowUp') - k('ArrowDown')
    if (pitch) this.pitchBy(pitch * lookRate)

    this.tickGround = this.enforceClearance(f !== 0 || r !== 0)
    return active
  }

  /**
   * How much room the camera has (meters, null when unknown): its height above the ground
   * below, or the distance to the first surface along the direction of travel if that's less.
   */
  private measureClearance(carto: Cartographic, travel: Cartesian3 | null): number | null {
    // Ground below: last tick's clearance sample, else Cesium's own per-frame one. Never a
    // guess: unknown ground must not read as sea level (that made speed surge).
    const ground = this.tickGround ?? this.scene.globeHeight
    if (ground !== undefined && Number.isFinite(ground) && ground > -1000) this.lastAgl = carto.height - ground
    let clearance = this.lastAgl
    if (!travel) {
      this.ahead = null
    } else {
      const now = performance.now()
      if (now - this.aheadAt >= AHEAD_PROBE_MS) {
        this.aheadAt = now
        const origin = this.scene.camera.positionWC
        const hit = raycastSurface(this.scene, new Ray(Cartesian3.clone(origin), Cartesian3.clone(travel)))
        this.ahead = hit ? Cartesian3.distance(hit, origin) : null
      }
    }
    // The distance ahead only ever lowers it: alone it would be the whole valley's length.
    if (this.ahead !== null && clearance !== null) clearance = Math.min(clearance, this.ahead)
    return clearance
  }

  /**
   * Keeps the camera above the surface; in eye-level mode, follows the ground. Returns the
   * ground height below the camera, when known.
   */
  private enforceClearance(movedHorizontally: boolean): number | undefined {
    const cam = this.scene.camera
    const c = Cartographic.fromCartesian(cam.positionWC)
    const ground = surfaceHeight(this.scene, toDeg(c.longitude), toDeg(c.latitude))
    if (ground === undefined) return undefined
    const minHeight = ground + (this.eyeLevel ? EYE_HEIGHT : this.settings.minClearance)
    if (this.eyeLevel && movedHorizontally) c.height = ground + EYE_HEIGHT
    else if (c.height < minHeight) c.height = minHeight
    else return ground
    Cartographic.toCartesian(c, this.scene.ellipsoid, cam.position)
    return ground
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
    this.endFollow()
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
   * The rail button and G: stand at `spot` (a dropped pin) or under the cursor; when already
   * standing there, leave eye level again. A pin dropped somewhere else while at eye level
   * moves you to it rather than leaving.
   */
  toggleEyeLevel(spot?: Cartesian3): Promise<void> {
    if (this.eyeLevel) {
      const here = this.surfacePoint(this.scene.camera.positionWC)
      const elsewhere = spot !== undefined && Cartesian3.distance(here, this.surfacePoint(spot)) > PIN_REACHED_M
      if (!elsewhere) return this.leaveEyeLevel()
    }
    return this.goToEyeLevel(spot)
  }

  /**
   * Readouts report the height above ground: well above standing height (rising with E,
   * say), the camera is no longer at eye level even though no exit action ran.
   */
  noteHeightAboveGround(agl: number | null): void {
    if (this.eyeLevel && agl !== null && agl > EYE_LEVEL_MAX_AGL) this.setEyeLevel(false)
  }

  /**
   * Drops the camera to standing height and levels the horizon — "what would I see from
   * here". Stands at `spot` when given (a dropped pin), else at the point under the cursor
   * (or screen center). `look` (degrees) faces a given direction instead of keeping the heading.
   */
  async goToEyeLevel(spot?: Cartesian3, look?: { heading: number; pitch: number }): Promise<void> {
    this.endFollow()
    let hit = spot
    if (!hit) {
      const canvas = this.scene.canvas
      const at = this.mouse ?? { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 }
      hit = pickSurface(this.scene, at.x, at.y) ?? this.pivot()
    }
    const c = Cartographic.fromCartesian(hit)
    let ground = c.height
    try {
      const precise = await this.callbacks.sampleGround(toDeg(c.longitude), toDeg(c.latitude))
      if (precise !== undefined && Number.isFinite(precise)) ground = precise
    } catch {
      /* keep the picked height */
    }
    const cam = this.scene.camera
    if (this.eyeLevel && this.eyeLevelReturn) {
      // Moving between pins at eye level: leaving returns to the view from before the first.
      this.eyeLevelReturn.spot = Cartesian3.fromRadians(c.longitude, c.latitude, ground)
    } else {
      this.eyeLevelReturn = {
        position: Cartesian3.clone(cam.positionWC),
        heading: cam.heading,
        pitch: cam.pitch,
        roll: cam.roll,
        spot: Cartesian3.fromRadians(c.longitude, c.latitude, ground)
      }
    }
    const controller = this.scene.screenSpaceCameraController
    controller.minimumZoomDistance = EYE_HEIGHT * 0.8
    // Keep the heading so the view looks across the point, in the direction you were facing.
    const arrived = await new Promise<boolean>((resolve) => {
      cam.flyTo({
        destination: Cartesian3.fromRadians(c.longitude, c.latitude, ground + EYE_HEIGHT),
        orientation: look ? { heading: toRad(look.heading), pitch: toRad(look.pitch), roll: 0 } : { heading: cam.heading, pitch: 0, roll: 0 },
        duration: 1.6,
        complete: () => resolve(true),
        cancel: () => resolve(false)
      })
    })
    if (arrived) this.setEyeLevel(true)
    else controller.minimumZoomDistance = this.settings.minClearance
  }

  /**
   * Back up from eye level: to the view you came from if you're still near where you stood,
   * otherwise to an overview of where you are now (keeping the heading).
   */
  async leaveEyeLevel(): Promise<void> {
    this.endFollow()
    const cam = this.scene.camera
    cam.cancelFlight()
    const back = this.eyeLevelReturn
    this.eyeLevelReturn = null
    this.setEyeLevel(false)
    const here = Cartographic.fromCartesian(cam.positionWC)
    const stillThere = back && Cartesian3.distance(Cartesian3.fromRadians(here.longitude, here.latitude, 0), this.surfacePoint(back.spot)) < 200
    await new Promise<void>((resolve) => {
      if (back && stillThere) {
        cam.flyTo({
          destination: back.position,
          orientation: { heading: back.heading, pitch: back.pitch, roll: back.roll },
          duration: 1.4,
          complete: () => resolve(),
          cancel: () => resolve()
        })
      } else {
        const ground = Cartesian3.fromRadians(here.longitude, here.latitude, Math.max(0, here.height - EYE_HEIGHT))
        cam.flyToBoundingSphere(new BoundingSphere(ground, 0), {
          offset: new HeadingPitchRange(cam.heading, toRad(-35), 600),
          duration: 1.4,
          complete: () => resolve(),
          cancel: () => resolve()
        })
      }
    })
  }

  /** The point at height 0 below a position (for horizontal distances). */
  private surfacePoint(p: Cartesian3): Cartesian3 {
    const c = Cartographic.fromCartesian(p)
    return Cartesian3.fromRadians(c.longitude, c.latitude, 0)
  }

  // ───────────────────────────── flights ─────────────────────────────

  private flightDuration(destination: Cartesian3): number {
    const d = Cartesian3.distance(this.scene.camera.positionWC, destination)
    return clamp(0.8 + Math.log10(1 + d / 500) * 0.9, 0.8, 5)
  }

  flyToView(view: CameraView, duration?: number): Promise<void> {
    this.endFollow()
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
    this.endFollow()
    this.scene.camera.setView({
      destination: Cartesian3.fromDegrees(view.longitude, view.latitude, view.height),
      orientation: { heading: toRad(view.heading), pitch: toRad(view.pitch), roll: toRad(view.roll) }
    })
  }

  /** Flies to a geographic location with an eased arc (§6.4). */
  flyToLocation(latitude: number, longitude: number, opts: FlyToLocationOptions = {}): Promise<void> {
    this.endFollow()
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

  // ───────────────────────────── overview map ─────────────────────────────

  /**
   * An overview map drag begins (§5.5): stops flights and inertia, and follows the terrain at
   * the current height above ground for as long as the drag lasts.
   */
  beginGlide(): void {
    this.userInput()
    this.headingVelocity = 0
    this.startFollow()
    this.followPointer = GLIDE_POINTER
  }

  /**
   * Carries the camera over the ground to a new spot, keeping its altitude, heading, pitch
   * and roll. Nothing is sampled here: followTerrain lifts the camera where the ground rises,
   * from the height Cesium measures below the camera every frame anyway.
   */
  glideTo(longitude: number, latitude: number): void {
    if (this.flyMode) return
    const cam = this.scene.camera
    if (!Matrix4.equals(cam.transform, Matrix4.IDENTITY)) cam.lookAtTransform(Matrix4.IDENTITY)
    const c = Cartographic.fromCartesian(cam.positionWC)
    if (!c) return
    if (this.followAgl === null) this.startFollow()
    cam.setView({
      destination: Cartesian3.fromDegrees(longitude, latitude, c.height),
      orientation: { heading: cam.heading, pitch: cam.pitch, roll: cam.roll }
    })
    this.scene.requestRender()
  }

  endGlide(): void {
    if (this.followPointer === GLIDE_POINTER) this.followPointer = null
    this.endFollow()
  }

  /** Double-click: fly closer to the clicked point, keeping the heading. */
  flyToPoint(windowPosition: Cartesian2): void {
    const hit = pickSurface(this.scene, windowPosition.x, windowPosition.y)
    if (!hit) return
    this.endFollow()
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
