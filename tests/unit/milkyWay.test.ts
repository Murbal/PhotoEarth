import * as Astronomy from 'astronomy-engine'
import { describe, expect, it } from 'vitest'
import type { WeatherSeries } from '@shared/types'
import { GALACTIC_CORE } from '@renderer/lib/celestial'
import {
  archFraming,
  archFramingLabel,
  astroNight,
  CORE_REGION_HALF_LON,
  coreVisibilityStatus,
  GALACTIC_CENTER_DEC_DEG,
  GALACTIC_CENTER_DIST_LY,
  GALACTIC_CENTER_RA_HOURS,
  galacticCoreDay,
  galacticCorePosition,
  galacticCoreState,
  intersectSpans,
  LOW_MOON_ILLUMINATION,
  milkyWayArch,
  spanDurationMs
} from '@renderer/lib/milkyWay'
import { moonPosition } from '@renderer/lib/moon'
import { createHorizon, traceHorizon } from '@renderer/lib/panorama'
import { geometricAltitude } from '@renderer/lib/sun'
import type { ShadowLevel } from '@renderer/lib/terrainShadow'
import { addDays, zonedToUtc } from '@renderer/lib/time'

const DEG = Math.PI / 180
const HOUR = 3_600_000

function angleDiff(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180)
}

const LOCATIONS = [
  { name: 'Zurich', lat: 47.3769, lon: 8.5417, tz: 'Europe/Zurich' },
  { name: 'Yosemite Valley', lat: 37.7456, lon: -119.5936, tz: 'America/Los_Angeles' },
  { name: 'Quito', lat: -0.1807, lon: -78.4678, tz: 'America/Guayaquil' },
  { name: 'Sydney', lat: -33.8688, lon: 151.2093, tz: 'Australia/Sydney' },
  { name: 'Reykjavik', lat: 64.1466, lon: -21.9426, tz: 'Atlantic/Reykjavik' },
  { name: 'Kathmandu', lat: 27.7172, lon: 85.324, tz: 'Asia/Kathmandu' }
]

function flatLevel(half: number, n: number, fn: (x: number, y: number) => number): ShadowLevel {
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

function constantWeather(startUtc: number, hours: number, low: number, mid: number, high: number): WeatherSeries {
  const fill = (v: number) => Array.from({ length: hours }, () => v)
  return {
    latitude: 37.75,
    longitude: -119.59,
    elevation: 1200,
    time: Array.from({ length: hours }, (_, i) => startUtc + i * HOUR),
    cloudLow: fill(low),
    cloudMid: fill(mid),
    cloudHigh: fill(high),
    visibility: fill(30_000),
    windSpeed: fill(2),
    windGusts: fill(4),
    windDirection: fill(270),
    precipitationProbability: fill(0),
    precipitation: fill(0),
    temperature: fill(10),
    dewPoint: fill(2),
    humidity: fill(55),
    weatherCode: fill(0)
  }
}

describe('Galactic Center (Sagittarius A*) position', () => {
  it('matches DefineStar + Equator + Horizon within 0.02° across six locations over a year', () => {
    Astronomy.DefineStar(Astronomy.Body.Star2, GALACTIC_CENTER_RA_HOURS, GALACTIC_CENTER_DEC_DEG, GALACTIC_CENTER_DIST_LY)
    let worstAlt = 0
    let worstAz = 0
    for (const loc of LOCATIONS) {
      const obs = new Astronomy.Observer(loc.lat, loc.lon, 0)
      for (let h = 0; h < 24 * 365; h += 73) {
        const t = Date.UTC(2026, 0, 1) + h * HOUR
        const eq = Astronomy.Equator(Astronomy.Body.Star2, new Date(t), obs, true, true)
        const ref = Astronomy.Horizon(new Date(t), obs, eq.ra, eq.dec, 'normal')
        const ours = galacticCorePosition(t, loc.lat, loc.lon)
        worstAlt = Math.max(worstAlt, Math.abs(ours.altitude - ref.altitude))
        if (Math.abs(ref.altitude) < 85) {
          worstAz = Math.max(worstAz, angleDiff(ours.azimuth, ref.azimuth) * Math.cos(ref.altitude * DEG))
        }
      }
    }
    expect(worstAlt).toBeLessThan(0.02)
    expect(worstAz).toBeLessThan(0.02)
  })

  it('agrees with the CelestialBody interface', () => {
    const t = Date.UTC(2026, 6, 15, 22, 0)
    expect(GALACTIC_CORE.id).toBe('galacticCore')
    expect(GALACTIC_CORE.position(t, 46.5, 7.9)).toEqual(galacticCorePosition(t, 46.5, 7.9))
    expect(GALACTIC_CORE.day('2026-07-15', 'Europe/Zurich', 46.5, 7.9)).toEqual(galacticCoreDay('2026-07-15', 'Europe/Zurich', 46.5, 7.9))
  })
})

describe('Galactic Core rise, transit and set', () => {
  it('keeps all events inside the local day across six time zones and hemispheres', () => {
    for (const loc of LOCATIONS) {
      if (loc.lat > 61) continue // never rises (tested separately below)
      const date = '2026-07-15'
      const day = galacticCoreDay(date, loc.tz, loc.lat, loc.lon)
      const start = zonedToUtc(date, 0, loc.tz)
      const end = zonedToUtc(addDays(date, 1), 0, loc.tz)
      expect(day.polar).toBeNull()
      for (const t of [day.rise, day.set, day.transit]) {
        expect(t, `${loc.name}`).not.toBeNull()
        expect(t!).toBeGreaterThanOrEqual(start)
        expect(t!).toBeLessThan(end)
      }
      const atRise = galacticCorePosition(day.rise!, loc.lat, loc.lon)
      const atSet = galacticCorePosition(day.set!, loc.lat, loc.lon)
      const atTransit = galacticCorePosition(day.transit!, loc.lat, loc.lon)
      expect(Math.abs(atRise.altitude), `${loc.name} rise alt`).toBeLessThan(0.1)
      expect(Math.abs(atSet.altitude), `${loc.name} set alt`).toBeLessThan(0.1)
      expect(atRise.azimuth).toBeLessThan(180)
      expect(atSet.azimuth).toBeGreaterThan(180)
      expect(day.transitAltitude).toBeCloseTo(atTransit.altitude, 1)
      // Theoretical max altitude ≈ 90° − |lat − dec| (+ refraction).
      const expectedMax = 90 - Math.abs(loc.lat - GALACTIC_CENTER_DEC_DEG)
      expect(Math.abs(atTransit.altitude - expectedMax), `${loc.name} transit`).toBeLessThan(0.25)
      // Transits due South north of Dec −29°, due North south of Dec −29°.
      const expectedAz = loc.lat > GALACTIC_CENTER_DEC_DEG ? 180 : 0
      expect(angleDiff(atTransit.azimuth, expectedAz), `${loc.name} transit az`).toBeLessThan(0.3)
    }
  })

  it('handles latitudes where the core never rises and where it is circumpolar', () => {
    const tromso = galacticCoreDay('2026-07-15', 'Europe/Oslo', 69.6492, 18.9553)
    expect(tromso.polar).toBe('down')
    expect(tromso.rise).toBeNull()
    expect(tromso.set).toBeNull()
    expect(tromso.transit).not.toBeNull()
    expect(tromso.transitAltitude!).toBeLessThan(-7)

    const reykjavik = galacticCoreDay('2026-07-15', 'Atlantic/Reykjavik', 64.1466, -21.9426)
    expect(reykjavik.polar).toBe('down')
    expect(reykjavik.transitAltitude!).toBeLessThan(-2)

    const mcmurdo = galacticCoreDay('2026-07-15', 'Antarctica/McMurdo', -77.8463, 166.6682)
    expect(mcmurdo.polar).toBe('up')
    expect(mcmurdo.rise).toBeNull()
    expect(mcmurdo.set).toBeNull()
    expect(mcmurdo.transitAltitude!).toBeGreaterThan(40)
  })

  it('covers 23-hour and 25-hour DST days accurately', () => {
    for (const [date, tz, lat, lon, expectedHours] of [
      ['2026-03-29', 'Europe/Zurich', 47.3769, 8.5417, 23],
      ['2026-10-25', 'Europe/Zurich', 47.3769, 8.5417, 25],
      ['2026-03-08', 'America/Los_Angeles', 37.7456, -119.5936, 23],
      ['2026-11-01', 'America/Los_Angeles', 37.7456, -119.5936, 25]
    ] as const) {
      const start = zonedToUtc(date, 0, tz)
      const end = zonedToUtc(addDays(date, 1), 0, tz)
      expect((end - start) / HOUR).toBe(expectedHours)
      const day = galacticCoreDay(date, tz, lat, lon)
      expect(day.polar).toBeNull()
      for (const t of [day.rise, day.set, day.transit]) {
        if (t !== null) {
          expect(t).toBeGreaterThanOrEqual(start)
          expect(t).toBeLessThan(end)
        }
      }
    }
  })
})

describe('Milky Way arch and elevation / tilt metrics', () => {
  it('samples the Galactic Plane with l = 0° at the Galactic Center and marks the bright core region', () => {
    const t = Date.UTC(2026, 6, 15, 22, 0)
    const arch = milkyWayArch(t, 37.7456, -119.5936, 5)
    expect(arch[0].galacticLon).toBe(-180)
    expect(arch[arch.length - 1].galacticLon).toBe(180)
    const center = arch.find((p) => p.galacticLon === 0)!
    const sgr = galacticCorePosition(t, 37.7456, -119.5936)
    // IAU 1958 (l=0, b=0) sits ~0.07° from Sagittarius A*.
    expect(Math.abs(center.altitude - sgr.altitude)).toBeLessThan(0.15)
    expect(angleDiff(center.azimuth, sgr.azimuth) * Math.cos(sgr.altitude * DEG)).toBeLessThan(0.15)
    for (const p of arch) {
      expect(p.isCoreRegion).toBe(Math.abs(p.galacticLon) <= CORE_REGION_HALF_LON)
      expect(p.azimuth).toBeGreaterThanOrEqual(0)
      expect(p.azimuth).toBeLessThan(360)
      expect(p.altitude).toBeGreaterThanOrEqual(-90)
      expect(p.altitude).toBeLessThanOrEqual(90)
    }
  })

  it('computes analytical arch elevation, apex azimuth and core tilt matching the sampled arch', () => {
    for (const [t, lat, lon] of [
      [Date.UTC(2026, 3, 15, 9, 0), 37.7456, -119.5936], // spring pre-dawn low arch in Yosemite
      [Date.UTC(2026, 6, 15, 6, 0), 37.7456, -119.5936], // summer night high arch in Yosemite
      [Date.UTC(2026, 6, 15, 13, 0), -33.8688, 151.2093], // southern hemisphere Sydney
      [Date.UTC(2026, 6, 15, 12, 9), -29.0078, 151.2] // near-zenith pass (must never NaN)
    ]) {
      const state = galacticCoreState(t, lat, lon)
      expect(Number.isFinite(state.archElevation)).toBe(true)
      expect(Number.isFinite(state.coreTilt)).toBe(true)
      expect(state.archElevation).toBeGreaterThanOrEqual(0)
      expect(state.archElevation).toBeLessThanOrEqual(90)
      expect(state.coreTilt).toBeGreaterThanOrEqual(0)
      expect(state.coreTilt).toBeLessThanOrEqual(90)

      const fine = milkyWayArch(t, lat, lon, 1)
      const peak = fine.reduce((a, b) => (b.altitude > a.altitude ? b : a))
      // Refraction lifts low apexes slightly; allow 0.7°.
      expect(Math.abs(state.archElevation - peak.altitude)).toBeLessThan(0.7)
      if (state.archElevation < 85 && state.archElevation > 5) {
        expect(angleDiff(state.archApexAzimuth, peak.azimuth)).toBeLessThan(2)
      }
      // Finite-difference check on core tilt away from zenith.
      if (Math.abs(state.altitude) < 80) {
        const pMinus = fine.find((p) => p.galacticLon === -1)!
        const pPlus = fine.find((p) => p.galacticLon === 1)!
        const dAz = ((((pPlus.azimuth - pMinus.azimuth + 180) % 360) + 360) % 360) - 180
        const dH = dAz * Math.cos(state.altitude * DEG)
        const dV = pPlus.altitude - pMinus.altitude
        const numericTilt = (Math.atan2(Math.abs(dV), Math.abs(dH)) * 180) / Math.PI
        expect(Math.abs(state.coreTilt - numericTilt)).toBeLessThan(1.5)
      }
    }
    expect(archFraming(25)).toBe('horizontal')
    expect(archFraming(50)).toBe('diagonal')
    expect(archFraming(75)).toBe('vertical')
    expect(archFramingLabel('horizontal')).toBe('Horizontal pano')
  })
})

describe('Astro Dark-Window intersections', () => {
  it('intersects interval lists accurately', () => {
    expect(
      intersectSpans(
        [
          { start: 0, end: 10 },
          { start: 20, end: 30 }
        ],
        [
          { start: 5, end: 25 },
          { start: 28, end: 35 }
        ]
      )
    ).toEqual([
      { start: 5, end: 10 },
      { start: 20, end: 25 },
      { start: 28, end: 30 }
    ])
    expect(spanDurationMs([{ start: 100, end: 250 }, { start: 300, end: 400 }])).toBe(250)
  })

  it('finds a long moonless Galactic Core dark window on a summer new moon in Yosemite', () => {
    // 2026-07-14 is New Moon — prime Milky Way night in Yosemite.
    const night = astroNight('2026-07-14', 'America/Los_Angeles', 37.7456, -119.5936, { minCoreAltitude: 5 })
    expect(night.astroDark.length).toBeGreaterThanOrEqual(1)
    expect(night.moonlessDark.length).toBeGreaterThanOrEqual(1)
    expect(night.coreDarkWindows.length).toBeGreaterThanOrEqual(1)
    expect(night.totalCoreDarkMs).toBeGreaterThan(3 * HOUR)
    expect(night.peakCore).not.toBeNull()
    expect(night.peakCore!.altitude).toBeGreaterThan(22)
    // Every point inside coreDarkWindows must be astronomically dark, moonless, and core >= 5°.
    for (const w of night.coreDarkWindows) {
      const mid = (w.start + w.end) / 2
      expect(geometricAltitude(mid, 37.7456, -119.5936)).toBeLessThan(-18)
      expect(moonPosition(mid, 37.7456, -119.5936).altitude).toBeLessThanOrEqual(0.2)
      expect(galacticCorePosition(mid, 37.7456, -119.5936).altitude).toBeGreaterThanOrEqual(4.8)
    }
    expect(night.rating).toBe('great')
  })

  it('blocks moonlit nights on a full moon and supports optional low-moon allowance', () => {
    // 2026-06-30 is Full Moon — moon is up all astronomical night in Yosemite.
    const full = astroNight('2026-06-29', 'America/Los_Angeles', 37.7456, -119.5936, { minCoreAltitude: 5 })
    expect(full.totalAstroDarkMs).toBeGreaterThan(4 * HOUR)
    expect(full.totalMoonlessDarkMs).toBeLessThan(30 * 60_000)
    expect(full.rating).toBe('poor')

    // 2026-07-16 is a thin waxing crescent (~5% illuminated) setting shortly after dusk.
    const strict = astroNight('2026-07-16', 'America/Los_Angeles', 37.7456, -119.5936, { maxMoonIllumination: 0 })
    const lenient = astroNight('2026-07-16', 'America/Los_Angeles', 37.7456, -119.5936, { maxMoonIllumination: LOW_MOON_ILLUMINATION })
    expect(lenient.totalMoonlessDarkMs).toBeGreaterThanOrEqual(strict.totalMoonlessDarkMs)
  })

  it('handles southern hemisphere winter, high-latitude white nights, and core-never-rises winters', () => {
    // Atacama / Sydney in July new moon: high overhead core and long dark night.
    const sydney = astroNight('2026-07-14', 'Australia/Sydney', -33.8688, 151.2093, { minCoreAltitude: 10 })
    expect(sydney.totalCoreDarkMs).toBeGreaterThan(6 * HOUR)
    expect(sydney.peakCore!.altitude).toBeGreaterThan(80)

    // Reykjavik solstice: no astronomical night at all.
    const reykjavikSummer = astroNight('2026-06-21', 'Atlantic/Reykjavik', 64.1466, -21.9426)
    expect(reykjavikSummer.astroDark).toEqual([])
    expect(reykjavikSummer.coreDarkWindows).toEqual([])
    expect(reykjavikSummer.darkestSunAltitude).toBeGreaterThan(-18)
    expect(reykjavikSummer.rating).toBe('poor')

    // Tromsø winter solstice: long dark sky, but Galactic Core never rises.
    const tromsoWinter = astroNight('2026-12-10', 'Europe/Oslo', 69.6492, 18.9553, { minCoreAltitude: 0 })
    expect(tromsoWinter.totalAstroDarkMs).toBeGreaterThan(10 * HOUR)
    expect(tromsoWinter.coreVisible).toEqual([])
    expect(tromsoWinter.coreDarkWindows).toEqual([])
  })

  it('handles DST spring-forward and fall-back nights cleanly', () => {
    const spring = astroNight('2026-03-07', 'America/Los_Angeles', 37.7456, -119.5936)
    expect((spring.nightEnd - spring.nightStart) / HOUR).toBe(23)
    const fall = astroNight('2026-10-31', 'America/Los_Angeles', 37.7456, -119.5936)
    expect((fall.nightEnd - fall.nightStart) / HOUR).toBe(25)
    for (const n of [spring, fall]) {
      for (const w of [...n.astroDark, ...n.moonlessDark, ...n.coreDarkWindows]) {
        expect(w.start).toBeGreaterThanOrEqual(n.nightStart)
        expect(w.end).toBeLessThanOrEqual(n.nightEnd)
        expect(w.end).toBeGreaterThan(w.start)
      }
      expect(n.totalCoreDarkMs).toBeLessThanOrEqual(n.totalMoonlessDarkMs + 1000)
      expect(n.totalMoonlessDarkMs).toBeLessThanOrEqual(n.totalAstroDarkMs + 1000)
    }
  })

  it('respects a Horizon Panorama skyline when provided', () => {
    // A tall southern ridge (26° apparent altitude in the south) hides the core in Yosemite (max 23.3°).
    const southWall = (x: number, y: number) => (y < -2000 && Math.abs(x) < 12000 ? 4000 : 0)
    const h = createHorizon(1.7)
    traceHorizon(h, [flatLevel(10000, 120, southWall)])
    const flatNight = astroNight('2026-07-14', 'America/Los_Angeles', 37.7456, -119.5936, { minCoreAltitude: 5 })
    const blockedNight = astroNight('2026-07-14', 'America/Los_Angeles', 37.7456, -119.5936, { minCoreAltitude: 5, horizon: h })
    expect(blockedNight.skylineAware).toBe(true)
    expect(flatNight.skylineAware).toBe(false)
    expect(blockedNight.totalCoreDarkMs).toBeLessThan(flatNight.totalCoreDarkMs)
  })

  it('integrates Open-Meteo cloud cover into sky clarity and night rating', () => {
    const start = zonedToUtc('2026-07-14', 0, 'America/Los_Angeles')
    const clear = astroNight('2026-07-14', 'America/Los_Angeles', 37.7456, -119.5936, {
      weather: constantWeather(start, 48, 0, 5, 5)
    })
    expect(clear.clouds?.clarity).toBe('clear')
    expect(clear.clouds?.meanCloud).toBeLessThan(15)
    expect(clear.clouds?.bestUtc).not.toBeNull()
    expect(clear.rating).toBe('great')

    const cloudy = astroNight('2026-07-14', 'America/Los_Angeles', 37.7456, -119.5936, {
      weather: constantWeather(start, 48, 85, 60, 40)
    })
    expect(cloudy.clouds?.clarity).toBe('cloudy')
    expect(cloudy.clouds?.meanCloud).toBeGreaterThan(80)
    expect(cloudy.rating).toBe('poor')

    // Weather from another month returns null clouds cleanly.
    const outOfRange = astroNight('2026-07-14', 'America/Los_Angeles', 37.7456, -119.5936, {
      weather: constantWeather(Date.UTC(2026, 0, 1), 48, 0, 0, 0)
    })
    expect(outOfRange.clouds).toBeNull()
  })

  it('reports accurate live core visibility statuses', () => {
    expect(coreVisibilityStatus(Date.UTC(2026, 6, 15, 6, 0), 69.65, 18.95, { polar: 'down' }).kind).toBe('never')
    // Yosemite 2026-07-14 at peak core (~06:00 UTC = 23:00 PDT, new moon): visible in dark sky.
    const night = astroNight('2026-07-14', 'America/Los_Angeles', 37.7456, -119.5936, { minCoreAltitude: 5 })
    expect(coreVisibilityStatus(night.peakCore!.utc, 37.7456, -119.5936, { minCoreAltitude: 5 }).kind).toBe('visible')
    expect(coreVisibilityStatus(night.peakCore!.utc, 37.7456, -119.5936, { minCoreAltitude: 30 }).kind).toBe('low')
    // Noon local when core is below horizon.
    const noon = zonedToUtc('2026-07-14', 720, 'America/Los_Angeles')
    expect(coreVisibilityStatus(noon, 37.7456, -119.5936).kind).toBe('below')
    // Full moon peak night: moonlit.
    const fullPeak = astroNight('2026-06-29', 'America/Los_Angeles', 37.7456, -119.5936, { minCoreAltitude: 5 }).nightCorePeak!
    expect(coreVisibilityStatus(fullPeak.utc, 37.7456, -119.5936, { minCoreAltitude: 5 }).kind).toBe('moonlit')
  })

  it('computes 16-day astro outlook quickly enough for the forecast strip', () => {
    const t0 = performance.now()
    let date = '2026-07-01'
    for (let i = 0; i < 16; i++, date = addDays(date, 1)) {
      astroNight(date, 'America/Los_Angeles', 37.7456, -119.5936, { stepMinutes: 10 })
    }
    expect(performance.now() - t0).toBeLessThan(300)
  })
})
