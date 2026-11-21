import { getEngine } from '../engine/instance'
import { formatLatLon } from '@shared/coords'
import { formatClock, formatDuration, formatShortDate, utcToZoned } from '../lib/time'
import { formatElevation, formatPointForClipboard } from '../lib/units'
import { appState, useAppStore, type SpotSunInfo } from '../store/appStore'
import { Icon } from './Icon'
import { SkyReadout, skySummary } from './LightPollution'
import { ViewshedReadout } from './ViewshedPanel'

export function StatusChips() {
  const exaggeration = useAppStore((s) => s.settings.verticalExaggeration)
  const lighting = useAppStore((s) => s.settings.lighting)
  const eyeLevel = useAppStore((s) => s.eyeLevel)
  const flyMode = useAppStore((s) => s.flyMode)
  const profileDrawing = useAppStore((s) => s.profile.active)
  const profilePoints = useAppStore((s) => s.profile.points.length)
  const patchSettings = useAppStore((s) => s.patchSettings)
  const horizonOpen = useAppStore((s) => s.horizon.open)
  const alignPick = useAppStore((s) => (s.alignment.open ? s.alignment.pickMode : null))
  const viewshedPicking = useAppStore((s) => s.viewshed.picking)
  // The light pollution layer drapes on the globe, which Photorealistic mode hides (§7.5).
  const lpHidden = useAppStore((s) => s.settings.lightPollution.enabled && s.mode === 'photorealistic' && s.tilesetReady)
  return (
    <div className="chip-row">
      {exaggeration !== 1 && (
        <span className="panel chip warn" title="Heights are exaggerated — don't judge real scenery from this view">
          <Icon name="warning" size={14} /> Vertical exaggeration {exaggeration.toFixed(1)}×
          <button className="btn ghost" style={{ height: 20, padding: '0 6px' }} onClick={() => patchSettings((d) => void (d.verticalExaggeration = 1))}>
            Reset
          </button>
        </span>
      )}
      {lighting === 'flat' && <span className="panel chip">Flat lighting</span>}
      {eyeLevel && !flyMode && <span className="panel chip">Eye level · 1.7 m — WASD to walk</span>}
      {flyMode && <span className="panel chip">Fly mode — WASD move · Q/E down/up · mouse look · Esc exit</span>}
      {profileDrawing && (
        <span className="panel chip" role="status">
          {profilePoints === 0
            ? 'Elevation profile: click the map to set the start point · Esc cancel'
            : profilePoints === 1
              ? 'Start point set: click a second point · Backspace undo · Esc cancel'
              : 'Click to add points · Enter or double-click to finish · Backspace undo'}
        </span>
      )}
      {alignPick && !profileDrawing && (
        <span className="panel chip" role="status">
          <Icon name="alignment" size={14} /> Shot alignment: click the map to place the {alignPick === 'camera' ? 'Camera' : 'Subject'} pin · Esc cancel
        </span>
      )}
      {horizonOpen && !profileDrawing && !alignPick && !viewshedPicking && (
        <span className="panel chip" role="status">
          Horizon: click the map to move the observer · H or Esc closes
        </span>
      )}
      {viewshedPicking && !profileDrawing && !alignPick && (
        <span className="panel chip" role="status">
          <Icon name="viewshed" size={14} style={{ color: 'var(--ok)' }} /> Viewshed: click a point on the map to set target · Esc cancels
          <button
            className="icon-btn small"
            style={{ width: 22, height: 22 }}
            aria-label="Cancel viewshed target selection"
            title="Cancel (Esc)"
            onClick={() => getEngine()?.viewshed.setPicking(false)}
          >
            <Icon name="close" size={12} />
          </button>
        </span>
      )}
      {lpHidden && (
        <span className="panel chip" role="status">
          <Icon name="night" size={14} /> Light pollution: map in Elevation mode · click a point for its sky
          <button className="btn ghost" style={{ height: 20, padding: '0 6px' }} onClick={() => getEngine()?.setMode('elevation')}>
            Show map
          </button>
          <button
            className="icon-btn small"
            style={{ width: 22, height: 22 }}
            aria-label="Turn off light pollution"
            title="Turn off light pollution"
            onClick={() => patchSettings((d) => void (d.lightPollution.enabled = false))}
          >
            <Icon name="close" size={12} />
          </button>
        </span>
      )}
      <DestinationChip />
    </div>
  )
}

/** Names where the last search landed, matching the pin on the map. */
function DestinationChip() {
  const destination = useAppStore((s) => s.destination)
  const format = useAppStore((s) => s.settings.coordFormat)
  if (!destination) return null
  const coords = formatLatLon(destination.latitude, destination.longitude, format)
  const showCoords = coords !== destination.name
  return (
    <span className="panel chip destination" role="status" aria-label={`Search result: ${destination.name}${destination.detail ? `, ${destination.detail}` : ''}`}>
      <Icon name="pin" size={14} style={{ color: '#ff5d5d', flex: 'none' }} />
      <span className="name">{destination.name}</span>
      {destination.detail && <span className="detail">{destination.detail}</span>}
      {showCoords && <span className="mono faint">{coords}</span>}
      <button className="icon-btn small" style={{ width: 22, height: 22 }} aria-label="Remove search pin" title="Remove search pin (Esc)" onClick={() => getEngine()?.searchMarker.clear()}>
        <Icon name="close" size={12} />
      </button>
    </span>
  )
}

export function FpsIndicator() {
  const show = useAppStore((s) => s.settings.quality.showFps)
  const fps = useAppStore((s) => s.fps)
  const pending = useAppStore((s) => s.pendingTiles)
  if (!show) return null
  return (
    <div className="panel fps" title="Frames per second (0 = idle: rendering only on change) and tiles loading">
      {fps ? `${fps} fps` : 'idle'} · {pending} tiles
    </div>
  )
}

export function LoadingBar() {
  const pending = useAppStore((s) => s.pendingTiles)
  return pending > 0 ? <div className="loading-bar" aria-label="Loading tiles" /> : null
}

export function Crosshair() {
  const flyMode = useAppStore((s) => s.flyMode)
  const timePanel = useAppStore((s) => s.panels.time)
  if (flyMode) return <div className="crosshair" />
  // The point the time & sun panel calculates for (the view center).
  return timePanel ? <div className="sun-target" aria-hidden="true" /> : null
}

export function Toast() {
  const toast = useAppStore((s) => s.toast)
  return toast ? <div className="panel toast">{toast.message}</div> : null
}

export function InspectCard() {
  const inspect = useAppStore((s) => s.inspect)
  const units = useAppStore((s) => s.settings.units)
  const format = useAppStore((s) => s.settings.coordFormat)
  const sky = useAppStore((s) => s.sky?.estimate ?? null)
  if (!inspect || !inspect.screen) return null
  const copy = () => {
    const text = formatPointForClipboard(inspect.latitude, inspect.longitude, inspect.elevation, units, sky ? [skySummary(sky)] : [])
    void navigator.clipboard
      .writeText(text)
      .then(() => appState().showToast('Copied to clipboard'))
  }
  return (
    <div className="panel inspect-card" style={{ left: inspect.screen.x, top: inspect.screen.y }}>
      <div className="row" style={{ minHeight: 0, alignItems: 'flex-start' }}>
        <div className="grow">
          <div className="mono">{formatLatLon(inspect.latitude, inspect.longitude, format)}</div>
          <div style={{ marginTop: 3 }}>
            <span className="faint">Elevation </span>
            <span className="mono">{formatElevation(inspect.elevation, units)}</span>
            {inspect.loading && <span className="faint"> …</span>}
          </div>
        </div>
        <button className="icon-btn small" title="Viewshed from here (Shift+V)" aria-label="Viewshed from here" onClick={() => void getEngine()?.openViewshed()}>
          <Icon name="viewshed" size={14} />
        </button>
        <button className="icon-btn small" title="Horizon panorama from here (H)" aria-label="Horizon panorama from here" onClick={() => void getEngine()?.openHorizon()}>
          <Icon name="panorama" size={14} />
        </button>
        <button
          className="icon-btn small"
          title="Use this point in Shot Alignment (Camera or Subject)"
          aria-label="Use this point in shot alignment"
          onClick={() => {
            const e = getEngine()
            if (!e) return
            const role = appState().alignment.camera && !appState().alignment.subject ? 'subject' : 'camera'
            e.useActivePinForAlignment(role)
          }}
        >
          <Icon name="alignment" size={14} />
        </button>
        <button className="icon-btn small" title={sky ? 'Copy coordinates, elevation and sky brightness' : 'Copy coordinates and elevation'} onClick={copy}>
          <Icon name="copy" size={14} />
        </button>
        <button className="icon-btn small" title="Remove marker (Esc)" onClick={() => getEngine()?.inspector.clear()}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <ViewshedReadout />
      <SpotSunTimes />
      <SkyReadout />
    </div>
  )
}

const SPOT_SUN_NOTES: Partial<Record<SpotSunInfo['status'], string>> = {
  'no-terrain': 'Add a Cesium ion token for sun times that account for the terrain.',
  unavailable: 'Terrain heights could not be loaded here.'
}

/** Flat-horizon sunrise and sunset next to when the sun actually reaches the inspected point. */
function SpotSunTimes() {
  const spot = useAppStore((s) => s.spotSun)
  if (!spot) return null
  const clock = (utc: number | null): string => {
    if (utc === null) return '—'
    const z = utcToZoned(utc, spot.timeZone)
    return z.date === spot.date ? formatClock(z.minutes) : '—'
  }
  const ready = spot.status === 'ready'
  const noSun = ready && spot.spans.length === 0
  const allDay = ready && spot.spans.length === 1 && spot.firstLight === null && spot.lastLight === null
  const terrain = (utc: number | null, label: string) => {
    if (spot.status === 'loading') return <span className="faint">…</span>
    if (!ready || utc === null) return <span className="mono faint">—</span>
    return (
      <button
        className="time-link mono"
        title={`${label} on this spot. Click to set the time to ${clock(utc)}.`}
        onClick={() => getEngine()?.sun.setInstant(utc, spot.timeZone)}
      >
        {clock(utc)}
      </button>
    )
  }
  const flatRise = spot.polar === 'day' ? 'polar day' : spot.polar === 'night' ? 'polar night' : clock(spot.sunrise)
  const flatSet = spot.polar ? '—' : clock(spot.sunset)
  const periods = spot.spans.length
  const note = SPOT_SUN_NOTES[spot.status]
    ?? (noSun
      ? 'No direct sun on this date: the terrain hides it all day.'
      : allDay
        ? 'Direct sun all day.'
        : ready
          ? `Direct sun ${formatDuration(spot.sunlitMs)}${periods > 1 ? ` in ${periods} periods` : ''}`
          : null)
  const spans = spot.spans.map((p) => `${clock(p.start)}–${clock(p.end)}`).join(', ')
  return (
    <div className="spot-sun">
      <div className="spot-sun-grid">
        <span className="k">{formatShortDate(spot.date)}</span>
        <span
          className="k"
          title="SunCalc sunrise and sunset: the sun's upper edge on a flat, sea-level horizon. Ignores mountains."
        >
          Flat horizon
        </span>
        <span
          className="k"
          title="When the center of the sun clears, or drops behind, the real skyline seen from this point: terrain out to 80 km, with earth curvature and refraction, as in the terrain shadows."
        >
          Sun on this spot
        </span>
        <span className="k">Sunrise</span>
        <span className="mono">{flatRise}</span>
        {terrain(spot.firstLight, 'First light')}
        <span className="k">Sunset</span>
        <span className="mono">{flatSet}</span>
        {terrain(spot.lastLight, 'Last light')}
      </div>
      {note && (
        <div className="small faint" style={{ marginTop: 4 }} title={periods > 1 ? `Direct sun ${spans}` : undefined}>
          {note}
        </div>
      )}
    </div>
  )
}
