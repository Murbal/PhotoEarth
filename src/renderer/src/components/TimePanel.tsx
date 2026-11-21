import { useMemo } from 'react'
import { getEngine } from '../engine/instance'
import { PLAYBACK_SPEEDS } from '../engine/SunController'
import { sunlitBands } from '../lib/horizon'
import { seasonEvents } from '../lib/seasons'
import { markerMinutes } from '../lib/sun'
import {
  dateFromDayOfYear,
  dayOfYear,
  daysInYear,
  formatClock,
  formatDuration,
  formatLongDate,
  formatOffset,
  parseDate,
  utcToZoned,
  withYear
} from '../lib/time'
import { compassPoint } from '../lib/units'
import { useAppStore, type PlaybackSpeedId } from '../store/appStore'
import { Icon } from './Icon'
import { TrackSlider, type SliderMarker } from './Slider'

/** Sky color for a sun altitude, used to shade the time-of-day slider. */
function skyColor(alt: number): string {
  if (alt < -18) return '#0a0f1f'
  if (alt < -12) return '#121a36'
  if (alt < -6) return '#1f2b55'
  if (alt < -0.833) return '#4a4a7a'
  if (alt < 6) return '#d9925a'
  if (alt < 15) return '#8fb6d8'
  return '#a9d1f2'
}

function dayGradient(profile: number[]): string {
  if (profile.length === 0) return 'var(--panel-hover)'
  const stops = profile.map((alt, i) => `${skyColor(alt)} ${((i / (profile.length - 1)) * 100).toFixed(2)}%`)
  return `linear-gradient(90deg, ${stops.join(', ')})`
}

const SPOT_SUN = '#a9d1f2'
const SPOT_SHADE = '#1f2b55'

/** Two tones only, sun on the marker or not: twilight and golden hour are flat-horizon ideas. */
function sunlitGradient(bands: Array<[number, number]>): string {
  if (bands.length === 0) return SPOT_SHADE
  const pct = (m: number) => `${((m / 1440) * 100).toFixed(2)}%`
  const stops: string[] = []
  let at = 0
  for (const [start, end] of bands) {
    stops.push(`${SPOT_SHADE} ${pct(at)}`, `${SPOT_SHADE} ${pct(start)}`, `${SPOT_SUN} ${pct(start)}`, `${SPOT_SUN} ${pct(end)}`)
    at = end
  }
  stops.push(`${SPOT_SHADE} ${pct(at)}`, `${SPOT_SHADE} 100%`)
  return `linear-gradient(90deg, ${stops.join(', ')})`
}

/** ~100 m precision: plenty for sun times, and short enough to fit the header. */
function shortLatLon(lat: number, lon: number): string {
  return `${Math.abs(lat).toFixed(3)}° ${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon).toFixed(3)}° ${lon < 0 ? 'W' : 'E'}`
}

const MONTH_STARTS = [1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335]
const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D']

export function TimePanel() {
  const open = useAppStore((s) => s.panels.time)
  const sim = useAppStore((s) => s.sim)
  const sun = useAppStore((s) => s.sun)
  const settings = useAppStore((s) => s.settings)
  const patchSim = useAppStore((s) => s.patchSim)
  const patchSettings = useAppStore((s) => s.patchSettings)
  const togglePanel = useAppStore((s) => s.togglePanel)
  const terrainShadows = useAppStore((s) => s.terrainShadows)
  const mode = useAppStore((s) => s.mode)
  const target = useAppStore((s) => s.target)
  const spotSun = useAppStore((s) => s.spotSun)
  const inspect = useAppStore((s) => s.inspect)

  const { year } = parseDate(sim.date)
  const yearDays = daysInYear(year)
  const doy = dayOfYear(sim.date)

  const seasonMarkers = useMemo<SliderMarker[]>(
    () =>
      seasonEvents(year).map((e) => {
        const local = utcToZoned(e.utc, sim.timeZone)
        const short = e.label.replace(' equinox', ' eq.').replace(' solstice', ' sol.')
        return { value: dayOfYear(local.date), label: short, className: 'season', title: `${e.label}: ${local.date} ${formatClock(local.minutes)}` }
      }),
    [year, sim.timeZone]
  )

  // `sun` is replaced every playback frame; these only change with the date and place.
  const sunrise = sun?.sunrise ?? null
  const solarNoon = sun?.solarNoon ?? null
  const sunset = sun?.sunset ?? null
  const dayTimes = useMemo(() => {
    const rise = markerMinutes(sunrise, sim.date, sim.timeZone)
    const noon = markerMinutes(solarNoon, sim.date, sim.timeZone)
    const set = markerMinutes(sunset, sim.date, sim.timeZone)
    const markers: SliderMarker[] = []
    if (rise !== null) markers.push({ value: rise, label: `↑ ${formatClock(rise)}`, title: 'Sunrise' })
    if (noon !== null) markers.push({ value: noon, label: `noon ${formatClock(noon)}`, title: 'Solar noon' })
    if (set !== null) markers.push({ value: set, label: `↓ ${formatClock(set)}`, title: 'Sunset' })
    const clock = (m: number | null) => (m === null ? '—' : formatClock(m))
    return { markers, rise: clock(rise), noon: clock(noon), set: clock(set) }
  }, [sunrise, solarNoon, sunset, sim.date, sim.timeZone])
  const profile = sun?.profile
  const dayBackground = useMemo(() => dayGradient(profile ?? []), [profile])

  // With a marker whose terrain sun times are known, the slider shows direct sun on it.
  const spot = spotSun?.status === 'ready' && spotSun.date === sim.date && spotSun.timeZone === sim.timeZone ? spotSun : null
  const spotSlider = useMemo(() => {
    if (!spot) return null
    const bands = sunlitBands(spot.spans, spot.date, spot.timeZone)
    const markers: SliderMarker[] = []
    const rise = markerMinutes(spot.firstLight, spot.date, spot.timeZone)
    const set = markerMinutes(spot.lastLight, spot.date, spot.timeZone)
    if (rise !== null) markers.push({ value: rise, label: `↑ ${formatClock(rise)}`, title: 'First light on the marker', className: 'spot' })
    if (set !== null) markers.push({ value: set, label: `↓ ${formatClock(set)}`, title: 'Last light on the marker', className: 'spot' })
    const summary =
      bands.length === 0
        ? 'no direct sun on this date'
        : rise === null && set === null && bands.length === 1
          ? 'direct sun all day'
          : `direct sun ${formatDuration(spot.sunlitMs)}${bands.length > 1 ? ` in ${bands.length} periods` : ''}`
    return { background: sunlitGradient(bands), markers, summary }
  }, [spot])

  if (!open) return null
  const engine = getEngine()
  const dayLength =
    sun?.sunrise && sun?.sunset ? formatDuration(sun.sunset - sun.sunrise) : sun?.polar === 'day' ? '24 h' : sun?.polar === 'night' ? '0 h' : '—'
  const simulated = settings.lighting === 'sun'

  return (
    <div className="panel time-panel">
      <div className="time-header">
        <div className="time-big mono">{formatClock(sim.minutes)}</div>
        <div className="time-title">
          <div>{formatLongDate(sim.date)}</div>
          <div className="small muted">
            {sim.timeZone} · {sun?.zoneName && !sun.zoneName.startsWith('GMT') ? `${sun.zoneName} · ` : ''}
            {formatOffset(sun?.offsetMinutes ?? 0)}
          </div>
          <div
            className="small muted time-location"
            title="Sun position, sunrise, sunset and the time zone are calculated for the ground at the center of the view (the ring on the map). Pan the map to move it; the inspected point and search pin don't change it."
          >
            <span className="sun-target-key" aria-hidden="true" />
            For the view center{target ? ` · ${shortLatLon(target.latitude, target.longitude)}` : ''}
          </div>
          {spotSlider && inspect && (
            <div
              className="small muted time-location"
              title="The time slider shows when the sun shines directly on the marker, over the real terrain (light: sun, dark: shade). Remove the marker to see the view center's sky again."
            >
              <span className="spot-key" aria-hidden="true" />
              Slider for the marker · {shortLatLon(inspect.latitude, inspect.longitude)} · {spotSlider.summary}
            </div>
          )}
        </div>
        <div className="time-controls">
          <input
            className="input"
            type="date"
            value={sim.date}
            aria-label="Date"
            onChange={(e) => e.target.value && patchSim({ date: e.target.value })}
            style={{ width: 140 }}
          />
          <input
            className="input"
            type="time"
            value={formatClock(sim.minutes)}
            aria-label="Local time"
            onChange={(e) => {
              const [h, m] = e.target.value.split(':').map(Number)
              if (Number.isFinite(h) && Number.isFinite(m)) patchSim({ minutes: h * 60 + m })
            }}
            style={{ width: 128 }}
          />
          <button className="btn" onClick={() => engine?.sun.setNow()} title="Reset to the current real time">
            Now
          </button>
          <button className="icon-btn" title={sim.playing ? 'Pause (Space)' : 'Play (Space)'} onClick={() => engine?.sun.togglePlay()}>
            <Icon name={sim.playing ? 'pause' : 'play'} size={16} />
          </button>
          <select
            className="input"
            value={sim.speed}
            aria-label="Playback speed"
            onChange={(e) => patchSim({ speed: e.target.value as PlaybackSpeedId })}
            style={{ width: 112 }}
          >
            {Object.entries(PLAYBACK_SPEEDS).map(([id, s]) => (
              <option key={id} value={id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <button className="icon-btn small time-close" title="Close" aria-label="Close time & sun" onClick={() => togglePanel('time', false)}>
          <Icon name="close" size={14} />
        </button>
      </div>

      <div style={{ paddingTop: 12 }}>
        <TrackSlider
          ariaLabel="Time of day"
          min={0}
          max={1439}
          step={1}
          value={Math.min(1439, sim.minutes)}
          valueText={formatClock(sim.minutes)}
          onChange={(minutes) => patchSim({ minutes })}
          background={spotSlider?.background ?? dayBackground}
          markers={spotSlider?.markers ?? dayTimes.markers}
        />
        <div className="slider-ticks">
          {['00', '03', '06', '09', '12', '15', '18', '21', '24'].map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
      </div>

      <div className="row" style={{ marginTop: 14, alignItems: 'flex-end' }}>
        <div className="grow">
          <TrackSlider
            ariaLabel="Day of year"
            min={1}
            max={yearDays}
            step={1}
            value={doy}
            valueText={sim.date}
            onChange={(d) => patchSim({ date: dateFromDayOfYear(year, d) })}
            background="linear-gradient(90deg, #1f3550, #3f6a7d 25%, #5d8d58 45%, #7c9a4e 55%, #3f6a7d 75%, #1f3550)"
            markers={seasonMarkers}
          />
          <div className="slider-ticks">
            {MONTH_STARTS.map((d, i) => (
              <span key={d}>{MONTHS[i]}</span>
            ))}
          </div>
        </div>
        <div className="row" style={{ marginBottom: 14 }}>
          <button className="icon-btn small" title="Previous year" onClick={() => patchSim({ date: withYear(sim.date, year - 1) })}>
            <Icon name="chevronLeft" size={14} />
          </button>
          <span className="mono">{year}</span>
          <button className="icon-btn small" title="Next year" onClick={() => patchSim({ date: withYear(sim.date, year + 1) })}>
            <Icon name="chevronRight" size={14} />
          </button>
        </div>
      </div>

      <div className="row" style={{ marginTop: 6, justifyContent: 'space-between', flexWrap: 'wrap', gap: 14 }}>
        <div className="sun-readouts">
          <span className="k">Azimuth</span>
          <span className="k">Altitude</span>
          <span className="k">Sunrise</span>
          <span className="k">Solar noon</span>
          <span className="k">Sunset</span>
          <span className="mono">{sun ? `${sun.azimuth.toFixed(1)}° ${compassPoint(sun.azimuth)}` : '—'}</span>
          <span className="mono" style={{ color: sun && sun.altitude < 0 ? 'var(--text-muted)' : 'var(--sun)' }}>
            {sun ? `${sun.altitude.toFixed(1)}°` : '—'}
          </span>
          <span className="mono">{sun?.polar === 'day' ? 'polar day' : sun?.polar === 'night' ? 'polar night' : dayTimes.rise}</span>
          <span className="mono">{sun ? dayTimes.noon : '—'}</span>
          <span className="mono">{sun?.polar ? '—' : dayTimes.set}</span>
        </div>
        <div className="small muted">Day length {dayLength}</div>
      </div>

      <div className="row" style={{ marginTop: 10, gap: 14, flexWrap: 'wrap' }}>
        <div className="segmented">
          <button className={simulated ? 'active' : ''} onClick={() => patchSettings((d) => void (d.lighting = 'sun'))}>
            Simulated sun
          </button>
          <button className={!simulated ? 'active' : ''} onClick={() => patchSettings((d) => void (d.lighting = 'flat'))}>
            Flat lighting
          </button>
        </div>
        <label className="switch">
          <input type="checkbox" checked={settings.shadows} disabled={!simulated} onChange={(e) => patchSettings((d) => void (d.shadows = e.target.checked))} />
          Shadows
        </label>
        <label className="switch">
          <input
            type="checkbox"
            checked={settings.showSunIndicator}
            disabled={!simulated}
            onChange={(e) => patchSettings((d) => void (d.showSunIndicator = e.target.checked))}
          />
          Sun direction
        </label>
        <label
          className="switch"
          title="Shadow-map detail close to the camera (buildings, trees) on top of the terrain shadows. Photorealistic mode only."
        >
          <input
            type="checkbox"
            checked={settings.detailShadows}
            disabled={!simulated || !settings.shadows || mode !== 'photorealistic'}
            onChange={(e) => patchSettings((d) => void (d.detailShadows = e.target.checked))}
          />
          Buildings &amp; trees
        </label>
        {simulated && settings.shadows && <ShadowSourceNote status={terrainShadows} />}
        <span className="small faint" style={{ marginLeft: 'auto' }}>
          <span className="kbd">[</span> <span className="kbd">]</span> ±15 min · <span className="kbd">Shift</span>+<span className="kbd">[ ]</span> ±1 day
        </span>
      </div>
    </div>
  )
}

const SHADOW_NOTES: Record<'off' | 'loading' | 'ready' | 'unavailable', { text: string; title: string }> = {
  ready: {
    text: 'Terrain shadows: heightmap',
    title: 'Mountain and valley shadows are ray-traced from Cesium World Terrain out to ~80 km, including off-screen ridges, earth curvature and refraction.'
  },
  loading: { text: 'Terrain shadows: loading…', title: 'Loading terrain heights around the view.' },
  unavailable: {
    text: 'Terrain shadows: shadow maps',
    title: 'Terrain heights could not be loaded, so shadow maps are used. Distant and off-screen ridges may not cast.'
  },
  off: {
    text: 'Terrain shadows: shadow maps',
    title: 'Add a Cesium ion token for accurate long-range terrain shadows. Shadow maps miss distant and off-screen ridges.'
  }
}

function ShadowSourceNote({ status }: { status: 'off' | 'loading' | 'ready' | 'unavailable' }) {
  const note = SHADOW_NOTES[status]
  return (
    <span className="small muted" title={note.title}>
      {note.text}
    </span>
  )
}
