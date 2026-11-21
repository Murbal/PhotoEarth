import { Cartesian2, Cartographic, Color, Material, Matrix4, type Scene } from 'cesium'
import type { ElevationStyleSettings, PaletteId } from '@shared/types'
import { geoidUndulation, toMsl } from '../lib/geoid'
import { hexToRgb, paletteColor, SLOPE_CLASSES } from '../lib/palettes'
import { RECEIVER_GLSL } from './shadows/shaders'
import { RECEIVER_UNIFORMS, type TerrainShadows } from './TerrainShadows'
import { toDeg } from './util'

const glslVec3 = (hex: string): string => {
  const [r, g, b] = hexToRgb(hex)
  return `vec3(${(r / 255).toFixed(4)}, ${(g / 255).toFixed(4)}, ${(b / 255).toFixed(4)})`
}

const SLOPE_GLSL = SLOPE_CLASSES.map(({ from, color }, i) =>
  i === 0 ? `  vec3 c = ${glslVec3(color)};` : `  if (deg >= ${from.toFixed(1)}) c = ${glslVec3(color)};`
).join('\n')

/**
 * One globe material that composites, bottom to top: hypsometric tint, slope classes,
 * hillshade (sun-following or fixed NW light), heightmap terrain shadows and contours with
 * index lines. The result alpha-blends over the draped imagery. Heights are corrected for
 * vertical exaggeration and shifted from the ellipsoid to approximately mean sea level
 * (geoid at the view target).
 */
export const ELEVATION_SHADER = /* glsl */ `
${RECEIVER_GLSL}
void pe_over(inout vec3 color, inout float alpha, vec3 src, float srcAlpha) {
  float outAlpha = srcAlpha + alpha * (1.0 - srcAlpha);
  if (outAlpha > 0.0) {
    color = (src * srcAlpha + color * alpha * (1.0 - srcAlpha)) / outAlpha;
  }
  alpha = outAlpha;
}

vec3 pe_slopeColor(float deg) {
${SLOPE_GLSL}
  return c;
}

float pe_line(float value, float spacing, float widthPx, float heightError) {
  float v = value / spacing;
  float fw = max(fwidth(v), 1e-6);
  float dist = abs(fract(v + 0.5) - 0.5) / fw;
  float halfWidth = 0.5 * widthPx * czm_pixelRatio;
  float line = 1.0 - smoothstep(halfWidth - 0.6, halfWidth + 0.6, dist);
  // Fade out where lines would be packed tighter than a few pixels, and where the terrain
  // drawn here is too coarse for the interval: contours of its flat triangles are
  // straight-edged rings and stars, not the real terrain.
  return line * (1.0 - smoothstep(0.12, 0.35, fw)) * (1.0 - smoothstep(0.25, 0.5, heightError / spacing));
}

czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material material = czm_getDefaultMaterial(materialInput);
  float h = (materialInput.height - exaggerationRelativeHeight) / max(exaggeration, 0.001)
    + exaggerationRelativeHeight - heightOffset;
  vec3 color = vec3(0.0);
  float alpha = 0.0;

  if (tintOpacity > 0.0) {
    float t = clamp((h - tintMin) / max(tintMax - tintMin, 1.0), 0.0, 1.0);
    pe_over(color, alpha, texture(ramp, vec2(t, 0.5)).rgb, tintOpacity);
  }

  if (slopeOpacity > 0.0) {
    pe_over(color, alpha, pe_slopeColor(degrees(materialInput.slope)), slopeOpacity);
  }

  if (hillshadeOpacity > 0.0) {
    vec3 positionWC = (czm_inverseView * vec4(-materialInput.positionToEyeEC, 1.0)).xyz;
    vec3 upWC = normalize(positionWC * czm_ellipsoidInverseRadii * czm_ellipsoidInverseRadii);
    vec3 upEC = normalize(czm_normal3D * upWC);
    vec3 eastEC = normalize(materialInput.tangentToEyeMatrix[0]);
    vec3 northEC = normalize(cross(upEC, eastEC));
    vec3 lightEC;
    float daylight = 1.0;
    if (hillshadeFollowSun > 0.5) {
      lightEC = normalize(czm_sunDirectionEC);
      // Below the horizon: fade to flat night shading instead of lighting from below.
      daylight = smoothstep(-0.03, 0.06, dot(lightEC, upEC));
    } else {
      // Classic cartographic light: from the north-west, 45° above the horizon.
      lightEC = normalize(-0.5 * eastEC + 0.5 * northEC + 0.70710678 * upEC);
    }
    float lambert = clamp(dot(normalize(materialInput.normalEC), lightEC), 0.0, 1.0);
    float shade = mix(0.3, lambert, daylight);
    pe_over(color, alpha, vec3(0.0), (1.0 - shade) * hillshadeOpacity);
  }

  if (shadowOpacity > 0.0) {
    float vis = pe_terrainVisibility(-materialInput.positionToEyeEC);
    // Faces turned away from the sun are already dark from globe lighting.
    float facing = smoothstep(0.0, 0.12, dot(normalize(materialInput.normalEC), normalize(czm_lightDirectionEC)));
    pe_over(color, alpha, vec3(0.02, 0.03, 0.08), (1.0 - vis) * facing * shadowOpacity);
  }

  if (contourOpacity > 0.0) {
    // Cesium refines terrain until its geometric error is about terrainSse pixels, so that
    // is roughly how far off the drawn heights are here (in real, unexaggerated meters).
    float heightError = terrainSse * czm_metersPerPixel(vec4(-materialInput.positionToEyeEC, 1.0), czm_pixelRatio)
      / max(exaggeration, 1.0);
    float minor = pe_line(h, contourInterval, contourWidth, heightError);
    float major = pe_line(h, contourInterval * 5.0, contourWidth * 2.0, heightError);
    pe_over(color, alpha, contourColor.rgb, max(minor * 0.7, major) * contourOpacity);
  }

  material.diffuse = color;
  material.alpha = alpha;
  return material;
}
`

/** How dark terrain shadows are on the Elevation mode globe (0–1 black overlay). */
const SHADOW_OPACITY = 0.55

/** Initial values for the receiver uniforms; TerrainShadows keeps them current. */
function receiverUniforms(shadows: TerrainShadows): Record<string, unknown> {
  const b = shadows.binding
  const placeholder = document.createElement('canvas')
  placeholder.width = 1
  placeholder.height = 1
  const out: Record<string, unknown> = {
    // A plain array declares a mat4 (a Matrix4 instance isn't recognized as one).
    [RECEIVER_UNIFORMS.eyeToLocal]: Matrix4.toArray(Matrix4.IDENTITY),
    [RECEIVER_UNIFORMS.params]: b.params,
    [RECEIVER_UNIFORMS.exaggeration]: b.exaggeration
  }
  RECEIVER_UNIFORMS.masks.forEach((name) => (out[name] = placeholder))
  RECEIVER_UNIFORMS.rects.forEach((name, k) => (out[name] = b.rects[k]))
  return out
}

export function paletteCanvas(id: PaletteId): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 1
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(256, 1)
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = paletteColor(id, i / 255)
    img.data.set([r, g, b, 255], i * 4)
  }
  ctx.putImageData(img, 0, 0)
  return canvas
}

export class ElevationStyler {
  private material: Material | null = null
  private palette: PaletteId | null = null
  private active = false
  private range: { min: number; max: number } | null = null

  constructor(
    private readonly scene: Scene,
    private readonly shadows: TerrainShadows
  ) {}

  private ensureMaterial(): Material {
    if (this.material) return this.material
    this.material = new Material({
      translucent: false,
      fabric: {
        type: 'PhotoEarthElevation',
        uniforms: {
          ramp: paletteCanvas('terrain'),
          tintMin: 0,
          tintMax: 4000,
          tintOpacity: 0,
          slopeOpacity: 0,
          hillshadeOpacity: 0,
          hillshadeFollowSun: 1,
          contourInterval: 50,
          contourWidth: 1.2,
          contourColor: Color.WHITE,
          contourOpacity: 0,
          terrainSse: 2,
          heightOffset: 0,
          exaggeration: 1,
          exaggerationRelativeHeight: 0,
          shadowOpacity: 0,
          ...receiverUniforms(this.shadows)
        },
        source: ELEVATION_SHADER
      }
    })
    this.shadows.bindMaterial(this.material)
    return this.material
  }

  /**
   * Applies the style; `enabled` is false outside Elevation mode. `terrainShadows` turns on
   * the heightmap shadow layer, which needs the material even with no style layer on.
   * `dataOverlay`: a colored data layer (light pollution, §7.5) is on the globe, so the
   * tint and slope colors, which would bury it, pause.
   */
  apply(
    style: ElevationStyleSettings,
    enabled: boolean,
    autoRange: { min: number; max: number } | null,
    terrainShadows = false,
    dataOverlay = false
  ): void {
    const tint = style.tint.enabled && !dataOverlay
    const slope = style.slope.enabled && !dataOverlay
    const anyLayer = tint || style.contours.enabled || slope || style.hillshade.enabled
    this.active = enabled && (anyLayer || terrainShadows)
    const globe = this.scene.globe
    if (!this.active) {
      if (globe.material) globe.material = undefined as unknown as Material
      this.scene.requestRender()
      return
    }
    const m = this.ensureMaterial()
    const u = m.uniforms as Record<string, unknown>
    if (this.palette !== style.tint.palette) {
      this.palette = style.tint.palette
      u.ramp = paletteCanvas(style.tint.palette)
    }
    const range = style.tint.autoRange && autoRange ? autoRange : { min: style.tint.min, max: style.tint.max }
    this.range = range
    u.tintMin = range.min
    u.tintMax = range.max
    u.tintOpacity = tint ? style.tint.opacity : 0
    u.slopeOpacity = slope ? style.slope.opacity : 0
    u.hillshadeOpacity = style.hillshade.enabled ? style.hillshade.opacity : 0
    u.hillshadeFollowSun = style.hillshade.followSun ? 1 : 0
    u.contourInterval = Math.max(1, style.contours.interval)
    u.contourWidth = style.contours.width
    u.contourColor = Color.fromCssColorString(style.contours.color)
    u.contourOpacity = style.contours.enabled ? style.contours.opacity : 0
    u.shadowOpacity = terrainShadows ? SHADOW_OPACITY : 0
    u.terrainSse = globe.maximumScreenSpaceError
    u.exaggeration = this.scene.verticalExaggeration
    u.exaggerationRelativeHeight = this.scene.verticalExaggerationRelativeHeight
    if (globe.material !== m) globe.material = m
    this.scene.requestRender()
  }

  /** Geoid height at the view target, so contours and tint read in meters above sea level. */
  setGeoidOffset(latitude: number, longitude: number): void {
    if (!this.material) return
    ;(this.material.uniforms as Record<string, unknown>).heightOffset = geoidUndulation(latitude, longitude)
    if (this.active) this.scene.requestRender()
  }

  /**
   * Samples the visible terrain on a screen grid and returns a padded MSL height range
   * for the auto-fit hypsometric tint.
   */
  sampleVisibleRange(): { min: number; max: number } | null {
    const scene = this.scene
    if (!scene.globe.show) return null
    const w = scene.canvas.clientWidth
    const h = scene.canvas.clientHeight
    const heights: number[] = []
    const cols = 12
    const rows = 9
    const exaggeration = scene.verticalExaggeration
    const rel = scene.verticalExaggerationRelativeHeight
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        const ray = scene.camera.getPickRay(new Cartesian2(((i + 0.5) / cols) * w, ((j + 0.5) / rows) * h))
        if (!ray) continue
        const hit = scene.globe.pick(ray, scene)
        if (!hit) continue
        const c = Cartographic.fromCartesian(hit)
        const real = (c.height - rel) / exaggeration + rel
        heights.push(toMsl(toDeg(c.latitude), toDeg(c.longitude), real))
      }
    }
    if (heights.length < 6) return null
    heights.sort((a, b) => a - b)
    const lo = heights[Math.floor(heights.length * 0.02)]
    const hi = heights[Math.ceil(heights.length * 0.98) - 1]
    const span = Math.max(hi - lo, 60)
    const mid = (hi + lo) / 2
    const pad = span * 0.06
    return { min: Math.round(mid - span / 2 - pad), max: Math.round(mid + span / 2 + pad) }
  }

  get currentRange(): { min: number; max: number } | null {
    return this.range
  }
}
