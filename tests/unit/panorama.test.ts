import { describe, expect, it } from 'vitest'
import {
  aboveSkyline,
  apparentAltitude,
  azDelta,
  createHorizon,
  HORIZON_LEVELS,
  horizonAt,
  horizonRange,
  pathRuns,
  peaksOnSkyline,
  sampleIndex,
  skylineCrossings,
  skylineSummits,
  SUN_RADIUS,
  traceHorizon,
  wrap360,
  type PathPoint
} from '@renderer/lib/panorama'
import { moonPhase, moonPosition } from '@renderer/lib/moon'
import { sunDay, sunPosition } from '@renderer/lib/sun'
import { EARTH_RADIUS, REFRACTION_K, type ShadowLevel } from '@renderer/lib/terrainShadow'

const DEG = 180 / Math.PI
const C = (1 - REFRACTION_K) / (2 * EARTH_RADIUS)

/** A grid centered on the observer with heights from `fn(x, y)` at the cell centers. */
function level(half: number, n: number, fn: (x: number, y: number) => number): ShadowLevel {
  const cell = (2 * half) / n
  const heights = new Float32Array(n * n)
  let minHeight = Infinity
  let maxHeight = -Infinity
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const h = fn(-half + (i + 0.5) * cell, -half + (j + 0.5) * cell)
      heights[j * n + i] = h
      minHeight = Math.min(minHeight, h)
      maxHeight = Math.max(maxHeight, h)
    }
  }
  return { cx: 0, cy: 0, half, n, heights, minHeight, maxHeight }
}

/** A cone of `height` m and base radius `radius` m centered at (x0, y0). */
const cone = (x0: number, y0: number, height: number, radius: number) => (x: number, y: number) =>
  Math.max(0, height * (1 - Math.hypot(x - x0, y - y0) / radius))

const flat = () => 0

function trace(levels: ShadowLevel[], eye: number) {
  const h = createHorizon(eye)
  traceHorizon(h, levels)
  return h
}

describe('skyline tracing', () => {
  it('sees the curved sea horizon dip below 0° from a height', () => {
    const h = trace([level(60000, 240, flat)], 100)
    const dip = Math.atan(-2 * Math.sqrt(100 * C)) * DEG
    expect(dip).toBeCloseTo(-0.3, 1)
    for (const az of [0, 90, 180, 270]) expect(horizonAt(h, az)).toBeCloseTo(dip, 2)
    // The tangent point is ~38 km out.
    expect(h.distance[sampleIndex(h, 45)] / 1000).toBeCloseTo(Math.sqrt(100 / C) / 1000, -1)
  })

  it('assumes the ground continues past the data, so a high observer still sees the earth curve', () => {
    const eye = 3000
    const h = trace([level(20000, 200, flat)], eye)
    // The square's corners reach farthest.
    expect(h.reach).toBeLessThan(20000 * Math.SQRT2)
    expect(horizonAt(h, 123)).toBeCloseTo(Math.atan(-2 * Math.sqrt(eye * C)) * DEG, 2)
  })

  it('traces a mountain in its direction and nothing elsewhere', () => {
    // A rounded top, so the grid's sampling doesn't shave the summit.
    const mountain = (x: number, y: number) => 1200 * Math.exp(-(((x - 10000) ** 2 + y ** 2) / 1500 ** 2))
    const h = trace([level(4000, 200, mountain), level(30000, 300, mountain)], 1.7)
    const expected = apparentAltitude(1.7, 10000, 0, 1200)
    expect(expected).toBeCloseTo(Math.atan(1198.3 / 10000 - 10000 * C) * DEG, 6)
    expect(horizonAt(h, 90)).toBeCloseTo(expected, 1)
    expect(h.distance[sampleIndex(h, 90)]).toBeGreaterThan(9500)
    expect(h.distance[sampleIndex(h, 90)]).toBeLessThan(10500)
    // Facing away it's flat ground: the skyline sits just below 0°.
    expect(horizonAt(h, 270)).toBeLessThan(0)
    expect(horizonAt(h, 270)).toBeGreaterThan(-0.2)
    const range = horizonRange(h)
    expect(range.max).toBeCloseTo(horizonAt(h, 90), 1)
    // A window that excludes the mountain.
    expect(horizonRange(h, 270, 60).max).toBeLessThan(0)
  })

  it('finds the summit on the skyline with its prominence', () => {
    const terrain = (x: number, y: number) => Math.max(cone(10000, 0, 1200, 3000)(x, y), cone(0, -15000, 600, 2500)(x, y))
    const h = trace([level(30000, 300, terrain)], 1.7)
    const summits = skylineSummits(h, 0.3)
    expect(summits.length).toBe(2)
    expect(summits[0].azimuth).toBeCloseTo(90, 0)
    expect(summits[0].prominence).toBeGreaterThan(5)
    expect(summits[1].azimuth).toBeCloseTo(180, 0)
    expect(summits[0].height).toBeGreaterThan(1100)
  })
})

describe('named peaks', () => {
  const near = cone(8000, 0, 1500, 3000)
  const far = cone(20000, 300, 1200, 3000)
  const terrain = (x: number, y: number) => Math.max(near(x, y), far(x, y), cone(0, 12000, 900, 2500)(x, y))
  const levels = [level(30000, 400, terrain)]
  const h = trace(levels, 1.7)

  it('labels summits on the skyline, also when the pin is a little off the top', () => {
    const peaks = peaksOnSkyline(h, levels, [
      { id: 'a', name: 'Near Peak', x: 8120, y: 90 },
      { id: 'n', name: 'North Peak', x: 0, y: 12000 }
    ])
    expect(peaks.map((p) => p.name).sort()).toEqual(['Near Peak', 'North Peak'])
    const a = peaks.find((p) => p.id === 'a')!
    expect(a.azimuth).toBeCloseTo(90, 0)
    expect(a.height).toBeGreaterThan(1400)
  })

  it('skips peaks hidden behind nearer ground and points that are not on the skyline', () => {
    const peaks = peaksOnSkyline(h, levels, [
      { id: 'hidden', name: 'Hidden Peak', x: 20000, y: 300 },
      { id: 'meadow', name: 'Meadow', x: -5000, y: -5000 },
      { id: 'self', name: 'Here', x: 50, y: 0 }
    ])
    expect(peaks).toEqual([])
  })

  it('keeps one label per summit', () => {
    const peaks = peaksOnSkyline(h, levels, [
      { id: 'a', name: 'Near Peak', x: 8000, y: 0 },
      { id: 'b', name: 'Near Peak', x: 8100, y: 40 }
    ])
    expect(peaks).toHaveLength(1)
  })
})

describe('sun and moon against the skyline', () => {
  it('finds when a body clears and drops behind a mountain', () => {
    const mountain = cone(10000, 0, 1200, 3000)
    const h = trace([level(30000, 300, mountain)], 1.7)
    const skyline = horizonAt(h, 90)
    // Due east, climbing 1° per hour from −5° at t = 0, then sinking after 15 h.
    const hour = 3600000
    const at = (t: number) => ({ azimuth: 90, altitude: t < 15 * hour ? -5 + t / hour : 10 - (t - 15 * hour) / hour })
    const day = skylineCrossings(h, at, 0, 30 * hour, SUN_RADIUS)
    expect(day.visibleAtStart).toBe(false)
    expect(day.events.map((e) => e.kind)).toEqual(['rise', 'set'])
    const rise = (skyline - SUN_RADIUS + 5) * hour
    expect(Math.abs(day.events[0].utc - rise)).toBeLessThan(2000)
    expect(Math.abs(day.visibleMs - (day.events[1].utc - day.events[0].utc))).toBeLessThan(1)
  })

  it('matches a flat-horizon sunrise and sunset to within two minutes', () => {
    const lat = 47.37
    const lon = 8.54
    const h = trace([level(30000, 200, flat)], 1.7)
    const day = sunDay('2026-06-21', 'Europe/Zurich', lat, lon)
    const start = day.solarNoon - 12 * 3600000
    const sky = skylineCrossings(h, (t) => sunPosition(t, lat, lon), start, start + 24 * 3600000, SUN_RADIUS)
    const rise = sky.events.find((e) => e.kind === 'rise')!
    const set = sky.events.find((e) => e.kind === 'set')!
    expect(Math.abs(rise.utc - day.sunrise!) / 60000).toBeLessThan(2)
    expect(Math.abs(set.utc - day.sunset!) / 60000).toBeLessThan(2)
  })

  it('computes moon positions and phase', () => {
    // Full moon on 2026-12-24 (≈ 01:28 UTC).
    const t = Date.UTC(2026, 11, 24, 1, 28)
    expect(moonPhase(t).fraction).toBeGreaterThan(0.99)
    expect(moonPhase(t).name).toBe('Full moon')
    const p = moonPosition(t, 47.37, 8.54)
    expect(p.azimuth).toBeGreaterThanOrEqual(0)
    expect(p.azimuth).toBeLessThan(360)
    // A full moon stands opposite the sun.
    const s = sunPosition(t, 47.37, 8.54)
    expect(Math.abs(azDelta(p.azimuth, s.azimuth))).toBeGreaterThan(150)
  })

  it('treats a body as above the skyline by its upper limb', () => {
    const h = trace([level(30000, 200, flat)], 1.7)
    const skyline = horizonAt(h, 10)
    expect(aboveSkyline(h, { azimuth: 10, altitude: skyline - SUN_RADIUS + 0.01 }, SUN_RADIUS)).toBe(true)
    expect(aboveSkyline(h, { azimuth: 10, altitude: skyline - SUN_RADIUS - 0.01 }, SUN_RADIUS)).toBe(false)
  })
})

describe('chart helpers', () => {
  it('wraps azimuths', () => {
    expect(wrap360(-10)).toBe(350)
    expect(wrap360(725)).toBe(5)
    expect(azDelta(10, 350)).toBe(20)
    expect(azDelta(350, 10)).toBe(-20)
  })

  it('interpolates the skyline across north', () => {
    const h = createHorizon(0, 4)
    h.altitude.set([0, 1, 2, 3])
    expect(horizonAt(h, 45)).toBeCloseTo(0.5)
    expect(horizonAt(h, 315)).toBeCloseTo(1.5)
    expect(horizonAt(h, -45)).toBeCloseTo(1.5)
  })

  it('splits paths at the seam and where visibility changes', () => {
    const pts: PathPoint[] = [0, 1, 2, 3, 4, 5].map((i) => ({ utc: i, azimuth: i * 10, altitude: i }))
    const runs = pathRuns(
      pts,
      (p) => p.altitude >= 2,
      (p) => (p.utc === 4 ? 1000 : p.azimuth),
      100
    )
    expect(runs.map((r) => [r.visible, r.points.map((p) => p.utc)])).toEqual([
      [false, [0, 1, 2]],
      [true, [2, 3]],
      [true, [4]],
      [true, [5]]
    ])
  })
})

describe('performance', () => {
  it('traces the full five-level skyline over mountains in well under half a second', () => {
    // Rolling alpine terrain everywhere: no early exits from the march.
    const alps = (x: number, y: number) => 1500 + 900 * Math.sin(x / 3100) * Math.cos(y / 2300) + 400 * Math.sin((x + y) / 900)
    const levels = HORIZON_LEVELS.map(({ half, n }) => level(half, n, alps))
    const h = createHorizon(alps(0, 0) + 1.7)
    const t0 = performance.now()
    traceHorizon(h, levels)
    const ms = performance.now() - t0
    expect(h.altitude.every(Number.isFinite)).toBe(true)
    expect(ms).toBeLessThan(500)
  })
})
