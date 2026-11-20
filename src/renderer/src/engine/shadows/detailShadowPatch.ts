import { ShadowMapShader, ShaderSource } from 'cesium'

/**
 * Patches Cesium's shadow-map receive shader for 3D Tiles (Cesium 1.147; each replaced
 * snippet is verified, and a mismatch leaves the shader untouched).
 *
 * 1. Shadow acne. Google's Photorealistic 3D Tiles carry no vertex normals, so Cesium skips
 *    its normal-offset bias and slopes under a low sun shadow themselves in stripes. The
 *    patch derives a face normal from screen-space derivatives of the eye-space position and
 *    restores the normal offset.
 * 2. Double darkening. The tileset's custom shader already applies the heightmap terrain
 *    shadow (globals pe_F0 / pe_F1 / pe_terrainVis). Where it marks itself as such, the
 *    shadow map's visibility is folded into the terrain one (min of the two) instead of
 *    multiplying on top, so a building's shadow inside a mountain's shadow isn't darker.
 */

const NO_NORMAL = 'vec3 getNormalEC() \n{ \n    return vec3(1.0); \n} \n'
const DERIVED_NORMAL =
  'vec3 getNormalEC() \n{ \n' +
  '    vec3 p = getPositionEC().xyz; \n' +
  '    vec3 n = normalize(cross(dFdx(p), dFdy(p))); \n' +
  '    return dot(n, p) > 0.0 ? -n : n; \n' +
  '} \n'

const NO_OFFSET = 'void applyNormalOffset(inout vec4 positionEC, vec3 normalEC, float nDotL) \n{ \n} \n'
const NORMAL_OFFSET =
  'void applyNormalOffset(inout vec4 positionEC, vec3 normalEC, float nDotL) \n{ \n' +
  '    float normalOffset = shadowMap_normalOffsetScaleDistanceMaxDistanceAndDarkness.x; \n' +
  '    positionEC.xyz += normalOffset * (1.0 - nDotL) * normalEC; \n' +
  '} \n'

const DARKNESS = '    shadowParameters.darkness = shadowMap_normalOffsetScaleDistanceMaxDistanceAndDarkness.w; \n'
const NO_DARKNESS = '    shadowParameters.darkness = 0.0; \n'

const APPLY = '    out_FragColor.rgb *= visibility; \n} \n'
const COMBINE = `#ifdef HDR
    vec3 pe_linear = out_FragColor.rgb;
#else
    vec3 pe_linear = czm_srgbToLinear(out_FragColor.rgb);
#endif
    vec3 pe_now = pe_F0 + (pe_F1 - pe_F0) * pe_terrainVis;
    vec3 pe_want = pe_F0 + (pe_F1 - pe_F0) * min(pe_terrainVis, visibility);
    pe_linear *= pe_want / max(pe_now, vec3(1.0e-4));
#ifdef HDR
    out_FragColor.rgb = pe_linear;
#else
    out_FragColor.rgb = czm_linearToSrgb(pe_linear);
#endif
}
`

/** Marker the tileset's custom shader declares so the receive shader can combine. */
export const TERRAIN_RECEIVER_MARKER = 'pe_terrainVis'

let installed = false
let working = true

export function detailShadowPatchWorking(): boolean {
  return installed && working
}

/** Rewrites one generated receive shader; exported for unit tests. */
export function patchReceiveShader(result: ShaderSource, fs: ShaderSource, isTerrain: boolean): ShaderSource {
  if (isTerrain) return result
  const last = result.sources.length - 1
  let src = result.sources[last]
  if (src.includes(NO_NORMAL)) {
    if (!src.includes(NO_OFFSET)) return fail(result)
    src = src.replace(NO_NORMAL, DERIVED_NORMAL).replace(NO_OFFSET, NORMAL_OFFSET)
  }
  if (fs.sources.some((s) => s.includes(TERRAIN_RECEIVER_MARKER))) {
    if (!src.includes(DARKNESS) || !src.includes(APPLY)) return fail(result)
    src = src.replace(DARKNESS, NO_DARKNESS).replace(APPLY, COMBINE)
  }
  const sources = result.sources.slice()
  sources[last] = src
  return new ShaderSource({ sources, defines: result.defines.slice() })
}

function fail(result: ShaderSource): ShaderSource {
  if (working) console.warn('[photoearth] Cesium shadow shader changed; detail-shadow patch disabled')
  working = false
  return result
}

export function installDetailShadowPatch(): void {
  if (installed) return
  installed = true
  const original = ShadowMapShader.createShadowReceiveFragmentShader.bind(ShadowMapShader)
  ShadowMapShader.createShadowReceiveFragmentShader = (fs, shadowMap, castShadows, isTerrain, hasTerrainNormal) =>
    patchReceiveShader(original(fs, shadowMap, castShadows, isTerrain, hasTerrainNormal), fs, isTerrain)
}
