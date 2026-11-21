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
import { moonEarthFixed } from './lib/moon'
import * as terrainShadow from './lib/terrainShadow'
import * as viewshed from './lib/viewshed'

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
  terrainShadow,
  /** Pure viewshed geometry, for comparing the GPU pass with its CPU reference. */
  viewshed,
  /** The moon position the rendered moon should be drawn at. */
  moonEarthFixed
}
