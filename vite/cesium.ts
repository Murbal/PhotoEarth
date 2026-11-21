/**
 * Build-time changes to CesiumJS for frame rate. Cesium is bundled from its ES module sources,
 * which (unlike Cesium's own release build) still contain the debug-only argument checks, and
 * a few of its hot paths stall the GPU or do redundant work for how PhotoEarth uses it.
 *
 * Each patch names the exact source it replaces; the build fails if Cesium changes underneath
 * it, rather than silently shipping without it.
 */

/** `//>>includeStart('debug', pragmas.debug)` … `//>>includeEnd('debug')`, as Cesium's build strips them. */
const DEBUG_BLOCK = /\/\/>>includeStart\('debug', pragmas\.debug\);?[\s\S]*?\/\/>>includeEnd\('debug'\);?/g

const CESIUM_SOURCE = /\/node_modules\/@cesium\/(core|engine|widgets)\/Source\//

export interface Patch {
  /** Path suffix of the Cesium source file. */
  file: string
  find: string
  replace: string
}

export const CESIUM_PATCHES: readonly Patch[] = [
  // CPU picking (camera collision, surface height, ray casts) on WebGL 2 reads the vertex and
  // index buffers back from the GPU on every pick, which stalls until the GPU has finished all
  // queued work: a full pipeline flush per pick, every frame the camera moves. With
  // `enablePick`, keep the CPU copies on WebGL 2 too (Cesium only does so on WebGL 1).
  {
    file: '/Scene/GltfLoader.js',
    find: 'isPositionAttribute && loader._enablePick && !frameState.context.webgl2;',
    replace: 'isPositionAttribute && loader._enablePick;'
  },
  {
    file: '/Scene/GltfLoader.js',
    find: '(loader._loadIndicesForWireframe || loader._enablePick) &&\n    !frameState.context.webgl2;',
    replace: 'loader._enablePick ||\n    (loader._loadIndicesForWireframe && !frameState.context.webgl2);'
  },
  // Ray–mesh picking transformed all three vertices of every triangle into world space. Move
  // the ray into the instance's model space once instead (same parametric distance: the map is
  // affine), and test the stored vertices directly.
  {
    file: '/Scene/Model/pickModel.js',
    find: `      const indicesLength = indices.length;
      for (let i = 0; i < indicesLength; i += 3) {`,
    replace: `      const indicesLength = indices.length;
      if (verticalExaggeration === 1.0) {
        for (const instance of instances) {
          const m = instance.transform;
          const inverse = Matrix4.inverse(m, scratchPickInverse);
          Matrix4.multiplyByPoint(inverse, ray.origin, scratchLocalRay.origin);
          Matrix4.multiplyByPointAsVector(inverse, ray.direction, scratchLocalRay.direction);
          // A mirroring transform flips the winding that back-face culling relies on.
          const det =
            m[0] * (m[5] * m[10] - m[6] * m[9]) -
            m[4] * (m[1] * m[10] - m[2] * m[9]) +
            m[8] * (m[1] * m[6] - m[2] * m[5]);
          const a = det < 0 ? scratchV2 : scratchV1;
          const b = det < 0 ? scratchV1 : scratchV2;
          const cull = model.backFaceCulling ?? true;
          for (let i = 0; i < indicesLength; i += 3) {
            readPosition(vertices, indices[i], numPosComponents, scratchV0);
            readPosition(vertices, indices[i + 1], numPosComponents, a);
            readPosition(vertices, indices[i + 2], numPosComponents, b);
            const t = IntersectionTests.rayTriangleParametric(scratchLocalRay, scratchV0, scratchV1, scratchV2, cull);
            if (defined(t) && t < minT && t >= 0.0) {
              minT = t;
            }
          }
        }
        return;
      }
      for (let i = 0; i < indicesLength; i += 3) {`
  },
  {
    file: '/Scene/Model/pickModel.js',
    find: 'const scratchBoundingSphere = new BoundingSphere();',
    replace: 'const scratchBoundingSphere = new BoundingSphere();\nconst scratchPickInverse = new Matrix4();\nconst scratchLocalRay = new Ray();'
  },
  // In-flight tile requests are cancelled as soon as one frame passes without a traversal
  // touching the tile. PhotoEarth runs the predicted-pose preload pass only every few frames
  // (a full extra traversal each time), so give requests a few frames' grace.
  {
    file: '/Scene/Cesium3DTileset.js',
    find: 'const outOfView = frameState.frameNumber - tile._touchedFrame >= 1;',
    replace: 'const outOfView = frameState.frameNumber - tile._touchedFrame >= 8;'
  },
  // Every pass of every frame snapshotted the tileset statistics, including a copy of the
  // per-texture reference counts (thousands of entries with Google's tiles). The snapshots are
  // only read for debug display; the counts are only changed on the tileset's own statistics.
  {
    file: '/Scene/Cesium3DTilesetStatistics.js',
    find: `  result.texturesReferenceCounterById = {
    ...statistics.texturesReferenceCounterById,
  };`,
    replace: '  result.texturesReferenceCounterById = statistics.texturesReferenceCounterById;'
  },
  // Shadow casters: with a low sun every cascade's light volume reaches far toward the sun,
  // so every visible tile (hundreds, many kilometres away) was drawn into all four cascades.
  // With `shadowMap.casterMargin` set (meters), a command casts into a cascade only when it
  // is within reach of that cascade's receivers: its far distance (×1.4 for the frustum
  // corners) plus the margin, i.e. the longest shadow worth drawing. PhotoEarth sets it only
  // when heightmap terrain shadows cover the distance, so nothing visible is lost.
  {
    file: '/Scene/Scene.js',
    find: `  const { shadowMapCullingVolume, isPointLight, passes } = shadowMap;
  const numberOfPasses = passes.length;
`,
    replace: `  const { shadowMapCullingVolume, isPointLight, passes } = shadowMap;
  const numberOfPasses = passes.length;
  const casterMargin = shadowMap.casterMargin;
  const cullCasters = !isPointLight && typeof casterMargin === "number";
  const casterFrom = scene.camera.positionWC;
  const cascadeFar = shadowMap._cascadeSplits[1];
  const casterReach = [cascadeFar.x, cascadeFar.y, cascadeFar.z, cascadeFar.w].map(
    (far) => far * 1.4 + casterMargin,
  );
  const casterReachAll =
    numberOfPasses === 1
      ? shadowMap.maximumDistance * 1.4 + casterMargin
      : casterReach[numberOfPasses - 1];
`
  },
  {
    file: '/Scene/Scene.js',
    find: `      !scene.isVisible(shadowMapCullingVolume, command)
    ) {
      continue;
    }
`,
    replace: `      !scene.isVisible(shadowMapCullingVolume, command)
    ) {
      continue;
    }

    let casterDistance = 0;
    if (cullCasters && defined(command.boundingVolume)) {
      const bv = command.boundingVolume;
      casterDistance = Cartesian3.distance(casterFrom, bv.center) - bv.radius;
      if (casterDistance > casterReachAll) {
        continue;
      }
    }
`
  },
  {
    file: '/Scene/Scene.js',
    find: `      for (let j = numberOfPasses - 1; j >= 0; --j) {
        const cascadeVolume = passes[j].cullingVolume;`,
    replace: `      for (let j = numberOfPasses - 1; j >= 0; --j) {
        if (cullCasters && casterDistance > casterReach[j]) {
          // Smaller cascades reach even less far.
          break;
        }
        const cascadeVolume = passes[j].cullingVolume;`
  },
  // Every visited tile recomputed parent × own transform every frame; Google's tiles carry no
  // transform of their own, so the product is the parent's.
  {
    file: '/Scene/Cesium3DTile.js',
    find: `  const computedTransform = Matrix4.multiplyTransformation(
    parentTransform,
    this.transform,
    scratchTransform,
  );`,
    replace: `  const computedTransform = Matrix4.equals(this.transform, Matrix4.IDENTITY)
    ? parentTransform
    : Matrix4.multiplyTransformation(
        parentTransform,
        this.transform,
        scratchTransform,
      );`
  },
  // Tile content (glTF parsing, model set-up) was created on the main thread the moment each
  // response arrived, so a burst of arrivals landed in one gap between frames. With
  // `tileset.contentGate` (a function returning a promise), creation waits for its turn;
  // PhotoEarth hands out one turn per frame while the camera moves.
  {
    file: '/Scene/Cesium3DTile.js',
    find: `  try {
    const content = await makeContent(tile, arrayBuffer);`,
    replace: `  if (typeof tileset.contentGate === "function") {
    await tileset.contentGate();
    if (tile.isDestroyed()) {
      --tileset.statistics.numberOfPendingRequests;
      return;
    }
  }

  try {
    const content = await makeContent(tile, arrayBuffer);`
  },
  // The preload-flight pass traverses every tileset with the full level of detail. With
  // `scene.preloadFlightScreenSpaceErrorFactor`, it uses a coarser one (memory-adjusted error
  // scaled for the pass, restored after): far fewer tiles to visit, and the coarse tiles are
  // what a moving view shows anyway (TilesetManager.setMoving).
  {
    file: '/Scene/Scene.js',
    find: `  preloadFlightTilesetPassState.camera = scene.preloadFlightCamera;
  preloadFlightTilesetPassState.cullingVolume =
    scene.preloadFlightCullingVolume;

  const primitives = scene.primitives;
  primitives.updateForPass(frameState, preloadFlightTilesetPassState);`,
    replace: `  preloadFlightTilesetPassState.camera = scene.preloadFlightCamera;
  preloadFlightTilesetPassState.cullingVolume =
    scene.preloadFlightCullingVolume;

  const primitives = scene.primitives;
  const sseFactor = scene.preloadFlightScreenSpaceErrorFactor ?? 1;
  const scaled = [];
  if (sseFactor !== 1) {
    for (let i = 0; i < primitives.length; ++i) {
      const p = primitives.get(i);
      if (defined(p) && p.isCesium3DTileset) {
        scaled.push(p, p._memoryAdjustedScreenSpaceError);
        p._memoryAdjustedScreenSpaceError *= sseFactor;
      }
    }
  }
  primitives.updateForPass(frameState, preloadFlightTilesetPassState);
  for (let i = 0; i < scaled.length; i += 2) {
    scaled[i]._memoryAdjustedScreenSpaceError = scaled[i + 1];
  }`
  },
  // A shader program whose last user (a tile) unloads was destroyed at the end of the frame,
  // and the next tile needing it compiled it again: a synchronous link of 60–120 ms (ANGLE /
  // D3D11) in the middle of camera motion. Keep released programs compiled (Cesium revives
  // them from this list on reuse) unless the cache grows past a cap.
  {
    file: '/Renderer/ShaderCache.js',
    find: `ShaderCache.prototype.destroyReleasedShaderPrograms = function () {
  const shadersToRelease = this._shadersToRelease;

  for (const keyword in shadersToRelease) {
    if (shadersToRelease.hasOwnProperty(keyword)) {
      const cachedShader = shadersToRelease[keyword];
      destroyShader(this, cachedShader);
      --this._numberOfShaders;
    }
  }

  this._shadersToRelease = {};
};`,
    replace: `ShaderCache.prototype.destroyReleasedShaderPrograms = function () {
  const shadersToRelease = this._shadersToRelease;
  let excess = this._numberOfShaders - 256;
  if (excess <= 0) {
    return;
  }
  // Oldest releases first (keys keep insertion order).
  for (const keyword of Object.keys(shadersToRelease)) {
    if (excess-- <= 0) {
      break;
    }
    destroyShader(this, shadersToRelease[keyword]);
    --this._numberOfShaders;
    delete shadersToRelease[keyword];
  }
};`
  },
  // In request-render mode, every animation tick that doesn't render runs a full tileset
  // traversal to check whether deferred tile requests can go out now. With a 144 Hz display
  // that kept a CPU core busy while idle, and during camera motion it runs on every tick
  // between input events. Check at most four times a second.
  {
    file: '/Scene/Scene.js',
    find: `    if (!shouldRender) {
      tryAndCatchError(this, updateRequestRenderModeDeferCheckPass);
    }`,
    replace: `    if (!shouldRender) {
      const deferCheckNow = performance.now();
      if (!(deferCheckNow - (this._deferCheckAt ?? -Infinity) < 250)) {
        this._deferCheckAt = deferCheckNow;
        tryAndCatchError(this, updateRequestRenderModeDeferCheckPass);
      }
    }`
  }
]

export interface CesiumTransformPlugin {
  name: string
  transform: (code: string, id: string) => { code: string; map: null } | null
}

/**
 * Strips Cesium's debug checks and applies CESIUM_PATCHES. Works as a Vite plugin (production build)
 * and as a Rolldown plugin for the dev server's dependency pre-bundling.
 */
export function cesiumOptimizations(): CesiumTransformPlugin {
  return {
    name: 'photoearth:cesium-optimizations',
    transform(code, id) {
      const path = id.split('?')[0].replace(/\\/g, '/')
      if (!CESIUM_SOURCE.test(path)) return null
      let out = code.replace(DEBUG_BLOCK, '')
      for (const patch of CESIUM_PATCHES) {
        if (!path.endsWith(patch.file)) continue
        if (!out.includes(patch.find)) {
          throw new Error(`photoearth:cesium-optimizations: Cesium changed, patch no longer applies to ${patch.file}:\n${patch.find}`)
        }
        out = out.replace(patch.find, patch.replace)
      }
      return out === code ? null : { code: out, map: null }
    }
  }
}
