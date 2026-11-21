// Minimal typings for the Cesium renderer internals the terrain shadow pass uses. They are
// exported at runtime by the `cesium` package but marked @private, so its typings omit them.
// Pinned to the installed Cesium version; check them when upgrading Cesium.
import 'cesium'

declare module 'cesium' {
  /** Cesium's WebGL context wrapper (scene.context). */
  export interface CesiumContext {
    readonly webgl2: boolean
    readonly textureFloatLinear: boolean
    readonly floatingPointTexture: boolean
    readonly defaultTexture: Texture
    getViewportQuadVertexArray(): unknown
  }

  export interface CesiumFrameState {
    context: CesiumContext
    frameNumber: number
    commandList: unknown[]
    passes: { render: boolean; pick: boolean }
  }

  export class Sampler {
    constructor(options?: {
      wrapS?: number
      wrapT?: number
      minificationFilter?: TextureMinificationFilter
      magnificationFilter?: TextureMagnificationFilter
    })
    static readonly NEAREST: Sampler
  }

  export class Texture {
    constructor(options: {
      context: CesiumContext
      width?: number
      height?: number
      pixelFormat?: PixelFormat
      pixelDatatype?: PixelDatatype
      source?: { arrayBufferView: ArrayBufferView; width: number; height: number }
      flipY?: boolean
      sampler?: Sampler
    })
    readonly width: number
    readonly height: number
    copyFrom(options: {
      source: { arrayBufferView: ArrayBufferView; width: number; height: number }
      xOffset?: number
      yOffset?: number
      skipColorSpaceConversion?: boolean
    }): void
    isDestroyed(): boolean
    destroy(): void
  }

  export class Framebuffer {
    constructor(options: { context: CesiumContext; colorTextures: Texture[]; destroyAttachments?: boolean })
    isDestroyed(): boolean
    destroy(): void
  }

  export class ShaderSource {
    constructor(options: { sources?: string[]; defines?: string[]; pickColorQualifier?: string; includeBuiltIns?: boolean })
    sources: string[]
    defines: string[]
  }

  export class ShaderProgram {
    static fromCache(options: {
      context: CesiumContext
      vertexShaderSource: string | ShaderSource
      fragmentShaderSource: string | ShaderSource
      attributeLocations?: Record<string, number>
    }): ShaderProgram
    isDestroyed(): boolean
    destroy(): void
  }

  export class RenderState {
    static fromCache(renderState?: Record<string, unknown>): RenderState
  }

  export class DrawCommand {
    constructor(options?: {
      vertexArray?: unknown
      primitiveType?: PrimitiveType
      renderState?: RenderState
      shaderProgram?: ShaderProgram
      uniformMap?: Record<string, () => unknown>
      framebuffer?: Framebuffer
      owner?: unknown
    })
    renderState: RenderState
    framebuffer: Framebuffer | undefined
    uniformMap: Record<string, () => unknown>
    execute(context: CesiumContext, passState?: unknown): void
  }

  export const Pass: { readonly COMPUTE: number }

  /** WebGL limits of the current context (filled in when the first context is created). */
  export const ContextLimits: { readonly maximumTextureSize: number; readonly maximumSamples: number }

  // Cesium's "preload flight" tileset pass (Scene.updatePreloadFlightPass), driven by
  // TilePreloader with a predicted camera.
  interface Camera {
    canPreloadFlight(): boolean
  }
  interface Cesium3DTileset {
    /** CPU ray cast against the loaded (selected) tiles; needs WebGL 2 or enablePick. */
    pick(ray: Ray, frameState: CesiumFrameState, result?: Cartesian3): Cartesian3 | undefined
  }
  interface Scene {
    readonly frameState: CesiumFrameState
    /** Surface height below the camera (terrain and collidable 3D tiles), as of this frame's start. */
    readonly globeHeight: number | undefined
    preloadFlightCamera: Camera
    preloadFlightCullingVolume: CullingVolume | undefined
  }

  export const ShadowMapShader: {
    createShadowReceiveFragmentShader(
      fs: ShaderSource,
      shadowMap: unknown,
      castShadows: boolean,
      isTerrain: boolean,
      hasTerrainNormal: boolean
    ): ShaderSource
  }
}
