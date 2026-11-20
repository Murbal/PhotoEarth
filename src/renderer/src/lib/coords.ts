// Coordinate parsing (decimal, DMS/DDM, Google Maps URLs) and formatting.

export interface ParsedLocation {
  latitude: number
  longitude: number
  /** Camera altitude above ground in meters (Google `…a` URL parameter). */
  altitude?: number
  /** Distance from the view center in meters (Google `…m` parameter or derived from zoom). */
  range?: number
  /** Camera heading, degrees clockwise from north. */
  heading?: number
  /** Google tilt: 0 = looking straight down, 90 = level with the horizon. */
  tilt?: number
  source: 'decimal' | 'dms' | 'url'
}

const NUM = String.raw`(\d+(?:\.\d+)?)`
const SNUM = String.raw`([+-]?\d+(?:\.\d+)?)`
// Degrees, then optional minutes and seconds. Parts are separated by their symbol or by
// whitespace, so digits are never split ("4633" is not 46°33').
const BODY = String.raw`${SNUM}(?:\s*°)?(?:(?:(?<=°)\s*|\s+)${NUM}(?:\s*')?)?(?:(?:(?<=')\s*|\s+)${NUM}(?:\s*")?)?\s*`
// Hemisphere letters either all before ("N 46° 33'") or all after ("46°33'N") the numbers.
// The unused hemisphere slot is an empty group so both forms share capture indices.
const PREFIXED = String.raw`(?:([NSEW])\s*)?${BODY}()`
const SUFFIXED = String.raw`()${BODY}([NSEW])?`
const SEPARATOR = String.raw`(?:\s*[,;/]\s*|\s+|(?<=[NSEW°'"]))`
const PAIRS = [PREFIXED, SUFFIXED].map((c) => new RegExp(String.raw`^\s*${c}${SEPARATOR}${c}\s*$`))

function normalize(input: string): string {
  return input
    .toUpperCase()
    .replace(/[º˚]/g, '°')
    .replace(/[′’‘`´]/g, "'")
    .replace(/[″“”]/g, '"')
    .replace(/''/g, '"')
    .replace(/\bDEG\b/g, '°')
    .replace(/\s+/g, ' ')
    .trim()
}

interface Component {
  value: number
  hemisphere: string | null
  hasMinutes: boolean
}

function component(
  pre: string | undefined,
  deg: string,
  min: string | undefined,
  sec: string | undefined,
  post: string | undefined
): Component | null {
  if (pre && post) return null
  const d = Number(deg)
  const m = min !== undefined ? Number(min) : 0
  const s = sec !== undefined ? Number(sec) : 0
  if (min !== undefined && (!Number.isInteger(Math.abs(d)) || m >= 60)) return null
  if (sec !== undefined && (!Number.isInteger(m) || s >= 60)) return null
  const hemisphere = pre ?? post ?? null
  if (hemisphere && deg.startsWith('-')) return null
  const magnitude = Math.abs(d) + m / 60 + s / 3600
  return { value: d < 0 || deg.startsWith('-') ? -magnitude : magnitude, hemisphere, hasMinutes: min !== undefined }
}

/** Parses "46.5577, 7.9586", "46°33'27.7\"N 7°57'31.0\"E", "N 46° 33.46' E 7° 57.52'" etc. */
export function parseCoordinatePair(input: string): ParsedLocation | null {
  const text = normalize(input)
  for (const re of PAIRS) {
    const m = re.exec(text)
    if (!m) continue
    const g = (i: number): string | undefined => m[i] || undefined
    const a = component(g(1), m[2], g(3), g(4), g(5))
    const b = component(g(6), m[7], g(8), g(9), g(10))
    if (!a || !b) continue
    const result = combine(a, b)
    if (result) return result
  }
  return null
}

function combine(a: Component, b: Component): ParsedLocation | null {
  let lat: Component
  let lon: Component
  const isLat = (c: Component) => c.hemisphere === 'N' || c.hemisphere === 'S'
  const isLon = (c: Component) => c.hemisphere === 'E' || c.hemisphere === 'W'
  if (a.hemisphere || b.hemisphere) {
    if ((isLat(a) && isLat(b)) || (isLon(a) && isLon(b))) return null
    if (isLon(a) || isLat(b)) [lat, lon] = [b, a]
    else [lat, lon] = [a, b]
  } else {
    ;[lat, lon] = [a, b]
  }
  const latitude = lat.hemisphere === 'S' ? -lat.value : lat.value
  const longitude = lon.hemisphere === 'W' ? -lon.value : lon.value
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null
  return { latitude, longitude, source: a.hasMinutes || b.hasMinutes ? 'dms' : 'decimal' }
}

/** Approximate camera distance for a Google Maps web zoom level on a ~900 px tall view. */
export function rangeFromZoom(zoom: number, latitude: number): number {
  const metersPerPixel = (156543.03392 * Math.cos((latitude * Math.PI) / 180)) / 2 ** zoom
  return metersPerPixel * 900 * 0.866
}

export function isGoogleMapsUrl(input: string): boolean {
  const text = input.trim()
  return /^(https?:\/\/)?(((www|maps)\.)?google\.[a-z.]+\/maps|maps\.google\.[a-z.]+)/i.test(text) || /^geo:/i.test(text)
}

export function isShortMapsLink(input: string): boolean {
  return /^(https?:\/\/)?(maps\.app\.goo\.gl|goo\.gl\/maps)\//i.test(input.trim())
}

/** Parses Google Maps URLs: `/@lat,lng,15z`, `/@lat,lng,500a,35y,90h,70t`, `!3d…!4d…`, `?q=lat,lng`. */
export function parseGoogleMapsUrl(input: string): ParsedLocation | null {
  const text = input.trim()
  const geo = /^geo:\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/i.exec(text)
  if (geo) {
    const p = parseCoordinatePair(`${geo[1]},${geo[2]}`)
    return p ? { ...p, source: 'url' } : null
  }
  if (!isGoogleMapsUrl(text)) return null
  let decoded = text
  try {
    decoded = decodeURIComponent(text)
  } catch {
    /* keep raw */
  }

  let result: ParsedLocation | null = null
  const at = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)((?:,[\d.]+[a-z])*)/i.exec(decoded)
  if (at) {
    const latitude = Number(at[1])
    const longitude = Number(at[2])
    if (Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
      result = { latitude, longitude, source: 'url' }
      for (const param of at[3].split(',').filter(Boolean)) {
        const value = Number(param.slice(0, -1))
        if (!Number.isFinite(value)) continue
        switch (param.slice(-1).toLowerCase()) {
          case 'z':
            result.range = rangeFromZoom(value, latitude)
            break
          case 'm':
            result.range = value
            break
          case 'a':
            result.altitude = value
            break
          case 'h':
            result.heading = value
            break
          case 't':
            result.tilt = value
            break
        }
      }
    }
  }

  // Place pins carry their exact location in the data blob.
  const pin = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(decoded)
  if (pin) {
    const latitude = Number(pin[1])
    const longitude = Number(pin[2])
    if (Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
      result = { ...(result ?? { source: 'url' as const }), latitude, longitude }
    }
  }

  if (!result) {
    try {
      const url = new URL(/^https?:/i.test(text) ? text : `https://${text}`)
      for (const key of ['q', 'query', 'll', 'center', 'viewpoint', 'destination', 'daddr']) {
        const v = url.searchParams.get(key)
        const p = v ? parseCoordinatePair(v) : null
        if (p) return { ...p, source: 'url' }
      }
      const search = /\/(?:search|place|dir)\/([^/]+)/.exec(url.pathname)
      const p = search ? parseCoordinatePair(decodeURIComponent(search[1]).replace(/\+/g, ' ')) : null
      if (p) return { ...p, source: 'url' }
    } catch {
      return null
    }
  }
  return result
}

/** Any supported coordinate input. */
export function parseLocationInput(input: string): ParsedLocation | null {
  return parseGoogleMapsUrl(input) ?? parseCoordinatePair(input)
}

function dms(value: number, positive: string, negative: string, secondsDigits = 1): string {
  const hemi = value < 0 ? negative : positive
  const abs = Math.abs(value)
  let d = Math.floor(abs)
  let m = Math.floor((abs - d) * 60)
  const factor = 10 ** secondsDigits
  let s = Math.round(((abs - d) * 3600 - m * 60) * factor) / factor
  if (s >= 60) {
    s -= 60
    m += 1
  }
  if (m >= 60) {
    m -= 60
    d += 1
  }
  return `${d}°${String(m).padStart(2, '0')}′${s.toFixed(secondsDigits).padStart(secondsDigits + 3, '0')}″${hemi}`
}

export function formatLatitude(lat: number, format: 'decimal' | 'dms'): string {
  return format === 'dms' ? dms(lat, 'N', 'S') : `${Math.abs(lat).toFixed(5)}° ${lat < 0 ? 'S' : 'N'}`
}

export function formatLongitude(lon: number, format: 'decimal' | 'dms'): string {
  return format === 'dms' ? dms(lon, 'E', 'W') : `${Math.abs(lon).toFixed(5)}° ${lon < 0 ? 'W' : 'E'}`
}

export function formatLatLon(lat: number, lon: number, format: 'decimal' | 'dms'): string {
  return `${formatLatitude(lat, format)}, ${formatLongitude(lon, format)}`
}

/** Plain, machine-friendly form for the clipboard ("46.557700, 7.958600"). */
export function formatLatLonPlain(lat: number, lon: number): string {
  return `${lat.toFixed(6)}, ${lon.toFixed(6)}`
}

export function normalizeLongitude(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180
}
