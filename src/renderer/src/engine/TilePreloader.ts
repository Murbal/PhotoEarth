import { Cartesian3, Cartographic, Math as CesiumMath, PerspectiveFrustum, type Scene } from 'cesium'

/** How far ahead (seconds) to load: roughly a tile's request + decode latency. */
export const LOOKAHEAD_SECONDS = 1.5
/** Below this speed (m/s) the current view's own requests are enough. */
export const MIN_SPEED = 2
/** Velocity smoothing time constant (seconds): mouse-look and key input are jittery. */
const SMOOTHING_SECONDS = 0.2
/** Turns are extrapolated for this fraction of the lookahead (they're less predictable). */
const TURN_FRACTION = 0.5
/** Screen-space error multiplier for the predicted-pose preload traversal. */
const PRELOAD_SSE_FACTOR = 2
/** Run the predicted-pose preload traversal on one frame in this many. */
const PRELOAD_EVERY_FRAMES = 6
/** Extra field of view for the preload culling volume, to cover turns (radians). */
const EXTRA_FOV = CesiumMath.toRadians(25)

export interface PredictedPose {
  position: Cartesian3
  direction: Cartesian3
  up: Cartesian3
}

/**
 * Tracks the camera's smoothed linear and angular velocity and extrapolates its pose.
 * Pure (no scene), so it's unit-tested on its own.
 */
export class MotionPredictor {
  readonly velocity = new Cartesian3()
  /** Rate of change of the view direction, per second. */
  readonly turnRate = new Cartesian3()
  private readonly lastPosition = new Cartesian3()
  private readonly lastDirection = new Cartesian3()
  private lastTime: number | null = null

  get speed(): number {
    return Cartesian3.magnitude(this.velocity)
  }

  /** Feed one camera sample; `time` in seconds. */
  sample(position: Cartesian3, direction: Cartesian3, time: number): void {
    if (this.lastTime === null) {
      this.reset(position, direction, time)
      return
    }
    const dt = time - this.lastTime
    if (dt <= 1e-4) return
    if (dt > 0.5) {
      // A long gap (tab hidden, render paused): start over rather than spike.
      this.reset(position, direction, time)
      return
    }
    const a = 1 - Math.exp(-dt / SMOOTHING_SECONDS)
    const v = Cartesian3.multiplyByScalar(Cartesian3.subtract(position, this.lastPosition, new Cartesian3()), 1 / dt, new Cartesian3())
    const w = Cartesian3.multiplyByScalar(Cartesian3.subtract(direction, this.lastDirection, new Cartesian3()), 1 / dt, new Cartesian3())
    Cartesian3.lerp(this.velocity, v, a, this.velocity)
    Cartesian3.lerp(this.turnRate, w, a, this.turnRate)
    Cartesian3.clone(position, this.lastPosition)
    Cartesian3.clone(direction, this.lastDirection)
    this.lastTime = time
  }

  reset(position: Cartesian3, direction: Cartesian3, time: number): void {
    Cartesian3.clone(position, this.lastPosition)
    Cartesian3.clone(direction, this.lastDirection)
    Cartesian3.clone(Cartesian3.ZERO, this.velocity)
    Cartesian3.clone(Cartesian3.ZERO, this.turnRate)
    this.lastTime = time
  }

  /**
   * Pose `seconds` ahead. The height is kept from dropping below `minHeight` (ellipsoidal),
   * so a steep dive doesn't preload from under the ground.
   */
  predict(position: Cartesian3, direction: Cartesian3, up: Cartesian3, seconds: number, minHeight?: number): PredictedPose {
    const ahead = Cartesian3.add(position, Cartesian3.multiplyByScalar(this.velocity, seconds, new Cartesian3()), new Cartesian3())
    if (minHeight !== undefined) {
      const c = Cartographic.fromCartesian(ahead)
      if (c && c.height < minHeight) Cartesian3.fromRadians(c.longitude, c.latitude, minHeight, undefined, ahead)
    }
    const turned = Cartesian3.add(direction, Cartesian3.multiplyByScalar(this.turnRate, seconds * TURN_FRACTION, new Cartesian3()), new Cartesian3())
    Cartesian3.normalize(turned, turned)
    // Keep up orthogonal to the new direction.
    const right = Cartesian3.normalize(Cartesian3.cross(turned, up, new Cartesian3()), new Cartesian3())
    const newUp = Cartesian3.normalize(Cartesian3.cross(right, turned, new Cartesian3()), new Cartesian3())
    return { position: ahead, direction: turned, up: newUp }
  }
}

/**
 * Loads 3D tiles for where the camera will be, not just where it is. Cesium already runs a
 * "preload flight" tileset pass for its own flyTo animations, with a separate camera at the
 * flight's destination. This drives that pass with a predicted pose whenever the camera
 * moves quickly (fly mode, fast pans, inertia glides). That camera isn't marked as moving,
 * so Cesium's cull-requests-while-moving optimization (which skips nearly every tile in
 * view at speed) doesn't apply to it, and tiles arrive before the view gets there.
 */
export class TilePreloader {
  private readonly predictor = new MotionPredictor()
  private active = false
  private readonly removeListener: () => void
  private readonly originalCanPreload: () => boolean
  private readonly frustum = new PerspectiveFrustum()
  private readonly wideFrustum = new PerspectiveFrustum()

  constructor(
    private readonly scene: Scene,
    /** Ground height (ellipsoidal) below the camera, if known. */
    private readonly groundHeight: () => number | null
  ) {
    const camera = scene.camera
    this.originalCanPreload = camera.canPreloadFlight.bind(camera)
    // The predicted-pose pass is a full extra tileset traversal: run it every few frames only
    // (it just issues requests; vite/cesium.ts keeps those alive between runs).
    camera.canPreloadFlight = () =>
      this.originalCanPreload() || (this.active && scene.frameState.frameNumber % PRELOAD_EVERY_FRAMES === 0)
    this.removeListener = scene.preUpdate.addEventListener(() => this.update())
  }

  /** Whether the predicted-pose preload is running (exposed for tests). */
  get preloading(): boolean {
    return this.active
  }

  destroy(): void {
    this.removeListener()
    this.scene.camera.canPreloadFlight = this.originalCanPreload
  }

  private update(): void {
    const camera = this.scene.camera
    this.predictor.sample(camera.positionWC, camera.directionWC, performance.now() / 1000)
    // A Cesium flight is preloading its destination already (at full detail).
    const sceneWithFactor = this.scene as Scene & { preloadFlightScreenSpaceErrorFactor?: number }
    if (this.originalCanPreload()) {
      this.active = false
      sceneWithFactor.preloadFlightScreenSpaceErrorFactor = 1
      return
    }
    this.active = this.predictor.speed > MIN_SPEED && camera.frustum instanceof PerspectiveFrustum
    // Coarser than the view: far fewer tiles to traverse, and a moving view shows coarser
    // tiles anyway (see vite/cesium.ts).
    sceneWithFactor.preloadFlightScreenSpaceErrorFactor = PRELOAD_SSE_FACTOR
    if (!this.active) return

    const c = Cartographic.fromCartesian(camera.positionWC)
    const ground = this.groundHeight()
    // Allow descending at most most of the way to the ground within the lookahead.
    const minHeight = c && ground !== null ? Math.min(c.height, ground + Math.max(2, (c.height - ground) * 0.2)) : undefined
    const pose = this.predictor.predict(camera.positionWC, camera.directionWC, camera.upWC, LOOKAHEAD_SECONDS, minHeight)

    const preload = this.scene.preloadFlightCamera
    const current = camera.frustum as PerspectiveFrustum
    // Same frustum for level-of-detail selection, so preloaded tiles are the ones the view
    // will want; a wider one only for culling, to cover turns.
    current.clone(this.frustum)
    preload.frustum = this.frustum
    preload.setView({ destination: pose.position, orientation: { direction: pose.direction, up: pose.up } })
    current.clone(this.wideFrustum)
    this.wideFrustum.fov = Math.min((current.fov ?? CesiumMath.PI_OVER_THREE) + EXTRA_FOV, CesiumMath.toRadians(150))
    this.scene.preloadFlightCullingVolume = this.wideFrustum.computeCullingVolume(
      preload.positionWC,
      preload.directionWC,
      preload.upWC
    )
  }
}
