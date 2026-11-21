import * as Astronomy from 'astronomy-engine'
import { describe, expect, it } from 'vitest'
import { dayBands, geometricAltitude, lightPhase, lightWindows, skyBand, sunDay, sunDirectionENU, sunPosition } from '@renderer/lib/sun'
import { zonedToUtc } from '@renderer/lib/time'

// Independent high-precision reference (astronomy-engine, VSOP87-based, sub-arcminute),
// standing in for the NOAA solar calculator.
function reference(utcMs: number, lat: number, lon: number): { azimuth: number; altitude: number } {
  const observer = new Astronomy.Observer(lat, lon, 0)
  const date = new Date(utcMs)
  const eq = Astronomy.Equator(Astronomy.Body.Sun, date, observer, true, true)
  const hor = Astronomy.Horizon(date, observer, eq.ra, eq.dec, 'normal')
  return { azimuth: hor.azimuth, altitude: hor.altitude }
}

function angleDiff(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180)
}

const LOCATIONS = [
  { name: 'Zurich', lat: 47.3769, lon: 8.5417 },
  { name: 'Yosemite Valley', lat: 37.7456, lon: -119.5936 },
  { name: 'Quito (equator)', lat: -0.1807, lon: -78.4678 },
  { name: 'Sydney', lat: -33.8688, lon: 151.2093 },
  { name: 'Reykjavik', lat: 64.1466, lon: -21.9426 },
  { name: 'Tromsø (polar)', lat: 69.6492, lon: 18.9553 },
  { name: 'Longyearbyen (polar)', lat: 78.2232, lon: 15.6267 },
  { name: 'McMurdo (antarctic)', lat: -77.8419, lon: 166.6863 },
  { name: 'Kathmandu', lat: 27.7172, lon: 85.324 }
]

const INSTANTS = [
  '2026-03-20T06:00:00Z',
  '2026-06-21T12:00:00Z',
  '2026-06-21T23:30:00Z',
  '2026-09-23T17:45:00Z',
  '2026-12-21T03:15:00Z',
  '2027-01-15T09:00:00Z',
  '2030-07-04T20:10:00Z'
].map((s) => Date.parse(s))

describe('sun position (within ±0.5° of a reference)', () => {
  for (const loc of LOCATIONS) {
    it(`matches the reference at ${loc.name}`, () => {
      for (const t of INSTANTS) {
        const ours = sunPosition(t, loc.lat, loc.lon)
        const ref = reference(t, loc.lat, loc.lon)
        expect(Math.abs(ours.altitude - ref.altitude)).toBeLessThan(0.5)
        // Azimuth is meaningless when the sun is (nearly) at the zenith.
        if (ref.altitude < 85) expect(angleDiff(ours.azimuth, ref.azimuth)).toBeLessThan(0.5)
      }
    })
  }

  it('is much tighter than the requirement in typical conditions', () => {
    let worst = 0
    for (const loc of LOCATIONS) {
      for (let h = 0; h < 24 * 365; h += 37) {
        const t = Date.UTC(2026, 0, 1) + h * 3600_000
        const ref = reference(t, loc.lat, loc.lon)
        if (ref.altitude < 2) continue // refraction models diverge right at the horizon
        const ours = sunPosition(t, loc.lat, loc.lon)
        worst = Math.max(worst, Math.abs(ours.altitude - ref.altitude))
        if (ref.altitude < 85) worst = Math.max(worst, angleDiff(ours.azimuth, ref.azimuth))
      }
    }
    expect(worst).toBeLessThan(0.1)
  })

  it('uses compass azimuths (0 = north, 90 = east)', () => {
    // Zurich, 2026-06-21: morning sun in the north-east, evening sun in the north-west.
    const morning = sunPosition(Date.parse('2026-06-21T04:30:00Z'), 47.3769, 8.5417)
    const noon = sunPosition(Date.parse('2026-06-21T11:30:00Z'), 47.3769, 8.5417)
    const evening = sunPosition(Date.parse('2026-06-21T18:30:00Z'), 47.3769, 8.5417)
    expect(morning.azimuth).toBeGreaterThan(45)
    expect(morning.azimuth).toBeLessThan(90)
    expect(angleDiff(noon.azimuth, 180)).toBeLessThan(10)
    expect(evening.azimuth).toBeGreaterThan(270)
    expect(evening.azimuth).toBeLessThan(315)
    expect(noon.altitude).toBeGreaterThan(65)
  })

  it('converts to an east-north-up direction', () => {
    const [e, n, u] = sunDirectionENU({ azimuth: 90, altitude: 0 })
    expect(e).toBeCloseTo(1)
    expect(n).toBeCloseTo(0)
    expect(u).toBeCloseTo(0)
    expect(sunDirectionENU({ azimuth: 0, altitude: 90 })[2]).toBeCloseTo(1)
  })
})

describe('sunrise / sunset', () => {
  const cases = [
    { name: 'Zurich summer', lat: 47.3769, lon: 8.5417, tz: 'Europe/Zurich', date: '2026-06-21' },
    { name: 'Zurich winter', lat: 47.3769, lon: 8.5417, tz: 'Europe/Zurich', date: '2026-12-21' },
    { name: 'Yosemite', lat: 37.7456, lon: -119.5936, tz: 'America/Los_Angeles', date: '2026-10-10' },
    { name: 'Sydney', lat: -33.8688, lon: 151.2093, tz: 'Australia/Sydney', date: '2026-04-05' },
    { name: 'Reykjavik', lat: 64.1466, lon: -21.9426, tz: 'Atlantic/Reykjavik', date: '2026-03-01' },
    { name: 'Kathmandu', lat: 27.7172, lon: 85.324, tz: 'Asia/Kathmandu', date: '2026-08-15' }
  ]
  for (const c of cases) {
    it(`matches the reference within 2 minutes in ${c.name}`, () => {
      const day = sunDay(c.date, c.tz, c.lat, c.lon)
      const observer = new Astronomy.Observer(c.lat, c.lon, 0)
      const midnight = zonedToUtc(c.date, 0, c.tz)
      const rise = Astronomy.SearchRiseSet(Astronomy.Body.Sun, observer, +1, new Date(midnight), 1)
      const set = Astronomy.SearchRiseSet(Astronomy.Body.Sun, observer, -1, new Date(midnight), 1)
      expect(day.polar).toBeNull()
      expect(Math.abs((day.sunrise as number) - rise!.date.getTime())).toBeLessThan(120_000)
      expect(Math.abs((day.sunset as number) - set!.date.getTime())).toBeLessThan(120_000)
      expect(day.solarNoon).toBeGreaterThan(day.sunrise as number)
      expect(day.solarNoon).toBeLessThan(day.sunset as number)
    })
  }

  it('reports polar day and polar night at high latitudes', () => {
    const summer = sunDay('2026-06-21', 'Europe/Oslo', 69.6492, 18.9553)
    expect(summer.polar).toBe('day')
    expect(summer.sunrise).toBeNull()
    expect(summer.sunset).toBeNull()

    const winter = sunDay('2026-12-21', 'Europe/Oslo', 69.6492, 18.9553)
    expect(winter.polar).toBe('night')
    expect(winter.noonAltitude).toBeLessThan(0)

    // Southern hemisphere is inverted.
    expect(sunDay('2026-12-21', 'Antarctica/McMurdo', -77.8419, 166.6863).polar).toBe('day')
    expect(sunDay('2026-06-21', 'Antarctica/McMurdo', -77.8419, 166.6863).polar).toBe('night')
  })

  it('classifies twilight phases', () => {
    expect(lightPhase(10)).toBe('day')
    expect(lightPhase(-3)).toBe('civil')
    expect(lightPhase(-9)).toBe('nautical')
    expect(lightPhase(-15)).toBe('astronomical')
    expect(lightPhase(-30)).toBe('night')
  })
})

describe('sky bands and light windows', () => {
  // Zurich on the June solstice: the sun dips to about −19° at night, so every band appears.
  const zurich = { date: '2026-06-21', tz: 'Europe/Zurich', lat: 47.3769, lon: 8.5417 }

  it('covers the whole day with contiguous, distinct bands', () => {
    for (const c of [zurich, { date: '2026-12-21', tz: 'Europe/Oslo', lat: 69.6492, lon: 18.9553 }, { date: '2026-03-29', tz: 'Europe/Zurich', lat: 47.3769, lon: 8.5417 }]) {
      const bands = dayBands(c.date, c.tz, c.lat, c.lon)
      expect(bands[0].start).toBe(0)
      expect(bands[bands.length - 1].end).toBe(1440)
      for (let i = 1; i < bands.length; i++) {
        expect(bands[i].start).toBe(bands[i - 1].end)
        expect(bands[i].band).not.toBe(bands[i - 1].band)
      }
    }
  })

  it('puts the band edges where the sun crosses those altitudes (reference within 2 min)', () => {
    const observer = new Astronomy.Observer(zurich.lat, zurich.lon, 0)
    const midnight = zonedToUtc(zurich.date, 0, zurich.tz)
    const windows = lightWindows(dayBands(zurich.date, zurich.tz, zurich.lat, zurich.lon))
    const localUtc = (minutes: number) => zonedToUtc(zurich.date, minutes, zurich.tz)
    // Band edges are geometric altitudes, as is astronomy-engine's SearchAltitude.
    const ref = (direction: 1 | -1, altitude: number) =>
      Astronomy.SearchAltitude(Astronomy.Body.Sun, observer, direction, new Date(midnight), 1, altitude)!.date.getTime()
    const close = (minutes: number, utc: number) => expect(Math.abs(localUtc(minutes) - utc)).toBeLessThan(120_000)

    const [blueAm] = windows.blue.filter((w) => w.kind === 'morning')
    const [blueEve] = windows.blue.filter((w) => w.kind === 'evening')
    close(blueAm.start, ref(+1, -6))
    close(blueAm.end, ref(+1, -4))
    close(blueEve.start, ref(-1, -4))
    close(blueEve.end, ref(-1, -6))
    const [nauticalAm] = windows.nautical.filter((w) => w.kind === 'morning')
    close(nauticalAm.start, ref(+1, -12))

    // Golden hour runs from −4° to +6°.
    const [goldenAm] = windows.golden.filter((w) => w.kind === 'morning')
    const [goldenEve] = windows.golden.filter((w) => w.kind === 'evening')
    expect(goldenAm.start).toBeCloseTo(blueAm.end, 6)
    close(goldenAm.end, ref(+1, 6))
    close(goldenEve.start, ref(-1, 6))
    expect(goldenEve.end).toBeCloseTo(blueEve.start, 6)

    // Civil twilight: dawn to sunrise and sunset to dusk.
    const day = sunDay(zurich.date, zurich.tz, zurich.lat, zurich.lon)
    const [civilAm] = windows.civil.filter((w) => w.kind === 'morning')
    const [civilEve] = windows.civil.filter((w) => w.kind === 'evening')
    expect(Math.abs(localUtc(civilAm.start) - day.dawn!)).toBeLessThan(60_000)
    expect(Math.abs(localUtc(civilAm.end) - day.sunrise!)).toBeLessThan(60_000)
    expect(Math.abs(localUtc(civilEve.start) - day.sunset!)).toBeLessThan(60_000)
    expect(Math.abs(localUtc(civilEve.end) - day.dusk!)).toBeLessThan(60_000)
    // At 00:00 the sun is still sinking through astronomical twilight from the evening before.
    expect(windows.astronomical.map((w) => w.kind)).toEqual(['evening', 'morning', 'evening'])
    expect(windows.astronomical[0]).toMatchObject({ start: 0, fromPreviousDay: true })
  })

  it('handles windows the sun never passes through', () => {
    // Tromsø at midwinter: the sun peaks at about −3°, below the horizon but inside golden hour,
    // so golden hour and civil twilight are both one stretch around noon.
    const winter = lightWindows(dayBands('2026-12-21', 'Europe/Oslo', 69.6492, 18.9553))
    for (const w of [winter.golden, winter.civil]) {
      expect(w).toHaveLength(1)
      expect(w[0]).toMatchObject({ kind: 'span', fromPreviousDay: false, intoNextDay: false })
    }
    expect(winter.blue.map((w) => w.kind)).toEqual(['morning', 'evening'])

    // Tromsø at midsummer: golden hour runs over midnight, cut at the day's edges, and there is no twilight.
    const summer = lightWindows(dayBands('2026-06-21', 'Europe/Oslo', 69.6492, 18.9553))
    expect(summer.civil).toEqual([])
    expect(summer.golden).toHaveLength(2)
    expect(summer.golden[0]).toMatchObject({ fromPreviousDay: true, kind: 'morning' })
    expect(summer.golden[1]).toMatchObject({ intoNextDay: true, kind: 'evening' })

    // Near the pole at the equinox the sun circles just above the horizon: golden hour all day.
    const pole = lightWindows(dayBands('2026-03-22', 'UTC', 89.5, 0))
    expect(pole.golden).toEqual([{ start: 0, end: 1440, fromPreviousDay: true, intoNextDay: true, kind: 'span' }])
    expect(pole.civil).toEqual([])
  })

  it('recovers the geometric altitude from the apparent one', () => {
    for (const loc of LOCATIONS) {
      for (const t of INSTANTS) {
        const observer = new Astronomy.Observer(loc.lat, loc.lon, 0)
        const eq = Astronomy.Equator(Astronomy.Body.Sun, new Date(t), observer, true, true)
        const airless = Astronomy.Horizon(new Date(t), observer, eq.ra, eq.dec).altitude
        expect(Math.abs(geometricAltitude(t, loc.lat, loc.lon) - airless)).toBeLessThan(0.05)
      }
    }
  })

  it('classifies sky bands by altitude', () => {
    expect(skyBand(-20)).toBe('night')
    expect(skyBand(-15)).toBe('astronomical')
    expect(skyBand(-8)).toBe('nautical')
    expect(skyBand(-5)).toBe('blue')
    expect(skyBand(-2)).toBe('goldenTwilight')
    expect(skyBand(3)).toBe('golden')
    expect(skyBand(30)).toBe('day')
  })
})
