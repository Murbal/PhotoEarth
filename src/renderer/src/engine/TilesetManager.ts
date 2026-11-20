import {
  Cartesian3,
  Cesium3DTileset,
  createGooglePhotorealistic3DTileset,
  CustomShader,
  LightingModel,
  ShadowMode,
  UniformType,
  type Scene
} from 'cesium'
import { classifyGoogleError } from '@shared/apiErrors'
import type { ApiCheck } from '@shared/types'
import { httpStatusOf, responseTextOf } from './util'

export interface TilesetEvents {
  onError: (check: ApiCheck) => void
  onReady: () => void
  onProgress: (pending: number) => void
}

/**
 * Google Photorealistic 3D Tiles. The mesh is both what you see and the shadow caster:
 * its geometry already contains Google's elevation.
 */
export class TilesetManager {
  tileset: Cesium3DTileset | null = null
  private generation = 0
  private failures = 0
  private visible = true
  private sse = 16
  private shadows = true
  // Google tiles are unlit (baked lighting). This shader only dims them for night/twilight.
  private readonly shader = new CustomShader({
    lightingModel: LightingModel.UNLIT,
    uniforms: {
      u_daylight: { type: UniformType.FLOAT, value: 1 },
      u_nightTint: { type: UniformType.VEC3, value: new Cartesian3(0.09, 0.11, 0.17) }
    },
    fragmentShaderText: /* glsl */ `
      void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
        material.diffuse = mix(material.diffuse * u_nightTint * 3.0, material.diffuse, u_daylight);
      }
    `
  })

  constructor(
    private readonly scene: Scene,
    private readonly events: TilesetEvents
  ) {}

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
          maximumScreenSpaceError: this.sse,
          enableCollision: true,
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
    if (this.tileset) this.tileset.maximumScreenSpaceError = sse
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
