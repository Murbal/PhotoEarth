import { Cartesian3, JulianDate, Matrix3, Simon1994PlanetaryPositions, Transforms } from 'cesium'
import { moonEarthFixed } from '../lib/moon'

type MoonPositionFn = (date?: JulianDate, result?: Cartesian3) => Cartesian3

const positions = Simon1994PlanetaryPositions as unknown as { computeMoonPositionInEarthInertialFrame: MoonPositionFn }

/**
 * Puts Cesium's rendered moon (`scene.moon`) where the readouts say it is.
 *
 * Cesium places it from its own low-precision series in inertial axes: ~0.03° off (measured
 * 2026, a long lens shows it), and until its ICRF data has loaded, or if it can't, it turns
 * those to Earth-fixed with a TEME approximation that ignores precession since J2000 (~0.36°
 * by 2026, most of a lunar diameter). This replaces the series with astronomy-engine's
 * Earth-fixed position, expressed in whichever inertial axes the scene is using at that
 * instant, so Cesium's own rotation lands it exactly. Everything that
 * reads the moon goes through this one function (the moon primitive and the moon-direction
 * uniform), so they stay consistent. Returns a function that restores Cesium's series.
 */
export function driveCesiumMoon(): () => void {
  const original = positions.computeMoonPositionInEarthInertialFrame
  const toFixed = new Matrix3()
  const fixed = new Cartesian3()
  let fixedTime: JulianDate | undefined
  positions.computeMoonPositionInEarthInertialFrame = (date = JulianDate.now(), result = new Cartesian3()) => {
    // The series is the costly part, and Cesium asks twice a frame for the same instant.
    if (!fixedTime || !JulianDate.equals(fixedTime, date)) {
      const [x, y, z] = moonEarthFixed(JulianDate.toDate(date).getTime())
      Cartesian3.fromElements(x, y, z, fixed)
      fixedTime = JulianDate.clone(date, fixedTime)
    }
    // Same choice of axes as Cesium's Moon: ICRF once its data has loaded, else TEME. Not
    // cached, because the ICRF data can arrive between two frames at the same instant.
    // (Transforms carries the same functions as Cesium's internal CelestialFrameTransforms.)
    const icrfToFixed = Transforms.computeIcrfToFixedMatrix(date, toFixed) ?? Transforms.computeTemeToPseudoFixedMatrix(date, toFixed)
    return Matrix3.multiplyByVector(Matrix3.transpose(icrfToFixed, toFixed), fixed, result)
  }
  return () => {
    positions.computeMoonPositionInEarthInertialFrame = original
  }
}
