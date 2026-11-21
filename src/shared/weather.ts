// Open-Meteo forecast request and response parsing (main process fetches, renderer reads).
import type { LatLng, WeatherSeries } from './types'

export const OPEN_METEO_ENDPOINT = 'https://api.open-meteo.com/v1/forecast'
/** Open-Meteo's longest forecast; its "best match" blend uses coarser global models for the later days. */
export const FORECAST_DAYS = 16
/** The view center, and the sunset and sunrise horizons (see lib/weather.ts). */
export const MAX_FORECAST_POINTS = 3

/** Hourly variables, in the order of WeatherSeries' columns. */
const HOURLY = {
  cloudLow: 'cloud_cover_low',
  cloudMid: 'cloud_cover_mid',
  cloudHigh: 'cloud_cover_high',
  visibility: 'visibility',
  windSpeed: 'wind_speed_10m',
  windGusts: 'wind_gusts_10m',
  windDirection: 'wind_direction_10m',
  precipitationProbability: 'precipitation_probability',
  precipitation: 'precipitation',
  temperature: 'temperature_2m',
  dewPoint: 'dew_point_2m',
  humidity: 'relative_humidity_2m',
  weatherCode: 'weather_code'
} as const satisfies Record<Exclude<keyof WeatherSeries, 'latitude' | 'longitude' | 'elevation' | 'time'>, string>

export type HourlyKey = keyof typeof HOURLY

/** One request for all points: Open-Meteo takes comma-separated coordinate lists. */
export function buildForecastUrl(points: readonly LatLng[]): string {
  const coord = (v: number) => v.toFixed(4)
  const params = new URLSearchParams({
    latitude: points.map((p) => coord(p.latitude)).join(','),
    longitude: points.map((p) => coord(p.longitude)).join(','),
    hourly: Object.values(HOURLY).join(','),
    forecast_days: String(FORECAST_DAYS),
    timezone: 'GMT',
    timeformat: 'unixtime',
    wind_speed_unit: 'ms'
  })
  return `${OPEN_METEO_ENDPOINT}?${params.toString()}`
}

type Json = unknown

const isObject = (v: Json): v is Record<string, Json> => typeof v === 'object' && v !== null && !Array.isArray(v)

function column(v: Json, length: number): (number | null)[] {
  const out: (number | null)[] = new Array<number | null>(length).fill(null)
  if (!Array.isArray(v)) return out
  for (let i = 0; i < length; i++) {
    const x = v[i] as Json
    out[i] = typeof x === 'number' && Number.isFinite(x) ? x : null
  }
  return out
}

function parseSeries(raw: Json): WeatherSeries | null {
  if (!isObject(raw) || !isObject(raw.hourly)) return null
  const { latitude, longitude, elevation } = raw
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return null
  const times = raw.hourly.time
  if (!Array.isArray(times) || times.length === 0) return null
  const time: number[] = []
  for (const t of times as Json[]) {
    if (typeof t !== 'number' || !Number.isFinite(t)) return null
    time.push(t * 1000)
  }
  const series = {
    latitude,
    longitude,
    elevation: typeof elevation === 'number' && Number.isFinite(elevation) ? elevation : null,
    time
  } as WeatherSeries
  for (const [key, name] of Object.entries(HOURLY) as Array<[HourlyKey, string]>) series[key] = column(raw.hourly[name], time.length)
  return series
}

/**
 * Parses an Open-Meteo response for `count` points: one object for a single point, an array in
 * request order for several. Returns null when it isn't a forecast for each of them.
 */
export function parseForecast(json: Json, count: number): WeatherSeries[] | null {
  const list = Array.isArray(json) ? json : [json]
  if (list.length !== count) return null
  const series = list.map(parseSeries)
  return series.every((s): s is WeatherSeries => s !== null) ? series : null
}

/** Open-Meteo's error body: `{ "error": true, "reason": "…" }`. */
export function forecastErrorReason(body: string): string | null {
  try {
    const json = JSON.parse(body) as Json
    return isObject(json) && typeof json.reason === 'string' ? json.reason.slice(0, 200) : null
  } catch {
    return null
  }
}
