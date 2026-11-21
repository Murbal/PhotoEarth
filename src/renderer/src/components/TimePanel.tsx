import { useMemo } from 'react'
import { getEngine } from '../engine/instance'
import { PLAYBACK_SPEEDS } from '../engine/SunController'
import { sunlitBands } from '../lib/horizon'
import { seasonEvents } from '../lib/seasons'
import {
  LIGHT_WINDOWS,
  lightWindows,
  markerMinutes,
  type BandSegment,
  type LightWindow,
  type LightWindowDef,
  type SkyBand
} from '../lib/sun'
import {
  dateFromDayOfYear,
  dayOfYear,
  daysInYear,
  formatClock,
  formatDuration,
  formatLongDate,
  formatOffset,
  formatShortDate,
  parseDate,
  utcToZoned,
  withYear
} from '../lib/time'
import { compassPoint } from '../lib/units'
import { useAppStore, type MoonInfo, type PlaybackSpeedId } from '../store/appStore'
import { Icon } from './Icon'
import { MoonDisc } from './MoonDisc'
import { TrackSlider, type SliderMarker } from './Slider'

/** Slider shading for each sky band. */
const BAND_COLORS: Record<SkyBand, string> = {
  night: '#0a0f1f',
  astronomical: '#151d3b',
  nautical: '#24336b',
  blue: '#3a68c4',
  goldenTwilight: '#c77b5a',
  golden: '#eca956',
  day: '#9cc6ea'
}

/** Swatch for a light window: its bands side by side. */
function windowSwatch(def: LightWindowDef): string {
  const colors = def.bands.map((b) => BAND_COLORS[b])
  if (colors.length === 1) return colors[0]
  const stops = colors.map((c, i) => `${c} ${(i / colors.length) * 100}%, ${c} ${((i + 1) / colors.length) * 100}%`)
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

/** Hard-edged bands, so the start and end of each window can be read off the slider. */
function dayGradient(bands: readonly BandSegment[]): string {
  if (bands.length === 0) return 'var(--panel-hover)'
  const pct = (m: number) => `${((m / 1440) * 100).toFixed(3)}%`
  const stops = bands.map((b) => `${BAND_COLORS[b.band]} ${pct(b.start)} ${pct(b.end)}`)
  return `linear-gradient(90deg, ${stops.join(', ')})`
}

const formatDegrees = (d: number) => `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d)}°`

function windowRange(w: LightWindow): string {
  return `${w.fromPreviousDay ? '…' : formatClock(w.start)}–${w.intoNextDay ? '…' : formatClock(w.end)}`
}

function windowTitle(def: LightWindowDef, w: LightWindow): string {
  const notes = [`${def.label}: ${formatClock(w.start)}–${formatClock(w.end)} (${formatDuration((w.end - w.start) * 60000)})`]
  if (w.fromPreviousDay) notes.push('started the previous day')
  if (w.intoNextDay) notes.push('continues into the next day')
  if (w.kind === 'span') notes.push('the sun does not pass through it')
  return notes.join(' · ')
}

/**
 * Morning and evening times of golden hour, blue hour and the three twilights, one column each.
 * The columns the sun is in right now are highlighted.
 */
function LightWindowsTable({ bands, minutes }: { bands: readonly BandSegment[]; minutes: number }) {
  const windows = useMemo(() => lightWindows(bands), [bands])
  // From the bands themselves, so the highlight flips exactly where the slider shading does.
  const current = bands.find((b) => minutes >= b.start && minutes < b.end)?.band ?? null
  const cell = (def: LightWindowDef, list: LightWindow[]) =>
    list.length === 0 ? '—' : list.map((w, i) => (
      <span key={i} title={windowTitle(def, w)}>
        {i > 0 ? ', ' : ''}
        {windowRange(w)}
      </span>
    ))
  return (
    <div className="light-windows" role="table" aria-label="Golden hour, blue hour and twilight times">
      <span className="k" role="columnheader" />
      {LIGHT_WINDOWS.map((def, i) => (
        <span
          key={def.id}
          role="columnheader"
          className={`k${current && def.bands.includes(current) ? ' now' : ''}`}
          style={{ gridColumn: i + 2 }}
          title={`Sun between ${formatDegrees(def.from)} and ${formatDegrees(def.to)}`}
        >
          <span className="band-swatch" style={{ background: windowSwatch(def) }} aria-hidden="true" />
          {def.label}
        </span>
      ))}
      <span className="k" role="rowheader" style={{ gridRow: 2 }}>
        Morning
      </span>
      <span className="k" role="rowheader" style={{ gridRow: 3 }}>
        Evening
      </span>
      {LIGHT_WINDOWS.map((def, i) => {
        const list = windows[def.id]
        const now = current && def.bands.includes(current) ? ' now' : ''
        const spans = list.filter((w) => w.kind === 'span')
        const column = i + 2
        // A window the sun never passes through (it peaks or bottoms out inside it) fills both rows.
        if (spans.length > 0 && spans.length === list.length) {
          return (
            <span key={def.id} role="cell" className={`mono span${now}`} style={{ gridColumn: column, gridRow: '2 / 4' }}>
              {spans.length === 1 && spans[0].fromPreviousDay && spans[0].intoNextDay ? 'all day' : cell(def, spans)}
            </span>
          )
        }
        return [
          <span key={`${def.id}-m`} role="cell" className={`mono${now}`} style={{ gridColumn: column, gridRow: 2 }}>
            {cell(def, list.filter((w) => w.kind !== 'evening'))}
          </span>,
          <span key={`${def.id}-e`} role="cell" className={`mono${now}`} style={{ gridColumn: column, gridRow: 3 }}>
            {cell(def, list.filter((w) => w.kind === 'evening'))}
          </span>
        ]
      })}
    </div>
  )
}

/** ~100 m precision: plenty for sun times, and short enough to fit the header. */
function shortLatLon(lat: number, lon: number): string {
  return `${Math.abs(lat).toFixed(3)}° ${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon).toFixed(3)}° ${lon < 0 ? 'W' : 'E'}`
}

const NO_BANDS: BandSegment[] = []

const MONTH_STARTS = [1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335]
const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D']

export function TimePanel() {
  const open = useAppStore((s) => s.panels.time)
  const sim = useAppStore((s) => s.sim)
  const sun = useAppStore((s) => s.sun)
  const moon = useAppStore((s) => s.moon)
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
  // Like the sun times: `moon` is replaced every playback frame, its rise and set aren't.
  const moonRise = moon?.rise ?? null
  const moonTransit = moon?.transit ?? null
  const moonSet = moon?.set ?? null
  const moonTimes = useMemo(() => {
    const clock = (t: number | null) => {
      const m = markerMinutes(t, sim.date, sim.timeZone)
      return m === null ? '—' : formatClock(m)
    }
    return { rise: clock(moonRise), transit: clock(moonTransit), set: clock(moonSet) }
  }, [moonRise, moonTransit, moonSet, sim.date, sim.timeZone])
  const bands = sun?.bands ?? NO_BANDS
  const dayBackground = useMemo(() => dayGradient(bands), [bands])

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
            title="Sun and moon positions, their rise and set times, and the time zone are calculated for the ground at the center of the view (the ring on the map). Pan the map to move it; the inspected point and search pin don't change it."
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

      <div className="row" style={{ marginTop: 6, justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 14 }}>
        <div className="sky-readouts">
          <span />
          <span className="k">Azimuth</span>
          <span className="k">Altitude</span>
          <span className="k">Rise</span>
          <span className="k" title="Highest point of the day: solar noon for the sun">
            Transit
          </span>
          <span className="k">Set</span>

          <span className="body-label">
            <span className="body-key sun" aria-hidden="true" />
            Sun
          </span>
          <span className="mono">{sun ? `${sun.azimuth.toFixed(1)}° ${compassPoint(sun.azimuth)}` : '—'}</span>
          <span className="mono" style={{ color: sun && sun.altitude < 0 ? 'var(--text-muted)' : 'var(--sun)' }}>
            {sun ? `${sun.altitude.toFixed(1)}°` : '—'}
          </span>
          <span className="mono" title="Sunrise">
            {sun?.polar === 'day' ? 'polar day' : sun?.polar === 'night' ? 'polar night' : dayTimes.rise}
          </span>
          <span className="mono" title="Solar noon">
            {sun ? dayTimes.noon : '—'}
          </span>
          <span className="mono" title="Sunset">
            {sun?.polar ? '—' : dayTimes.set}
          </span>

          <span className="body-label">
            <span className="body-key moon" aria-hidden="true" />
            Moon
          </span>
          <span className="mono">{moon ? `${moon.azimuth.toFixed(1)}° ${compassPoint(moon.azimuth)}` : '—'}</span>
          <span className="mono" style={{ color: moon && moon.altitude < 0 ? 'var(--text-muted)' : 'var(--moon)' }}>
            {moon ? `${moon.altitude.toFixed(1)}°` : '—'}
          </span>
          <span className="mono" title={moon && moon.rise === null && !moon.polar ? 'No moonrise on this date' : 'Moonrise (upper limb)'}>
            {moon?.polar === 'up' ? 'up all day' : moon?.polar === 'down' ? 'down all day' : moonTimes.rise}
          </span>
          <span
            className="mono"
            title={moon?.transitAltitude != null ? `Moon transit, ${moon.transitAltitude.toFixed(1)}° high` : 'No moon transit on this date'}
          >
            {moon ? moonTimes.transit : '—'}
          </span>
          <span className="mono" title={moon && moon.set === null && !moon.polar ? 'No moonset on this date' : 'Moonset (upper limb)'}>
            {moon?.polar ? '—' : moonTimes.set}
          </span>
        </div>
        <div className="sky-side">
          <div className="small muted">Day length {dayLength}</div>
          {moon && <MoonPhase moon={moon} date={sim.date} timeZone={sim.timeZone} imperial={settings.units === 'imperial'} />}
        </div>
      </div>

      <LightWindowsTable bands={bands} minutes={sim.minutes} />

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
        <label className="switch">
          <input
            type="checkbox"
            checked={settings.showMoonIndicator}
            onChange={(e) => patchSettings((d) => void (d.showMoonIndicator = e.target.checked))}
          />
          Moon direction
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

/** Local "today 14:05" or "Nov 24 14:05" for an instant. */
function eventTime(utc: number | null, date: string, timeZone: string): string {
  if (utc === null) return '—'
  const local = utcToZoned(utc, timeZone)
  return `${local.date === date ? 'today' : formatShortDate(local.date)} ${formatClock(local.minutes)}`
}

function MoonPhase({ moon, date, timeZone, imperial }: { moon: MoonInfo; date: string; timeZone: string; imperial: boolean }) {
  const lit = Math.round(moon.illumination * 100)
  const distance = imperial
    ? `${Math.round(moon.distanceKm / 1.609344).toLocaleString('en-US')} mi`
    : `${Math.round(moon.distanceKm).toLocaleString('en-US')} km`
  // Soonest first: the full moon while waxing, the new moon while waning.
  const events = [
    { label: 'Full', utc: moon.nextFullMoon },
    { label: 'New', utc: moon.nextNewMoon }
  ].sort((a, b) => (a.utc ?? Infinity) - (b.utc ?? Infinity))
  return (
    <div className="moon-phase" title={`Distance ${distance}. The disc is drawn as the moon looks in the sky from here: up is towards the zenith.`}>
      <MoonDisc illumination={moon.illumination} brightLimb={moon.brightLimb} size={30} label={`${moon.phaseName}, ${lit}% illuminated`} />
      <div>
        <div>
          {moon.phaseName} <span className="muted">· {lit}%</span>
        </div>
        <div className="small muted">{events.map((e) => `${e.label} ${eventTime(e.utc, date, timeZone)}`).join(' · ')}</div>
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
