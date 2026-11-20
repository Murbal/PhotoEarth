import { Cartesian3, Cartographic } from 'cesium'
import { describe, expect, it } from 'vitest'
import { LOOKAHEAD_SECONDS, MotionPredictor } from '@renderer/engine/TilePreloader'

const start = Cartesian3.fromDegrees(8, 46, 2000)
const east = new Cartesian3(0, 1, 0) // at lon 8° the local east is nearly +y
const dir = Cartesian3.normalize(new Cartesian3(0, 1, -0.2), new Cartesian3())
const up = Cartesian3.normalize(Cartesian3.clone(start), new Cartesian3())

/** Feeds `frames` samples at 60 fps moving at `speed` m/s along `east`. */
function fly(p: MotionPredictor, speed: number, frames: number, direction = dir, t0 = 0): Cartesian3 {
  let pos = start
  for (let i = 0; i <= frames; i++) {
    pos = Cartesian3.add(start, Cartesian3.multiplyByScalar(east, (speed * i) / 60, new Cartesian3()), new Cartesian3())
    p.sample(pos, direction, t0 + i / 60)
  }
  return pos
}

describe('motion prediction for tile preloading', () => {
  it('converges on the camera velocity and extrapolates ahead', () => {
    const p = new MotionPredictor()
    const pos = fly(p, 300, 90)
    expect(p.speed).toBeCloseTo(300, 0)
    const pose = p.predict(pos, dir, up, LOOKAHEAD_SECONDS)
    expect(Cartesian3.distance(pose.position, pos)).toBeCloseTo(300 * LOOKAHEAD_SECONDS, -1)
    // Direction and up stay unit length and orthogonal.
    expect(Cartesian3.magnitude(pose.direction)).toBeCloseTo(1, 6)
    expect(Cartesian3.dot(pose.direction, pose.up)).toBeCloseTo(0, 6)
  })

  it('smooths a single jittery frame', () => {
    const p = new MotionPredictor()
    const pos = fly(p, 100, 60)
    const jump = Cartesian3.add(pos, new Cartesian3(0, 50, 0), new Cartesian3())
    p.sample(jump, dir, 61 / 60)
    expect(p.speed).toBeLessThan(800) // one frame alone would read 3000 m/s
  })

  it('starts over after a long pause instead of spiking', () => {
    const p = new MotionPredictor()
    fly(p, 200, 30)
    p.sample(Cartesian3.fromDegrees(9, 46, 2000), dir, 10)
    expect(p.speed).toBe(0)
  })

  it('keeps a diving prediction above the floor height', () => {
    const p = new MotionPredictor()
    const down = Cartesian3.negate(up, new Cartesian3())
    let pos = start
    for (let i = 0; i <= 60; i++) {
      pos = Cartesian3.add(start, Cartesian3.multiplyByScalar(down, (1000 * i) / 60, new Cartesian3()), new Cartesian3())
      p.sample(pos, dir, i / 60)
    }
    const pose = p.predict(pos, dir, up, LOOKAHEAD_SECONDS, 500)
    expect(Cartographic.fromCartesian(pose.position)!.height).toBeCloseTo(500, 0)
  })

  it('extrapolates part of a turn', () => {
    const p = new MotionPredictor()
    let pos = start
    for (let i = 0; i <= 60; i++) {
      const a = (i / 60) * 0.5 // turning 0.5 rad/s
      const d = Cartesian3.normalize(new Cartesian3(Math.sin(a), Math.cos(a), -0.2), new Cartesian3())
      pos = Cartesian3.add(start, Cartesian3.multiplyByScalar(east, (50 * i) / 60, new Cartesian3()), new Cartesian3())
      p.sample(pos, d, i / 60)
    }
    const now = Cartesian3.normalize(new Cartesian3(Math.sin(0.5), Math.cos(0.5), -0.2), new Cartesian3())
    const pose = p.predict(pos, now, up, LOOKAHEAD_SECONDS)
    // Turned further the same way (+x), by less than the full lookahead's worth.
    expect(pose.direction.x).toBeGreaterThan(now.x)
    expect(Math.acos(Cartesian3.dot(pose.direction, now))).toBeLessThan(0.5 * LOOKAHEAD_SECONDS)
  })
})
