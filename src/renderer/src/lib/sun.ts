import { getPosition, getTimes } from 'suncalc'
import { addDays, offsetMinutes, utcToZoned, zonedToUtc } from './time'

export interface SunPosition {
  /** Degrees clockwise from true north. */
  azimuth: number
  /** Apparent altitude above the horizon (refraction-corrected), degrees. */
  altitude: number
}

export interface SunDay {
  sunrise: number | null
  sunset: number | null
  solarNoon: number
  /** Civil twilight boundaries (sun at −6°). */
  dawn: number | null
  dusk: number | null
  /** Sun never sets / never rises on this date at this place. */
  polar: 'day' | 'night' | null
  /** Sun altitude at solar noon, degrees. */
  noonAltitude: number
}

/** Sun azimuth/altitude for an instant and location (SunCalc; NOAA-grade accuracy). */
export function sunPosition(utcMs: number, latitude: number, longitude: number): SunPosition {
  const p = getPosition(new Date(utcMs), latitude, longitude)
  return { azimuth: ((p.azimuth % 360) + 360) % 360, altitude: p.altitude }
}

/** Meeus 16.4 refraction (degrees) for a geometric altitude, as SunCalc applies it: held at its 0° value below the horizon. */
function refraction(h: number): number {
  const x = Math.max(0, h)
  return 1.02 / Math.tan(((x + 10.26 / (x + 5.1)) * Math.PI) / 180) / 60
}

/**
 * Geometric (airless) altitude of the sun's center, degrees. Twilight, golden and blue hour
 * edges are defined on it, as are SunCalc's sunrise, sunset, dawn and dusk.
 */
export function geometricAltitude(utcMs: number, latitude: number, longitude: number): number {
  const apparent = sunPosition(utcMs, latitude, longitude).altitude
  let h = apparent - refraction(0)
  if (h <= 0) return h
  // Fixed-point inversion of apparent = h + R(h); |R'| is small, so this converges quickly.
  for (let i = 0; i < 6; i++) h = apparent - refraction(h)
  return h
}

const time = (d: Date | null | undefined): number | null =>
  d instanceof Date && !Number.isNaN(d.getTime()) ? d.getTime() : null

/**
 * Sunrise, solar noon and sunset for the civil date `date` in `timeZone`
 * at the given location. Times are UTC instants.
 */
export function sunDay(date: string, timeZone: string, latitude: number, longitude: number): SunDay {
  const noonUtc = zonedToUtc(date, 720, timeZone)
  const offset = offsetMinutes(noonUtc, timeZone)
  const t = getTimes(new Date(noonUtc), latitude, longitude, 0, offset)
  const solarNoon = time(t.solarNoon) ?? noonUtc
  const noonAltitude = sunPosition(solarNoon, latitude, longitude).altitude
  let polar: SunDay['polar'] = null
  if (t.alwaysUp) polar = 'day'
  else if (t.alwaysDown) polar = 'night'
  return {
    sunrise: time(t.sunrise),
    sunset: time(t.sunset),
    solarNoon,
    dawn: time(t.dawn),
    dusk: time(t.dusk),
    polar,
    noonAltitude
  }
}

export type LightPhase = 'night' | 'astronomical' | 'nautical' | 'civil' | 'day'

export function lightPhase(altitude: number): LightPhase {
  if (altitude >= -0.833) return 'day'
  if (altitude >= -6) return 'civil'
  if (altitude >= -12) return 'nautical'
  if (altitude >= -18) return 'astronomical'
  return 'night'
}

interface DaySample {
  /** Local minutes of day (0 … 1440), as the time slider maps them. */
  minutes: number
  utc: number
  altitude: number
}

/** `steps + 1` evenly spaced local-time samples from 00:00 to 24:00. */
function daySamples(
  date: string,
  timeZone: string,
  latitude: number,
  longitude: number,
  steps: number,
  altitudeAt: (utcMs: number, latitude: number, longitude: number) => number
): DaySample[] {
  const out: DaySample[] = []
  // On a day without a clock change, local minutes map linearly to UTC: two zone conversions
  // instead of one per sample (each costs several Intl calls).
  const start = zonedToUtc(date, 0, timeZone)
  const end = zonedToUtc(addDays(date, 1), 0, timeZone)
  const linear = end - start === 1440 * 60000 && offsetMinutes(start, timeZone) === offsetMinutes(end, timeZone)
  for (let i = 0; i <= steps; i++) {
    const minutes = (i / steps) * 1440
    const utc = linear ? start + minutes * 60000 : zonedToUtc(date, minutes, timeZone)
    out.push({ minutes, utc, altitude: altitudeAt(utc, latitude, longitude) })
  }
  return out
}

/**
 * Samples the sun altitude across the local day.
 * Returns `steps + 1` altitudes from 00:00 to 24:00 local time.
 */
export function altitudeProfile(
  date: string,
  timeZone: string,
  latitude: number,
  longitude: number,
  steps = 96
): number[] {
  return daySamples(date, timeZone, latitude, longitude, steps, (t, la, lo) => sunPosition(t, la, lo).altitude).map((s) => s.altitude)
}

/**
 * Geometric sun altitudes that split the day into light bands, ascending: astronomical, nautical and
 * civil twilight start at −18°, −12° and −6°; blue hour runs from −6° to −4°, golden hour
 * from −4° to +6°; −0.833° is sunrise/sunset (the upper limb on the refracted horizon).
 */
export const BAND_EDGES = [-18, -12, -6, -4, -0.833, 6] as const

/**
 * The stretch of sky between two consecutive `BAND_EDGES`, lowest first: `SKY_BANDS[i]` lies
 * between `BAND_EDGES[i - 1]` and `BAND_EDGES[i]`. `goldenTwilight` is the part of golden hour
 * with the sun still below the horizon (it is also the end of civil twilight).
 */
export const SKY_BANDS = ['night', 'astronomical', 'nautical', 'blue', 'goldenTwilight', 'golden', 'day'] as const
export type SkyBand = (typeof SKY_BANDS)[number]

/** The sky band for a geometric sun altitude (see `geometricAltitude`). */
export function skyBand(altitude: number): SkyBand {
  let i = 0
  while (i < BAND_EDGES.length && altitude >= BAND_EDGES[i]) i++
  return SKY_BANDS[i]
}

/** A stretch of the local day in one band, in local minutes (0 … 1440). */
export interface BandSegment {
  start: number
  end: number
  band: SkyBand
}

/**
 * Splits the local day into sky bands. Edge crossings are found on a 15-minute grid and then
 * bisected to well under a second, so the slider shading and the band times agree exactly.
 * A grazing pass through an edge between two grid samples (minutes at most) is not seen.
 */
export function dayBands(date: string, timeZone: string, latitude: number, longitude: number, steps = 96): BandSegment[] {
  const samples = daySamples(date, timeZone, latitude, longitude, steps, geometricAltitude)
  const crossings: Array<{ minutes: number; rising: boolean; edge: number }> = []
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i]
    const b = samples[i + 1]
    const found: typeof crossings = []
    BAND_EDGES.forEach((h, edge) => {
      if (a.altitude >= h === b.altitude >= h) return
      const rising = b.altitude > a.altitude
      // Bisect on the UTC instant: 15 min / 2^12 ≈ 0.2 s.
      let lo = a.utc
      let hi = b.utc
      for (let k = 0; k < 12; k++) {
        const mid = (lo + hi) / 2
        if (geometricAltitude(mid, latitude, longitude) >= h === rising) hi = mid
        else lo = mid
      }
      const f = ((lo + hi) / 2 - a.utc) / (b.utc - a.utc)
      found.push({ minutes: a.minutes + f * (b.minutes - a.minutes), rising, edge })
    })
    crossings.push(...found.sort((x, y) => x.minutes - y.minutes))
  }

  const segments: BandSegment[] = []
  let level = SKY_BANDS.indexOf(skyBand(samples[0].altitude))
  let start = 0
  for (const c of crossings) {
    const next = c.rising ? c.edge + 1 : c.edge
    if (next === level) continue
    if (c.minutes > start) segments.push({ start, end: c.minutes, band: SKY_BANDS[level] })
    start = c.minutes
    level = next
  }
  segments.push({ start, end: 1440, band: SKY_BANDS[level] })
  return segments
}

export type LightWindowId = 'golden' | 'blue' | 'civil' | 'nautical' | 'astronomical'

export interface LightWindowDef {
  id: LightWindowId
  label: string
  /** Geometric sun altitude range, degrees. */
  from: number
  to: number
  bands: readonly SkyBand[]
}

/** The named light windows photographers plan around, in the order the panel lists them. */
export const LIGHT_WINDOWS: readonly LightWindowDef[] = [
  { id: 'golden', label: 'Golden hour', from: -4, to: 6, bands: ['goldenTwilight', 'golden'] },
  { id: 'blue', label: 'Blue hour', from: -6, to: -4, bands: ['blue'] },
  { id: 'civil', label: 'Civil twilight', from: -6, to: -0.833, bands: ['blue', 'goldenTwilight'] },
  { id: 'nautical', label: 'Nautical twilight', from: -12, to: -6, bands: ['nautical'] },
  { id: 'astronomical', label: 'Astronomical twilight', from: -18, to: -12, bands: ['astronomical'] }
]

/** One continuous stretch of a light window within the local day. */
export interface LightWindow {
  /** Local minutes of day. */
  start: number
  end: number
  /** Already under way at 00:00 / still going at 24:00. */
  fromPreviousDay: boolean
  intoNextDay: boolean
  /**
   * `morning`: the sun passes up through the window; `evening`: down through it;
   * `span`: it climbs in and sinks back out (or never leaves) without crossing it,
   * as when the sun never gets higher than golden hour, or dips only into twilight at night.
   */
  kind: 'morning' | 'evening' | 'span'
}

/** Where each light window falls in the local day, from `dayBands` output. */
export function lightWindows(segments: readonly BandSegment[]): Record<LightWindowId, LightWindow[]> {
  const level = (b: SkyBand) => SKY_BANDS.indexOf(b)
  const out = {} as Record<LightWindowId, LightWindow[]>
  for (const def of LIGHT_WINDOWS) {
    const levels = def.bands.map(level)
    const lo = Math.min(...levels)
    const hi = Math.max(...levels)
    const windows: LightWindow[] = []
    for (let i = 0; i < segments.length; ) {
      if (!def.bands.includes(segments[i].band)) {
        i++
        continue
      }
      let j = i
      while (j + 1 < segments.length && def.bands.includes(segments[j + 1].band)) j++
      const before = segments[i - 1]
      const after = segments[j + 1]
      // Entering from below or leaving upward means the sun is climbing.
      const enteredRising = before ? level(before.band) < lo : null
      const leftRising = after ? level(after.band) > hi : null
      const edges = [enteredRising, leftRising].filter((e): e is boolean => e !== null)
      const kind = edges.length === 0 || edges[0] !== edges[edges.length - 1] ? 'span' : edges[0] ? 'morning' : 'evening'
      windows.push({ start: segments[i].start, end: segments[j].end, fromPreviousDay: !before, intoNextDay: !after, kind })
      i = j + 1
    }
    out[def.id] = windows
  }
  return out
}

/** Local minutes-of-day for a UTC instant (helper for slider markers). */
export function markerMinutes(utcMs: number | null, date: string, timeZone: string): number | null {
  if (utcMs === null) return null
  const z = utcToZoned(utcMs, timeZone)
  return z.date === date ? z.minutes : null
}

/** Unit vector toward the sun in the local east-north-up frame. */
export function sunDirectionENU(pos: SunPosition): [number, number, number] {
  const az = (pos.azimuth * Math.PI) / 180
  const alt = (pos.altitude * Math.PI) / 180
  return [Math.sin(az) * Math.cos(alt), Math.cos(az) * Math.cos(alt), Math.sin(alt)]
}
