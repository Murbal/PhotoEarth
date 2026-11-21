import { describe, expect, it } from 'vitest'
import {
  addDays,
  addMinutes,
  dateFromDayOfYear,
  dayOfYear,
  formatClock,
  formatDuration,
  formatOffset,
  offsetMinutes,
  utcToZoned,
  withYear,
  zonedToUtc
} from '@renderer/lib/time'
import { lookupTimeZone } from '@renderer/lib/timezone'

describe('time zone resolution (§8.4)', () => {
  const cases: Array<[string, number, number, string]> = [
    ['Zurich', 47.3769, 8.5417, 'Europe/Zurich'],
    ['Lauterbrunnen', 46.5935, 7.9091, 'Europe/Zurich'],
    ['Chamonix', 45.9237, 6.8694, 'Europe/Paris'],
    ['Yosemite', 37.7456, -119.5936, 'America/Los_Angeles'],
    ['Phoenix (no DST)', 33.4484, -112.074, 'America/Phoenix'],
    ['Kathmandu (+5:45)', 27.7172, 85.324, 'Asia/Kathmandu'],
    ['Tokyo', 35.6762, 139.6503, 'Asia/Tokyo'],
    ['Longyearbyen', 78.2232, 15.6267, 'Arctic/Longyearbyen'],
    ['Patagonia', -50.9423, -73.4068, 'America/Punta_Arenas']
  ]
  for (const [name, lat, lon, zone] of cases) {
    it(`resolves ${name}`, () => {
      expect(lookupTimeZone(lat, lon)).toBe(zone)
    })
  }

  it('falls back to nautical zones at sea and UTC for bad input', () => {
    expect(lookupTimeZone(0, -30)).toMatch(/^Etc\/GMT/)
    expect(lookupTimeZone(Number.NaN, 0)).toBe('UTC')
  })

  it('wraps longitudes outside ±180', () => {
    expect(lookupTimeZone(47.3769, 8.5417 + 360)).toBe('Europe/Zurich')
  })
})

describe('offsets and DST', () => {
  it('knows summer and winter offsets of the viewed location', () => {
    expect(offsetMinutes(Date.parse('2026-07-01T12:00:00Z'), 'Europe/Zurich')).toBe(120)
    expect(offsetMinutes(Date.parse('2026-01-01T12:00:00Z'), 'Europe/Zurich')).toBe(60)
    expect(offsetMinutes(Date.parse('2026-07-01T12:00:00Z'), 'America/Los_Angeles')).toBe(-420)
    expect(offsetMinutes(Date.parse('2026-07-01T12:00:00Z'), 'America/Phoenix')).toBe(-420)
    expect(offsetMinutes(Date.parse('2026-01-01T12:00:00Z'), 'America/Phoenix')).toBe(-420)
    expect(offsetMinutes(Date.parse('2026-07-01T12:00:00Z'), 'Asia/Kathmandu')).toBe(345)
    // Southern hemisphere DST runs over the northern winter.
    expect(offsetMinutes(Date.parse('2026-01-01T12:00:00Z'), 'Australia/Sydney')).toBe(660)
    expect(offsetMinutes(Date.parse('2026-07-01T12:00:00Z'), 'Australia/Sydney')).toBe(600)
  })

  it('round-trips local wall time', () => {
    for (const zone of ['Europe/Zurich', 'America/New_York', 'Asia/Kathmandu', 'Australia/Sydney', 'UTC']) {
      for (const date of ['2026-01-15', '2026-03-29', '2026-07-04', '2026-10-25', '2026-11-01']) {
        for (const minutes of [0, 90.5, 720, 1439]) {
          const utc = zonedToUtc(date, minutes, zone)
          const back = utcToZoned(utc, zone)
          // Skip wall times that fall inside a DST gap.
          if (back.date === date && Math.abs(back.minutes - minutes) > 1e-6 && Math.abs(back.minutes - minutes - 60) < 1e-6) continue
          expect(back.date).toBe(date)
          expect(back.minutes).toBeCloseTo(minutes, 6)
        }
      }
    }
  })

  it('shifts non-existent times forward across the spring-forward gap', () => {
    // Europe: 2026-03-29 02:00 → 03:00.
    const utc = zonedToUtc('2026-03-29', 150, 'Europe/Zurich')
    expect(new Date(utc).toISOString()).toBe('2026-03-29T01:30:00.000Z')
    expect(utcToZoned(utc, 'Europe/Zurich').minutes).toBeCloseTo(210)
  })

  it('picks the earlier instant during the fall-back overlap', () => {
    // Europe: 2026-10-25 03:00 CEST → 02:00 CET, so 02:30 happens twice.
    expect(new Date(zonedToUtc('2026-10-25', 150, 'Europe/Zurich')).toISOString()).toBe('2026-10-25T00:30:00.000Z')
    // US: 2026-11-01 02:00 EDT → 01:00 EST.
    expect(new Date(zonedToUtc('2026-11-01', 90, 'America/New_York')).toISOString()).toBe('2026-11-01T05:30:00.000Z')
  })

  it('does not depend on the computer’s time zone', () => {
    expect(process.env.TZ).toBe('Pacific/Chatham')
    expect(new Date(zonedToUtc('2026-06-21', 720, 'Europe/Zurich')).toISOString()).toBe('2026-06-21T10:00:00.000Z')
  })

  it('formats offsets', () => {
    expect(formatOffset(120)).toBe('UTC+2')
    expect(formatOffset(-210)).toBe('UTC−3:30')
    expect(formatOffset(345)).toBe('UTC+5:45')
    expect(formatOffset(0)).toBe('UTC')
  })
})

describe('calendar helpers', () => {
  it('handles day of year and leap years', () => {
    expect(dayOfYear('2026-01-01')).toBe(1)
    expect(dayOfYear('2026-12-31')).toBe(365)
    expect(dayOfYear('2028-12-31')).toBe(366)
    expect(dateFromDayOfYear(2028, 60)).toBe('2028-02-29')
    expect(withYear('2028-02-29', 2027)).toBe('2027-02-28')
  })

  it('adds days and minutes across boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addMinutes('2026-06-21', 1430, 15)).toEqual({ date: '2026-06-22', minutes: 5 })
    expect(addMinutes('2026-06-21', 5, -15)).toEqual({ date: '2026-06-20', minutes: 1430 })
    expect(addMinutes('2026-06-21', 600, 1440)).toEqual({ date: '2026-06-22', minutes: 600 })
  })

  it('formats clock times', () => {
    expect(formatClock(0)).toBe('00:00')
    expect(formatClock(1439.99)).toBe('23:59')
    expect(formatClock(605.5, true)).toBe('10:05:30')
  })
})

describe('formatDuration', () => {
  it('rounds to whole minutes without ever showing 60 min', () => {
    // 8 h 59 min 40 s used to render as "8 h 60 min".
    expect(formatDuration((8 * 60 + 59) * 60000 + 40000)).toBe('9 h')
    expect(formatDuration((8 * 60 + 59) * 60000 + 20000)).toBe('8 h 59 min')
    expect(formatDuration((15 * 60 + 2) * 60000)).toBe('15 h 2 min')
    expect(formatDuration(45 * 60000)).toBe('45 min')
    expect(formatDuration(0)).toBe('0 min')
  })
})
