import * as Astronomy from 'astronomy-engine'
import { getMoonIllumination, getMoonPosition, getMoonTimes } from 'suncalc'
import { describe, expect, it } from 'vitest'
import { MOON, SUN } from '@renderer/lib/celestial'
import { moonDay, moonEarthFixed, moonPosition, moonState, nextPhases, phaseName, skyBearing } from '@renderer/lib/moon'
import { sunDay, sunPosition } from '@renderer/lib/sun'
import { addDays, offsetMinutes, zonedToUtc } from '@renderer/lib/time'

// The moon runs on astronomy-engine. SunCalc (an independent, much simpler series with its own
// parallax and rise/set search) cross-checks the glue: frames, day windows and time zones.

const DEG = Math.PI / 180

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

/** WGS84 geodetic → ECEF, meters. */
function ecef(lat: number, lon: number): [number, number, number] {
  const a = 6378137
  const e2 = 6.69437999014e-3
  const s = Math.sin(lat * DEG)
  const n = a / Math.sqrt(1 - e2 * s * s)
  return [n * Math.cos(lat * DEG) * Math.cos(lon * DEG), n * Math.cos(lat * DEG) * Math.sin(lon * DEG), n * (1 - e2) * s]
}

/** Sky position of an Earth-fixed point seen from a place (or, without parallax, from the Earth's center). */
function skyPosition(p: [number, number, number], lat: number, lon: number, fromSurface: boolean) {
  const o = fromSurface ? ecef(lat, lon) : [0, 0, 0]
  const d = [p[0] - o[0], p[1] - o[1], p[2] - o[2]]
  const len = Math.hypot(d[0], d[1], d[2])
  const [sl, cl, sp, cp] = [Math.sin(lon * DEG), Math.cos(lon * DEG), Math.sin(lat * DEG), Math.cos(lat * DEG)]
  const east = -sl * d[0] + cl * d[1]
  const north = -sp * cl * d[0] - sp * sl * d[1] + cp * d[2]
  const up = cp * cl * d[0] + cp * sl * d[1] + sp * d[2]
  return { altitude: Math.asin(up / len) / DEG, azimuth: (Math.atan2(east, north) / DEG + 360) % 360 }
}

describe('moon position', () => {
  it('matches SunCalc within 0.05° over a year (topocentric, refracted)', () => {
    let worst = 0
    for (const loc of LOCATIONS) {
      for (let h = 0; h < 24 * 365; h += 41) {
        const t = Date.UTC(2026, 0, 1) + h * 3600_000
        const ref = getMoonPosition(new Date(t), loc.lat, loc.lon)
        if (ref.altitude < 3) continue // refraction models diverge right at the horizon
        const ours = moonPosition(t, loc.lat, loc.lon)
        worst = Math.max(worst, Math.abs(ours.altitude - ref.altitude))
        if (ref.altitude < 85) worst = Math.max(worst, angleDiff(ours.azimuth, ref.azimuth))
      }
    }
    expect(worst).toBeLessThan(0.05)
  })

  it('includes parallax: a low moon sits ~1° lower than seen from the Earth’s center', () => {
    for (let h = 0; h < 24 * 30; h += 5) {
      const t = Date.UTC(2026, 2, 1) + h * 3600_000
      const observer = new Astronomy.Observer(47.3769, 8.5417, 0)
      const m = moonEarthFixed(t)
      const topocentric = skyPosition(m, 47.3769, 8.5417, true)
      const geocentric = skyPosition(m, 47.3769, 8.5417, false)
      if (topocentric.altitude < 0 || topocentric.altitude > 20) continue
      const parallax = geocentric.altitude - topocentric.altitude
      expect(parallax).toBeGreaterThan(0.8)
      expect(parallax).toBeLessThan(1.02)
      const eq = Astronomy.Equator(Astronomy.Body.Moon, new Date(t), observer, true, false)
      expect(Math.abs(Astronomy.Horizon(new Date(t), observer, eq.ra, eq.dec).altitude - topocentric.altitude)).toBeLessThan(0.01)
    }
    const s = moonState(Date.UTC(2026, 2, 4, 7, 0), 47.3769, 8.5417)
    expect(s.distanceKm).toBeGreaterThan(356_000)
    expect(s.distanceKm).toBeLessThan(407_000)
  })

  it('agrees with the CelestialBody interface', () => {
    const t = Date.UTC(2026, 5, 1, 22, 0)
    expect(MOON.id).toBe('moon')
    expect(MOON.position(t, 46.5, 7.9)).toEqual(moonPosition(t, 46.5, 7.9))
    expect(SUN.position(t, 46.5, 7.9)).toEqual(sunPosition(t, 46.5, 7.9))
    const sun = SUN.day('2026-06-21', 'Europe/Zurich', 47.3769, 8.5417)
    const ref = sunDay('2026-06-21', 'Europe/Zurich', 47.3769, 8.5417)
    expect(sun).toEqual({ rise: ref.sunrise, set: ref.sunset, transit: ref.solarNoon, transitAltitude: ref.noonAltitude, polar: null })
    expect(SUN.day('2026-06-21', 'Europe/Oslo', 69.6492, 18.9553).polar).toBe('up')
  })
})

describe('moon in Earth-fixed axes (drives the rendered moon)', () => {
  it('points where the topocentric sky position says, within 0.01°', () => {
    let worst = 0
    for (const loc of LOCATIONS) {
      for (let h = 0; h < 24 * 60; h += 7) {
        const t = Date.UTC(2026, 3, 1) + h * 3600_000
        const { altitude, azimuth } = skyPosition(moonEarthFixed(t), loc.lat, loc.lon, true)
        const observer = new Astronomy.Observer(loc.lat, loc.lon, 0)
        const eq = Astronomy.Equator(Astronomy.Body.Moon, new Date(t), observer, true, false)
        const ref = Astronomy.Horizon(new Date(t), observer, eq.ra, eq.dec)
        worst = Math.max(worst, Math.abs(altitude - ref.altitude))
        if (ref.altitude < 85) worst = Math.max(worst, angleDiff(azimuth, ref.azimuth) * Math.cos(altitude * DEG))
      }
    }
    expect(worst).toBeLessThan(0.01)
  })
})

describe('moon phase', () => {
  it('finds the full and new moons of the 2026 eclipses', () => {
    // Total lunar eclipse 2026-03-03 (full moon 11:38 UTC), total solar eclipse 2026-08-12 (new moon 17:37 UTC).
    const full = nextPhases(Date.UTC(2026, 2, 1)).fullMoon as number
    const newMoon = nextPhases(Date.UTC(2026, 7, 1)).newMoon as number
    expect(Math.abs(full - Date.UTC(2026, 2, 3, 11, 38))).toBeLessThan(5 * 60_000)
    expect(Math.abs(newMoon - Date.UTC(2026, 7, 12, 17, 37))).toBeLessThan(5 * 60_000)
    const atFull = moonState(full, 47.3769, 8.5417)
    expect(atFull.illumination).toBeGreaterThan(0.99)
    expect(atFull.phaseName).toBe('Full moon')
    const atNew = moonState(newMoon, 47.3769, 8.5417)
    expect(atNew.illumination).toBeLessThan(0.01)
    expect(atNew.phaseName).toBe('New moon')
    // Searching from the instant itself still finds it, then the next one a lunation later.
    expect(nextPhases(full).fullMoon).toBeCloseTo(full, -4)
    expect((nextPhases(full + 60_000).fullMoon as number) - full).toBeGreaterThan(29 * 86_400_000)
  })

  it('matches SunCalc’s illuminated fraction', () => {
    let worst = 0
    for (let h = 0; h < 24 * 365; h += 13) {
      const t = Date.UTC(2026, 0, 1) + h * 3600_000
      worst = Math.max(worst, Math.abs(moonState(t, 0, 0).illumination - getMoonIllumination(new Date(t)).fraction))
    }
    expect(worst).toBeLessThan(0.005)
  })

  it('names the phases', () => {
    expect(phaseName(0)).toBe('New moon')
    expect(phaseName(358)).toBe('New moon')
    expect(phaseName(20)).toBe('Waxing crescent')
    expect(phaseName(92)).toBe('First quarter')
    expect(phaseName(120)).toBe('Waxing gibbous')
    expect(phaseName(178)).toBe('Full moon')
    expect(phaseName(200)).toBe('Waning gibbous')
    expect(phaseName(270)).toBe('Last quarter')
    expect(phaseName(300)).toBe('Waning crescent')
  })

  it('orients the lit limb as seen in the sky', () => {
    expect(skyBearing({ azimuth: 180, altitude: 30 }, { azimuth: 180, altitude: 60 })).toBeCloseTo(0)
    expect(skyBearing({ azimuth: 180, altitude: 0 }, { azimuth: 200, altitude: 0 })).toBeCloseTo(90)
    expect(skyBearing({ azimuth: 180, altitude: 30 }, { azimuth: 180, altitude: 0 })).toBeCloseTo(180)
    // Evening crescent: lit on the right in the north, on the bottom-left in the south.
    const zurich = moonState(Date.UTC(2026, 7, 15, 19, 30), 47.3769, 8.5417)
    const sydney = moonState(Date.UTC(2026, 7, 15, 9, 0), -33.8688, 151.2093)
    expect(Math.sin(zurich.brightLimb * DEG)).toBeGreaterThan(0.9)
    expect(Math.sin(sydney.brightLimb * DEG)).toBeLessThan(0)
    // SunCalc: zenith angle of the bright limb = parallactic angle − position angle (Meeus 48.5).
    for (const [t, lat, lon] of [
      [Date.UTC(2026, 7, 15, 19, 30), 47.3769, 8.5417],
      [Date.UTC(2026, 7, 15, 9, 0), -33.8688, 151.2093],
      [Date.UTC(2026, 9, 2, 3, 0), 37.7456, -119.5936]
    ]) {
      const ref = getMoonPosition(new Date(t), lat, lon).parallacticAngle - getMoonIllumination(new Date(t)).angle
      expect(angleDiff(moonState(t, lat, lon).brightLimb, ref)).toBeLessThan(2)
    }
  })
})

describe('moonrise / moonset', () => {
  it('matches SunCalc within a minute for 60 days in six time zones', () => {
    let compared = 0
    for (const loc of LOCATIONS) {
      let date = '2026-10-01'
      for (let d = 0; d < 60; d++, date = addDays(date, 1)) {
        // SunCalc scans a fixed 24 h, so it can't follow a 23 or 25 h day (tested below).
        if (zonedToUtc(addDays(date, 1), 0, loc.tz) - zonedToUtc(date, 0, loc.tz) !== 86_400_000) continue
        const ours = moonDay(date, loc.tz, loc.lat, loc.lon)
        const noon = zonedToUtc(date, 720, loc.tz)
        const ref = getMoonTimes(new Date(noon), loc.lat, loc.lon, offsetMinutes(noon, loc.tz))
        for (const [x, y] of [
          [ours.rise, ref.rise],
          [ours.set, ref.set],
          [ours.transit, ref.transit]
        ] as const) {
          // A rise a few seconds from midnight may fall on either side in the other model.
          if (x === null || !y) {
            const edge = x ?? y?.getTime()
            if (edge !== undefined) {
              const m = Math.min(Math.abs(edge - zonedToUtc(date, 0, loc.tz)), Math.abs(edge - zonedToUtc(addDays(date, 1), 0, loc.tz)))
              expect(m, `${loc.name} ${date}`).toBeLessThan(5 * 60_000)
            }
            continue
          }
          expect(Math.abs(x - y.getTime()), `${loc.name} ${date}`).toBeLessThan(60_000)
          compared++
        }
      }
    }
    expect(compared).toBeGreaterThan(900)
  })

  it('keeps every event inside the local day and skips one rise and one set a month', () => {
    let date = '2026-07-01'
    let noRise = 0
    let noSet = 0
    for (let d = 0; d < 31; d++, date = addDays(date, 1)) {
      const day = moonDay(date, 'Europe/Zurich', 47.3769, 8.5417)
      const start = zonedToUtc(date, 0, 'Europe/Zurich')
      const end = zonedToUtc(addDays(date, 1), 0, 'Europe/Zurich')
      for (const t of [day.rise, day.set, day.transit]) {
        if (t !== null) {
          expect(t).toBeGreaterThanOrEqual(start)
          expect(t).toBeLessThan(end)
        }
      }
      if (day.rise === null) noRise++
      if (day.set === null) noSet++
      expect(day.polar).toBeNull()
      if (day.rise !== null) {
        // Upper limb on the horizon: the center sits about a semi-diameter below it.
        const p = moonPosition(day.rise, 47.3769, 8.5417)
        expect(p.altitude).toBeGreaterThan(-0.6)
        expect(p.altitude).toBeLessThan(0.1)
        expect(p.azimuth).toBeLessThan(180)
      }
      if (day.set !== null) expect(moonPosition(day.set, 47.3769, 8.5417).azimuth).toBeGreaterThan(180)
      if (day.transit !== null) {
        expect(day.transitAltitude).toBeCloseTo(moonPosition(day.transit, 47.3769, 8.5417).altitude, 2)
        expect(angleDiff(moonPosition(day.transit, 47.3769, 8.5417).azimuth, 180)).toBeLessThan(0.1)
      }
    }
    expect(noRise).toBeGreaterThanOrEqual(1)
    expect(noSet).toBeGreaterThanOrEqual(1)
  })

  it('covers the whole local day when the clocks change', () => {
    // Zurich, 2026-10-25: a 25-hour day from 00:00 CEST to 24:00 CET.
    const start = zonedToUtc('2026-10-25', 0, 'Europe/Zurich')
    const end = zonedToUtc('2026-10-26', 0, 'Europe/Zurich')
    expect(end - start).toBe(25 * 3600_000)
    const observer = new Astronomy.Observer(47.3769, 8.5417, 0)
    const day = moonDay('2026-10-25', 'Europe/Zurich', 47.3769, 8.5417)
    for (const [t, dir] of [[day.rise, +1], [day.set, -1]] as const) {
      const ref = Astronomy.SearchRiseSet(Astronomy.Body.Moon, observer, dir, new Date(start), 25 / 24)
      expect(t).toBe(ref ? ref.date.getTime() : null)
    }
  })

  it('reports a moon that stays up or down all day at high latitudes', () => {
    let date = '2026-01-01'
    const seen = new Set<string | null>()
    for (let d = 0; d < 30; d++, date = addDays(date, 1)) {
      const day = moonDay(date, 'Arctic/Longyearbyen', 78.2232, 15.6267)
      seen.add(day.polar)
      if (day.polar) {
        expect(day.rise).toBeNull()
        expect(day.set).toBeNull()
        const noon = moonPosition(zonedToUtc(date, 720, 'Arctic/Longyearbyen'), 78.2232, 15.6267)
        expect(noon.altitude > 0).toBe(day.polar === 'up')
      }
    }
    expect(seen.has('up')).toBe(true)
    expect(seen.has('down')).toBe(true)
  })
})
