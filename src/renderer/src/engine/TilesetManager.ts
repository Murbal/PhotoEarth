import {
  Cartesian3,
  Cesium3DTileset,
  createGooglePhotorealistic3DTileset,
  CustomShader,
  LightingModel,
  Matrix4,
  ShadowMode,
  TextureUniform,
  UniformType,
  type Scene
} from 'cesium'
import { classifyGoogleError } from '@shared/apiErrors'
import type { ApiCheck } from '@shared/types'
import { RECEIVER_GLSL } from './shadows/shaders'
import type { ShadowBinding } from './shadows/ShadowCompute'
import { ContentGate } from './ContentGate'
import { RECEIVER_UNIFORMS } from './TerrainShadows'
import { httpStatusOf, responseTextOf } from './util'

/** Shadowed surfaces keep this much of their color: a cool skylight tint. */
export const SHADOW_TINT = new Cartesian3(0.4, 0.44, 0.54)

/**
 * The tileset's shader. Google's tiles are unlit (lighting is baked into the photos), so
 * this applies the simulated sun itself: heightmap terrain shadows (RECEIVER_GLSL) and
 * night/twilight dimming. It publishes the factor it applied (pe_F0 + (pe_F1 − pe_F0)·vis)
 * so the patched shadow-map receive shader can fold detail shadows into it.
 */
function createTilesetShader(binding: ShadowBinding): CustomShader {
  const dummy = new TextureUniform({ typedArray: new Uint8Array(4), width: 1, height: 1 })
  const shader = new CustomShader({
    lightingModel: LightingModel.UNLIT,
    uniforms: {
      u_daylight: { type: UniformType.FLOAT, value: 1 },
      u_nightTint: { type: UniformType.VEC3, value: new Cartesian3(0.09, 0.11, 0.17) },
      u_peShadowTint: { type: UniformType.VEC3, value: SHADOW_TINT },
      u_peMask0: { type: UniformType.SAMPLER_2D, value: dummy },
      u_peMask1: { type: UniformType.SAMPLER_2D, value: dummy },
      u_peMask2: { type: UniformType.SAMPLER_2D, value: dummy },
      u_peRect0: { type: UniformType.VEC4, value: binding.rects[0] },
      u_peRect1: { type: UniformType.VEC4, value: binding.rects[1] },
      u_peRect2: { type: UniformType.VEC4, value: binding.rects[2] },
      u_peParams: { type: UniformType.VEC4, value: binding.params },
      u_peEyeToLocal: { type: UniformType.MAT4, value: Matrix4.clone(Matrix4.IDENTITY) },
      u_peExaggeration: { type: UniformType.VEC2, value: binding.exaggeration }
    },
    fragmentShaderText: /* glsl */ `
      ${RECEIVER_GLSL}
      vec3 pe_F0 = vec3(1.0);
      vec3 pe_F1 = vec3(1.0);
      float pe_terrainVis = 1.0;
      void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
        float vis = pe_terrainVisibility(fsInput.attributes.positionEC);
        vec3 night = u_nightTint * 3.0;
        pe_F0 = mix(night, u_peShadowTint, u_daylight);
        pe_F1 = mix(night, vec3(1.0), u_daylight);
        pe_terrainVis = vis;
        material.diffuse *= pe_F0 + (pe_F1 - pe_F0) * vis;
      }
    `
  })
  // The receiver uniforms read the live binding. Models copy uniformMap when they build their
  // draw commands, so this must happen before the shader is assigned to the tileset.
  const map = (shader as unknown as { uniformMap: Record<string, () => unknown> }).uniformMap
  const fallback = () => (shader as unknown as { _defaultTexture: unknown })._defaultTexture
  RECEIVER_UNIFORMS.masks.forEach((name, k) => (map[name] = () => binding.masks[k] ?? fallback()))
  RECEIVER_UNIFORMS.rects.forEach((name, k) => (map[name] = () => binding.rects[k]))
  map[RECEIVER_UNIFORMS.params] = () => binding.params
  map[RECEIVER_UNIFORMS.eyeToLocal] = () => binding.eyeToLocal
  map[RECEIVER_UNIFORMS.exaggeration] = () => binding.exaggeration
  return shader
}

export interface TilesetEvents {
  onError: (check: ApiCheck) => void
  onReady: () => void
  onProgress: (pending: number) => void
}

/**
 * Google Photorealistic 3D Tiles. The mesh is both what you see and the shadow caster:
 * its geometry already contains Google's elevation.
 */
/** Screen-space error multiplier while the camera moves (see setMoving). */
const MOVING_SSE_FACTOR = 1.5

export class TilesetManager {
  tileset: Cesium3DTileset | null = null
  private generation = 0
  private failures = 0
  private visible = true
  private sse = 16
  private moving = false
  private shadows = true
  private readonly shader: CustomShader
  private readonly gate: ContentGate

  constructor(
    private readonly scene: Scene,
    private readonly events: TilesetEvents,
    binding: ShadowBinding
  ) {
    this.shader = createTilesetShader(binding)
    this.gate = new ContentGate(scene)
  }

  /** The tileset shader (exposed for the end-to-end shader compile test). */
  get customShader(): CustomShader {
    return this.shader
  }

  async load(key: string | null): Promise<void> {
    const generation = ++this.generation
    this.unload()
    if (!key) return
    this.failures = 0
    try {
      const tileset = await createGooglePhotorealistic3DTileset(
        { key, onlyUsingWithGoogleGeocoder: true },
        {
          // Google requires its attributions to be visible on screen, not in a lightbox.
          showCreditsOnScreen: true,
          maximumScreenSpaceError: this.moving ? this.sse * MOVING_SSE_FACTOR : this.sse,
          enableCollision: true,
          // Keep CPU copies of tile geometry for picking (collision, surface heights, ray
          // casts). Without them every pick reads buffers back from the GPU and stalls the
          // frame; vite/cesium.ts makes Cesium honor this on WebGL 2.
          enablePick: true,
          shadows: this.shadows ? ShadowMode.ENABLED : ShadowMode.DISABLED,
          dynamicScreenSpaceError: true,
          foveatedScreenSpaceError: true,
          preloadFlightDestinations: true
        }
      )
      if (generation !== this.generation) {
        tileset.destroy()
        return
      }
      tileset.show = this.visible
      tileset.customShader = this.shader
      ;(tileset as unknown as { contentGate?: () => Promise<void> }).contentGate = this.gate.acquire
      tileset.loadProgress.addEventListener((pending: number, processing: number) => {
        this.events.onProgress(pending + processing)
      })
      tileset.tileFailed.addEventListener((err: { message?: string }) => this.onTileFailed(err))
      this.scene.primitives.add(tileset)
      this.tileset = tileset
      this.events.onReady()
    } catch (error) {
      if (generation !== this.generation) return
      this.events.onError(
        classifyGoogleError('Map Tiles API', httpStatusOf(error), responseTextOf(error), navigator.onLine)
      )
    }
  }

  private onTileFailed(err: { message?: string }): void {
    this.failures++
    const message = err.message ?? ''
    // Individual tile failures are normal on flaky networks; report persistent ones.
    if (this.failures === 8 || /403|429/.test(message)) {
      const status = /429/.test(message) ? 429 : /403/.test(message) ? 403 : 0
      this.events.onError(classifyGoogleError('Map Tiles API', status || undefined, message, navigator.onLine))
    }
  }

  unload(): void {
    if (this.tileset) {
      this.scene.primitives.remove(this.tileset)
      this.tileset = null
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    if (this.tileset) this.tileset.show = visible
  }

  setScreenSpaceError(sse: number): void {
    this.sse = sse
    this.applyScreenSpaceError()
  }

  /**
   * While the camera moves, settle for somewhat coarser tiles (their parents, which are
   * already loaded): fewer tiles to traverse, draw and cast shadows from each frame. Full
   * detail is back as soon as the camera stops.
   */
  setMoving(moving: boolean): void {
    if (moving === this.moving) return
    this.moving = moving
    this.applyScreenSpaceError()
    this.gate.setMoving(moving)
  }

  private applyScreenSpaceError(): void {
    if (this.tileset) this.tileset.maximumScreenSpaceError = this.moving ? this.sse * MOVING_SSE_FACTOR : this.sse
  }

  setShadows(enabled: boolean): void {
    this.shadows = enabled
    if (this.tileset) this.tileset.shadows = enabled ? ShadowMode.ENABLED : ShadowMode.DISABLED
  }

  /** 1 = full daylight, 0 = night. */
  setDaylight(factor: number): void {
    this.shader.setUniform('u_daylight', factor)
  }
}
