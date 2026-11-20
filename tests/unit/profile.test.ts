import { describe, expect, it } from 'vitest'
import { densifyPath, haversine, interpolate, nearestSampleIndex, profileStats, type ProfileSample } from '@renderer/lib/profile'

const zurich = { latitude: 47.3769, longitude: 8.5417 }
const geneva = { latitude: 46.2044, longitude: 6.1432 }

describe('path geometry', () => {
  it('measures great-circle distance', () => {
    expect(haversine(zurich, geneva) / 1000).toBeCloseTo(224.1, 0)
    expect(haversine(zurich, zurich)).toBe(0)
  })

  it('interpolates along the great circle', () => {
    const mid = interpolate(zurich, geneva, 0.5)
    expect(haversine(zurich, mid)).toBeCloseTo(haversine(mid, geneva), 3)
  })

  it('densifies evenly and keeps every vertex', () => {
    const mid = { latitude: 46.9, longitude: 7.4 }
    const samples = densifyPath([zurich, mid, geneva], 200)
    expect(samples[0].distance).toBe(0)
    expect(samples.length).toBeGreaterThanOrEqual(200)
    expect(samples.some((s) => s.latitude === mid.latitude && s.longitude === mid.longitude)).toBe(true)
    const total = haversine(zurich, mid) + haversine(mid, geneva)
    expect(samples[samples.length - 1].distance).toBeCloseTo(total, 3)
    for (let i = 1; i < samples.length; i++) expect(samples[i].distance).toBeGreaterThan(samples[i - 1].distance)
  })
})

describe('profile statistics', () => {
  const mk = (elevations: Array<number | null>): ProfileSample[] =>
    elevations.map((elevation, i) => ({ latitude: 0, longitude: i, distance: i * 100, elevation }))

  it('computes min, max, ascent and descent', () => {
    const s = profileStats(mk([1000, 1200, 1100, 1500, 900]))!
    expect(s.min).toBe(900)
    expect(s.max).toBe(1500)
    expect(s.maxIndex).toBe(3)
    expect(s.ascent).toBe(600)
    expect(s.descent).toBe(700)
    expect(s.distance).toBe(400)
  })

  it('skips missing samples and filters small noise with a threshold', () => {
    const s = profileStats(mk([100, null, 102, 101, 103, 150]), 5)!
    expect(s.ascent).toBe(50)
    expect(s.descent).toBe(0)
    expect(profileStats(mk([null, null]))).toBeNull()
  })

  it('finds the nearest sample by distance', () => {
    const samples = mk([1, 2, 3, 4])
    expect(nearestSampleIndex(samples, 140)).toBe(1)
    expect(nearestSampleIndex(samples, 160)).toBe(2)
    expect(nearestSampleIndex(samples, 1e9)).toBe(3)
  })
})
