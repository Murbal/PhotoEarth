import type { QualityOverrides, QualityPreset } from '@shared/types'

/**
 * Largest shadow-map texture allocated, per side. Cesium packs 4 cascades into one atlas
 * twice the cascade size (so 4096 per cascade is already 8192², ~256 MB of depth); 8192 per
 * cascade would be a 16384² (~1 GB) atlas.
 */
export const MAX_SHADOW_ATLAS = 8192

export interface QualityConfig {
  /** 3D Tiles screen-space error (lower = sharper, more data). */
  maximumScreenSpaceError: number
  /** Terrain screen-space error for the globe. */
  terrainScreenSpaceError: number
  /** Per cascade; see MAX_SHADOW_ATLAS. */
  shadowMapSize: number
  shadowCascades: 1 | 4
  softShadows: boolean
  /** Distance covered by shadow maps when they do all the shadowing (no terrain heights), meters. */
  shadowDistance: number
  /** Range of building/tree detail shadows on top of heightmap terrain shadows, meters (0 = off). */
  detailShadowDistance: number
  /** Cells per side of the terrain shadow grids. */
  terrainShadowResolution: number
  msaaSamples: number
  fxaa: boolean
  resolutionScale: number
}

export const PRESETS: Record<QualityPreset, QualityConfig> = {
  low: {
    maximumScreenSpaceError: 32,
    terrainScreenSpaceError: 4,
    shadowMapSize: 1024,
    shadowCascades: 1,
    softShadows: false,
    shadowDistance: 5000,
    detailShadowDistance: 0,
    terrainShadowResolution: 256,
    msaaSamples: 1,
    fxaa: true,
    resolutionScale: 0.75
  },
  medium: {
    maximumScreenSpaceError: 20,
    terrainScreenSpaceError: 2,
    shadowMapSize: 2048,
    shadowCascades: 4,
    softShadows: false,
    shadowDistance: 10000,
    detailShadowDistance: 600,
    terrainShadowResolution: 384,
    msaaSamples: 2,
    fxaa: false,
    resolutionScale: 1
  },
  high: {
    maximumScreenSpaceError: 12,
    terrainScreenSpaceError: 1.5,
    shadowMapSize: 4096,
    shadowCascades: 4,
    softShadows: true,
    shadowDistance: 20000,
    detailShadowDistance: 1200,
    terrainShadowResolution: 512,
    msaaSamples: 4,
    fxaa: false,
    resolutionScale: 1
  },
  ultra: {
    maximumScreenSpaceError: 6,
    terrainScreenSpaceError: 1.2,
    // 4096 per cascade = an 8192² atlas (MAX_SHADOW_ATLAS).
    shadowMapSize: 4096,
    shadowCascades: 4,
    softShadows: true,
    shadowDistance: 30000,
    detailShadowDistance: 2500,
    terrainShadowResolution: 768,
    msaaSamples: 8,
    fxaa: false,
    resolutionScale: 1
  }
}

export interface DeviceLimits {
  maxTextureSize: number
  maxSamples: number
}

/** Preset values with the user's advanced overrides applied, clamped to device limits. */
export function resolveQuality(
  preset: QualityPreset,
  overrides: QualityOverrides,
  limits: DeviceLimits = { maxTextureSize: 16384, maxSamples: 8 }
): QualityConfig {
  const base = PRESETS[preset]
  const pick = <K extends keyof QualityOverrides & keyof QualityConfig>(key: K): QualityConfig[K] =>
    (overrides[key] ?? base[key]) as QualityConfig[K]
  const shadowCascades = pick('shadowCascades')
  const atlasPerCascade = shadowCascades === 4 ? 2 : 1
  return {
    ...base,
    maximumScreenSpaceError: pick('maximumScreenSpaceError'),
    shadowMapSize: Math.min(pick('shadowMapSize'), Math.min(limits.maxTextureSize, MAX_SHADOW_ATLAS) / atlasPerCascade),
    shadowCascades,
    softShadows: pick('softShadows'),
    terrainShadowResolution: pick('terrainShadowResolution'),
    msaaSamples: Math.max(1, Math.min(pick('msaaSamples'), limits.maxSamples)),
    fxaa: pick('fxaa'),
    resolutionScale: pick('resolutionScale')
  }
}
