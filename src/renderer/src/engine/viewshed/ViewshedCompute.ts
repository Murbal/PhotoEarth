import {
  BoundingRectangle,
  Cartesian2,
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
  levelCell,
  levelMinX,
  levelMinY,
  MAX_RESOLUTION,
  type ShadowLevel
} from '../../lib/terrainShadow'
import { VIEWSHED_LEVEL_COUNT, viewshedNearLimit } from '../../lib/viewshed'
import { COMPUTE_VS } from '../shadows/shaders'
import { VIEWSHED_COMPUTE_FS } from './shaders'

/** Live values read by the 3D Tiles and globe receiver shaders every frame (VIEWSHED_RECEIVER_GLSL). */
export interface ViewshedBinding {
  masks: Array<Texture | undefined>
  /** Per level: (minX, minY, cell, n); n = 0 while the level has no current mask. */
  rects: Cartesian4[]
  /** (encoding base height, enabled, viewerOffset, 1 / earthRadius) */
  params: Cartesian4
  /** (analysis radius, opacity, ringStep (0 = off), colorMode (0 = solid, 1 = distance)) */
  style: Cartesian4
  /** Eye coordinates -> viewshed local frame, refreshed every frame from the camera. */
  eyeToLocal: Matrix4
  /** (vertical exaggeration, relative height), to recover true heights. */
  exaggeration: Cartesian2
}

interface LevelState {
  level: ShadowLevel | null
  heights: Texture | undefined
  uploadPending: boolean
  /** True when the computed mask matches the current heights, targetHeight, and maxRadius. */
  maskCurrent: boolean
  /** True when the mask reflects this level's current data (otherwise rect stays inactive). */
  maskForData: boolean
  framebuffer: Framebuffer | undefined
  command: DrawCommand | undefined
}

const INACTIVE = (): Cartesian4 => new Cartesian4(0, 0, 1, 0)

/**
 * Runs the viewshed ray-march inside Cesium's compute pass, computing per-cell minimum visible
 * height (`zMin`) directly on the GPU with zero CPU readbacks. Only runs when heights, target
 * height, or analysis radius change — completely idle in `requestRenderMode` otherwise.
 */
export class ViewshedCompute {
  readonly binding: ViewshedBinding = {
    masks: [undefined, undefined, undefined],
    rects: [INACTIVE(), INACTIVE(), INACTIVE()],
    params: new Cartesian4(0, 0, 1.7, 1 / 6371000),
    style: new Cartesian4(15000, 0.45, 5000, 1),
    eyeToLocal: new Matrix4(),
    exaggeration: new Cartesian2(1, 0)
  }
  show = true
  private context: CesiumContext | undefined
  private program: ShaderProgram | undefined
  private readonly levels: LevelState[] = Array.from({ length: VIEWSHED_LEVEL_COUNT }, () => ({
    level: null,
    heights: undefined,
    uploadPending: false,
    maskCurrent: false,
    maskForData: false,
    framebuffer: undefined,
    command: undefined
  }))
  private enabled = false
  private earthRadius = 6371000
  private targetHeight = 0
  private maxRadius = 15000
  private base = 0
  private maxHeight = 0
  private destroyed = false
  private readonly lv = [new Cartesian4(), new Cartesian4(), new Cartesian4()]
  private readonly target = new Cartesian4()
  private readonly observer = new Cartesian4()
  private readonly computeParams = new Cartesian4()
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

  setEarthRadius(radius: number): void {
    if (radius === this.earthRadius) return
    this.earthRadius = radius
    this.binding.params.w = 1 / radius
    this.invalidate()
  }

  setTarget(targetHeight: number, maxRadius: number): void {
    const changed = targetHeight !== this.targetHeight || maxRadius !== this.maxRadius
    this.targetHeight = targetHeight
    this.maxRadius = maxRadius
    this.binding.style.x = maxRadius
    if (changed) this.invalidate()
  }

  setStyle(viewerOffset: number, opacity: number, ringStep: number, distanceTint: boolean): void {
    this.binding.params.z = viewerOffset
    this.binding.style.y = opacity
    this.binding.style.z = ringStep
    this.binding.style.w = distanceTint ? 1 : 0
    this.requestRender()
  }

  setLevel(index: number, level: ShadowLevel | null, deactivate = false): void {
    const s = this.levels[index]
    s.level = level
    s.uploadPending = true
    s.maskForData = false
    if (deactivate || !level) this.binding.rects[index] = INACTIVE()
    this.updateRanges()
    this.invalidate()
  }

  clear(): void {
    for (let i = 0; i < VIEWSHED_LEVEL_COUNT; i++) this.setLevel(i, null, true)
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
    this.maxHeight = max
    const base = Math.floor((min - 500) / 100) * 100
    if (base !== this.base) {
      this.base = base
      for (const s of this.levels) s.maskForData = false
      for (let i = 0; i < VIEWSHED_LEVEL_COUNT; i++) this.binding.rects[i] = INACTIVE()
    }
  }

  private invalidate(): void {
    for (const s of this.levels) s.maskCurrent = false
    this.requestRender()
  }

  // ───────────────────────────── Cesium primitive interface ─────────────────────────────

  update(frameState: CesiumFrameState): void {
    if (this.destroyed || !this.show || !frameState.passes.render) return
    const context = frameState.context
    if (!this.context) this.initialize(context)
    for (let i = 0; i < VIEWSHED_LEVEL_COUNT; i++) this.upload(i)
    this.binding.params.x = this.base
    if (!this.enabled) return

    const pick = this.pickLevel()
    if (pick >= 0) this.schedule(pick, frameState)
    if (this.levels.some((s) => s.level && s.heights && !s.maskCurrent)) this.requestRender()
  }

  private pickLevel(): number {
    // Levels without a mask for their current data go first (coarse-to-fine arrival order).
    for (let i = VIEWSHED_LEVEL_COUNT - 1; i >= 0; i--) {
      const s = this.levels[i]
      if (s.level && s.heights && !s.maskForData) return i
    }
    for (let i = 0; i < VIEWSHED_LEVEL_COUNT; i++) {
      const s = this.levels[i]
      if (s.level && s.heights && !s.maskCurrent) return i
    }
    return -1
  }

  private initialize(context: CesiumContext): void {
    this.context = context
    const nearest = new Sampler({
      minificationFilter: TextureMinificationFilter.NEAREST,
      magnificationFilter: TextureMagnificationFilter.NEAREST
    })
    for (let i = 0; i < VIEWSHED_LEVEL_COUNT; i++) {
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
        sources: [VIEWSHED_COMPUTE_FS],
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
          u_observer: () => this.observer,
          u_params: () => this.computeParams
        }
      })
    }
    s.command.renderState = RenderState.fromCache({ viewport: new BoundingRectangle(0, 0, l.n, l.n) })
    const command = s.command
    const cell = levelCell(l)
    const minX = levelMinX(l)
    const minY = levelMinY(l)
    const targetHeight = this.targetHeight
    const maxRadius = this.maxRadius
    const nearLimit = viewshedNearLimit(this.levels.map((x) => x.level))
    const params = [1 / this.earthRadius, this.maxHeight, this.base, nearLimit] as const

    this.computeCommands[index] = {
      pass: Pass.COMPUTE,
      execute: () => {
        for (let i = 0; i < VIEWSHED_LEVEL_COUNT; i++) this.heightsRect(i, this.lv[i])
        Cartesian4.fromElements(minX, minY, cell, index, this.target)
        Cartesian4.fromElements(0, 0, targetHeight, maxRadius, this.observer)
        Cartesian4.fromElements(params[0], params[1], params[2], params[3], this.computeParams)
        command.execute(context)
      }
    }
    frameState.commandList.push(this.computeCommands[index])
    s.maskCurrent = true
    s.maskForData = true
    Cartesian4.fromElements(minX, minY, cell, l.n, this.binding.rects[index])
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
