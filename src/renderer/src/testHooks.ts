// Only bundled into end-to-end test builds (VITE_PHOTOEARTH_TEST=1). Exposes the few Cesium
// classes the tests need; importing the whole namespace would defeat tree-shaking and pull in
// code that evaluates strings, which the CSP (correctly) blocks.
import {
  Cartesian2,
  Cartesian3,
  GeometryInstance,
  MaterialAppearance,
  Model,
  Primitive,
  Rectangle,
  RectangleGeometry,
  ShadowMode,
  Transforms
} from 'cesium'
import * as terrainShadow from './lib/terrainShadow'

export const testCesium = {
  Cartesian2,
  Cartesian3,
  GeometryInstance,
  MaterialAppearance,
  Model,
  Primitive,
  Rectangle,
  RectangleGeometry,
  ShadowMode,
  Transforms,
  /** Pure terrain-shadow geometry, for comparing the GPU pass with its CPU reference. */
  terrainShadow
}
