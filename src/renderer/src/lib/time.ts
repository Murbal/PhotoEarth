// Time-zone aware date helpers built on Intl (full ICU ships with Electron).
// A "local date" is a YYYY-MM-DD string in some IANA zone; "minutes" is the local
// wall-clock time of day in minutes (may be fractional).

export const MINUTES_PER_DAY = 1440
const MS_PER_MINUTE = 60000
const MS_PER_DAY = 86400000

export interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
    formatters.set(timeZone, f)
  }
  return f
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone)
    return true
  } catch {
    return false
  }
}

export function zonedParts(utcMs: number, timeZone: string): ZonedParts {
  const parts = formatter(timeZone).formatToParts(new Date(utcMs))
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? 0)
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second')
  }
}

/** UTC offset of `timeZone` at the given instant, in minutes east of UTC. */
export function offsetMinutes(utcMs: number, timeZone: string): number {
  const p = zonedParts(utcMs, timeZone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  const truncated = Math.floor(utcMs / 1000) * 1000
  return Math.round((asUtc - truncated) / MS_PER_MINUTE)
}

export function parseDate(date: string): { year: number; month: number; day: number } {
  const m = /^(-?\d{1,6})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) throw new Error(`Invalid date: ${date}`)
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }
}

export function formatDateParts(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * Converts a local wall-clock time in `timeZone` to a UTC instant.
 * During a DST gap the non-existent wall time maps forward (like most calendars);
 * during an overlap the earlier (DST) instant is returned.
 */
export function zonedToUtc(date: string, minutes: number, timeZone: string): number {
  const { year, month, day } = parseDate(date)
  const naive = Date.UTC(year, month - 1, day) + minutes * MS_PER_MINUTE
  const matches = (utc: number): boolean => {
    const z = utcToZoned(utc, timeZone)
    return z.date === date && Math.abs(z.minutes - minutes) < 1e-6
  }
  const o1 = offsetMinutes(naive, timeZone)
  const c1 = naive - o1 * MS_PER_MINUTE
  const o2 = offsetMinutes(c1, timeZone)
  if (o1 === o2) {
    // Overlap (clocks fall back): the same wall time exists twice; return the earlier one.
    const earlier = c1 - 60 * MS_PER_MINUTE
    return matches(earlier) ? earlier : c1
  }
  const c2 = naive - o2 * MS_PER_MINUTE
  if (matches(c2)) return c2
  if (matches(c1)) return c1
  // Gap (clocks spring forward): the wall time doesn't exist; shift it forward.
  return Math.max(c1, c2)
}

export function utcToZoned(utcMs: number, timeZone: string): { date: string; minutes: number } {
  const p = zonedParts(utcMs, timeZone)
  const subSecond = (((utcMs % 1000) + 1000) % 1000) / 1000
  return {
    date: formatDateParts(p.year, p.month, p.day),
    minutes: p.hour * 60 + p.minute + (p.second + subSecond) / 60
  }
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

export function daysInYear(year: number): number {
  return isLeapYear(year) ? 366 : 365
}

/** 1-based day of year. */
export function dayOfYear(date: string): number {
  const { year, month, day } = parseDate(date)
  return Math.round((Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 1)) / MS_PER_DAY) + 1
}

export function dateFromDayOfYear(year: number, doy: number): string {
  const d = new Date(Date.UTC(year, 0, 1) + (doy - 1) * MS_PER_DAY)
  return formatDateParts(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
}

export function addDays(date: string, days: number): string {
  const { year, month, day } = parseDate(date)
  const d = new Date(Date.UTC(year, month - 1, day) + days * MS_PER_DAY)
  return formatDateParts(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
}

export function withYear(date: string, year: number): string {
  const { month, day } = parseDate(date)
  // Feb 29 → Feb 28 in non-leap years.
  const safeDay = month === 2 && day === 29 && !isLeapYear(year) ? 28 : day
  return formatDateParts(year, month, safeDay)
}

/**
 * Adds a (possibly negative or > 1 day) number of minutes to a local date/time,
 * carrying whole days into the date.
 */
export function addMinutes(date: string, minutes: number, delta: number): { date: string; minutes: number } {
  const total = minutes + delta
  const dayShift = Math.floor(total / MINUTES_PER_DAY)
  return { date: dayShift ? addDays(date, dayShift) : date, minutes: total - dayShift * MINUTES_PER_DAY }
}

export function formatClock(minutes: number, withSeconds = false): string {
  const totalSeconds = Math.floor(minutes * 60 + 1e-6)
  const h = Math.floor(totalSeconds / 3600) % 24
  const m = Math.floor(totalSeconds / 60) % 60
  const s = totalSeconds % 60
  const hm = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  return withSeconds ? `${hm}:${String(s).padStart(2, '0')}` : hm
}

/** "UTC+2", "UTC−3:30", "UTC" */
export function formatOffset(offsetMin: number): string {
  if (offsetMin === 0) return 'UTC'
  const sign = offsetMin > 0 ? '+' : '−'
  const abs = Math.abs(offsetMin)
  const h = Math.floor(abs / 60)
  const m = abs % 60
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`
}

const zoneNameFormatters = new Map<string, Intl.DateTimeFormat | null>()

/** Time-zone abbreviation such as "CEST", falling back to the offset. */
export function zoneAbbreviation(utcMs: number, timeZone: string): string {
  let f = zoneNameFormatters.get(timeZone)
  if (f === undefined) {
    // Building a formatter costs ~20× formatting with one; this runs every playback frame.
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
    } catch {
      f = null
    }
    zoneNameFormatters.set(timeZone, f)
  }
  if (!f) return ''
  try {
    return f.formatToParts(new Date(utcMs)).find((p) => p.type === 'timeZoneName')?.value ?? ''
  } catch {
    return ''
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function formatShortDate(date: string): string {
  const { month, day } = parseDate(date)
  return `${MONTHS[month - 1]} ${day}`
}

export function formatLongDate(date: string): string {
  const { year, month, day } = parseDate(date)
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]
  return `${weekday}, ${MONTHS[month - 1]} ${day}, ${year}`
}

/** Minutes of the local day for an instant in a zone (convenience). */
export function localMinutesOf(utcMs: number, timeZone: string): number {
  return utcToZoned(utcMs, timeZone).minutes
}
