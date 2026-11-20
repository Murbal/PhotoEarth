import { ShaderSource, ShadowMapShader } from 'cesium'
import { describe, expect, it } from 'vitest'
import { patchReceiveShader, TERRAIN_RECEIVER_MARKER } from '@renderer/engine/shadows/detailShadowPatch'

// Runs Cesium's real receive-shader generator, so a Cesium upgrade that changes the snippets
// the patch rewrites fails here rather than silently re-introducing shadow acne.

const bias = {
  polygonOffset: true,
  polygonOffsetFactor: 1.1,
  polygonOffsetUnits: 4,
  normalOffset: true,
  normalOffsetScale: 0.1,
  normalShading: true,
  normalShadingSmooth: 0.05,
  depthBias: 0.00002
}

const shadowMap = {
  _usesDepthTexture: true,
  _polygonOffsetSupported: true,
  _isPointLight: false,
  _isSpotLight: false,
  _numberOfCascades: 4,
  debugCascadeColors: false,
  softShadows: false,
  _primitiveBias: bias,
  _terrainBias: bias,
  _pointBias: bias
}

function receive(fsText: string, isTerrain = false): { fs: ShaderSource; out: ShaderSource } {
  const fs = new ShaderSource({ sources: [fsText] })
  return { fs, out: ShadowMapShader.createShadowReceiveFragmentShader(fs, shadowMap, true, isTerrain, false) }
}

describe('detail shadow patch', () => {
  it('derives normals for meshes without them and restores the normal offset', () => {
    const { fs, out } = receive('void main() { out_FragColor = vec4(1.0); }')
    const patched = patchReceiveShader(out, fs, false).sources.join('\n')
    expect(patched).toContain('cross(dFdx(p), dFdy(p))')
    expect(patched).toContain('positionEC.xyz += normalOffset')
    expect(patched).not.toContain('pe_want')
  })

  it('folds shadow-map visibility into the terrain shadow for marked receivers', () => {
    const { fs, out } = receive(`vec3 pe_F0; vec3 pe_F1; float ${TERRAIN_RECEIVER_MARKER}; void main() { out_FragColor = vec4(1.0); }`)
    const patched = patchReceiveShader(out, fs, false).sources.join('\n')
    expect(patched).toContain('shadowParameters.darkness = 0.0;')
    expect(patched).toContain('min(pe_terrainVis, visibility)')
    expect(patched).not.toContain('out_FragColor.rgb *= visibility;')
  })

  it('leaves terrain receivers alone', () => {
    const { fs, out } = receive('void main() { out_FragColor = vec4(1.0); }', true)
    expect(patchReceiveShader(out, fs, true)).toBe(out)
  })
})
