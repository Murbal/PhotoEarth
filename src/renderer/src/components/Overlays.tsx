import { getEngine } from '../engine/instance'
import { formatLatLon, formatLatLonPlain } from '../lib/coords'
import { formatElevation } from '../lib/units'
import { appState, useAppStore } from '../store/appStore'
import { Icon } from './Icon'

export function StatusChips() {
  const exaggeration = useAppStore((s) => s.settings.verticalExaggeration)
  const lighting = useAppStore((s) => s.settings.lighting)
  const eyeLevel = useAppStore((s) => s.eyeLevel)
  const flyMode = useAppStore((s) => s.flyMode)
  const profileDrawing = useAppStore((s) => s.profile.active)
  const patchSettings = useAppStore((s) => s.patchSettings)
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
      {profileDrawing && <span className="panel chip">Click to add points · Enter or double-click to finish · Backspace undo</span>}
    </div>
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
  return flyMode ? <div className="crosshair" /> : null
}

export function Toast() {
  const toast = useAppStore((s) => s.toast)
  return toast ? <div className="panel toast">{toast.message}</div> : null
}

export function InspectCard() {
  const inspect = useAppStore((s) => s.inspect)
  const units = useAppStore((s) => s.settings.units)
  const format = useAppStore((s) => s.settings.coordFormat)
  if (!inspect || !inspect.screen) return null
  const copy = () => {
    const elev = inspect.elevation !== null ? `, ${Math.round(inspect.elevation)} m` : ''
    void navigator.clipboard
      .writeText(`${formatLatLonPlain(inspect.latitude, inspect.longitude)}${elev}`)
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
        <button className="icon-btn small" title="Copy coordinates and elevation" onClick={copy}>
          <Icon name="copy" size={14} />
        </button>
        <button className="icon-btn small" title="Remove marker (Esc)" onClick={() => getEngine()?.inspector.clear()}>
          <Icon name="close" size={14} />
        </button>
      </div>
    </div>
  )
}
