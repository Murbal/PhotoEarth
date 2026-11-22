import { describe, expect, it } from 'vitest'
import { GLOBE_SHADER } from '@renderer/engine/GlobeMaterial'
import { LIGHT_POLLUTION_RECEIVER_GLSL } from '@renderer/engine/LightPollution'
import { COMPUTE_FS, COMPUTE_VS, RECEIVER_GLSL } from '@renderer/engine/shadows/shaders'
import { VIEWSHED_COMPUTE_FS, VIEWSHED_RECEIVER_GLSL } from '@renderer/engine/viewshed/shaders'

// GLSL ES 3.00 keywords and reserved words (§3.6): none may name a variable or function, or
// the shader fails to compile on the GPU (which no unit test otherwise sees).
const RESERVED = new Set(
  `attribute const uniform varying layout centroid flat smooth break continue do for while switch case default
  if else in out inout float int void bool true false invariant discard return mat2 mat3 mat4 mat2x2 mat2x3 mat2x4
  mat3x2 mat3x3 mat3x4 mat4x2 mat4x3 mat4x4 vec2 vec3 vec4 ivec2 ivec3 ivec4 bvec2 bvec3 bvec4 uint uvec2 uvec3 uvec4
  lowp mediump highp precision sampler2D sampler3D samplerCube sampler2DShadow struct
  coherent volatile restrict readonly writeonly resource atomic_uint noperspective patch sample subroutine common
  partition active asm class union enum typedef template this goto inline noinline public static extern external
  interface long short double half fixed unsigned superp input output hvec2 hvec3 hvec4 dvec2 dvec3 dvec4 fvec2
  fvec3 fvec4 filter sizeof cast namespace using`.split(/\s+/)
)

const TYPES = 'float|int|uint|bool|[biud]?vec[234]|mat[234](?:x[234])?|sampler2D|samplerCube|void|czm_material'

function declaredNames(source: string): string[] {
  const names: string[] = []
  const decl = new RegExp(`\\b(?:${TYPES})\\s+([A-Za-z_]\\w*)\\s*(?=[=;,(\\[)])`, 'g')
  for (const m of source.matchAll(decl)) names.push(m[1])
  return names
}

describe('GLSL sources', () => {
  const sources = {
    GLOBE_SHADER,
    COMPUTE_VS,
    COMPUTE_FS,
    RECEIVER_GLSL,
    VIEWSHED_COMPUTE_FS,
    VIEWSHED_RECEIVER_GLSL,
    LIGHT_POLLUTION_RECEIVER_GLSL
  }
  it.each(Object.entries(sources))('%s names nothing with a reserved word', (_, source) => {
    const names = declaredNames(source)
    expect(names.length).toBeGreaterThan(0)
    expect(names.filter((n) => RESERVED.has(n))).toEqual([])
  })

  it('catches a reserved name', () => {
    expect(declaredNames('float flat = 1.0;').filter((n) => RESERVED.has(n))).toEqual(['flat'])
  })
})
