import { afterEach, describe, expect, it, vi } from 'vitest'
import { ShadowCompute } from '@renderer/engine/shadows/ShadowCompute'
import { MAX_SHADOW_ATLAS, PRESETS, resolveQuality } from '@renderer/engine/quality'
import { altitudeProfile, sunPosition } from '@renderer/lib/sun'
import { formatLongDate, zonedToUtc, zoneAbbreviation } from '@renderer/lib/time'
import type { ShadowLevel, SunVector } from '@renderer/lib/terrainShadow'

const OVERRIDES = {
  maximumScreenSpaceError: null,
  shadowMapSize: null,
  shadowCascades: null,
  softShadows: null,
  terrainShadowResolution: null,
  msaaSamples: null,
  fxaa: null,
  resolutionScale: null
} as const

describe('resolveQuality shadow atlas', () => {
  it('keeps the 4-cascade atlas (twice the cascade size) within MAX_SHADOW_ATLAS', () => {
    for (const preset of Object.keys(PRESETS) as Array<keyof typeof PRESETS>) {
      const q = resolveQuality(preset, OVERRIDES, { maxTextureSize: 16384, maxSamples: 8 })
      const atlas = q.shadowMapSize * (q.shadowCascades === 4 ? 2 : 1)
      expect(atlas, preset).toBeLessThanOrEqual(MAX_SHADOW_ATLAS)
    }
    const big = resolveQuality('ultra', { ...OVERRIDES, shadowMapSize: 8192 }, { maxTextureSize: 16384, maxSamples: 8 })
    expect(big.shadowMapSize).toBe(4096)
    const single = resolveQuality('ultra', { ...OVERRIDES, shadowMapSize: 8192, shadowCascades: 1 }, { maxTextureSize: 16384, maxSamples: 8 })
    expect(single.shadowMapSize).toBe(8192)
  })

  it('respects the device texture limit', () => {
    const q = resolveQuality('high', OVERRIDES, { maxTextureSize: 4096, maxSamples: 4 })
    expect(q.shadowMapSize).toBe(2048)
    expect(q.msaaSamples).toBe(4)
  })
})

describe('time helpers used every playback frame', () => {
  it('altitudeProfile matches per-sample zone conversion, on normal and clock-change days', () => {
    const cases: Array<[string, string, number, number]> = [
      ['2026-06-21', 'Europe/Zurich', 46.5, 7.9],
      ['2026-03-29', 'Europe/Zurich', 46.5, 7.9], // spring forward
      ['2026-10-25', 'Europe/Zurich', 46.5, 7.9], // fall back
      ['2026-11-01', 'America/Denver', 39.7, -105],
      ['2026-04-05', 'Australia/Lord_Howe', -31.5, 159.1] // 30-minute DST
    ]
    for (const [date, zone, lat, lon] of cases) {
      const fast = altitudeProfile(date, zone, lat, lon, 96)
      const slow = Array.from({ length: 97 }, (_, i) => sunPosition(zonedToUtc(date, (i / 96) * 1440, zone), lat, lon).altitude)
      expect(fast, `${zone} ${date}`).toEqual(slow)
    }
  })

  it('zoneAbbreviation reuses formatters and tolerates invalid zones', () => {
    const summer = Date.UTC(2026, 6, 1, 12)
    const winter = Date.UTC(2026, 0, 1, 12)
    expect(zoneAbbreviation(summer, 'America/New_York')).toBe('EDT')
    expect(zoneAbbreviation(winter, 'America/New_York')).toBe('EST')
    expect(zoneAbbreviation(summer, 'Not/AZone')).toBe('')
  })

  it('formatLongDate names the weekday', () => {
    expect(formatLongDate('2026-11-20')).toBe('Fri, Nov 20, 2026')
    expect(formatLongDate('2024-02-29')).toBe('Thu, Feb 29, 2024')
  })
})

/** Drives ShadowCompute's level choice without a WebGL context. */
function harness() {
  const compute = new ShadowCompute(() => undefined)
  const internals = compute as unknown as {
    levels: Array<{ heights: unknown; maskForData: boolean; maskSun: SunVector | null }>
    frameNumber: number
    lastComputeAt: number
    pickLevel(): number
  }
  const level = (half: number): ShadowLevel => ({ cx: 0, cy: 0, half, n: 64, heights: new Float32Array(64 * 64), minHeight: 0, maxHeight: 100 })
  compute.setEnabled(true)
  ;[5000, 20000, 80000].forEach((half, k) => compute.setLevel(k, level(half)))
  for (const s of internals.levels) s.heights = {}
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  let sun: SunVector = { x: 0, y: 0.996, z: 0.0872 }
  compute.setSun(sun, true)
  /** One frame: what update() would schedule, then what schedule() records. */
  const frame = (ms = 16.7): number => {
    now += ms
    internals.frameNumber++
    const pick = internals.pickLevel()
    if (pick >= 0) {
      internals.levels[pick].maskForData = true
      internals.levels[pick].maskSun = { ...sun }
      internals.lastComputeAt = now
    }
    return pick
  }
  const turnSun = (degrees: number) => {
    const a = Math.atan2(sun.x, sun.y) + (degrees * Math.PI) / 180
    const h = Math.hypot(sun.x, sun.y)
    sun = { x: Math.sin(a) * h, y: Math.cos(a) * h, z: sun.z }
    compute.setSun(sun, true)
  }
  const allCurrent = () => internals.levels.every((s) => s.maskSun && s.maskSun.x === sun.x && s.maskSun.y === sun.y && s.maskSun.z === sun.z)
  return { frame, turnSun, allCurrent }
}

describe('ShadowCompute scheduling', () => {
  afterEach(() => vi.restoreAllMocks())

  it('computes changed data immediately, one level per frame', () => {
    const { frame } = harness()
    expect([frame(), frame(), frame(), frame()]).toEqual([0, 1, 2, -1])
  })

  it('refreshes every level while the sun keeps moving (no starvation)', () => {
    const { frame, turnSun } = harness()
    frame(); frame(); frame()
    const picks: number[] = []
    for (let i = 0; i < 60; i++) {
      turnSun(0.25) // 1 h/s at 60 fps
      picks.push(frame())
    }
    for (const k of [0, 1, 2]) expect(picks.filter((p) => p === k).length, `level ${k}`).toBeGreaterThan(4)
    // Throttled: fewer recomputes than frames.
    expect(picks.filter((p) => p >= 0).length).toBeLessThanOrEqual(31)
  })

  it('converges every level to the exact sun once it stops', () => {
    const { frame, turnSun, allCurrent } = harness()
    frame(); frame(); frame()
    for (let i = 0; i < 10; i++) {
      turnSun(0.004) // slow playback: below the moving threshold per frame
      frame()
    }
    expect(allCurrent()).toBe(false)
    for (let i = 0; i < 5; i++) frame()
    expect(allCurrent()).toBe(true)
    expect(frame()).toBe(-1)
  })
})
