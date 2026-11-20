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
  /** Sun/data revision the mask was last computed for. */
  maskRevision: number
  /** The mask reflects this level's current data (otherwise the rect stays inactive). */
  maskForData: boolean
  framebuffer: Framebuffer | undefined
  command: DrawCommand | undefined
}

const INACTIVE = (): Cartesian4 => new Cartesian4(0, 0, 1, 0)

/**
 * Runs the terrain shadow pass inside Cesium's compute pass, so the masks are computed on the
 * GPU right before the frame that uses them and never round-trip through the CPU. Added to
 * scene.primitives; `update()` is Cesium's per-frame hook.
 *
 * One level is recomputed per frame (finest first), which spreads the cost of sun playback;
 * a level whose data just changed is computed in the same frame its rect switches over, so a
 * mask and its placement are always consistent.
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
    maskRevision: -1,
    maskForData: false,
    framebuffer: undefined,
    command: undefined
  }))
  private sun: SunVector = { x: 0, y: 0, z: 1 }
  private sunUp = false
  private enabled = false
  private revision = 0
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
    this.sun = sun
    this.sunUp = up
    this.binding.params.z = up ? 1 : 0
    this.invalidate()
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

  private invalidate(): void {
    this.revision++
    this.requestRender()
  }

  // ───────────────────────────── Cesium primitive interface ─────────────────────────────

  update(frameState: CesiumFrameState): void {
    if (this.destroyed || !this.show || !frameState.passes.render) return
    const context = frameState.context
    if (!this.context) this.initialize(context)
    for (let i = 0; i < LEVEL_COUNT; i++) this.upload(i)
    this.binding.params.x = this.base
    if (!this.enabled || !this.sunUp) return

    // Pick one level: one whose data changed first (it isn't visible until computed), then
    // the finest stale one.
    let pick = -1
    for (let i = 0; i < LEVEL_COUNT && pick < 0; i++) {
      const s = this.levels[i]
      if (s.level && s.heights && !s.maskForData) pick = i
    }
    for (let i = 0; i < LEVEL_COUNT && pick < 0; i++) {
      const s = this.levels[i]
      if (s.level && s.heights && s.maskRevision !== this.revision) pick = i
    }
    if (pick < 0) return
    this.schedule(pick, frameState)
    if (this.levels.some((s) => s.level && s.heights && s.maskRevision !== this.revision)) this.requestRender()
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
    s.maskRevision = this.revision
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
