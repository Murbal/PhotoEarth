// Reading an Open-Meteo forecast for photography: twilight colour, fog and wind.
import type { LatLng, WeatherSeries } from '@shared/types'
import type { HourlyKey } from '@shared/weather'
import { sunDay, sunPosition } from './sun'
import { addDays, utcToZoned } from './time'

const HOUR = 3600_000
const EARTH_RADIUS = 6371008.8

/**
 * How far toward the sun the "is the horizon clear?" sample sits. Light that colours cloud
 * overhead at sunset skims the ground ~200–300 km away (√(2Rh) for clouds 4–8 km up); cloud
 * anywhere along that path shades it. 150 km is the middle of the path.
 */
export const HORIZON_DISTANCE_M = 150_000

/** The forecast for the view center, with the sky toward the sunset and sunrise. */
export interface Forecast {
  /** Where it was requested (the view center then). */
  location: LatLng
  fetchedAt: number
  observer: WeatherSeries
  /** HORIZON_DISTANCE_M toward the sun as it sets / rises, mid-forecast. */
  sunsetSide: WeatherSeries | null
  sunriseSide: WeatherSeries | null
  /** Bearings of those samples, degrees. */
  sunsetAzimuth: number
  sunriseAzimuth: number
}

/** Point `distance` meters from a start along a great circle with initial `bearing` (degrees). */
export function destinationPoint(from: LatLng, bearing: number, distance: number): LatLng {
  const d = distance / EARTH_RADIUS
  const b = (bearing * Math.PI) / 180
  const φ1 = (from.latitude * Math.PI) / 180
  const λ1 = (from.longitude * Math.PI) / 180
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(b))
  const λ2 = λ1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(φ1), Math.cos(d) - Math.sin(φ1) * Math.sin(φ2))
  const lon = (((λ2 * 180) / Math.PI + 540) % 360) - 180
  return { latitude: (φ2 * 180) / Math.PI, longitude: lon }
}

/**
 * Directions to sample the sunset and sunrise sky in: where the sun sets and rises midway
 * through the forecast (they drift < 10° over 16 days). Due west and east under polar day or night.
 */
export function twilightAzimuths(date: string, timeZone: string, at: LatLng): { sunset: number; sunrise: number } {
  const mid = addDays(date, 8)
  const day = sunDay(mid, timeZone, at.latitude, at.longitude)
  return {
    sunset: day.sunset !== null ? sunPosition(day.sunset, at.latitude, at.longitude).azimuth : 270,
    sunrise: day.sunrise !== null ? sunPosition(day.sunrise, at.latitude, at.longitude).azimuth : 90
  }
}

/** The points to request, in order: view center, sunset side, sunrise side. */
export function forecastPoints(at: LatLng, azimuths: { sunset: number; sunrise: number }): LatLng[] {
  return [at, destinationPoint(at, azimuths.sunset, HORIZON_DISTANCE_M), destinationPoint(at, azimuths.sunrise, HORIZON_DISTANCE_M)]
}

/** Index of the forecast hour within half an hour of `utc`, else -1. */
export function hourIndex(s: WeatherSeries, utc: number): number {
  if (s.time.length === 0) return -1
  const i = Math.round((utc - s.time[0]) / HOUR)
  if (i < 0 || i >= s.time.length || Math.abs(utc - s.time[i]) > HOUR / 2) return -1
  return i
}

/**
 * A column at an instant, linear between hours (nearest hour beside a gap). Null outside the
 * forecast. Not for wind direction (it wraps).
 */
export function valueAt(s: WeatherSeries, key: Exclude<HourlyKey, 'windDirection' | 'weatherCode'>, utc: number): number | null {
  const n = s.time.length
  if (n === 0) return null
  const x = (utc - s.time[0]) / HOUR
  if (x < 0 || x > n - 1) return null
  const col = s[key]
  if (n === 1) return col[0]
  const i = Math.min(n - 2, Math.floor(x))
  const f = x - i
  const a = col[i]
  const b = col[i + 1]
  if (a === null || b === null) return f < 0.5 ? (a ?? b) : (b ?? a)
  return a + (b - a) * f
}

/**
 * Combined cloud cover (0–100 %) at an instant from low, mid and high layers under random
 * overlap: `1 − (1 − L)(1 − M)(1 − H)`. Null outside the forecast or when all layers are missing.
 */
export function totalCloudAt(s: WeatherSeries, utc: number): number | null {
  const low = valueAt(s, 'cloudLow', utc)
  const mid = valueAt(s, 'cloudMid', utc)
  const high = valueAt(s, 'cloudHigh', utc)
  if (low === null && mid === null && high === null) return null
  const clear = (v: number | null) => 1 - Math.min(100, Math.max(0, v ?? 0)) / 100
  return Math.round(100 * (1 - clear(low) * clear(mid) * clear(high)))
}

export interface ForecastHour {
  utc: number
  cloudLow: number | null
  cloudMid: number | null
  cloudHigh: number | null
  visibility: number | null
  windSpeed: number | null
  windGusts: number | null
  windDirection: number | null
  precipitationProbability: number | null
  precipitation: number | null
  temperature: number | null
  dewPoint: number | null
  humidity: number | null
  weatherCode: number | null
}

/** The forecast hour nearest `utc` (within half an hour), or null outside the forecast. */
export function forecastHour(s: WeatherSeries, utc: number): ForecastHour | null {
  const i = hourIndex(s, utc)
  if (i < 0) return null
  return {
    utc: s.time[i],
    cloudLow: s.cloudLow[i],
    cloudMid: s.cloudMid[i],
    cloudHigh: s.cloudHigh[i],
    visibility: s.visibility[i],
    windSpeed: s.windSpeed[i],
    windGusts: s.windGusts[i],
    windDirection: s.windDirection[i],
    precipitationProbability: s.precipitationProbability[i],
    precipitation: s.precipitation[i],
    temperature: s.temperature[i],
    dewPoint: s.dewPoint[i],
    humidity: s.humidity[i],
    weatherCode: s.weatherCode[i]
  }
}

export type FogLevel = 'low' | 'possible' | 'likely'

export interface FogRisk {
  level: FogLevel
  reason: string
}

/**
 * Open-Meteo has no fog probability, so it's read off the hour: fog in the weather code or
 * visibility under 1 km is likely fog; near-saturated air with little wind, or haze in humid
 * air, is possible fog. Radiation fog in valleys forms below the model's resolution, so
 * "possible" on a calm, clear night is worth a look.
 */
export function fogRisk(h: ForecastHour): FogRisk {
  if (h.weatherCode === 45 || h.weatherCode === 48) return { level: 'likely', reason: h.weatherCode === 48 ? 'rime fog forecast' : 'fog forecast' }
  if (h.visibility !== null && h.visibility < 1000) return { level: 'likely', reason: 'visibility under 1 km' }
  const spread = h.temperature !== null && h.dewPoint !== null ? h.temperature - h.dewPoint : null
  const saturated = (spread !== null && spread <= 1) || (h.humidity !== null && h.humidity >= 97)
  const calm = h.windSpeed !== null && h.windSpeed < 3
  if (saturated && calm) return { level: 'possible', reason: 'near-saturated air and light wind' }
  if (h.visibility !== null && h.visibility < 5000 && h.humidity !== null && h.humidity >= 90) return { level: 'possible', reason: 'mist' }
  return { level: 'low', reason: '' }
}

export type WindLevel = 'calm' | 'light' | 'breezy' | 'strong'

/** Gusts (m/s) past which most camera drones shouldn't fly. */
export const STRONG_GUST = 12

/** What the wind means for long exposures and drones. Speeds in m/s. */
export function windLevel(speed: number | null, gusts: number | null): { level: WindLevel; note: string } | null {
  if (speed === null) return null
  const g = gusts ?? speed
  if (g >= STRONG_GUST || speed >= 9) return { level: 'strong', note: 'Too windy for most camera drones; long exposures need shelter' }
  if (g >= 8 || speed >= 5) return { level: 'breezy', note: 'Gusty: weigh the tripod down; small drones struggle' }
  if (speed < 2 && g < 4) return { level: 'calm', note: 'Calm: still-water reflections and steady long exposures' }
  return { level: 'light', note: 'Light wind: fine for drones and tripods' }
}

export type GlowRating = 'poor' | 'fair' | 'good' | 'great'

export interface GlowOutlook {
  /** 0–100. */
  score: number
  rating: GlowRating
  /** Mid and high cloud overhead, low cloud overhead, low/mid cloud toward the sun, rain chance (%). */
  canvas: number
  low: number
  /** Null when there's no sample toward the sun. */
  horizon: number | null
  precipitation: number
  summary: string
}

/** How well clouds `c`% of the sky take colour: none is plain, scattered to broken is best, overcast is dull. */
function canvasFactor(c: number): number {
  if (c <= 30) return 0.15 + (0.85 * c) / 30
  if (c <= 70) return 1
  return 1 - (0.45 * (c - 70)) / 30
}

const RATINGS: Array<[number, GlowRating]> = [
  [75, 'great'],
  [50, 'good'],
  [25, 'fair'],
  [0, 'poor']
]

/**
 * Sunrise/sunset colour potential at an instant. Colour needs mid or high cloud overhead to
 * catch the light, and a clear path for the light: little low cloud overhead (it hides the
 * canvas) and little low or mid cloud toward the sun (it shades the canvas from below).
 * `side` is the forecast HORIZON_DISTANCE_M toward the sun. A heuristic, not a model.
 */
export function glowOutlook(observer: WeatherSeries, side: WeatherSeries | null, utc: number): GlowOutlook | null {
  const high = valueAt(observer, 'cloudHigh', utc)
  const mid = valueAt(observer, 'cloudMid', utc)
  const low = valueAt(observer, 'cloudLow', utc)
  if (high === null || mid === null || low === null) return null
  const precipitation = valueAt(observer, 'precipitationProbability', utc) ?? 0
  const sideLow = side ? valueAt(side, 'cloudLow', utc) : null
  const sideMid = side ? valueAt(side, 'cloudMid', utc) : null
  const horizon = sideLow === null ? null : Math.max(sideLow, 0.6 * (sideMid ?? 0))

  // Mid cloud is a thicker, darker canvas than high cloud.
  const canvas = Math.min(100, Math.max(high, 0.85 * mid))
  const lowFactor = 1 - (0.8 * Math.max(0, low - 25)) / 75
  const horizonFactor = horizon === null ? 1 : 1 - (0.85 * Math.max(0, horizon - 10)) / 90
  const rainFactor = 1 - (0.5 * precipitation) / 100
  const score = Math.round(100 * canvasFactor(canvas) * lowFactor * horizonFactor * rainFactor)
  const rating = RATINGS.find(([min]) => score >= min)![1]

  let summary: string
  if (low >= 80) summary = 'Low overcast hides the sky'
  else if (horizon !== null && horizon >= 60) summary = canvas >= 20 ? 'Clouds overhead, but cloud toward the sun blocks the light' : 'Cloud toward the sun blocks the light'
  else if (canvas < 10) summary = 'Clear sky: clean light, little colour in the sky'
  else if (canvas > 90) summary = 'Thick cloud cover: colour only if it breaks'
  else if (rating === 'great' || rating === 'good') summary = horizon === null ? 'Clouds to catch the light' : 'Clouds to catch the light and a clear path for it'
  else summary = 'Some cloud to catch the light'
  if (precipitation >= 50) summary += `; ${Math.round(precipitation)}% chance of rain`
  return { score, rating, canvas: Math.round(canvas), low: Math.round(low), horizon: horizon === null ? null : Math.round(horizon), precipitation: Math.round(precipitation), summary }
}

export interface TwilightOutlook {
  utc: number
  glow: GlowOutlook
}

export interface DayOutlook {
  /** Local date (YYYY-MM-DD) in the forecast's zone. */
  date: string
  sunrise: TwilightOutlook | null
  sunset: TwilightOutlook | null
  /** Worst fog risk in the two hours either side of sunrise (or around 06:00 under polar day / night). */
  morningFog: FogRisk
  /** Strongest gust between sunrise and sunset, m/s. */
  maxGust: number | null
}

const FOG_ORDER: Record<FogLevel, number> = { low: 0, possible: 1, likely: 2 }

/**
 * One outlook per local day the forecast covers, from `today` on (dates in `timeZone`,
 * sun times at the view center).
 */
export function forecastDays(f: Forecast, timeZone: string, today: string): DayOutlook[] {
  const s = f.observer
  if (s.time.length === 0) return []
  const { latitude, longitude } = f.location
  const first = utcToZoned(s.time[0], timeZone).date
  const last = utcToZoned(s.time[s.time.length - 1], timeZone).date
  const days: DayOutlook[] = []
  for (let date = first > today ? first : today; date <= last; date = addDays(date, 1)) {
    const sun = sunDay(date, timeZone, latitude, longitude)
    const twilight = (utc: number | null, side: WeatherSeries | null): TwilightOutlook | null => {
      if (utc === null) return null
      const glow = glowOutlook(s, side, utc)
      return glow ? { utc, glow } : null
    }
    const sunrise = twilight(sun.sunrise, f.sunriseSide)
    const sunset = twilight(sun.sunset, f.sunsetSide)
    const dawn = sun.sunrise ?? sun.solarNoon - 6 * HOUR
    let morningFog: FogRisk = { level: 'low', reason: '' }
    for (let t = dawn - 2 * HOUR; t <= dawn + 2 * HOUR; t += HOUR) {
      const h = forecastHour(s, t)
      const risk = h ? fogRisk(h) : null
      if (risk && FOG_ORDER[risk.level] > FOG_ORDER[morningFog.level]) morningFog = risk
    }
    let maxGust: number | null = null
    if (sun.polar !== 'night') {
      const from = sun.sunrise ?? sun.solarNoon - 12 * HOUR
      const to = sun.sunset ?? sun.solarNoon + 12 * HOUR
      for (let t = Math.ceil(from / HOUR) * HOUR; t <= to; t += HOUR) {
        const i = hourIndex(s, t)
        const g = i < 0 ? null : (s.windGusts[i] ?? s.windSpeed[i])
        if (g !== null && (maxGust === null || g > maxGust)) maxGust = g
      }
    }
    // Keep every day the forecast reaches, including polar night with no sunrise, sunset or
    // daylight gusts: its fog note and astro window still apply.
    if (sunrise || sunset || maxGust !== null || hourIndex(s, sun.solarNoon) >= 0) days.push({ date, sunrise, sunset, morningFog, maxGust })
  }
  return days
}

/** Forecast hours falling on a local date: [minutes of day, index]. */
export function hoursOnDate(s: WeatherSeries, date: string, timeZone: string): Array<{ minutes: number; index: number }> {
  const out: Array<{ minutes: number; index: number }> = []
  for (let i = 0; i < s.time.length; i++) {
    const local = utcToZoned(s.time[i], timeZone)
    if (local.date === date) out.push({ minutes: local.minutes, index: i })
    else if (local.date > date) break
  }
  return out
}
