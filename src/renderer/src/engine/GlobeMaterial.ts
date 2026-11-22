import { Material, Matrix4, type Scene } from 'cesium'
import { RECEIVER_GLSL } from './shadows/shaders'
import { RECEIVER_UNIFORMS, type TerrainShadows } from './TerrainShadows'
import { VIEWSHED_RECEIVER_GLSL } from './viewshed/shaders'
import { VIEWSHED_RECEIVER_UNIFORMS, type ViewshedTool } from './ViewshedTool'

/**
 * The terrain globe's overlays, for when it stands in for the 3D Tiles (none loaded, or
 * unavailable): heightmap terrain shadows and the viewshed, the same layers the 3D Tiles get
 * from their custom shader. The result alpha-blends over the draped imagery.
 */
export const GLOBE_SHADER = /* glsl */ `
${RECEIVER_GLSL}
${VIEWSHED_RECEIVER_GLSL}
void pe_over(inout vec3 color, inout float alpha, vec3 src, float srcAlpha) {
  float outAlpha = srcAlpha + alpha * (1.0 - srcAlpha);
  if (outAlpha > 0.0) {
    color = (src * srcAlpha + color * alpha * (1.0 - srcAlpha)) / outAlpha;
  }
  alpha = outAlpha;
}

czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material material = czm_getDefaultMaterial(materialInput);
  vec3 color = vec3(0.0);
  float alpha = 0.0;

  if (shadowOpacity > 0.0) {
    float vis = pe_terrainVisibility(-materialInput.positionToEyeEC);
    // Faces turned away from the sun are already dark from globe lighting.
    float facing = smoothstep(0.0, 0.12, dot(normalize(materialInput.normalEC), normalize(czm_lightDirectionEC)));
    pe_over(color, alpha, vec3(0.02, 0.03, 0.08), (1.0 - vis) * facing * shadowOpacity);
  }

  vec4 vs = pe_viewshedOverlay(-materialInput.positionToEyeEC);
  if (vs.a > 0.0) {
    pe_over(color, alpha, vs.rgb, vs.a);
  }

  material.diffuse = color;
  material.alpha = alpha;
  return material;
}
`

/** How dark terrain shadows are on the globe (0–1 black overlay). */
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

/** Initial values for the viewshed receiver uniforms; ViewshedTool keeps them current. */
function viewshedReceiverUniforms(viewshed: ViewshedTool): Record<string, unknown> {
  const b = viewshed.binding
  const placeholder = document.createElement('canvas')
  placeholder.width = 1
  placeholder.height = 1
  const out: Record<string, unknown> = {
    [VIEWSHED_RECEIVER_UNIFORMS.eyeToLocal]: Matrix4.toArray(Matrix4.IDENTITY),
    [VIEWSHED_RECEIVER_UNIFORMS.params]: b.params,
    [VIEWSHED_RECEIVER_UNIFORMS.style]: b.style,
    [VIEWSHED_RECEIVER_UNIFORMS.exaggeration]: b.exaggeration
  }
  VIEWSHED_RECEIVER_UNIFORMS.masks.forEach((name) => (out[name] = placeholder))
  VIEWSHED_RECEIVER_UNIFORMS.rects.forEach((name, k) => (out[name] = b.rects[k]))
  return out
}

export class GlobeMaterial {
  private material: Material | null = null

  constructor(
    private readonly scene: Scene,
    private readonly shadows: TerrainShadows,
    private readonly viewshed: ViewshedTool
  ) {}

  private ensureMaterial(): Material {
    if (this.material) return this.material
    this.material = new Material({
      translucent: false,
      fabric: {
        type: 'PhotoEarthGlobe',
        uniforms: {
          shadowOpacity: 0,
          ...receiverUniforms(this.shadows),
          ...viewshedReceiverUniforms(this.viewshed)
        },
        source: GLOBE_SHADER
      }
    })
    this.shadows.bindMaterial(this.material)
    this.viewshed.bindMaterial(this.material)
    return this.material
  }

  /**
   * `globeShown`: the globe is the 3D view right now. `terrainShadows` / `viewshedActive`: those
   * layers have something to draw. Without either, the globe goes without a material.
   */
  apply(globeShown: boolean, terrainShadows: boolean, viewshedActive: boolean): void {
    const globe = this.scene.globe
    if (!globeShown || (!terrainShadows && !viewshedActive)) {
      if (globe.material) globe.material = undefined as unknown as Material
      this.scene.requestRender()
      return
    }
    const m = this.ensureMaterial()
    ;(m.uniforms as Record<string, unknown>).shadowOpacity = terrainShadows ? SHADOW_OPACITY : 0
    if (globe.material !== m) globe.material = m
    this.scene.requestRender()
  }
}
