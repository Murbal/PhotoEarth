import { describe, expect, it } from 'vitest'
import { defaultSettings, sanitizeSettings } from '@shared/settings'
import type { WeatherSeries } from '@shared/types'
import { buildForecastUrl, FORECAST_DAYS, forecastErrorReason, parseForecast } from '@shared/weather'
import { haversine } from '@renderer/lib/profile'
import { sunDay, sunPosition } from '@renderer/lib/sun'
import { utcToZoned } from '@renderer/lib/time'
import {
  destinationPoint,
  fogRisk,
  forecastDays,
  forecastHour,
  forecastPoints,
  glowOutlook,
  HORIZON_DISTANCE_M,
  hourIndex,
  hoursOnDate,
  twilightAzimuths,
  valueAt,
  windLevel,
  type Forecast,
  type ForecastHour
} from '@renderer/lib/weather'

const HOUR = 3600_000
const START = Date.UTC(2026, 10, 21) // 2026-11-21 00:00 UTC

type Columns = Omit<WeatherSeries, 'latitude' | 'longitude' | 'elevation' | 'time'>

/** `hours` hourly values from START; every column constant unless overridden. */
function series(hours: number, values: Partial<Record<keyof Columns, number | null | ((i: number) => number | null)>> = {}): WeatherSeries {
  const defaults: Record<keyof Columns, number> = {
    cloudLow: 0,
    cloudMid: 0,
    cloudHigh: 0,
    visibility: 30000,
    windSpeed: 3,
    windGusts: 5,
    windDirection: 270,
    precipitationProbability: 0,
    precipitation: 0,
    temperature: 10,
    dewPoint: 2,
    humidity: 60,
    weatherCode: 1
  }
  const s = { latitude: 46.48, longitude: 7.8, elevation: 800, time: Array.from({ length: hours }, (_, i) => START + i * HOUR) } as WeatherSeries
  for (const key of Object.keys(defaults) as Array<keyof Columns>) {
    const v = key in values ? values[key] : defaults[key]
    s[key] = Array.from({ length: hours }, (_, i) => (typeof v === 'function' ? v(i) : (v ?? null)))
  }
  return s
}

const hour = (patch: Partial<ForecastHour>): ForecastHour => ({ ...forecastHour(series(1), START)!, ...patch })

describe('Open-Meteo request and response', () => {
  it('asks for every point, 16 days, UTC unix times and m/s', () => {
    const url = new URL(
      buildForecastUrl([
        { latitude: 46.48, longitude: 7.8 },
        { latitude: 46.123456, longitude: -122.5 }
      ])
    )
    expect(url.origin + url.pathname).toBe('https://api.open-meteo.com/v1/forecast')
    expect(url.searchParams.get('latitude')).toBe('46.4800,46.1235')
    expect(url.searchParams.get('longitude')).toBe('7.8000,-122.5000')
    expect(url.searchParams.get('forecast_days')).toBe(String(FORECAST_DAYS))
    expect(url.searchParams.get('timeformat')).toBe('unixtime')
    expect(url.searchParams.get('wind_speed_unit')).toBe('ms')
    expect(url.searchParams.get('hourly')!.split(',')).toEqual(
      expect.arrayContaining(['cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high', 'visibility', 'wind_gusts_10m', 'weather_code'])
    )
  })

  const raw = (n: number) => ({
    latitude: 46.47,
    longitude: 7.79,
    elevation: 2640,
    hourly: {
      time: Array.from({ length: n }, (_, i) => START / 1000 + i * 3600),
      cloud_cover_low: Array.from({ length: n }, (_, i) => i * 10),
      cloud_cover_high: [5, null, 'x'],
      visibility: [24140]
    }
  })

  it('parses one point or a list, converting times to ms and filling gaps with null', () => {
    const [s] = parseForecast(raw(3), 1)!
    expect(s.time).toEqual([START, START + HOUR, START + 2 * HOUR])
    expect(s.cloudLow).toEqual([0, 10, 20])
    expect(s.cloudHigh).toEqual([5, null, null])
    expect(s.visibility).toEqual([24140, null, null])
    expect(s.windSpeed).toEqual([null, null, null])
    expect(s.elevation).toBe(2640)
    expect(parseForecast([raw(2), raw(2), raw(2)], 3)).toHaveLength(3)
  })

  it('rejects responses that are not a forecast for each point', () => {
    expect(parseForecast(raw(2), 3)).toBeNull()
    expect(parseForecast([raw(2), { error: true }], 2)).toBeNull()
    expect(parseForecast({ ...raw(2), hourly: { time: [1, 'x'] } }, 1)).toBeNull()
    expect(parseForecast(null, 1)).toBeNull()
  })

  it('reads the error reason', () => {
    expect(forecastErrorReason('{"error":true,"reason":"Latitude must be in range"}')).toBe('Latitude must be in range')
    expect(forecastErrorReason('<html>')).toBeNull()
  })

  it('the forecast is on by default and survives sanitizing', () => {
    expect(defaultSettings().forecast).toBe(true)
    expect(sanitizeSettings({ forecast: false }).forecast).toBe(false)
    expect(sanitizeSettings({ forecast: 'no' }).forecast).toBe(true)
  })
})

describe('geometry', () => {
  it('destination point lies at the distance and bearing', () => {
    const from = { latitude: 46.48, longitude: 7.8 }
    const west = destinationPoint(from, 270, HORIZON_DISTANCE_M)
    expect(haversine(from, west)).toBeCloseTo(HORIZON_DISTANCE_M, -1)
    expect(west.longitude).toBeLessThan(from.longitude)
    expect(destinationPoint(from, 0, 100_000).latitude).toBeCloseTo(46.48 + 100 / 111.2, 2)
    // Wraps across the antimeridian.
    expect(destinationPoint({ latitude: 0, longitude: 179.9 }, 90, 50_000).longitude).toBeCloseTo(-179.65, 1)
  })

  it('samples the sky where the sun sets and rises mid-forecast', () => {
    const at = { latitude: 46.48, longitude: 7.8 }
    const az = twilightAzimuths('2026-11-21', 'Europe/Zurich', at)
    // Late November in the Alps: sets in the south-west, rises in the south-east.
    expect(az.sunset).toBeGreaterThan(225)
    expect(az.sunset).toBeLessThan(245)
    expect(az.sunrise).toBeGreaterThan(115)
    expect(az.sunrise).toBeLessThan(135)
    const mid = sunDay('2026-11-29', 'Europe/Zurich', at.latitude, at.longitude)
    expect(az.sunset).toBeCloseTo(sunPosition(mid.sunset!, at.latitude, at.longitude).azimuth, 6)
    const [center, sunset, sunrise] = forecastPoints(at, az)
    expect(center).toEqual(at)
    expect(haversine(at, sunset)).toBeCloseTo(HORIZON_DISTANCE_M, -1)
    expect(sunset.longitude).toBeLessThan(at.longitude)
    expect(sunrise.longitude).toBeGreaterThan(at.longitude)
  })

  it('falls back to due west and east under polar night', () => {
    expect(twilightAzimuths('2026-12-21', 'Arctic/Longyearbyen', { latitude: 78.2, longitude: 15.6 })).toEqual({ sunset: 270, sunrise: 90 })
  })
})

describe('reading the series', () => {
  const s = series(48, { cloudHigh: (i) => i, cloudMid: (i) => (i === 5 ? null : 50) })

  it('finds the hour within half an hour', () => {
    expect(hourIndex(s, START + 3 * HOUR + 29 * 60000)).toBe(3)
    expect(hourIndex(s, START + 3 * HOUR + 31 * 60000)).toBe(4)
    expect(hourIndex(s, START - 31 * 60000)).toBe(-1)
    expect(hourIndex(s, START + 47 * HOUR + 31 * 60000)).toBe(-1)
    expect(forecastHour(s, START + 10 * HOUR)?.cloudHigh).toBe(10)
  })

  it('interpolates between hours and uses the nearest value beside a gap', () => {
    expect(valueAt(s, 'cloudHigh', START + 2.25 * HOUR)).toBeCloseTo(2.25)
    expect(valueAt(s, 'cloudMid', START + 4.25 * HOUR)).toBe(50)
    expect(valueAt(s, 'cloudMid', START + 4.75 * HOUR)).toBe(50)
    expect(valueAt(s, 'cloudHigh', START - 1)).toBeNull()
    expect(valueAt(s, 'cloudHigh', START + 48 * HOUR)).toBeNull()
  })

  it('lists the hours of a local date', () => {
    // UTC+1 in winter: 00:00 local is 23:00 UTC the day before, outside this series.
    const hours = hoursOnDate(s, '2026-11-21', 'Europe/Zurich')
    expect(hours[0]).toEqual({ minutes: 60, index: 0 })
    expect(hours).toHaveLength(23)
    expect(hoursOnDate(s, '2026-11-22', 'Europe/Zurich')).toHaveLength(24)
    expect(hoursOnDate(s, '2026-11-25', 'Europe/Zurich')).toHaveLength(0)
  })
})

describe('fog and wind', () => {
  it('fog in the weather code or visibility under 1 km is likely', () => {
    expect(fogRisk(hour({ weatherCode: 45 })).level).toBe('likely')
    expect(fogRisk(hour({ weatherCode: 48 })).reason).toContain('rime')
    expect(fogRisk(hour({ visibility: 600 })).level).toBe('likely')
  })

  it('saturated, still air or mist is possible fog', () => {
    expect(fogRisk(hour({ temperature: 3, dewPoint: 2.4, windSpeed: 1 })).level).toBe('possible')
    // The same air with wind mixes and doesn't fog.
    expect(fogRisk(hour({ temperature: 3, dewPoint: 2.4, windSpeed: 6 })).level).toBe('low')
    expect(fogRisk(hour({ visibility: 3000, humidity: 93 })).level).toBe('possible')
    expect(fogRisk(hour({})).level).toBe('low')
  })

  it('rates wind for drones and long exposures', () => {
    expect(windLevel(1, 2)?.level).toBe('calm')
    expect(windLevel(3, 5)?.level).toBe('light')
    expect(windLevel(4, 9)?.level).toBe('breezy')
    expect(windLevel(6, 13)?.level).toBe('strong')
    expect(windLevel(null, null)).toBeNull()
  })
})

describe('sunrise and sunset colour outlook', () => {
  const at = START + 16 * HOUR
  const sky = (low: number, mid: number, high: number, extra: Parameters<typeof series>[1] = {}) =>
    series(24, { cloudLow: low, cloudMid: mid, cloudHigh: high, ...extra })
  const clearSide = sky(0, 0, 0)

  it('high cloud with a clear path for the light is great', () => {
    const g = glowOutlook(sky(5, 10, 55), clearSide, at)!
    expect(g.rating).toBe('great')
    expect(g.summary).toContain('clear path')
  })

  it('the same sky with low cloud toward the sun is poor', () => {
    const g = glowOutlook(sky(5, 10, 55), sky(90, 40, 0), at)!
    expect(g.rating).toBe('poor')
    expect(g.horizon).toBe(90)
    expect(g.summary).toContain('blocks the light')
  })

  it('a clear sky has little colour, low overcast none', () => {
    const clear = glowOutlook(sky(0, 0, 0), clearSide, at)!
    expect(clear.rating).toBe('poor')
    expect(clear.summary).toContain('Clear sky')
    const overcast = glowOutlook(sky(100, 20, 60), clearSide, at)!
    expect(overcast.score).toBeLessThan(clear.score + 15)
    expect(overcast.summary).toContain('Low overcast')
  })

  it('total cover is worse than broken cloud, and rain lowers it', () => {
    const broken = glowOutlook(sky(0, 20, 60), clearSide, at)!
    const total = glowOutlook(sky(0, 100, 100), clearSide, at)!
    expect(total.score).toBeLessThan(broken.score)
    const wet = glowOutlook(sky(0, 20, 60, { precipitationProbability: 80 }), clearSide, at)!
    expect(wet.score).toBeLessThan(broken.score)
    expect(wet.summary).toContain('80% chance of rain')
  })

  it('without a sample toward the sun it judges the sky overhead only', () => {
    expect(glowOutlook(sky(5, 10, 55), null, at)!.horizon).toBeNull()
    expect(glowOutlook(sky(5, 10, 55), null, at)!.rating).toBe('great')
    expect(glowOutlook(sky(5, 10, 55), null, START + 30 * HOUR)).toBeNull()
  })
})

describe('daily outlook', () => {
  const location = { latitude: 46.48, longitude: 7.8 }
  const forecast = (observer: WeatherSeries): Forecast => ({
    location,
    fetchedAt: START,
    observer,
    sunsetSide: series(observer.time.length),
    sunriseSide: series(observer.time.length),
    sunsetAzimuth: 235,
    sunriseAzimuth: 125
  })

  it('has one day per local date from today, with sunrise and sunset outlooks at the real sun times', () => {
    const f = forecast(series(16 * 24, { cloudHigh: 50 }))
    const days = forecastDays(f, 'Europe/Zurich', '2026-11-21')
    expect(days[0].date).toBe('2026-11-21')
    expect(days.length).toBeGreaterThanOrEqual(16)
    const sun = sunDay('2026-11-23', 'Europe/Zurich', location.latitude, location.longitude)
    const day = days.find((d) => d.date === '2026-11-23')!
    expect(day.sunrise?.utc).toBe(sun.sunrise)
    expect(day.sunset?.utc).toBe(sun.sunset)
    expect(day.sunset?.glow.rating).toBe('great')
    // Later "today" drops the earlier days.
    expect(forecastDays(f, 'Europe/Zurich', '2026-11-25')[0].date).toBe('2026-11-25')
  })

  it('dates are local: a western zone starts the previous evening, which is skipped as past', () => {
    const f = forecast(series(48))
    const days = forecastDays(f, 'America/Los_Angeles', '2026-11-21')
    expect(utcToZoned(START, 'America/Los_Angeles').date).toBe('2026-11-20')
    expect(days[0].date).toBe('2026-11-21')
  })

  it('flags morning fog and the day’s strongest gust', () => {
    const sunrise = sunDay('2026-11-22', 'Europe/Zurich', location.latitude, location.longitude).sunrise!
    const fogHour = Math.round((sunrise - START) / HOUR) - 1
    const f = forecast(series(72, { weatherCode: (i) => (i === fogHour ? 45 : 1), windGusts: (i) => (i === 36 ? 14 : 5) }))
    const days = forecastDays(f, 'Europe/Zurich', '2026-11-21')
    const day = days.find((d) => d.date === '2026-11-22')!
    expect(day.morningFog.level).toBe('likely')
    expect(day.maxGust).toBe(14)
    expect(days.find((d) => d.date === '2026-11-21')!.morningFog.level).toBe('low')
  })
})
