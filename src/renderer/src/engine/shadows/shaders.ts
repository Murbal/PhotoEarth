import {
  CARE_BELOW,
  DIST_STEP,
  LEVEL_BLEND_TEXELS,
  MAX_STEPS,
  PENUMBRA_MIN,
  PENUMBRA_MIN_PER_CELL,
  RECEIVER_BIAS,
  RECEIVER_BIAS_PER_CELL,
  REFRACTION_K,
  STEP_GROWTH,
  SUN_ANGULAR_RADIUS,
  TOP_STEP
} from '../../lib/terrainShadow'

const f = (v: number): string => (Number.isInteger(v) ? `${v}.0` : String(v))

/** Fullscreen-quad vertex shader for the compute pass (Cesium's viewport-quad layout). */
export const COMPUTE_VS = /* glsl */ `
in vec4 position;
in vec2 textureCoordinates;
void main() {
  gl_Position = position;
}
`

/**
 * Computes the shadow top of every cell of one level (`u_target`), marching through the
 * height grids of all levels. Mirrors `shadowTop()` in lib/terrainShadow.ts exactly.
 * Output: RGBA8 = (top hi, top lo, distance hi, distance lo).
 */
export const COMPUTE_FS = /* glsl */ `
uniform highp sampler2D u_h0;
uniform highp sampler2D u_h1;
uniform highp sampler2D u_h2;
// Height grids: (minX, minY, cell, n); n = 0 when the level isn't loaded.
uniform vec4 u_lv0;
uniform vec4 u_lv1;
uniform vec4 u_lv2;
// Level being computed: (minX, minY, cell, index).
uniform vec4 u_target;
// Unit vector toward the sun, local frame.
uniform vec3 u_sun;
// (1 / earth radius, far ground height, max height, encoding base height)
uniform vec4 u_params;

bool pe_inside(vec4 lv, vec2 p) {
  if (lv.w < 0.5) return false;
  vec2 u = (p - lv.xy) / lv.z;
  return all(greaterThan(u, vec2(1.0))) && all(lessThan(u, vec2(lv.w - 1.0)));
}

float pe_fetch(highp sampler2D t, vec4 lv, vec2 p) {
  vec2 u = (p - lv.xy) / lv.z;
#ifdef PE_FLOAT_LINEAR
  return texture(t, u / lv.w).r;
#else
  vec2 g = u - 0.5;
  vec2 i0 = floor(g);
  vec2 w = g - i0;
  ivec2 a = ivec2(i0);
  float h00 = texelFetch(t, a, 0).r;
  float h10 = texelFetch(t, a + ivec2(1, 0), 0).r;
  float h01 = texelFetch(t, a + ivec2(0, 1), 0).r;
  float h11 = texelFetch(t, a + ivec2(1, 1), 0).r;
  return mix(mix(h00, h10, w.x), mix(h01, h11, w.x), w.y);
#endif
}

float pe_ownHeight(ivec2 ij) {
  if (u_target.w < 0.5) return texelFetch(u_h0, ij, 0).r;
  if (u_target.w < 1.5) return texelFetch(u_h1, ij, 0).r;
  return texelFetch(u_h2, ij, 0).r;
}

void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  vec2 P = u_target.xy + (vec2(ij) + 0.5) * u_target.z;
  float h0 = pe_ownHeight(ij);
  float best = -1.0e30;
  float bestD = 0.0;
  float horizontal = length(u_sun.xy);
  if (horizontal > 1.0e-5) {
    vec2 dir = u_sun.xy / horizontal;
    float tanAlt = u_sun.z / horizontal;
    float invR = u_params.x;
    float tanP = tanAlt + dot(P, dir) * invR;
    float c2 = (1.0 - ${f(REFRACTION_K)}) * 0.5 * invR;
    float dStar = tanP < 0.0 ? -tanP / (2.0 * c2) : 0.0;
    float threshold = h0 - ${f(CARE_BELOW)};
    float dLast = 0.0;
    float d = 0.5 * u_target.z;
    for (int i = 0; i < ${MAX_STEPS}; i++) {
      vec2 Q = P + dir * d;
      float h;
      float cell;
      if (pe_inside(u_lv0, Q)) { h = pe_fetch(u_h0, u_lv0, Q); cell = u_lv0.z; }
      else if (pe_inside(u_lv1, Q)) { h = pe_fetch(u_h1, u_lv1, Q); cell = u_lv1.z; }
      else if (pe_inside(u_lv2, Q)) { h = pe_fetch(u_h2, u_lv2, Q); cell = u_lv2.z; }
      else break;
      float v = h - d * tanP - d * d * c2;
      if (v > best) { best = v; bestD = d; }
      dLast = d;
      float bound = u_params.z - d * tanP - d * d * c2;
      if (d > dStar && bound < max(best, threshold)) break;
      d += max(cell, d * ${f(STEP_GROWTH)});
    }
    if (dLast > 0.0) {
      float dc = max(dStar, dLast);
      float far = u_params.y - dc * tanP - dc * dc * c2;
      if (far > best) { best = far; bestD = dc; }
    }
  }
  float t = clamp(floor((best - u_params.w) / ${f(TOP_STEP)} + 0.5), 0.0, 65535.0);
  float dd = clamp(floor(bestD / ${f(DIST_STEP)} + 0.5), 0.0, 65535.0);
  float th = floor(t / 256.0);
  float dh = floor(dd / 256.0);
  out_FragColor = vec4(th, t - th * 256.0, dh, dd - dh * 256.0) / 255.0;
}
`

/**
 * Receiver side, shared by the 3D Tiles custom shader and the globe material. Expects these
 * uniforms to be declared by the host (both Cesium shader systems declare them from their
 * uniform lists): u_peMask0..2 (sampler2D), u_peRect0..2 (vec4: minX, minY, cell, n),
 * u_peEyeToLocal (mat4), u_peParams (vec4: base height, enabled, sun up, 1 / radius),
 * u_peExaggeration (vec2: factor, relative height).
 */
export const RECEIVER_GLSL = /* glsl */ `
vec2 pe_decodeShadow(sampler2D t, ivec2 p) {
  vec4 c = floor(texelFetch(t, p, 0) * 255.0 + 0.5);
  return vec2(u_peParams.x + (c.r * 256.0 + c.g) * ${f(TOP_STEP)}, (c.b * 256.0 + c.a) * ${f(DIST_STEP)});
}

// Visibility from one level; edge = distance to its border in texels (< 0: outside).
float pe_levelVisibility(sampler2D t, vec4 r, vec2 xy, float h, out float edge) {
  vec2 g = (xy - r.xy) / r.z - 0.5;
  edge = min(min(g.x, g.y), min(r.w - 1.0 - g.x, r.w - 1.0 - g.y));
  if (r.w < 0.5 || edge < 0.0) {
    edge = -1.0;
    return 1.0;
  }
  vec2 i0 = floor(g);
  vec2 w = g - i0;
  ivec2 a = ivec2(i0);
  ivec2 hi = ivec2(int(r.w) - 1);
  vec2 s00 = pe_decodeShadow(t, a);
  vec2 s10 = pe_decodeShadow(t, min(a + ivec2(1, 0), hi));
  vec2 s01 = pe_decodeShadow(t, min(a + ivec2(0, 1), hi));
  vec2 s11 = pe_decodeShadow(t, min(a + ivec2(1, 1), hi));
  vec2 s = mix(mix(s00, s10, w.x), mix(s01, s11, w.x), w.y);
  float penumbra = max(${f(PENUMBRA_MIN)} + ${f(PENUMBRA_MIN_PER_CELL)} * r.z, s.y * ${f(SUN_ANGULAR_RADIUS)});
  float bias = ${f(RECEIVER_BIAS)} + ${f(RECEIVER_BIAS_PER_CELL)} * r.z;
  return smoothstep(s.x - penumbra, s.x + penumbra, h + bias);
}

// 1 = in sunlight, 0 = in terrain shadow (soft in between).
float pe_terrainVisibility(vec3 positionEC) {
  if (u_peParams.y < 0.5) return 1.0;
  if (u_peParams.z < 0.5) return 0.0;
  vec3 local = (u_peEyeToLocal * vec4(positionEC, 1.0)).xyz;
  float invR = u_peParams.w;
  // Tangent plane → height above the ellipsoid, and back to the nadir point the grids use.
  float hRender = local.z + 0.5 * dot(local.xy, local.xy) * invR;
  vec2 xy = local.xy / (1.0 + hRender * invR);
  float h = (hRender - u_peExaggeration.y) / max(u_peExaggeration.x, 0.001) + u_peExaggeration.y;
  float e0;
  float v0 = pe_levelVisibility(u_peMask0, u_peRect0, xy, h, e0);
  float w0 = clamp(e0 / ${f(LEVEL_BLEND_TEXELS)}, 0.0, 1.0);
  if (w0 >= 1.0) return v0;
  float e1;
  float v1 = pe_levelVisibility(u_peMask1, u_peRect1, xy, h, e1);
  float w1 = clamp(e1 / ${f(LEVEL_BLEND_TEXELS)}, 0.0, 1.0);
  float rest = v1;
  if (w1 < 1.0) {
    float e2;
    float v2 = pe_levelVisibility(u_peMask2, u_peRect2, xy, h, e2);
    float w2 = clamp(e2 / ${f(LEVEL_BLEND_TEXELS)}, 0.0, 1.0);
    rest = mix(mix(1.0, v2, w2), v1, w1);
  }
  return mix(rest, v0, w0);
}
`
