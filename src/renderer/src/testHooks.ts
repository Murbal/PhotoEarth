// Only bundled into end-to-end test builds (VITE_PHOTOEARTH_TEST=1). Exposes the few Cesium
// classes the tests need; importing the whole namespace would defeat tree-shaking and pull in
// code that evaluates strings, which the CSP (correctly) blocks.
import { GeometryInstance, MaterialAppearance, Primitive, Rectangle, RectangleGeometry } from 'cesium'

export const testCesium = { GeometryInstance, MaterialAppearance, Primitive, Rectangle, RectangleGeometry }
