// Only bundled into test builds (VITE_PHOTOEARTH_TEST=1), which scripts driving the app (such as
// the camera benchmark) use. Exposes a few Cesium math classes; importing the whole namespace
// would defeat tree-shaking and pull in code that evaluates strings, which the CSP blocks.
import { Cartesian2, Cartesian3, Rectangle, Transforms } from 'cesium'

export const testCesium = { Cartesian2, Cartesian3, Rectangle, Transforms }
