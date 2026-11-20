import { describe, expect, it } from 'vitest'
import { FALL_SECONDS, MAX_SPEED, MIN_SPEED, MovementSpeed, RISE_SECONDS } from '@renderer/engine/MovementSpeed'

/** Feeds `clearance` for `seconds` at 60 fps; returns the reference after each frame. */
function run(s: MovementSpeed, clearance: number | null, seconds: number): number[] {
  const out: number[] = []
  for (let t = 0; t < seconds; t += 1 / 60) out.push(s.update(clearance, 1 / 60)!)
  return out
}

describe('MovementSpeed', () => {
  it('starts at the first measurement', () => {
    const s = new MovementSpeed()
    expect(s.update(null, 0.016)).toBeNull()
    expect(s.update(50, 0.016)).toBe(50)
  })

  it('eases up past a cliff edge instead of jumping', () => {
    const s = new MovementSpeed()
    s.update(50, 0.016)
    const ramp = run(s, 500, 3)
    // One frame after the ground drops away 10×, speed has barely changed.
    expect(ramp[0]).toBeLessThan(55)
    // Ratio steps are even (log-space): no frame gains more than ~6 %.
    for (let i = 1; i < ramp.length; i++) expect(ramp[i] / ramp[i - 1]).toBeLessThan(1.07)
    // After one rise time constant, about 63 % of the way in log space: 50 · 10^0.63.
    const atTau = ramp[Math.round(RISE_SECONDS * 60) - 1]
    expect(Math.log10(atTau / 50)).toBeCloseTo(1 - Math.exp(-1), 1)
    expect(ramp[ramp.length - 1]).toBeGreaterThan(490)
  })

  it('slows down promptly when an obstacle appears', () => {
    const s = new MovementSpeed()
    s.update(500, 0.016)
    const drop = run(s, 50, 1)
    // Falls 4× faster than it rises.
    const atTau = drop[Math.round(FALL_SECONDS * 60) - 1]
    expect(Math.log10(500 / atTau)).toBeCloseTo(1 - Math.exp(-1), 1)
    expect(drop[drop.length - 1]).toBeLessThan(52)
  })

  it('holds its value while the clearance is unknown (never reads unknown ground as sea level)', () => {
    const s = new MovementSpeed()
    s.update(40, 0.016)
    expect(run(s, null, 1).every((r) => r === 40)).toBe(true)
  })

  it('is frame-rate independent', () => {
    const fast = new MovementSpeed()
    const slow = new MovementSpeed()
    fast.update(30, 0)
    slow.update(30, 0)
    let a = 0
    let b = 0
    for (let i = 0; i < 60; i++) a = fast.update(300, 1 / 60)!
    for (let i = 0; i < 4; i++) b = slow.update(300, 0.25)!
    expect(a / b).toBeCloseTo(1, 5)
  })

  it('maps the reference to a clamped speed', () => {
    expect(MovementSpeed.speedFor(0.5)).toBe(MIN_SPEED)
    expect(MovementSpeed.speedFor(100)).toBeCloseTo(110)
    expect(MovementSpeed.speedFor(1e9)).toBe(MAX_SPEED)
  })
})
