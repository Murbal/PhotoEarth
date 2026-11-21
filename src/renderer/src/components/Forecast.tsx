import { useMemo } from 'react'
import type { Units, WeatherSeries } from '@shared/types'
import { haversine } from '../lib/profile'
import { astroNight, LOW_MOON_ILLUMINATION, type AstroNight } from '../lib/milkyWay'
import { addDays, formatClock, formatDuration, formatShortDate, localMinutesOf, parseDate, utcToZoned, zonedToUtc } from '../lib/time'
import { compassPoint, formatDistance, formatSpeed } from '../lib/units'
import {
  fogRisk,
  forecastDays,
  forecastHour,
  hoursOnDate,
  STRONG_GUST,
  windLevel,
  type DayOutlook,
  type Forecast,
  type GlowOutlook,
  type TwilightOutlook
} from '../lib/weather'
import { useAppStore, type WeatherState } from '../store/appStore'

/** Past this, a forecast is for somewhere else: hide it until the new one arrives. */
const SHOW_WITHIN_M = 25_000

/** The forecast, while it's still for (about) the view center. */
export function useViewForecast(): WeatherState & { usable: Forecast | null } {
  const weather = useAppStore((s) => s.weather)
  const target = useAppStore((s) => s.target)
  const enabled = useAppStore((s) => s.settings.forecast)
  const f = weather.forecast
  const usable = enabled && f && target && haversine(f.location, target) <= SHOW_WITHIN_M ? f : null
  return { ...weather, usable }
}

const LANES = [
  { key: 'cloudHigh', title: 'High cloud (above ~6 km): the canvas for sunset colour' },
  { key: 'cloudMid', title: 'Mid cloud (~2–6 km)' },
  { key: 'cloudLow', title: 'Low cloud and fog (below ~2 km): hides the sky above it' }
] as const

function laneGradient(s: WeatherSeries, key: (typeof LANES)[number]['key'], hours: Array<{ minutes: number; index: number }>): string {
  const pct = (m: number) => `${((m / 1440) * 100).toFixed(2)}%`
  const stops: string[] = []
  const first = hours[0].minutes
  const last = hours[hours.length - 1].minutes
  // Each value holds half an hour either side of its hour, then fades into the next.
  if (first > 0) stops.push(`transparent ${pct(Math.max(0, first - 30))}`)
  for (const { minutes, index } of hours) {
    const v = s[key][index]
    const color = v === null ? 'transparent' : `color-mix(in srgb, var(--cloud) ${Math.round(v)}%, transparent)`
    stops.push(`${color} ${pct(minutes)}`)
  }
  if (last < 1440) stops.push(`transparent ${pct(Math.min(1440, last + 30))}`)
  return `linear-gradient(90deg, ${stops.join(', ')})`
}

/** High, mid and low cloud through the day, aligned with the time slider above. */
export function CloudLanes({ forecast, date, timeZone }: { forecast: Forecast; date: string; timeZone: string }) {
  const lanes = useMemo(() => {
    const hours = hoursOnDate(forecast.observer, date, timeZone)
    if (hours.length === 0) return null
    return LANES.map((l) => ({ ...l, background: laneGradient(forecast.observer, l.key, hours) }))
  }, [forecast, date, timeZone])
  if (!lanes) return null
  return (
    <div className="cloud-lanes" aria-label="Cloud cover through the day: high, mid and low">
      {lanes.map((l) => (
        <div key={l.key} className="cloud-lane" title={l.title}>
          <div className="cloud-fill" style={{ background: l.background }} />
        </div>
      ))}
    </div>
  )
}

const RATING_LABEL: Record<GlowOutlook['rating'], string> = { poor: 'Poor', fair: 'Fair', good: 'Good', great: 'Great' }

function glowTitle(kind: 'Sunrise' | 'Sunset', t: TwilightOutlook, timeZone: string, azimuth: number): string {
  const g = t.glow
  const lines = [
    `${kind} ${formatClock(utcToZoned(t.utc, timeZone).minutes)}: ${RATING_LABEL[g.rating]} (${g.score}/100)`,
    g.summary,
    `Mid/high cloud overhead ${g.canvas}%, low cloud overhead ${g.low}%`,
    g.horizon === null ? 'No sample toward the sun' : `Low/mid cloud 150 km toward the ${kind.toLowerCase()} (${compassPoint(azimuth)}) ${g.horizon}%`
  ]
  if (g.precipitation > 0) lines.push(`Rain chance ${g.precipitation}%`)
  return lines.join('\n')
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function weekday(date: string): string {
  const { year, month, day } = parseDate(date)
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]
}

function astroTitle(night: AstroNight, timeZone: string): string {
  const nextDay = parseDate(addDays(night.date, 1)).day
  const lines = [`Night ${formatShortDate(night.date)}–${nextDay}: ${RATING_LABEL[night.rating]}`]
  if (night.astroDark.length === 0) {
    lines.push(`No astronomical night (sun reaches ${night.darkestSunAltitude.toFixed(1)}°)`)
  } else if (night.moonlessDark.length === 0) {
    lines.push('Moon up during astronomical night')
  } else if (night.coreDarkWindows.length > 0 && night.peakCore) {
    const w = night.coreDarkWindows[0]
    lines.push(
      `Core dark window ${formatClock(localMinutesOf(w.start, timeZone))}–${formatClock(localMinutesOf(w.end, timeZone))} (${formatDuration(night.totalCoreDarkMs)})`
    )
    lines.push(
      `Peak core ${formatClock(localMinutesOf(night.peakCore.utc, timeZone))} (${night.peakCore.altitude.toFixed(1)}° ${compassPoint(night.peakCore.azimuth)})`
    )
  } else {
    const w = night.moonlessDark[0]
    lines.push(
      `Moonless dark ${formatClock(localMinutesOf(w.start, timeZone))}–${formatClock(localMinutesOf(w.end, timeZone))} (${formatDuration(night.totalMoonlessDarkMs)}) · core below threshold`
    )
  }
  if (night.clouds) lines.push(`${night.clouds.label}: avg ${night.clouds.meanCloud}% cloud (best ${night.clouds.minCloud}%)`)
  if (night.peakCore || night.moonlessDark.length > 0) lines.push('Click to jump to peak core / dark window')
  return lines.join('\n')
}

function DayChip({
  day,
  astro,
  selected,
  forecast,
  timeZone,
  units,
  onPick
}: {
  day: DayOutlook
  astro: AstroNight | null
  selected: boolean
  forecast: Forecast
  timeZone: string
  units: Units
  onPick: (utc: number) => void
}) {
  const strongWind = day.maxGust !== null && day.maxGust >= STRONG_GUST
  const notes = [day.morningFog.level === 'likely' ? 'fog' : day.morningFog.level === 'possible' ? 'fog?' : '', strongWind ? 'wind' : ''].filter(Boolean)
  const twilight = (kind: 'Sunrise' | 'Sunset', t: TwilightOutlook | null, azimuth: number) =>
    t ? (
      <button
        className={`glow-dot glow-${t.glow.rating}`}
        title={glowTitle(kind, t, timeZone, azimuth)}
        aria-label={`${kind} ${formatShortDate(day.date)}: ${RATING_LABEL[t.glow.rating]}`}
        onClick={() => onPick(t.utc)}
      >
        {kind === 'Sunrise' ? '↑' : '↓'}
      </button>
    ) : (
      <span className="glow-dot glow-none" aria-hidden="true">
        {kind === 'Sunrise' ? '↑' : '↓'}
      </span>
    )
  const astroJump = astro?.peakCore?.utc ?? astro?.moonlessDark[0]?.start ?? astro?.astroDark[0]?.start ?? null
  const fogTitle = day.morningFog.level !== 'low' ? `Fog ${day.morningFog.level} around sunrise (${day.morningFog.reason})` : ''
  const windTitle = day.maxGust !== null ? `Gusts up to ${formatSpeed(day.maxGust, units)} in daylight` : ''
  return (
    <div className={`forecast-day${selected ? ' selected' : ''}`} title={[fogTitle, windTitle].filter(Boolean).join('\n') || undefined}>
      <div className="forecast-day-label">
        {weekday(day.date)} <span className="muted">{parseDate(day.date).day}</span>
      </div>
      <div className="forecast-day-glow">
        {twilight('Sunrise', day.sunrise, forecast.sunriseAzimuth)}
        {twilight('Sunset', day.sunset, forecast.sunsetAzimuth)}
        {astro && astroJump !== null ? (
          <button
            className={`glow-dot astro-dot astro-${astro.rating}`}
            title={astroTitle(astro, timeZone)}
            aria-label={`Astro night ${formatShortDate(day.date)}: ${RATING_LABEL[astro.rating]}`}
            onClick={() => onPick(astroJump)}
          >
            ✦
          </button>
        ) : (
          <span className="glow-dot glow-none" title={astro ? astroTitle(astro, timeZone) : undefined} aria-hidden="true">
            ✦
          </span>
        )}
      </div>
      <div className="forecast-day-note">{notes.join(' ') || '\u00a0'}</div>
    </div>
  )
}

function TwilightLine({ kind, t, timeZone, azimuth }: { kind: 'Sunrise' | 'Sunset'; t: TwilightOutlook; timeZone: string; azimuth: number }) {
  const g = t.glow
  return (
    <>
      <span className="k">
        {kind} {formatClock(utcToZoned(t.utc, timeZone).minutes)}
      </span>
      <span className={`glow-rating glow-${g.rating}`} title={glowTitle(kind, t, timeZone, azimuth)}>
        {RATING_LABEL[g.rating]} <span className="mono">{g.score}</span>
      </span>
      <span className="muted">{g.summary}</span>
    </>
  )
}

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v)}%`)

/**
 * Sunrise and sunset colour outlook for the next 16 days, and the clouds, visibility, wind and
 * fog risk at the selected hour.
 */
export function ForecastSection({
  date,
  minutes,
  timeZone,
  units,
  onPick
}: {
  date: string
  minutes: number
  timeZone: string
  units: Units
  onPick: (utc: number) => void
}) {
  const { usable: forecast, status, error } = useViewForecast()
  const astroPrefs = useAppStore((s) => s.settings.astro)
  const days = useMemo(
    () => (forecast ? forecastDays(forecast, timeZone, utcToZoned(Date.now(), timeZone).date) : []),
    [forecast, timeZone]
  )
  const astroByDate = useMemo(() => {
    const map = new Map<string, AstroNight>()
    if (!forecast) return map
    const { latitude, longitude } = forecast.location
    const maxMoonIllumination = astroPrefs.allowLowMoon ? LOW_MOON_ILLUMINATION : 0
    for (const d of days) {
      map.set(
        d.date,
        astroNight(d.date, timeZone, latitude, longitude, {
          minCoreAltitude: astroPrefs.minCoreAltitude,
          maxMoonIllumination,
          weather: forecast.observer,
          stepMinutes: 10
        })
      )
    }
    return map
  }, [forecast, days, timeZone, astroPrefs.minCoreAltitude, astroPrefs.allowLowMoon])

  const header = (
    <div className="forecast-header">
      <span className="k">Weather</span>
      {status === 'loading' && <span className="small muted">{forecast ? 'Updating…' : 'Loading forecast…'}</span>}
      {status === 'error' && (
        <span className="small" style={{ color: 'var(--warn)' }} title={error ?? undefined}>
          {forecast ? 'Update failed' : `Forecast unavailable${error ? `: ${error}` : ''}`}
        </span>
      )}
      <span
        className="forecast-legend small muted"
        title="Sunrise (↑), sunset (↓) colour outlook and night astro window (✦). Click one to jump to it."
      >
        {(['poor', 'fair', 'good', 'great'] as const).map((r) => (
          <span key={r}>
            <span className={`legend-swatch glow-${r}`} aria-hidden="true" />
            {RATING_LABEL[r]}
          </span>
        ))}
      </span>
      {forecast && (
        <span className="forecast-legend small muted" title="The three bands under the time slider: high, mid and low cloud, brighter where there's more">
          <span className="legend-lanes" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          Cloud high / mid / low
        </span>
      )}
      <a className="small faint forecast-credit" href="https://open-meteo.com/" target="_blank" rel="noreferrer">
        Weather data by Open-Meteo.com
      </a>
    </div>
  )
  if (!forecast) return <div className="forecast">{header}</div>

  const utc = zonedToUtc(date, minutes, timeZone)
  const hour = forecastHour(forecast.observer, utc)
  const today = days.find((d) => d.date === date)
  const nightDate = minutes < 360 ? addDays(date, -1) : date
  const todayAstro = astroByDate.get(nightDate) ?? null
  const fog = hour ? fogRisk(hour) : null
  const wind = hour ? windLevel(hour.windSpeed, hour.windGusts) : null
  const lastDate = days.length > 0 ? days[days.length - 1].date : null

  return (
    <div className="forecast">
      {header}
      <div className="forecast-days" role="list" aria-label="Sunrise, sunset and astro night outlook by day">
        {days.map((d) => (
          <div role="listitem" key={d.date}>
            <DayChip
              day={d}
              astro={astroByDate.get(d.date) ?? null}
              selected={d.date === date}
              forecast={forecast}
              timeZone={timeZone}
              units={units}
              onPick={onPick}
            />
          </div>
        ))}
      </div>
      {today || hour ? (
        <div className="forecast-detail">
          {today?.sunrise && <TwilightLine kind="Sunrise" t={today.sunrise} timeZone={timeZone} azimuth={forecast.sunriseAzimuth} />}
          {today?.sunset && <TwilightLine kind="Sunset" t={today.sunset} timeZone={timeZone} azimuth={forecast.sunsetAzimuth} />}
          {todayAstro?.clouds && (
            <>
              <span className="k">Astro {formatShortDate(todayAstro.date)}</span>
              <span className={`glow-rating astro-${todayAstro.rating}`} title={astroTitle(todayAstro, timeZone)}>
                {todayAstro.clouds.label} <span className="mono">{todayAstro.clouds.meanCloud}%</span>
              </span>
              <span className="muted">
                {todayAstro.coreDarkWindows.length > 0 && todayAstro.peakCore ? (
                  <>
                    Core window{' '}
                    <button
                      className="time-link mw mono"
                      onClick={() => onPick(todayAstro.coreDarkWindows[0].start)}
                      title="Jump to Galactic Core dark-window start"
                    >
                      {formatClock(localMinutesOf(todayAstro.coreDarkWindows[0].start, timeZone))}–
                      {formatClock(localMinutesOf(todayAstro.coreDarkWindows[0].end, timeZone))}
                    </button>
                    {' · peak '}
                    <button
                      className="time-link mw mono"
                      onClick={() => onPick(todayAstro.peakCore!.utc)}
                      title="Jump to peak Galactic Core"
                    >
                      {formatClock(localMinutesOf(todayAstro.peakCore.utc, timeZone))} ({todayAstro.peakCore.altitude.toFixed(0)}°)
                    </button>
                  </>
                ) : todayAstro.moonlessDark.length > 0 ? (
                  <>
                    Moonless dark{' '}
                    <button
                      className="time-link mw mono"
                      onClick={() => onPick(todayAstro.moonlessDark[0].start)}
                      title="Jump to moonless dark window start"
                    >
                      {formatClock(localMinutesOf(todayAstro.moonlessDark[0].start, timeZone))}–
                      {formatClock(localMinutesOf(todayAstro.moonlessDark[0].end, timeZone))}
                    </button>{' '}
                    · core below threshold
                  </>
                ) : (
                  'No moonless dark window'
                )}
              </span>
            </>
          )}
          {hour && (
            <>
              <span className="k">At {formatClock(utcToZoned(hour.utc, timeZone).minutes)}</span>
              <span className="forecast-hour">
                <span title="Cloud cover: high (above ~6 km), mid (~2–6 km), low (below ~2 km), as in the bands under the time slider">
                  Cloud high <span className="mono">{pct(hour.cloudHigh)}</span> mid <span className="mono">{pct(hour.cloudMid)}</span> low{' '}
                  <span className="mono">{pct(hour.cloudLow)}</span>
                </span>
                <span>
                  Visibility <span className="mono">{hour.visibility === null ? '—' : formatDistance(hour.visibility, units)}</span>
                </span>
                <span title={wind?.note}>
                  Wind <span className="mono">{formatSpeed(hour.windSpeed, units)}</span>
                  {hour.windDirection !== null && ` ${compassPoint(hour.windDirection)}`}
                  {hour.windGusts !== null && (
                    <>
                      , gusts <span className={`mono${wind?.level === 'strong' ? ' warn' : ''}`}>{formatSpeed(hour.windGusts, units)}</span>
                    </>
                  )}
                </span>
                <span>
                  Rain <span className="mono">{pct(hour.precipitationProbability)}</span>
                </span>
                <span title={fog && fog.level !== 'low' ? fog.reason : 'Estimated from visibility, humidity, dew point and wind'}>
                  Fog <span className={fog?.level === 'likely' ? 'warn' : ''}>{fog ? (fog.level === 'low' ? 'unlikely' : fog.level) : '—'}</span>
                </span>
              </span>
            </>
          )}
        </div>
      ) : (
        <div className="small muted">
          No forecast for {formatShortDate(date)}
          {lastDate ? `: it covers today to ${formatShortDate(lastDate)}.` : '.'}
        </div>
      )}
    </div>
  )
}
