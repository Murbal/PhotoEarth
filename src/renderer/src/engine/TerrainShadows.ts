import { Cartesian3, Cartographic, Matrix4, Transforms, type Material, type Scene, type TerrainProvider } from 'cesium'
import { sunDirectionENU } from '../lib/sun'
import {
  LEVEL_COUNT,
  LEVEL_HALF,
  levelResolutions,
  needsRecenter,
  snap,
  SUN_CUTOFF_ALTITUDE,
  type ShadowLevel
} from '../lib/terrainShadow'
import { HeightField, LocalFrame } from './shadows/HeightField'
import { ShadowCompute, type ShadowBinding } from './shadows/ShadowCompute'

export type TerrainShadowStatus = 'off' | 'loading' | 'ready' | 'unavailable'

/** Names of the receiver uniforms, as declared by RECEIVER_GLSL's hosts. */
export const RECEIVER_UNIFORMS = {
  masks: ['u_peMask0', 'u_peMask1', 'u_peMask2'],
  rects: ['u_peRect0', 'u_peRect1', 'u_peRect2'],
  params: 'u_peParams',
  eyeToLocal: 'u_peEyeToLocal',
  exaggeration: 'u_peExaggeration'
} as const

interface Placement {
  cx: number
  cy: number
  n: number
}

const RETRY_MS = 10000

/**
 * Heightmap terrain shadows (§8.1.1). Three nested grids of Cesium World Terrain heights
 * (±5 km at ~20 m, ±20 km at ~80 m, ±80 km at ~400 m with the High preset) follow the view;
 * a GPU pass ray-marches them toward the sun into per-cell shadow tops, and the 3D Tiles and
 * globe shaders shade against those. Unlike shadow maps this is independent of what the
 * camera has loaded, so off-screen and distant ridges cast, and it costs nothing per frame
 * while the sun stands still.
 */
export class TerrainShadows {
  readonly compute: ShadowCompute
  private field: HeightField | null = null
  private frame: LocalFrame | null = null
  private readonly levels: Array<ShadowLevel | null> = [null, null, null]
  private desiredFrame: { longitude: number; latitude: number } | null = null
  private desired: Placement[] = []
  private enabled = false
  private resolution = 512
  private sun: { azimuth: number; altitude: number; longitude: number; latitude: number } | null = null
  private status: TerrainShadowStatus = 'off'
  private pumping = false
  /** The camera is moving: hold off re-centering (loading and rasterizing on this thread). */
  private moving = false
  private failedAt = 0
  private generation = 0
  private readonly materials = new Set<Material>()
  private readonly removePreRender: () => void

  constructor(
    private readonly scene: Scene,
    private getProvider: () => TerrainProvider | null,
    private readonly onStatus: (status: TerrainShadowStatus) => void
  ) {
    this.compute = new ShadowCompute(() => scene.requestRender())
    scene.primitives.add(this.compute)
    this.removePreRender = scene.preRender.addEventListener(() => this.onPreRender())
  }

  get binding(): ShadowBinding {
    return this.compute.binding
  }

  /** True once at least one level shades the view. */
  get ready(): boolean {
    return this.status === 'ready'
  }

  destroy(): void {
    this.generation++
    this.removePreRender()
    this.materials.clear()
    if (!this.scene.isDestroyed()) this.scene.primitives.remove(this.compute)
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return
    this.enabled = enabled
    this.compute.setEnabled(enabled)
    if (!enabled) {
      this.setStatus('off')
      return
    }
    this.setStatus(this.compute.hasMasks ? 'ready' : 'loading')
    void this.pump()
  }

  setResolution(resolution: number): void {
    const n = levelResolutions(resolution)[0]
    if (n === this.resolution) return
    this.resolution = n
    this.updateDesired()
    void this.pump()
  }

  /** Sun position at the camera target (degrees). */
  setSun(azimuth: number, altitude: number, longitude: number, latitude: number): void {
    this.sun = { azimuth, altitude, longitude, latitude }
    this.applySun()
  }

  /**
   * Where the grids should sit. Normally the camera target; for a camera close to the ground
   * looking out at the horizon, the fine grid stays near the camera, biased toward the view.
   */
  setView(camera: Cartesian3, target: Cartesian3 | null, heightAboveGround: number | null): void {
    const camC = Cartographic.fromCartesian(camera)
    if (!camC) return
    let focus = target ? Cartographic.fromCartesian(target) : camC
    if (target && heightAboveGround !== null && heightAboveGround < LEVEL_HALF[0] * 0.3 && focus) {
      const nadir = Cartesian3.fromRadians(camC.longitude, camC.latitude, 0)
      const ground = Cartesian3.fromRadians(focus.longitude, focus.latitude, 0)
      const d = Cartesian3.distance(nadir, ground)
      const reach = LEVEL_HALF[0] * 0.5
      if (d > reach) focus = Cartographic.fromCartesian(Cartesian3.lerp(nadir, ground, reach / d, new Cartesian3())) ?? focus
    }
    if (!focus) return
    if (!this.desiredFrame) {
      this.desiredFrame = { longitude: focus.longitude, latitude: focus.latitude }
    } else {
      const origin = Cartesian3.fromRadians(this.desiredFrame.longitude, this.desiredFrame.latitude, 0)
      const f = Cartesian3.fromRadians(focus.longitude, focus.latitude, 0)
      if (Cartesian3.distance(origin, f) > LEVEL_HALF[2] * 0.25) {
        this.desiredFrame = { longitude: focus.longitude, latitude: focus.latitude }
        this.desired = []
      }
    }
    this.focus = focus
    this.updateDesired()
    void this.pump()
  }

  private focus: Cartographic | null = null

  /** Registers a material that declares the receiver uniforms (the globe's). */
  bindMaterial(material: Material): void {
    this.materials.add(material)
    this.syncMaterial(material)
  }

  // ───────────────────────────── placement ─────────────────────────────

  private updateDesired(): void {
    const df = this.desiredFrame
    if (!df || !this.focus) return
    const frame = this.frame && this.frame.longitude === df.longitude && this.frame.latitude === df.latitude ? this.frame : new LocalFrame(df.longitude, df.latitude)
    const local = frame.toLocal(this.focus.longitude, this.focus.latitude)
    const ns = levelResolutions(this.resolution)
    const next: Placement[] = []
    for (let k = 0; k < LEVEL_COUNT; k++) {
      const half = LEVEL_HALF[k]
      const cell = (2 * half) / ns[k]
      const prev = this.desired[k]
      if (k === LEVEL_COUNT - 1) {
        next.push({ cx: 0, cy: 0, n: ns[k] })
      } else if (prev && prev.n === ns[k] && !needsRecenter(prev.cx, prev.cy, half, local.x, local.y)) {
        next.push(prev)
      } else {
        next.push({ cx: snap(local.x, cell * 8), cy: snap(local.y, cell * 8), n: ns[k] })
      }
    }
    this.desired = next
  }

  private matches(k: number): boolean {
    const l = this.levels[k]
    const d = this.desired[k]
    return !!l && !!d && l.cx === d.cx && l.cy === d.cy && l.n === d.n
  }

  private frameIsDesired(): boolean {
    const df = this.desiredFrame
    return !!this.frame && !!df && this.frame.longitude === df.longitude && this.frame.latitude === df.latitude
  }

  /**
   * While the camera moves, grids aren't re-centered (each level is loaded and rasterized on
   * the main thread, which costs frames). They catch up once it stops. Nothing shaded yet
   * still loads right away.
   */
  setMoving(moving: boolean): void {
    if (moving === this.moving) return
    this.moving = moving
    if (!moving) void this.pump()
  }

  /** Loads whatever differs from the desired placement, coarse first, one level at a time. */
  private async pump(): Promise<void> {
    if (this.pumping || !this.enabled || !this.desiredFrame) return
    if (this.failedAt && performance.now() - this.failedAt < RETRY_MS) return
    const provider = this.getProvider()
    if (!provider) return
    if (!this.field || this.field.provider !== provider) {
      this.field = HeightField.for(provider)
      this.resetLevels()
    }
    const field = this.field
    this.pumping = true
    const generation = this.generation
    try {
      while (this.enabled && generation === this.generation && field === this.field) {
        if (this.moving && this.compute.hasMasks) break
        const switchFrame = !this.frameIsDesired()
        const df = this.desiredFrame!
        const frame = switchFrame ? new LocalFrame(df.longitude, df.latitude) : this.frame!
        let k = -1
        for (let i = LEVEL_COUNT - 1; i >= 0; i--) {
          if (switchFrame ? i === LEVEL_COUNT - 1 : !this.matches(i)) {
            k = i
            break
          }
        }
        if (k < 0) break
        const want = this.desired[k]
        const coarser = !switchFrame && k < LEVEL_COUNT - 1 ? this.levels[k + 1] : null
        const stale = () =>
          !this.enabled ||
          generation !== this.generation ||
          this.desiredFrame !== df ||
          this.desired[k]?.cx !== want.cx ||
          this.desired[k]?.cy !== want.cy ||
          this.desired[k]?.n !== want.n
        const level = await field.loadLevel(frame, want.cx, want.cy, LEVEL_HALF[k], want.n, coarser, stale)
        if (stale()) continue
        if (!level) {
          this.failedAt = performance.now()
          if (!this.compute.hasMasks) this.setStatus('unavailable')
          break
        }
        this.failedAt = 0
        if (switchFrame) {
          this.frame = frame
          this.compute.setRadius(frame.radius)
          for (let i = 0; i < LEVEL_COUNT; i++) this.levels[i] = null
          this.compute.clear()
          this.applySun()
        }
        this.levels[k] = level
        this.compute.setLevel(k, level)
        this.setStatus('ready')
      }
    } finally {
      this.pumping = false
    }
    // Retry after a failure once the back-off has passed.
    if (this.failedAt && this.enabled) {
      window.setTimeout(() => void this.pump(), RETRY_MS + 50)
    }
  }

  private resetLevels(): void {
    this.generation++
    this.frame = null
    for (let i = 0; i < LEVEL_COUNT; i++) this.levels[i] = null
    this.compute.clear()
    if (this.enabled) this.setStatus('loading')
  }

  // ───────────────────────────── sun & per-frame state ─────────────────────────────

  private applySun(): void {
    const s = this.sun
    if (!s || !this.frame) return
    const [e, n, u] = sunDirectionENU({ azimuth: s.azimuth, altitude: s.altitude })
    const enu = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(s.longitude, s.latitude, 0))
    const fixed = Matrix4.multiplyByPointAsVector(enu, new Cartesian3(e, n, u), new Cartesian3())
    const local = this.frame.directionToLocal(fixed)
    Cartesian3.normalize(local, local)
    this.compute.setSun({ x: local.x, y: local.y, z: local.z }, s.altitude > SUN_CUTOFF_ALTITUDE)
  }

  private onPreRender(): void {
    const b = this.compute.binding
    if (this.frame) Matrix4.multiply(this.frame.fixedToEnu, this.scene.camera.inverseViewMatrix, b.eyeToLocal)
    b.exaggeration.x = this.scene.verticalExaggeration
    b.exaggeration.y = this.scene.verticalExaggerationRelativeHeight
    for (const m of this.materials) this.syncMaterial(m)
  }

  private syncMaterial(m: Material): void {
    const b = this.compute.binding
    const u = m.uniforms as Record<string, unknown>
    for (let k = 0; k < LEVEL_COUNT; k++) {
      const mask = b.masks[k]
      if (mask && u[RECEIVER_UNIFORMS.masks[k]] !== mask) u[RECEIVER_UNIFORMS.masks[k]] = mask
      u[RECEIVER_UNIFORMS.rects[k]] = b.rects[k]
    }
    u[RECEIVER_UNIFORMS.params] = b.params
    u[RECEIVER_UNIFORMS.eyeToLocal] = b.eyeToLocal
    u[RECEIVER_UNIFORMS.exaggeration] = b.exaggeration
  }

  private setStatus(status: TerrainShadowStatus): void {
    if (!this.enabled) status = 'off'
    if (status === this.status) return
    this.status = status
    this.onStatus(status)
  }

  // ───────────────────────────── test support ─────────────────────────────
}
