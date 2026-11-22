import { DIST_STEP, REFRACTION_K, TOP_STEP } from '../../lib/terrainShadow'
import {
  VIEWSHED_BLEND_TEXELS,
  VIEWSHED_HEIGHT_CAP,
  VIEWSHED_MAX_STEPS,
  VIEWSHED_RECEIVER_BIAS,
  VIEWSHED_RECEIVER_BIAS_PER_CELL,
  VIEWSHED_SOFT_MIN,
  VIEWSHED_SOFT_PER_CELL,
  VIEWSHED_STEP_CELL,
  VIEWSHED_STEP_GROWTH
} from '../../lib/viewshed'

const f = (v: number): string => (Number.isInteger(v) ? `${v}.0` : String(v))

/**
 * Computes the viewshed visibility top `zMin` of every cell of one level (`u_target`),
 * marching from the target at (0, 0) outward through the nested height grids.
 * Mirrors `viewshedTop()` in lib/viewshed.ts exactly.
 * Output: RGBA8 = (zMin hi, zMin lo, occluderDist hi, occluderDist lo).
 */
export const VIEWSHED_COMPUTE_FS = /* glsl */ `
uniform highp sampler2D u_h0;
uniform highp sampler2D u_h1;
uniform highp sampler2D u_h2;
// Height grids: (minX, minY, cell, n); n = 0 when the level isn't loaded.
uniform vec4 u_lv0;
uniform vec4 u_lv1;
uniform vec4 u_lv2;
// Level being computed: (minX, minY, cell, index).
uniform vec4 u_target;
// (0, 0, targetEllipsoidalHeight, maxRadius)
uniform vec4 u_observer;
// (1 / earthRadius, maxHeight, encodingBase, nearLimit)
uniform vec4 u_params;

bool pe_vs_inside(vec4 lv, vec2 p) {
  if (lv.w < 0.5) return false;
  vec2 u = (p - lv.xy) / lv.z;
  return all(greaterThan(u, vec2(1.0))) && all(lessThan(u, vec2(lv.w - 1.0)));
}

float pe_vs_fetch(highp sampler2D t, vec4 lv, vec2 p) {
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

void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  vec2 P = u_target.xy + (vec2(ij) + 0.5) * u_target.z;
  float dist = length(P);
  float zT = u_observer.z;
  float radius = u_observer.w;
  float invR = u_params.x;
  float maxH = u_params.y;
  float base = u_params.z;
  float nearLimit = u_params.w;

  float zMin = -1.0e30;
  float bestOccD = 0.0;

  if (dist > nearLimit && dist <= radius + 2.0 * u_target.z) {
    vec2 dir = P / dist;
    float c = (1.0 - ${f(REFRACTION_K)}) * 0.5 * invR;
    float sEnd = dist - 0.5 * u_target.z;
    float sStar = maxH < zT ? sqrt((zT - maxH) / c) : 0.0;
    float maxCap = maxH + ${f(VIEWSHED_HEIGHT_CAP)};
    float bestSlope = -1.0e30;
    float bestS = 0.0;
    float s = nearLimit;
    for (int i = 0; i < ${VIEWSHED_MAX_STEPS}; i++) {
      if (s >= sEnd) break;
      vec2 Q = dir * s;
      float h;
      float cell;
      if (pe_vs_inside(u_lv0, Q)) { h = pe_vs_fetch(u_h0, u_lv0, Q); cell = u_lv0.z; }
      else if (pe_vs_inside(u_lv1, Q)) { h = pe_vs_fetch(u_h1, u_lv1, Q); cell = u_lv1.z; }
      else if (pe_vs_inside(u_lv2, Q)) { h = pe_vs_fetch(u_h2, u_lv2, Q); cell = u_lv2.z; }
      else break;
      float slope = (h - zT) / s - s * c;
      if (slope > bestSlope) {
        bestSlope = slope;
        bestS = s;
      }
      if (s > sStar && (maxH - zT) / s - s * c < bestSlope) break;
      if (zT + dist * bestSlope + dist * dist * c > maxCap) break;
      s += max(cell * ${f(VIEWSHED_STEP_CELL)}, s * ${f(VIEWSHED_STEP_GROWTH)});
    }
    if (bestSlope > -1.0e29) {
      zMin = min(maxCap, zT + dist * bestSlope + dist * dist * c);
      bestOccD = max(0.0, dist - bestS);
    }
  }
  float t = clamp(floor((zMin - base) / ${f(TOP_STEP)} + 0.5), 0.0, 65535.0);
  float dd = clamp(floor(bestOccD / ${f(DIST_STEP)} + 0.5), 0.0, 65535.0);
  float th = floor(t / 256.0);
  float dh = floor(dd / 256.0);
  out_FragColor = vec4(th, t - th * 256.0, dh, dd - dh * 256.0) / 255.0;
}
`

/**
 * Receiver side, shared by the 3D Tiles custom shader and the stand-in globe's material.
 * Expects these uniforms declared by the host:
 *   u_vsMask0..2 (sampler2D), u_vsRect0..2 (vec4: minX, minY, cell, n),
 *   u_vsEyeToLocal (mat4), u_vsParams (vec4: base height, enabled, viewerOffset, 1 / radius),
 *   u_vsStyle (vec4: analysis radius, opacity, ringStep, colorMode),
 *   u_vsExaggeration (vec2: factor, relative height).
 */
export const VIEWSHED_RECEIVER_GLSL = /* glsl */ `
vec2 pe_vs_decode(sampler2D t, ivec2 p) {
  vec4 c = floor(texelFetch(t, p, 0) * 255.0 + 0.5);
  return vec2(u_vsParams.x + (c.r * 256.0 + c.g) * ${f(TOP_STEP)}, (c.b * 256.0 + c.a) * ${f(DIST_STEP)});
}

// Visibility (0..1) from one level; edge = distance to border in texels (< 0: outside).
float pe_vs_levelVisibility(sampler2D t, vec4 r, vec2 xy, float hViewer, out float edge) {
  vec2 g = (xy - r.xy) / r.z - 0.5;
  edge = min(min(g.x, g.y), min(r.w - 1.0 - g.x, r.w - 1.0 - g.y));
  if (r.w < 0.5 || edge < 0.0) {
    edge = -1.0;
    return 0.0;
  }
  vec2 i0 = floor(g);
  vec2 w = g - i0;
  ivec2 a = ivec2(i0);
  ivec2 hi = ivec2(int(r.w) - 1);
  float soft = ${f(VIEWSHED_SOFT_MIN)} + ${f(VIEWSHED_SOFT_PER_CELL)} * r.z;
  float h = hViewer + ${f(VIEWSHED_RECEIVER_BIAS)} + ${f(VIEWSHED_RECEIVER_BIAS_PER_CELL)} * r.z;
  vec2 s00 = pe_vs_decode(t, a);
  vec2 s10 = pe_vs_decode(t, min(a + ivec2(1, 0), hi));
  vec2 s01 = pe_vs_decode(t, min(a + ivec2(0, 1), hi));
  vec2 s11 = pe_vs_decode(t, min(a + ivec2(1, 1), hi));
  float v00 = smoothstep(s00.x - soft, s00.x + soft, h);
  float v10 = smoothstep(s10.x - soft, s10.x + soft, h);
  float v01 = smoothstep(s01.x - soft, s01.x + soft, h);
  float v11 = smoothstep(s11.x - soft, s11.x + soft, h);
  return mix(mix(v00, v10, w.x), mix(v01, v11, w.x), w.y);
}

float pe_vs_visibility(vec2 xy, float hViewer) {
  float e0;
  float v0 = pe_vs_levelVisibility(u_vsMask0, u_vsRect0, xy, hViewer, e0);
  float w0 = clamp(e0 / ${f(VIEWSHED_BLEND_TEXELS)}, 0.0, 1.0);
  if (w0 >= 1.0) return v0;
  float e1;
  float v1 = pe_vs_levelVisibility(u_vsMask1, u_vsRect1, xy, hViewer, e1);
  float w1 = clamp(e1 / ${f(VIEWSHED_BLEND_TEXELS)}, 0.0, 1.0);
  float rest = v1;
  if (w1 < 1.0) {
    float e2;
    float v2 = pe_vs_levelVisibility(u_vsMask2, u_vsRect2, xy, hViewer, e2);
    float w2 = clamp(e2 / ${f(VIEWSHED_BLEND_TEXELS)}, 0.0, 1.0);
    rest = mix(mix(0.0, v2, w2), v1, w1);
  }
  return mix(rest, v0, w0);
}

// Distance-graded tint (cyan-emerald near -> spring green mid -> amber-gold far) or uniform emerald.
vec3 pe_vs_color(float frac, float mode) {
  if (mode < 0.5) return vec3(0.18, 0.86, 0.54);
  vec3 cNear = vec3(0.10, 0.88, 0.72);
  vec3 cMid = vec3(0.38, 0.88, 0.36);
  vec3 cFar = vec3(0.96, 0.72, 0.24);
  return frac < 0.45 ? mix(cNear, cMid, frac / 0.45) : mix(cMid, cFar, (frac - 0.45) / 0.55);
}

// Returns straight-alpha (rgb, a) overlay color for a fragment at positionEC.
vec4 pe_viewshedOverlay(vec3 positionEC) {
  if (u_vsParams.y < 0.5) return vec4(0.0);
  vec3 local = (u_vsEyeToLocal * vec4(positionEC, 1.0)).xyz;
  float invR = u_vsParams.w;
  float hRender = local.z + 0.5 * dot(local.xy, local.xy) * invR;
  vec2 xy = local.xy / (1.0 + hRender * invR);
  float dist = length(xy);
  // Compute screen-space derivative in uniform control flow to avoid quad artifacts.
  float fwDist = max(fwidth(dist), 1.0e-4);
  float radius = u_vsStyle.x;
  float px = czm_pixelRatio;
  if (dist > radius + fwDist * 3.0 * px) return vec4(0.0);

  float h = (hRender - u_vsExaggeration.y) / max(u_vsExaggeration.x, 0.001) + u_vsExaggeration.y;
  float vis = dist <= radius ? pe_vs_visibility(xy, h + u_vsParams.z) : 0.0;
  float inside = 1.0 - smoothstep(radius - fwDist * px, radius + fwDist * px, dist);
  vis *= inside;

  vec3 color = vec3(0.0);
  float alpha = 0.0;
  if (vis > 0.001 && u_vsStyle.y > 0.0) {
    color = pe_vs_color(clamp(dist / max(radius, 1.0), 0.0, 1.0), u_vsStyle.w);
    alpha = vis * u_vsStyle.y;
  }

  // Crisp outer analysis-radius boundary ring.
  float borderDist = abs(dist - radius) / fwDist;
  float borderHalf = 0.85 * px;
  float borderLine = 1.0 - smoothstep(borderHalf - 0.6, borderHalf + 0.6, borderDist);
  if (borderLine > 0.001) {
    float ba = borderLine * 0.62;
    float outA = ba + alpha * (1.0 - ba);
    color = (vec3(0.76, 0.96, 0.92) * ba + color * alpha * (1.0 - ba)) / max(outA, 1.0e-5);
    alpha = outA;
  }

  // Optional concentric interior distance rings.
  float ringStep = u_vsStyle.z;
  if (ringStep > 0.5 && dist > ringStep * 0.5 && dist < radius - fwDist * 2.0 * px) {
    float rv = dist / ringStep;
    float rfw = max(fwDist / ringStep, 1.0e-6);
    float rdist = abs(fract(rv + 0.5) - 0.5) / rfw;
    float rhalf = 0.6 * px;
    float rline = (1.0 - smoothstep(rhalf - 0.6, rhalf + 0.6, rdist)) * (1.0 - smoothstep(0.12, 0.35, rfw));
    if (rline > 0.001) {
      float ra = rline * mix(0.20, 0.44, vis);
      float outA = ra + alpha * (1.0 - ra);
      color = (vec3(0.94, 0.98, 1.0) * ra + color * alpha * (1.0 - ra)) / max(outA, 1.0e-5);
      alpha = outA;
    }
  }

  return vec4(color, alpha);
}
`
