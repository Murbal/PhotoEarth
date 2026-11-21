import { describe, expect, it } from 'vitest'
import { defaultViewfinder, sanitizeViewfinder } from '@shared/settings'
import type { ViewfinderSettings } from '@shared/types'
import {
  cesiumFov,
  cropFactor,
  fitFrame,
  FOCAL_MAX,
  FOCAL_MIN,
  focalToSlider,
  frameOnSensor,
  guideLines,
  lensView,
  nudgeFocal,
  SENSORS,
  sliderToFocal,
  stepFocal
} from '../../src/renderer/src/lib/lens'

const DEG = 180 / Math.PI
const vf = (patch: Partial<ViewfinderSettings>): ViewfinderSettings => ({ ...defaultViewfinder(), ...patch })

/** Reproduces Cesium's PerspectiveFrustum: `fov` spans the larger side; returns full angles in degrees. */
function cesiumAngles(fov: number, width: number, height: number): { h: number; v: number } {
  const aspect = width / height
  const fovy = aspect <= 1 ? fov : 2 * Math.atan(Math.tan(fov / 2) / aspect)
  const fovx = 2 * Math.atan(Math.tan(fovy / 2) * aspect)
  return { h: fovx * DEG, v: fovy * DEG }
}

/** Angle subtended by a centered span of `size` px in a view whose full angle across `view` px is `full` (deg). */
function spanAngle(fullDeg: number, view: number, size: number): number {
  return 2 * Math.atan((Math.tan(fullDeg / DEG / 2) * size) / view) * DEG
}

describe('angle of view', () => {
  it('50 mm on full frame is 39.6° × 27.0°, 46.8° diagonal', () => {
    const l = lensView(vf({ focalLength: 50 }))
    expect(l.horizontal).toBeCloseTo(39.6, 1)
    expect(l.vertical).toBeCloseTo(27.0, 1)
    expect(l.diagonal).toBeCloseTo(46.8, 1)
    expect(l.crop).toBeCloseTo(1, 6)
    expect(l.equivalent).toBeCloseTo(50, 6)
  })

  it('600 mm on full frame is a ~3.4° × 2.3° view', () => {
    const l = lensView(vf({ focalLength: 600 }))
    expect(l.horizontal).toBeCloseTo(3.44, 2)
    expect(l.vertical).toBeCloseTo(2.29, 2)
    expect(l.diagonal).toBeCloseTo(4.13, 2)
  })

  it('crop sensors: crop factor and 35 mm equivalent', () => {
    const apsc = lensView(vf({ sensor: 'apsc', focalLength: 35 }))
    expect(apsc.crop).toBeCloseTo(1.53, 2)
    expect(apsc.equivalent).toBeCloseTo(53.7, 1)
    expect(lensView(vf({ sensor: 'apsc-canon' })).crop).toBeCloseTo(1.61, 2)
    expect(lensView(vf({ sensor: 'm43' })).crop).toBeCloseTo(2.0, 1)
    expect(lensView(vf({ sensor: '1in' })).crop).toBeCloseTo(2.73, 2)
    expect(lensView(vf({ sensor: 'mf44' })).crop).toBeCloseTo(0.79, 2)
    // A crop sensor at its equivalent focal length matches full frame across the diagonal.
    const m43 = lensView(vf({ sensor: 'm43', focalLength: 25 }))
    const ff = lensView(vf({ focalLength: m43.equivalent }))
    expect(m43.diagonal).toBeCloseTo(ff.diagonal, 6)
  })

  it('phone focal lengths are 35 mm equivalents', () => {
    const phone = lensView(vf({ sensor: 'phone', focalLength: 24 }))
    expect(phone.equivalent).toBe(24)
    expect(phone.focal).toBeCloseTo(24 / phone.crop, 6)
    expect(phone.focal).toBeGreaterThan(6)
    expect(phone.focal).toBeLessThan(7.5)
    // Same diagonal angle as 24 mm on full frame: 84.1°.
    expect(phone.diagonal).toBeCloseTo(lensView(vf({ focalLength: 24 })).diagonal, 6)
    expect(phone.ratio).toBeCloseTo(4 / 3, 6)
  })

  it('custom sensors use their own dimensions', () => {
    const l = lensView(vf({ sensor: 'custom', customSensor: { width: 72, height: 48 }, focalLength: 100 }))
    expect(l.crop).toBeCloseTo(0.5, 6)
    expect(l.horizontal).toBeCloseTo(2 * Math.atan(36 / 100) * DEG, 6)
  })

  it('every preset sensor has a sane size', () => {
    for (const s of SENSORS) {
      expect(s.width).toBeGreaterThan(s.height)
      expect(cropFactor(s)).toBeGreaterThan(0.5)
    }
  })
})

describe('frame on the sensor', () => {
  const ff = { width: 36, height: 24 }
  it('crops the largest rectangle of the ratio', () => {
    expect(frameOnSensor(ff, 'native', false)).toEqual({ width: 36, height: 24 })
    expect(frameOnSensor(ff, '1:1', false)).toEqual({ width: 24, height: 24 })
    expect(frameOnSensor(ff, '16:9', false)).toEqual({ width: 36, height: 20.25 })
    const pano = frameOnSensor(ff, '65:24', false)
    expect(pano.width).toBe(36)
    expect(pano.height).toBeCloseTo(13.29, 2)
    const fourFive = frameOnSensor(ff, '4:5', false)
    expect(fourFive.height).toBe(24)
    expect(fourFive.width).toBeCloseTo(19.2, 6)
  })

  it('portrait turns the camera', () => {
    expect(frameOnSensor(ff, '3:2', true)).toEqual({ width: 24, height: 36 })
    const l = lensView(vf({ portrait: true }))
    expect(l.horizontal).toBeCloseTo(27.0, 1)
    expect(l.vertical).toBeCloseTo(39.6, 1)
  })

  it('a 16:9 crop keeps the full width (same horizontal angle)', () => {
    const native = lensView(vf({ focalLength: 35 }))
    const wide = lensView(vf({ focalLength: 35, aspect: '16:9' }))
    expect(wide.horizontal).toBeCloseTo(native.horizontal, 9)
    expect(wide.vertical).toBeLessThan(native.vertical)
  })
})

describe('frame on screen', () => {
  it('fills the width of a tall window', () => {
    const f = fitFrame(800, 1200, 1.5)
    expect(f).toEqual({ x: 0, y: (1200 - 800 / 1.5) / 2, width: 800, height: 800 / 1.5 })
  })

  it('fills the height of a wide window', () => {
    const f = fitFrame(2000, 800, 1.5)
    expect(f).toEqual({ x: (2000 - 1200) / 2, y: 0, width: 1200, height: 800 })
  })

  it('stays centered inside an inset', () => {
    const f = fitFrame(1600, 1000, 3 / 2, { x: 12, y: 36 })
    expect(f.height).toBe(1000 - 72)
    expect(f.width).toBeCloseTo((1000 - 72) * 1.5, 9)
    expect(f.x + f.width / 2).toBeCloseTo(800, 9)
    expect(f.y + f.height / 2).toBeCloseTo(500, 9)
  })
})

describe('Cesium field of view', () => {
  const cases: Array<[string, number, number, Partial<ViewfinderSettings>]> = [
    ['wide window, 50 mm 3:2', 1920, 1080, { focalLength: 50 }],
    ['wide window, 600 mm 65:24', 1920, 1080, { focalLength: 600, aspect: '65:24' }],
    ['tall window, 24 mm portrait', 700, 1200, { focalLength: 24, portrait: true }],
    ['tall window, 200 mm landscape 16:9', 700, 1200, { focalLength: 200, aspect: '16:9' }],
    ['square window, 85 mm 1:1', 1000, 1000, { focalLength: 85, aspect: '1:1' }],
    ['ultra-wide window, 14 mm MFT', 3440, 1000, { focalLength: 14, sensor: 'm43' }]
  ]
  for (const [name, w, h, patch] of cases) {
    it(`the frame shows exactly the angle of view: ${name}`, () => {
      const lens = lensView(vf(patch))
      const frame = fitFrame(w, h, lens.ratio, { x: 12, y: 36 })
      const fov = cesiumFov(w, h, frame, lens.horizontal, lens.vertical)
      const full = cesiumAngles(fov, w, h)
      expect(spanAngle(full.h, w, frame.width)).toBeCloseTo(lens.horizontal, 6)
      expect(spanAngle(full.v, h, frame.height)).toBeCloseTo(lens.vertical, 6)
    })
  }

  it('when the frame fills the long side, fov is the lens angle itself', () => {
    const lens = lensView(vf({ focalLength: 50 }))
    // 3:2 window, 3:2 frame: the frame is the whole view.
    const fov = cesiumFov(1500, 1000, { width: 1500, height: 1000 }, lens.horizontal, lens.vertical)
    expect(fov * DEG).toBeCloseTo(lens.horizontal, 9)
    // Portrait window: Cesium's fov is vertical.
    const portrait = lensView(vf({ focalLength: 50, portrait: true }))
    expect(cesiumFov(1000, 1500, { width: 1000, height: 1500 }, portrait.horizontal, portrait.vertical) * DEG).toBeCloseTo(portrait.vertical, 9)
  })

  it('stays below 180° for the widest lenses', () => {
    const lens = lensView(vf({ sensor: 'mf44', focalLength: 8, aspect: '65:24' }))
    const frame = fitFrame(800, 1400, lens.ratio)
    expect(cesiumFov(800, 1400, frame, lens.horizontal, lens.vertical)).toBeLessThan(Math.PI)
  })
})

describe('focal length controls', () => {
  it('maps the slider logarithmically and round-trips the presets', () => {
    expect(focalToSlider(FOCAL_MIN)).toBe(0)
    expect(focalToSlider(FOCAL_MAX)).toBeCloseTo(1, 12)
    expect(focalToSlider(80)).toBeCloseTo(0.5, 9)
    for (const mm of [14, 24, 35, 50, 85, 135, 200, 400, 600]) expect(sliderToFocal(focalToSlider(mm))).toBe(mm)
    expect(sliderToFocal(-1)).toBe(FOCAL_MIN)
    expect(sliderToFocal(2)).toBe(FOCAL_MAX)
  })

  it('steps through the presets', () => {
    expect(stepFocal(50, 1)).toBe(85)
    expect(stepFocal(50, -1)).toBe(35)
    expect(stepFocal(70, 1)).toBe(85)
    expect(stepFocal(70, -1)).toBe(50)
    expect(stepFocal(600, 1)).toBe(800)
    expect(stepFocal(800, 1)).toBe(800)
    expect(stepFocal(14, -1)).toBe(8)
    expect(stepFocal(8, -1)).toBe(8)
    expect(nudgeFocal(100, 1)).toBe(105)
    expect(nudgeFocal(10, -1)).toBe(9)
    expect(nudgeFocal(800, 1)).toBe(800)
  })
})

describe('composition guides', () => {
  it('draws the expected lines', () => {
    expect(guideLines('none')).toEqual([])
    expect(guideLines('thirds').map((l) => l[0])).toEqual([1 / 3, 2 / 3, 0, 0])
    const phi = guideLines('phi')
    expect(phi[0][0]).toBeCloseTo(0.382, 3)
    expect(phi[1][0]).toBeCloseTo(0.618, 3)
    expect(guideLines('center')).toHaveLength(2)
    expect(guideLines('diagonals')).toEqual([
      [0, 0, 1, 1],
      [1, 0, 0, 1]
    ])
  })
})

describe('viewfinder settings sanitization', () => {
  it('falls back to defaults and clamps', () => {
    expect(sanitizeViewfinder(undefined)).toEqual(defaultViewfinder())
    const s = sanitizeViewfinder({ sensor: 'apsc', focalLength: 5000, aspect: '7:3', portrait: 'yes', guide: 'phi', customSensor: { width: 0, height: 50 } })
    expect(s).toEqual({ sensor: 'apsc', focalLength: 800, aspect: 'native', portrait: false, guide: 'phi', customSensor: { width: 1, height: 50 } })
  })
})
