import { describe, expect, it } from 'vitest'
import { horizonAngle, horizonProfile, receiverHeight, skylineAt, sunlitBands, sunlitDay } from '@renderer/lib/horizon'
import { sunDay, type SunPosition } from '@renderer/lib/sun'
import {
  EARTH_RADIUS,
  heightRange,
  levelCell,
  levelResolutions,
  receiverVisibility,
  REFRACTION_K,
  shadowTop,
  type ShadowLevel
} from '@renderer/lib/terrainShadow'
import { zonedToUtc } from '@renderer/lib/time'

const DEG = Math.PI / 180
const C2 = ((1 - REFRACTION_K) * 0.5) / EARTH_RADIUS

function level(half: number, n: number, height: (x: number, y: number) => number): ShadowLevel {
  const heights = new Float32Array(n * n)
  const cell = (2 * half) / n
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) heights[j * n + i] = height(-half + (i + 0.5) * cell, -half + (j + 0.5) * cell)
  }
  const { min, max } = heightRange(heights)
  return { cx: 0, cy: 0, half, n, heights, minHeight: min, maxHeight: max }
}

/** Valley floor at 1000 m with a 1000 m high north–south wall 2 km to the east. */
const valley = (x: number) => (x >= 2000 && x <= 2400 ? 2000 : 1000)

/** Synthetic sun: rises due east at 06:00 UTC, culminates at 30° due south, sets due west at 18:00. */
function arcSun(utc: number): SunPosition {
  const day = zonedToUtc('2026-03-20', 0, 'UTC')
  const minutes = (utc - day) / 60000
  const x = (minutes - 360) / 720
  return { azimuth: 90 + 180 * x, altitude: 30 * Math.sin(Math.PI * x) }
}

const clock = (utc: number | null) => (utc === null ? null : (utc - zonedToUtc('2026-03-20', 0, 'UTC')) / 60000)

describe('terrain skyline', () => {
  it('sees a valley wall at its true angle and an open plain at about 0°', () => {
    const levels = [level(5000, 250, valley)]
    const opts = { farHeight: 1000, maxHeight: 2000 }
    const east = horizonAngle(levels, 0, 0, 1000, 90, opts)
    // Nearest wall face, 2000 m away and 1000 m up (a whisker less for curvature).
    expect(east).toBeGreaterThan(26.2)
    expect(east).toBeLessThan(26.7)
    const west = horizonAngle(levels, 0, 0, 1000, 270, opts)
    expect(Math.abs(west)).toBeLessThan(0.1)
  })

  it('dips below 0° from a summit, as the shadow pass does', () => {
    // A sharp cone: the near slopes fall away, so the far sea sets the horizon.
    const levels = [level(5000, 100, (x, y) => Math.max(0, 3000 - 2 * Math.hypot(x, y)))]
    const dip = horizonAngle(levels, 0, 0, 3000, 200, { farHeight: 0, maxHeight: 3000 })
    // Geometric dip with terrestrial refraction: 2·√(h·(1 − k)/2R).
    expect(dip).toBeCloseTo(-(2 * Math.sqrt(3000 * C2)) / DEG, 1)
  })

  it('agrees with shadowTop on whether the spot is lit, for any sun direction', () => {
    const peaks = (x: number, y: number) =>
      800 + 900 * Math.exp(-((x - 1500) ** 2 + (y - 300) ** 2) / 4e5) + 600 * Math.exp(-((x + 2500) ** 2 + (y + 1800) ** 2) / 1e6)
    const fine = level(5000, 250, peaks)
    const coarse = level(20000, 200, peaks)
    const levels = [fine, coarse]
    const opts = { farHeight: coarse.minHeight, maxHeight: Math.max(fine.maxHeight, coarse.maxHeight) }
    const cell = levelCell(fine)
    const ground = 800
    const height = receiverHeight(ground, cell)
    let seed = 7
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    let checked = 0
    for (let k = 0; k < 400; k++) {
      const az = random() * 360
      const alt = -2 + random() * 30
      const skyline = horizonAngle(levels, 0, 0, height, az, opts)
      if (Math.abs(alt - skyline) < 0.05) continue // on the edge: either answer is right
      const sun = { x: Math.sin(az * DEG) * Math.cos(alt * DEG), y: Math.cos(az * DEG) * Math.cos(alt * DEG), z: Math.sin(alt * DEG) }
      const top = shadowTop(levels, 0, 0, ground, cell, sun, opts)
      // Half the disc visible ⇔ receiver + bias above the shadow top (no penumbra needed here).
      const litByShadow = receiverVisibility({ top: top.top, distance: 0 }, ground, cell) > 0.5
      expect(alt > skyline, `az ${az.toFixed(1)}° alt ${alt.toFixed(2)}°`).toBe(litByShadow)
      checked++
    }
    expect(checked).toBeGreaterThan(350)
  })

  it('interpolates between azimuth bins and wraps at north', () => {
    const profile = new Float32Array([0, 10, 20, 30])
    expect(skylineAt(profile, 45)).toBeCloseTo(5, 6)
    expect(skylineAt(profile, 315)).toBeCloseTo(15, 6)
    expect(skylineAt(profile, -45)).toBeCloseTo(15, 6)
    expect(skylineAt(profile, 360)).toBeCloseTo(0, 6)
  })

  it('traces a full-resolution skyline quickly enough for a click', () => {
    const [n, , nc] = levelResolutions(512)
    const hills = (x: number, y: number) => 1200 + 400 * Math.sin(x / 1700) * Math.cos(y / 2300) + 0.01 * x
    const levels = [level(5000, n, hills), level(20000, n, hills), level(80000, nc, hills)]
    const opts = { farHeight: levels[2].minHeight, maxHeight: Math.max(...levels.map((l) => l.maxHeight)) }
    const t0 = performance.now()
    const profile = horizonProfile(levels, 0, 0, receiverHeight(1200, levelCell(levels[0])), opts)
    const ms = performance.now() - t0
    expect(profile.every(Number.isFinite)).toBe(true)
    expect(ms).toBeLessThan(1500)
  })
})

describe('sunlit day', () => {
  it('finds first and last light behind a skyline', () => {
    // 15° skyline in the east half, 5° in the west half.
    const profile = new Float32Array(1440).map((_, i) => (i < 720 ? 15 : 5))
    const day = sunlitDay(profile, '2026-03-20', 'UTC', 0, 0, arcSun)
    // 30·sin(πx) = 15 → x = 1/6 → 08:00; 30·sin(πx) = 5 on the way down → 18:00 − 38.4 min.
    expect(clock(day.firstLight)).toBeCloseTo(480, 1)
    expect(clock(day.lastLight)).toBeCloseTo(1080 - (Math.asin(1 / 6) / Math.PI) * 720, 1)
    expect(day.spans).toHaveLength(1)
    expect(day.sunlitMs).toBe(day.lastLight! - day.firstLight!)
  })

  it('splits the day when a peak hides the sun at noon', () => {
    const profile = new Float32Array(1440).map((_, i) => (Math.abs(i / 4 - 180) <= 5 ? 40 : 0))
    const day = sunlitDay(profile, '2026-03-20', 'UTC', 0, 0, arcSun)
    expect(day.spans).toHaveLength(2)
    // Azimuth 175° → 185° is 40 minutes of sun motion (plus a bin of interpolation).
    expect((day.spans[1].start - day.spans[0].end) / 60000).toBeGreaterThan(39.5)
    expect((day.spans[1].start - day.spans[0].end) / 60000).toBeLessThan(41.5)
    expect(clock(day.firstLight)).toBeCloseTo(360, 0)
    expect(clock(day.lastLight)).toBeCloseTo(1080, 0)
  })

  it('reports no direct sun when the skyline is higher than the sun all day', () => {
    const day = sunlitDay(new Float32Array(1440).fill(35), '2026-03-20', 'UTC', 0, 0, arcSun)
    expect(day.spans).toEqual([])
    expect(day.firstLight).toBeNull()
    expect(day.lastLight).toBeNull()
    expect(day.sunlitMs).toBe(0)
  })

  it('has no rise or set under the midnight sun', () => {
    const always = (): SunPosition => ({ azimuth: 0, altitude: 10 })
    const day = sunlitDay(new Float32Array(1440), '2026-06-21', 'UTC', 78, 15, always)
    expect(day.firstLight).toBeNull()
    expect(day.lastLight).toBeNull()
    expect(day.sunlitMs).toBe(24 * 3600000)
  })

  it('matches the flat-horizon sunrise and sunset on open ground', () => {
    // Real sun, Vienna; a 0° skyline. Center-of-disc vs. upper-limb timing differs by ~1 min.
    const profile = new Float32Array(1440)
    const flat = sunDay('2026-11-21', 'Europe/Vienna', 48.2, 16.37)
    const day = sunlitDay(profile, '2026-11-21', 'Europe/Vienna', 48.2, 16.37)
    expect(Math.abs(day.firstLight! - flat.sunrise!) / 60000).toBeLessThan(2.5)
    expect(Math.abs(day.lastLight! - flat.sunset!) / 60000).toBeLessThan(2.5)
    expect(day.firstLight!).toBeGreaterThan(flat.sunrise!)
    expect(day.lastLight!).toBeLessThan(flat.sunset!)
  })
})

describe('sunlit bands for the time slider', () => {
  it('converts periods to local minutes, ending periods that run past midnight at 1440', () => {
    const at = (minutes: number) => zonedToUtc('2026-11-21', minutes, 'Europe/Vienna')
    const spans = [
      { start: at(451), end: at(600) },
      { start: at(640), end: at(961) },
      { start: at(1400), end: zonedToUtc('2026-11-22', 0, 'Europe/Vienna') }
    ]
    expect(sunlitBands(spans, '2026-11-21', 'Europe/Vienna')).toEqual([
      [451, 600],
      [640, 961],
      [1400, 1440]
    ])
  })
})
