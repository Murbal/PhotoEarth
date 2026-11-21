import { describe, expect, it } from 'vitest'
import { defaultSettings, defaultViewshed, sanitizeSettings, VIEWSHED_OFFSET_RANGE, VIEWSHED_RADIUS_RANGE } from '@shared/settings'
import { EARTH_RADIUS, heightRange, levelCell, REFRACTION_K, type ShadowLevel } from '@renderer/lib/terrainShadow'
import {
  checkPointVisibility,
  computeViewshedProfile,
  curvatureDrop,
  decodeViewshed,
  encodeViewshed,
  formatArea,
  viewshedCoverageStats,
  viewshedLevelHalves,
  viewshedLevelResolutions,
  viewshedNearLimit,
  viewshedReceiverVisibility,
  viewshedRingInterval,
  viewshedTop
} from '@renderer/lib/viewshed'
import { useAppStore } from '@renderer/store/appStore'

const C = curvatureDrop(EARTH_RADIUS)

/** Synthetic height level centered at (0, 0). */
function level(half: number, n: number, height: (x: number, y: number) => number): ShadowLevel {
  const heights = new Float32Array(n * n)
  const cell = (2 * half) / n
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      heights[j * n + i] = height(-half + (i + 0.5) * cell, -half + (j + 0.5) * cell)
    }
  }
  const { min, max } = heightRange(heights)
  return { cx: 0, cy: 0, half, n, heights, minHeight: min, maxHeight: max }
}

describe('viewshed geometry, curvature, refraction and occlusion', () => {
  it('sees flat terrain within the Earth-curvature horizon and hides it beyond', () => {
    // Target at 1.7 m on flat sea-level ground: horizon distance d1 = sqrt(1.7 / C) ≈ 4.99 km.
    // Another 1.7 m viewer can see it out to 2 * d1 ≈ 9.98 km, and is hidden at 15 km.
    const flat = [level(22000, 220, () => 0)]
    const cell = levelCell(flat[0])
    const opts = { maxRadius: 20000, maxHeight: 0 }

    const near = viewshedTop(flat, 6000, 0, 1.7, cell, opts)
    expect(viewshedReceiverVisibility(near, 1.7, cell)).toBe(1)

    const far = viewshedTop(flat, 15000, 0, 1.7, cell, opts)
    // Analytic minimum height at 15 km past the 4.99 km tangent: C * (15000 - 4990)^2 ≈ 6.84 m.
    const d1 = Math.sqrt(1.7 / C)
    const expectedZMin = C * (15000 - d1) ** 2
    expect(far.zMin).toBeCloseTo(expectedZMin, 0)
    // Standing 1.7 m high at 15 km cannot clear the ~6.8 m Earth bulge, but 15 m tower does.
    expect(viewshedReceiverVisibility(far, 1.7, cell)).toBe(0)
    expect(viewshedReceiverVisibility(far, 15, cell)).toBe(1)
  })

  it('respects terrestrial refraction (k = 0.13) over long sightlines', () => {
    expect(C).toBeCloseTo((1 - REFRACTION_K) / (2 * EARTH_RADIUS), 12)
    // Without refraction (k=0), the bulge at 30 km (from 0 m target) is ~17.66 m at midpoint;
    // with k=0.13 refraction, a 50 m peak at 30 km requires less height than in vacuum.
    const flat = [level(35000, 200, () => 0)]
    const cell = levelCell(flat[0])
    const top = viewshedTop(flat, 30000, 0, 50, cell, { maxRadius: 32000, maxHeight: 0 })
    const d1Refracted = Math.sqrt(50 / C)
    const d1Vacuum = Math.sqrt(50 / (1 / (2 * EARTH_RADIUS)))
    expect(d1Refracted).toBeGreaterThan(d1Vacuum)
    expect(top.zMin).toBeCloseTo(C * (30000 - d1Refracted) ** 2, 0)
  })

  it('blocks terrain behind a ridge while keeping the front face and high ground visible', () => {
    // Target at (0, 0) on a 1000 m valley; a 1600 m north-south ridge 200 m wide at x = 2000 m.
    const ridge = (x: number) => (Math.abs(x - 2000) <= 100 ? 1600 : 1000)
    const levels = [level(6000, 240, ridge)]
    const cell = levelCell(levels[0])
    const opts = { maxRadius: 5000, maxHeight: 1600 }
    const targetH = 1001.7

    // In front of the ridge (x = 1000 m): visible.
    const front = viewshedTop(levels, 1000, 0, targetH, cell, opts)
    expect(viewshedReceiverVisibility(front, 1001.7, cell)).toBe(1)

    // Behind the ridge (x = 4000 m): line from 1001.7 at x=0 over 1600 at x=2000 reaches ~2200 m at x=4000.
    const behind = viewshedTop(levels, 4000, 0, targetH, cell, opts)
    expect(behind.zMin).toBeGreaterThan(2100)
    expect(behind.zMin).toBeLessThan(2350)
    expect(behind.occluderDistance).toBeGreaterThan(1850)
    expect(behind.occluderDistance).toBeLessThan(2150)
    // Ground-level viewer behind ridge is hidden; a high peak or drone rising above ~2250 m sees over it.
    expect(viewshedReceiverVisibility(behind, 1001.7, cell)).toBe(0)
    expect(viewshedReceiverVisibility(behind, 2400, cell)).toBe(1)

    // Opposite direction (x = -4000 m): unobstructed.
    const west = viewshedTop(levels, -4000, 0, targetH, cell, opts)
    expect(viewshedReceiverVisibility(west, 1001.7, cell)).toBe(1)
  })

  it('lifts line of sight when target height offset rises above an obstacle', () => {
    // Low hill 25 m high at x = 1000 m on flat 0 m ground.
    const hill = (x: number) => (Math.abs(x - 1000) <= 80 ? 25 : 0)
    const levels = [level(5000, 250, hill)]
    const cell = levelCell(levels[0])
    const opts = { maxRadius: 4000, maxHeight: 25 }

    // Eye-level target (1.7 m) is blocked behind the 25 m hill at x = 2000 m.
    const lowTarget = viewshedTop(levels, 2000, 0, 1.7, cell, opts)
    expect(viewshedReceiverVisibility(lowTarget, 1.7, cell)).toBe(0)

    // Drone/tower target at 60 m sees straight over the 25 m hill to the 0 m ground at x = 2000 m!
    const highTarget = viewshedTop(levels, 2000, 0, 60, cell, opts)
    expect(viewshedReceiverVisibility(highTarget, 1.7, cell)).toBe(1)
  })

  it('marches seamlessly across nested fine, medium, and coarse grids', () => {
    // A 1200 m ridge at x = 1500 m (inside L0) blocks points at x = 12000 m (in L2).
    const terrain = (x: number) => (Math.abs(x - 1500) <= 100 ? 1200 : 500)
    const l0 = level(3000, 150, terrain)
    const l1 = level(8000, 160, terrain)
    const l2 = level(18000, 180, terrain)
    const cell2 = levelCell(l2)

    // Target 15 m above 500 m plain has a ~14.8 km curved-Earth horizon, so ±12 km is in range.
    const blocked = viewshedTop([l0, l1, l2], 12000, 0, 515, cell2, { maxRadius: 15000, maxHeight: 1200 })
    expect(viewshedReceiverVisibility(blocked, 501.7, cell2)).toBe(0)
    expect(blocked.occluderDistance).toBeGreaterThan(10000)

    const clear = viewshedTop([l0, l1, l2], -12000, 0, 515, cell2, { maxRadius: 15000, maxHeight: 1200 })
    expect(viewshedReceiverVisibility(clear, 501.7, cell2)).toBe(1)
  })

  it('round-trips the 16-bit RGBA8 viewshed encoding', () => {
    const base = -500
    const [r, g, b, a] = encodeViewshed(2842.63, 14320, base)
    const d = decodeViewshed(r, g, b, a, base)
    expect(Math.abs(d.zMin - 2842.63)).toBeLessThanOrEqual(0.125)
    expect(Math.abs(d.occluderDistance - 14320)).toBeLessThanOrEqual(1)
    expect(decodeViewshed(...encodeViewshed(Number.NEGATIVE_INFINITY, 0, base), base).zMin).toBe(base)
    expect(decodeViewshed(...encodeViewshed(1e9, 1e9, base), base).zMin).toBe(base + 65535 * 0.25)
  })

  it('computes accurate visible coverage stats and responds to viewer offset', () => {
    // A tall wall blocking the entire eastern half (x > 500 m) -> ~50% visible!
    const halfWall = (x: number) => (x >= 500 && x <= 700 ? 2000 : 500)
    const levels = [level(6000, 240, halfWall)]
    const profile = computeViewshedProfile(levels, 505, 5000, { rays: 180 })
    const stats = viewshedCoverageStats(profile, 1.7)
    expect(stats.totalAreaM2).toBeCloseTo(Math.PI * 5000 * 5000, -1)
    expect(stats.visibleFraction).toBeGreaterThan(0.45)
    expect(stats.visibleFraction).toBeLessThan(0.62)

    // Flat ground within 3 km from a 10 m target: 100% visible.
    const flat = [level(4000, 120, () => 100)]
    const flatProfile = computeViewshedProfile(flat, 110, 3000, { rays: 120 })
    expect(viewshedCoverageStats(flatProfile, 1.7).visibleFraction).toBeGreaterThan(0.99)
  })

  it('checks point-to-target line of sight with bearing, pitch, clearance, and radius bounds', () => {
    // Target at (0, 0) height 2000 m; viewer at (0, -4000) (due south, so bearing to target = 0° N) at 1000 m.
    const slope = (_x: number, y: number) => 2000 + y * 0.25 // 2000 at y=0, 1000 at y=-4000
    const levels = [level(6000, 150, slope)]
    const check = checkPointVisibility(levels, 0, -4000, 1000, 2001.7, 1.7, 5000)
    expect(check.visible).toBe(true)
    expect(check.outsideRadius).toBe(false)
    expect(check.distance).toBeCloseTo(4000, 3)
    expect(check.bearingToTarget).toBeCloseTo(0, 3)
    expect(check.pitchToTarget).toBeGreaterThan(13)
    expect(check.pitchToTarget).toBeLessThan(15)

    // Point due east of target looks due west (270°).
    const eastCheck = checkPointVisibility(levels, 3000, 0, 2000, 2001.7, 1.7, 5000)
    expect(eastCheck.bearingToTarget).toBeCloseTo(270, 3)

    // Point beyond analysis radius is flagged outsideRadius and not visible.
    const outside = checkPointVisibility(levels, 0, -6000, 500, 2001.7, 1.7, 5000)
    expect(outside.outsideRadius).toBe(true)
    expect(outside.visible).toBe(false)
  })

  it('computes grid geometry, ring intervals, and formatted areas', () => {
    expect(viewshedLevelHalves(15000)).toEqual([2700, 7200, 16800])
    expect(viewshedLevelResolutions(512)).toEqual([512, 512, 512])
    expect(viewshedLevelResolutions(2048)).toEqual([1024, 1024, 1024])
    expect(viewshedNearLimit([level(5000, 500, () => 0)])).toBe(20)
    expect(viewshedNearLimit([level(1000, 500, () => 0)])).toBe(15)
    expect(viewshedRingInterval(5000, 'metric')).toBe(1000)
    expect(viewshedRingInterval(15000, 'metric')).toBe(5000)
    expect(viewshedRingInterval(50000, 'metric')).toBe(10000)
    expect(viewshedRingInterval(5000, 'imperial')).toBeCloseTo(1609.344, 1)
    expect(formatArea(24_500_000, 'metric')).toBe('25 km²')
    expect(formatArea(3_400_000, 'metric')).toBe('3.4 km²')
    expect(formatArea(10_000_000, 'imperial')).toBe('3.9 mi²')
  })
})

describe('viewshed settings and store behavior', () => {
  it('sanitizes viewshed settings and clamps out-of-range values', () => {
    expect(sanitizeSettings({}).viewshed).toEqual(defaultViewshed())
    const s = sanitizeSettings({
      viewshed: {
        radius: 500_000,
        targetOffset: -10,
        viewerOffset: 999,
        opacity: 2,
        colorMode: 'rainbow',
        showRings: false
      }
    })
    expect(s.viewshed).toEqual({
      radius: VIEWSHED_RADIUS_RANGE.max,
      targetOffset: VIEWSHED_OFFSET_RANGE.min,
      viewerOffset: VIEWSHED_OFFSET_RANGE.max,
      opacity: 1,
      colorMode: 'distance',
      showRings: false
    })
    expect(defaultSettings().viewshed.radius).toBe(15000)
  })

  it('patches and resets viewshed runtime state cleanly in appStore', () => {
    useAppStore.getState().resetViewshed()
    expect(useAppStore.getState().viewshed.open).toBe(false)
    useAppStore.getState().patchViewshed({
      open: true,
      picking: true,
      status: 'ready',
      loaded: 3,
      levels: 3,
      stats: { visibleAreaM2: 10_000_000, totalAreaM2: 50_000_000, visibleFraction: 0.2 }
    })
    useAppStore.getState().set({
      inspectViewshed: { visible: true, distance: 1200, bearingToTarget: 45, pitchToTarget: 5, clearanceM: 20, outsideRadius: false }
    })
    expect(useAppStore.getState().viewshed.open).toBe(true)
    expect(useAppStore.getState().viewshed.picking).toBe(true)
    expect(useAppStore.getState().inspectViewshed?.visible).toBe(true)

    useAppStore.getState().resetViewshed()
    expect(useAppStore.getState().viewshed).toMatchObject({ open: false, picking: false, status: 'idle', target: null, stats: null })
    expect(useAppStore.getState().inspectViewshed).toBeNull()
  })
})
