import {
  BoundingRectangle,
  Cartesian2,
  Cartesian3,
  Cartesian4,
  DrawCommand,
  Framebuffer,
  Matrix4,
  Pass,
  PixelDatatype,
  PixelFormat,
  PrimitiveType,
  RenderState,
  Sampler,
  ShaderProgram,
  ShaderSource,
  Texture,
  TextureMagnificationFilter,
  TextureMinificationFilter,
  type CesiumContext,
  type CesiumFrameState
} from 'cesium'
import {
  CARE_BELOW,
  LEVEL_COUNT,
  levelCell,
  levelMinX,
  levelMinY,
  MAX_RESOLUTION,
  type ShadowLevel,
  type SunVector
} from '../../lib/terrainShadow'
import { COMPUTE_FS, COMPUTE_VS } from './shaders'

/** Live values read by the receiver shaders every frame (see RECEIVER_GLSL). */
export interface ShadowBinding {
  masks: Array<Texture | undefined>
  /** Per level: (minX, minY, cell, n); n = 0 while the level has no current mask. */
  rects: Cartesian4[]
  /** (encoding base height, enabled, sun up, 1 / radius) */
  params: Cartesian4
  /** Eye coordinates → local frame, refreshed every frame from the camera. */
  eyeToLocal: Matrix4
  /** (vertical exaggeration, relative height), to recover true heights. */
  exaggeration: Cartesian2
}

interface LevelState {
  level: ShadowLevel | null
  heights: Texture | undefined
  /** Data changed since the heights were uploaded. */
  uploadPending: boolean
  /** Sun the mask was last computed for; null when it must be recomputed regardless. */
  maskSun: SunVector | null
  /** The mask reflects this level's current data (otherwise the rect stays inactive). */
  maskForData: boolean
  framebuffer: Framebuffer | undefined
  command: DrawCommand | undefined
}

const INACTIVE = (): Cartesian4 => new Cartesian4(0, 0, 1, 0)

/**
 * While the sun animates (playback, slider drags), a level is recomputed only once its mask
 * is this far behind the sun (radians), and sun-driven recomputes are spaced at least this
 * far apart. Once the sun stops, every level converges to the exact sun.
 */
const MOVING_MIN_ANGLE = (0.02 * Math.PI) / 180
const MOVING_MIN_INTERVAL_MS = 30
/** Staleness weight per level: the fine level carries the closest, sharpest edges. */
const LEVEL_PRIORITY = [2, 1, 1]

/** Angle between two unit vectors (accurate for tiny angles). */
function sunAngle(a: SunVector, b: SunVector): number {
  const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
  return 2 * Math.asin(Math.min(1, d / 2))
}

/**
 * Runs the terrain shadow pass inside Cesium's compute pass, so the masks are computed on the
 * GPU right before the frame that uses them and never round-trip through the CPU. Added to
 * scene.primitives; `update()` is Cesium's per-frame hook.
 *
 * At most one level is recomputed per frame. A level whose data just changed goes first and is
 * computed in the same frame its rect switches over, so a mask and its placement are always
 * consistent. Otherwise the level whose mask lags the sun the most goes next (so no level
 * starves during playback), throttled while the sun is moving (see MOVING_MIN_ANGLE).
 */
export class ShadowCompute {
  readonly binding: ShadowBinding = {
    masks: [undefined, undefined, undefined],
    rects: [INACTIVE(), INACTIVE(), INACTIVE()],
    params: new Cartesian4(0, 0, 0, 1 / 6371000),
    eyeToLocal: new Matrix4(),
    exaggeration: new Cartesian2(1, 0)
  }
  show = true
  private context: CesiumContext | undefined
  private program: ShaderProgram | undefined
  private readonly levels: LevelState[] = Array.from({ length: LEVEL_COUNT }, () => ({
    level: null,
    heights: undefined,
    uploadPending: false,
    maskSun: null,
    maskForData: false,
    framebuffer: undefined,
    command: undefined
  }))
  private sun: SunVector = { x: 0, y: 0, z: 1 }
  private sunUp = false
  private enabled = false
  /** Frame number of the last update() and of the last sun change. */
  private frameNumber = 0
  private sunChangedFrame = Number.NEGATIVE_INFINITY
  private lastComputeAt = Number.NEGATIVE_INFINITY
  private radius = 6371000
  private base = 0
  private farHeight = 0
  private maxHeight = 0
  private destroyed = false
  private readonly lv = [new Cartesian4(), new Cartesian4(), new Cartesian4()]
  private readonly target = new Cartesian4()
  private readonly computeParams = new Cartesian4()
  private readonly sunUniform = new Cartesian3()
  private readonly computeCommands: Array<{ pass: number; execute: () => void }> = []

  constructor(private readonly requestRender: () => void) {}

  get hasMasks(): boolean {
    return this.binding.rects.some((r) => r.w > 0)
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    this.binding.params.y = enabled ? 1 : 0
    this.requestRender()
  }

  setRadius(radius: number): void {
    this.radius = radius
    this.binding.params.w = 1 / radius
    this.invalidate()
  }

  /** Sun direction in the local frame; `up` false once it's far enough below the horizon. */
  setSun(sun: SunVector, up: boolean): void {
    const s = this.sun
    const changed = sun.x !== s.x || sun.y !== s.y || sun.z !== s.z || up !== this.sunUp
    this.sun = { x: sun.x, y: sun.y, z: sun.z }
    this.sunUp = up
    this.binding.params.z = up ? 1 : 0
    if (!changed) return
    this.sunChangedFrame = this.frameNumber
    this.requestRender()
  }

  /**
   * Replaces one level's heights (null clears it). With `deactivate`, its mask stops being
   * used immediately (the frame moved); otherwise the old mask stays until the new one is
   * computed.
   */
  setLevel(index: number, level: ShadowLevel | null, deactivate = false): void {
    const s = this.levels[index]
    s.level = level
    s.uploadPending = true
    s.maskForData = false
    if (deactivate || !level) this.binding.rects[index] = INACTIVE()
    this.updateRanges()
    this.invalidate()
  }

  /** Clears every level (frame change). */
  clear(): void {
    for (let i = 0; i < LEVEL_COUNT; i++) this.setLevel(i, null, true)
  }

  private updateRanges(): void {
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (const s of this.levels) {
      if (!s.level) continue
      min = Math.min(min, s.level.minHeight)
      max = Math.max(max, s.level.maxHeight)
    }
    if (!Number.isFinite(min)) return
    const coarsest = [...this.levels].reverse().find((s) => s.level)?.level
    this.farHeight = (coarsest?.minHeight ?? min) - 100
    this.maxHeight = max
    const base = Math.floor((min - CARE_BELOW - 200) / 100) * 100
    if (base !== this.base) {
      // Every mask is encoded relative to the base; all of them must be recomputed.
      this.base = base
      for (const s of this.levels) s.maskForData = false
      for (let i = 0; i < LEVEL_COUNT; i++) this.binding.rects[i] = INACTIVE()
    }
  }

  /** Every mask must be recomputed: each level's march reads all levels' heights. */
  private invalidate(): void {
    for (const s of this.levels) s.maskSun = null
    this.requestRender()
  }

  // ───────────────────────────── Cesium primitive interface ─────────────────────────────

  update(frameState: CesiumFrameState): void {
    if (this.destroyed || !this.show || !frameState.passes.render) return
    const context = frameState.context
    this.frameNumber = frameState.frameNumber
    if (!this.context) this.initialize(context)
    for (let i = 0; i < LEVEL_COUNT; i++) this.upload(i)
    this.binding.params.x = this.base
    if (!this.enabled || !this.sunUp) return

    const pick = this.pickLevel()
    if (pick >= 0) {
      this.schedule(pick, frameState)
      this.lastComputeAt = performance.now()
    }
    // Keep frames coming until every mask matches the sun.
    if (this.levels.some((s) => s.level && s.heights && this.staleness(s) > 0)) this.requestRender()
  }

  /** How far a level's mask lags the current sun (radians; Infinity: must recompute). */
  private staleness(s: LevelState): number {
    return s.maskSun ? sunAngle(s.maskSun, this.sun) : Number.POSITIVE_INFINITY
  }

  private pickLevel(): number {
    // A level whose data changed isn't visible until computed: always first, never throttled.
    for (let i = 0; i < LEVEL_COUNT; i++) {
      const s = this.levels[i]
      if (s.level && s.heights && !s.maskForData) return i
    }
    // The sun changed this frame or the last one: it's animating.
    const moving = this.frameNumber - this.sunChangedFrame <= 1
    if (moving && performance.now() - this.lastComputeAt < MOVING_MIN_INTERVAL_MS) return -1
    let pick = -1
    let best = 0
    for (let i = 0; i < LEVEL_COUNT; i++) {
      const s = this.levels[i]
      if (!s.level || !s.heights) continue
      const lag = this.staleness(s)
      if (lag === 0 || (moving && lag < MOVING_MIN_ANGLE)) continue
      const priority = lag * LEVEL_PRIORITY[i]
      if (priority > best) {
        best = priority
        pick = i
      }
    }
    return pick
  }

  private initialize(context: CesiumContext): void {
    this.context = context
    const nearest = new Sampler({
      minificationFilter: TextureMinificationFilter.NEAREST,
      magnificationFilter: TextureMagnificationFilter.NEAREST
    })
    for (let i = 0; i < LEVEL_COUNT; i++) {
      // Allocated once at full size and never replaced: the globe material holds a reference.
      const mask = new Texture({
        context,
        width: MAX_RESOLUTION,
        height: MAX_RESOLUTION,
        pixelFormat: PixelFormat.RGBA,
        pixelDatatype: PixelDatatype.UNSIGNED_BYTE,
        sampler: nearest
      })
      this.binding.masks[i] = mask
      this.levels[i].framebuffer = new Framebuffer({ context, colorTextures: [mask], destroyAttachments: false })
    }
    this.program = ShaderProgram.fromCache({
      context,
      vertexShaderSource: COMPUTE_VS,
      fragmentShaderSource: new ShaderSource({
        sources: [COMPUTE_FS],
        defines: context.textureFloatLinear ? ['PE_FLOAT_LINEAR'] : []
      }),
      attributeLocations: { position: 0, textureCoordinates: 1 }
    })
  }

  private upload(index: number): void {
    const s = this.levels[index]
    if (!s.uploadPending || !this.context) return
    s.uploadPending = false
    s.heights?.destroy()
    s.heights = undefined
    const l = s.level
    if (!l) return
    s.heights = new Texture({
      context: this.context,
      width: l.n,
      height: l.n,
      pixelFormat: PixelFormat.RED,
      pixelDatatype: PixelDatatype.FLOAT,
      source: { arrayBufferView: l.heights, width: l.n, height: l.n },
      flipY: false,
      sampler: this.context.textureFloatLinear
        ? new Sampler()
        : new Sampler({ minificationFilter: TextureMinificationFilter.NEAREST, magnificationFilter: TextureMagnificationFilter.NEAREST })
    })
  }

  private heightsRect(index: number, out: Cartesian4): Cartesian4 {
    const s = this.levels[index]
    const l = s.level
    if (!l || !s.heights) return Cartesian4.fromElements(0, 0, 1, 0, out)
    return Cartesian4.fromElements(levelMinX(l), levelMinY(l), levelCell(l), l.n, out)
  }

  private schedule(index: number, frameState: CesiumFrameState): void {
    const s = this.levels[index]
    const l = s.level!
    const context = frameState.context
    if (!s.command) {
      const fallback = context.defaultTexture
      s.command = new DrawCommand({
        vertexArray: context.getViewportQuadVertexArray(),
        primitiveType: PrimitiveType.TRIANGLES,
        shaderProgram: this.program,
        framebuffer: s.framebuffer,
        owner: this,
        uniformMap: {
          u_h0: () => this.levels[0].heights ?? fallback,
          u_h1: () => this.levels[1].heights ?? fallback,
          u_h2: () => this.levels[2].heights ?? fallback,
          u_lv0: () => this.lv[0],
          u_lv1: () => this.lv[1],
          u_lv2: () => this.lv[2],
          u_target: () => this.target,
          u_sun: () => this.sunUniform,
          u_params: () => this.computeParams
        }
      })
    }
    s.command.renderState = RenderState.fromCache({ viewport: new BoundingRectangle(0, 0, l.n, l.n) })
    const command = s.command
    const cell = levelCell(l)
    const minX = levelMinX(l)
    const minY = levelMinY(l)
    const sun = this.sun
    const params = [1 / this.radius, this.farHeight, this.maxHeight, this.base] as const
    // Uniform values are captured now and applied when Cesium executes the compute pass.
    this.computeCommands[index] = {
      pass: Pass.COMPUTE,
      execute: () => {
        for (let i = 0; i < LEVEL_COUNT; i++) this.heightsRect(i, this.lv[i])
        Cartesian4.fromElements(minX, minY, cell, index, this.target)
        Cartesian3.fromElements(sun.x, sun.y, sun.z, this.sunUniform)
        Cartesian4.fromElements(params[0], params[1], params[2], params[3], this.computeParams)
        command.execute(context)
      }
    }
    frameState.commandList.push(this.computeCommands[index])
    s.maskSun = { x: sun.x, y: sun.y, z: sun.z }
    s.maskForData = true
    Cartesian4.fromElements(minX, minY, cell, l.n, this.binding.rects[index])
  }

  /** Test support: the raw RGBA8 mask of a level (call after a frame has rendered). */
  readMask(index: number): Uint8Array | null {
    const s = this.levels[index]
    if (!this.context || !s.framebuffer || !s.level) return null
    return this.context.readPixels({ x: 0, y: 0, width: s.level.n, height: s.level.n, framebuffer: s.framebuffer })
  }

  get encodingBase(): number {
    return this.base
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  destroy(): void {
    this.destroyed = true
    for (const s of this.levels) {
      s.heights?.destroy()
      if (s.framebuffer && !s.framebuffer.isDestroyed()) s.framebuffer.destroy()
    }
    for (const m of this.binding.masks) if (m && !m.isDestroyed()) m.destroy()
    if (this.program && !this.program.isDestroyed()) this.program.destroy()
  }
}
