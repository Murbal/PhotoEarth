import { useMemo } from 'react'
import { getEngine } from '../engine/instance'
import { PLAYBACK_SPEEDS } from '../engine/SunController'
import { seasonEvents } from '../lib/seasons'
import { markerMinutes } from '../lib/sun'
import {
  dateFromDayOfYear,
  dayOfYear,
  daysInYear,
  formatClock,
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

  if (!open) return null
  const engine = getEngine()
  const local = (utc: number | null) => {
    const m = markerMinutes(utc, sim.date, sim.timeZone)
    return m === null ? '—' : formatClock(m)
  }
  const dayMarkers: SliderMarker[] = []
  if (sun) {
    const rise = markerMinutes(sun.sunrise, sim.date, sim.timeZone)
    const noon = markerMinutes(sun.solarNoon, sim.date, sim.timeZone)
    const set = markerMinutes(sun.sunset, sim.date, sim.timeZone)
    if (rise !== null) dayMarkers.push({ value: rise, label: `↑ ${formatClock(rise)}`, title: 'Sunrise' })
    if (noon !== null) dayMarkers.push({ value: noon, label: `noon ${formatClock(noon)}`, title: 'Solar noon' })
    if (set !== null) dayMarkers.push({ value: set, label: `↓ ${formatClock(set)}`, title: 'Sunset' })
  }
  const dayLength =
    sun?.sunrise && sun?.sunset ? `${Math.floor((sun.sunset - sun.sunrise) / 3600000)} h ${Math.round(((sun.sunset - sun.sunrise) % 3600000) / 60000)} min` : sun?.polar === 'day' ? '24 h' : sun?.polar === 'night' ? '0 h' : '—'
  const simulated = settings.lighting === 'sun'

  return (
    <div className="panel time-panel">
      <div className="time-header">
        <div className="time-big mono">{formatClock(sim.minutes)}</div>
        <div>
          <div>{formatLongDate(sim.date)}</div>
          <div className="small muted">
            {sim.timeZone} · {sun?.zoneName && !sun.zoneName.startsWith('GMT') ? `${sun.zoneName} · ` : ''}
            {formatOffset(sun?.offsetMinutes ?? 0)}
          </div>
        </div>
        <div style={{ flex: 1 }} />
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
          style={{ width: 104 }}
        >
          {Object.entries(PLAYBACK_SPEEDS).map(([id, s]) => (
            <option key={id} value={id}>
              {s.label}
            </option>
          ))}
        </select>
        <button className="icon-btn small" title="Close" onClick={() => togglePanel('time', false)}>
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
          background={dayGradient(sun?.profile ?? [])}
          markers={dayMarkers}
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
          <span className="mono">{sun?.polar === 'day' ? 'polar day' : sun?.polar === 'night' ? 'polar night' : local(sun?.sunrise ?? null)}</span>
          <span className="mono">{sun ? local(sun.solarNoon) : '—'}</span>
          <span className="mono">{sun?.polar ? '—' : local(sun?.sunset ?? null)}</span>
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
