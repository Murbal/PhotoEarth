import { useState } from 'react'
import { formatLatLon } from '@shared/coords'
import { VIEWSHED_OFFSET_RANGE } from '@shared/settings'
import type { Units, ViewshedSettings } from '@shared/types'
import { getEngine } from '../engine/instance'
import { compassPoint, FEET_PER_METER, formatDistance, formatElevation } from '../lib/units'
import {
  formatArea,
  VIEWSHED_RADII,
  VIEWSHED_TARGET_PRESETS,
  VIEWSHED_VIEWER_PRESETS,
  viewshedRingInterval
} from '../lib/viewshed'
import { useAppStore } from '../store/appStore'
import { Icon } from './Icon'

function formatRadiusLabel(meters: number, units: Units): string {
  if (units === 'imperial') return `${Math.round(meters / 1609.344)} mi`
  return `${Math.round(meters / 1000)} km`
}

function formatOffsetLabel(meters: number, units: Units): string {
  if (meters === 0) return '0'
  if (units === 'imperial') return `${Math.round(meters * FEET_PER_METER)} ft`
  return Number.isInteger(meters) ? `${meters} m` : `${meters.toFixed(1)} m`
}

/** Numeric offset input in current display units (meters or feet), committing back to meters. */
function OffsetField({
  meters,
  units,
  label,
  onCommit
}: {
  meters: number
  units: Units
  label: string
  onCommit: (meters: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const factor = units === 'imperial' ? FEET_PER_METER : 1
  const display = Math.round(meters * factor * 10) / 10
  const maxDisplay = Math.round(VIEWSHED_OFFSET_RANGE.max * factor)
  const commit = (text: string) => {
    const v = Number(text.replace(',', '.'))
    if (text.trim() === '' || !Number.isFinite(v)) return
    const m = v / factor
    if (m >= VIEWSHED_OFFSET_RANGE.min && m <= VIEWSHED_OFFSET_RANGE.max) onCommit(Math.round(m * 10) / 10)
  }
  return (
    <input
      className="input mono vs-num"
      type="number"
      inputMode="decimal"
      min={0}
      max={maxDisplay}
      step={units === 'imperial' ? 1 : 0.5}
      aria-label={label}
      value={draft ?? String(display)}
      onFocus={(e) => setDraft(e.target.value)}
      onChange={(e) => {
        setDraft(e.target.value)
        commit(e.target.value)
      }}
      onBlur={() => setDraft(null)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') {
          setDraft(null)
          ;(e.target as HTMLInputElement).blur()
        }
      }}
    />
  )
}

/** Compact bottom-stack control panel shown while a viewshed overlay is active. */
export function ViewshedPanel() {
  const state = useAppStore((s) => s.viewshed)
  const settings = useAppStore((s) => s.settings.viewshed)
  const units = useAppStore((s) => s.settings.units)
  const coordFormat = useAppStore((s) => s.settings.coordFormat)
  const hasIon = useAppStore((s) => !!s.keys.cesiumIonToken)
  const patchSettings = useAppStore((s) => s.patchSettings)
  const set = useAppStore((s) => s.set)
  const [collapsed, setCollapsed] = useState(false)

  if (!state.open) return null

  const patch = (fn: (v: ViewshedSettings) => void) => patchSettings((d) => fn(d.viewshed))
  const engine = getEngine()
  const unitTag = units === 'imperial' ? 'ft' : 'm'
  const ringSpacing = viewshedRingInterval(settings.radius, units)
  const pct = state.stats ? `${(state.stats.visibleFraction * 100).toFixed(1)}%` : null
  const area = state.stats ? formatArea(state.stats.visibleAreaM2, units) : null

  return (
    <div className="panel viewshed-panel" role="region" aria-label="Viewshed analysis">
      <div className="row vs-head">
        <Icon name="viewshed" size={17} style={{ color: 'var(--ok)', flex: 'none' }} />
        <strong>Viewshed</strong>
        {state.target && (
          <span className="mono small muted vs-coords" title="Viewshed target coordinates and ground elevation">
            {formatLatLon(state.target.latitude, state.target.longitude, coordFormat)} · {formatElevation(state.target.groundMsl, units)}
            {settings.targetOffset > 0 && ` (+${formatOffsetLabel(settings.targetOffset, units)})`}
          </span>
        )}
        {state.status === 'loading' && (
          <span className="badge" role="status">
            Loading {state.loaded}/{state.levels}…
          </span>
        )}
        {state.stats && state.status !== 'error' && (
          <span className="badge ok mono" title={`Visible terrain within ${formatDistance(settings.radius, units)} radius`}>
            {pct} · {area}
          </span>
        )}
        <span className="grow" />
        <button
          className={`btn ghost vs-btn ${state.picking ? 'active' : ''}`}
          aria-pressed={state.picking}
          title="Click a point on the map to move the viewshed target"
          onClick={() => engine?.viewshed.setPicking(!state.picking)}
        >
          <Icon name="pin" size={13} />
          {state.picking ? 'Click map…' : 'Move target'}
        </button>
        {state.target && (
          <button
            className="btn ghost vs-btn"
            title="Fly camera to the viewshed target"
            onClick={() => void engine?.flyToViewshedTarget()}
          >
            Frame
          </button>
        )}
        <button
          className="icon-btn small"
          title={collapsed ? 'Show viewshed controls' : 'Hide viewshed controls'}
          aria-label={collapsed ? 'Show viewshed controls' : 'Hide viewshed controls'}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
        >
          <Icon name={collapsed ? 'chevronUp' : 'chevronDown'} size={14} />
        </button>
        <button
          className="icon-btn small"
          title="Clear viewshed"
          aria-label="Clear viewshed"
          onClick={() => engine?.viewshed.clear()}
        >
          <Icon name="close" size={14} />
        </button>
      </div>

      {state.status === 'error' && state.error && (
        <div className="notice row" style={{ marginTop: 6 }}>
          <span className="grow">{state.error}</span>
          {!hasIon && (
            <button className="btn ghost vs-btn" onClick={() => set({ settingsOpen: true })}>
              Settings
            </button>
          )}
        </div>
      )}

      {!collapsed && state.status !== 'error' && (
        <div className="vs-controls">
          <div className="row vs-row">
            <span className="muted vs-label">Radius</span>
            <div className="segmented" role="group" aria-label="Viewshed radius">
              {VIEWSHED_RADII.map((r) => (
                <button
                  key={r}
                  className={settings.radius === r ? 'active' : ''}
                  aria-pressed={settings.radius === r}
                  onClick={() => patch((v) => void (v.radius = r))}
                >
                  {formatRadiusLabel(r, units)}
                </button>
              ))}
            </div>

            <span className="muted vs-label" style={{ marginLeft: 8 }}>
              Opacity
            </span>
            <input
              type="range"
              min={0.05}
              max={0.95}
              step={0.05}
              value={settings.opacity}
              aria-label="Viewshed opacity"
              title={`Opacity ${Math.round(settings.opacity * 100)}%`}
              onChange={(e) => patch((v) => void (v.opacity = Number(e.target.value)))}
              style={{ width: 92 }}
            />
            <span className="mono small faint" style={{ width: 32 }}>
              {Math.round(settings.opacity * 100)}%
            </span>
          </div>

          <div className="row vs-row">
            <span className="muted vs-label" title="Height of the target above ground (e.g. 0 m for a mountain peak, 1.7 m eye height, or tower/drone height)">
              Target height
            </span>
            <div className="vs-presets">
              {VIEWSHED_TARGET_PRESETS.map((m) => (
                <button
                  key={m}
                  className={`btn ghost vs-preset ${Math.abs(settings.targetOffset - m) < 0.05 ? 'active' : ''}`}
                  aria-pressed={Math.abs(settings.targetOffset - m) < 0.05}
                  onClick={() => patch((v) => void (v.targetOffset = m))}
                >
                  {formatOffsetLabel(m, units)}
                </button>
              ))}
              <OffsetField
                meters={settings.targetOffset}
                units={units}
                label="Target height offset"
                onCommit={(m) => patch((v) => void (v.targetOffset = m))}
              />
              <span className="small faint">{unitTag}</span>
            </div>

            <span className="muted vs-label" style={{ marginLeft: 8 }} title="Standing height of the photographer/viewer on the surrounding ground">
              Viewer height
            </span>
            <div className="vs-presets">
              {VIEWSHED_VIEWER_PRESETS.map((m) => (
                <button
                  key={m}
                  className={`btn ghost vs-preset ${Math.abs(settings.viewerOffset - m) < 0.05 ? 'active' : ''}`}
                  aria-pressed={Math.abs(settings.viewerOffset - m) < 0.05}
                  onClick={() => patch((v) => void (v.viewerOffset = m))}
                >
                  {formatOffsetLabel(m, units)}
                </button>
              ))}
              <OffsetField
                meters={settings.viewerOffset}
                units={units}
                label="Viewer height offset"
                onCommit={(m) => patch((v) => void (v.viewerOffset = m))}
              />
              <span className="small faint">{unitTag}</span>
            </div>
          </div>

          <div className="row vs-row">
            <div className="segmented" role="group" aria-label="Viewshed color mode">
              <button
                className={settings.colorMode === 'distance' ? 'active' : ''}
                aria-pressed={settings.colorMode === 'distance'}
                onClick={() => patch((v) => void (v.colorMode = 'distance'))}
              >
                Distance tint
              </button>
              <button
                className={settings.colorMode === 'solid' ? 'active' : ''}
                aria-pressed={settings.colorMode === 'solid'}
                onClick={() => patch((v) => void (v.colorMode = 'solid'))}
              >
                Uniform
              </button>
            </div>

            <label className="switch small" style={{ marginLeft: 6 }}>
              <input
                type="checkbox"
                checked={settings.showRings}
                onChange={(e) => patch((v) => void (v.showRings = e.target.checked))}
              />
              Rings ({formatDistance(ringSpacing, units)})
            </label>

            <span className="grow" />

            {settings.colorMode === 'distance' ? (
              <div className="vs-legend" title="Visible terrain tinted by distance from target to help judge focal length">
                <span className="small faint">0</span>
                <div className="vs-legend-bar" />
                <span className="small faint">{formatRadiusLabel(settings.radius, units)}</span>
              </div>
            ) : (
              <div className="vs-legend">
                <span className="vs-swatch" />
                <span className="small faint">Visible to target</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** Viewshed quick controls inside the Elevation side panel. */
export function ViewshedSection() {
  const state = useAppStore((s) => s.viewshed)
  const settings = useAppStore((s) => s.settings.viewshed)
  const units = useAppStore((s) => s.settings.units)
  const terrainReady = useAppStore((s) => s.terrainReady)
  const patchSettings = useAppStore((s) => s.patchSettings)
  const patch = (fn: (v: ViewshedSettings) => void) => patchSettings((d) => fn(d.viewshed))
  const engine = getEngine()

  return (
    <div className="section viewshed-section">
      <div className="row">
        <span className="grow" style={{ fontWeight: 500 }}>
          Viewshed analysis
        </span>
        {state.open ? (
          <button className="btn ghost vs-btn" onClick={() => engine?.viewshed.clear()}>
            Clear
          </button>
        ) : (
          <button className="btn vs-btn" onClick={() => void engine?.openViewshed()}>
            Analyze view
          </button>
        )}
      </div>

      <div className="row" style={{ marginTop: 4 }}>
        <button
          className={`btn ghost vs-btn grow ${state.picking ? 'active' : ''}`}
          aria-pressed={state.picking}
          onClick={() => engine?.viewshed.setPicking(!state.picking)}
        >
          <Icon name="pin" size={13} />
          {state.picking ? 'Click map to set target…' : state.open ? 'Move target on map' : 'Pick target on map'}
        </button>
        <select
          className="input"
          style={{ width: 88 }}
          aria-label="Viewshed radius"
          value={String(settings.radius)}
          onChange={(e) => patch((v) => void (v.radius = Number(e.target.value)))}
        >
          {VIEWSHED_RADII.map((r) => (
            <option key={r} value={String(r)}>
              {formatRadiusLabel(r, units)}
            </option>
          ))}
        </select>
      </div>

      <div className="row" style={{ marginTop: 4 }}>
        <span className="muted small grow">Opacity</span>
        <input
          type="range"
          min={0.05}
          max={0.95}
          step={0.05}
          value={settings.opacity}
          aria-label="Viewshed opacity"
          onChange={(e) => patch((v) => void (v.opacity = Number(e.target.value)))}
          style={{ width: 90 }}
        />
      </div>

      {state.open && state.stats && (
        <div className="small muted" style={{ marginTop: 4 }}>
          Visible: <span className="mono">{(state.stats.visibleFraction * 100).toFixed(1)}%</span> (
          <span className="mono">{formatArea(state.stats.visibleAreaM2, units)}</span>)
        </div>
      )}

      {!terrainReady && (
        <div className="small faint" style={{ marginTop: 4 }}>
          Requires Cesium World Terrain (Cesium ion token in Settings).
        </div>
      )}

      <div className="small faint" style={{ marginTop: 4 }}>
        Highlights all terrain with an unobstructed line of sight to the target (with Earth curvature and refraction), in both Photorealistic and Elevation modes.
      </div>
    </div>
  )
}

/** Line-of-sight readout shown inside InspectCard when a viewshed is active. */
export function ViewshedReadout() {
  const check = useAppStore((s) => s.inspectViewshed)
  const units = useAppStore((s) => s.settings.units)
  if (!check) return null
  const engine = getEngine()
  const pitchSign = check.pitchToTarget > 0 ? '+' : check.pitchToTarget < 0 ? '−' : ''
  const pitchText = `${pitchSign}${Math.abs(check.pitchToTarget).toFixed(1)}°`
  const clearanceText = check.outsideRadius
    ? 'Outside analysis radius'
    : check.visible
      ? Number.isFinite(check.clearanceM) && check.clearanceM > 0.5
        ? `Clears terrain by ${formatElevation(check.clearanceM, units)}`
        : 'Unobstructed line of sight'
      : `Blocked by ~${formatElevation(Math.max(1, -check.clearanceM), units)}`

  return (
    <div className="viewshed-readout">
      <div className="row" style={{ minHeight: 0, gap: 6 }}>
        <span className={`vs-dot ${check.visible ? 'visible' : 'hidden'}`} />
        <span style={{ fontWeight: 600 }}>
          {check.outsideRadius ? 'Outside viewshed' : check.visible ? 'Visible to target' : 'Hidden from target'}
        </span>
        <span className="mono small muted" style={{ marginLeft: 'auto' }}>
          {formatDistance(check.distance, units)}
        </span>
      </div>
      <div className="small muted mono" style={{ marginTop: 2 }}>
        To target: {Math.round(check.bearingToTarget)}° {compassPoint(check.bearingToTarget)} · {pitchText}
      </div>
      <div className="small faint" style={{ marginTop: 2 }}>
        {clearanceText}
      </div>
      <div className="row" style={{ marginTop: 6, minHeight: 0, gap: 6 }}>
        <button
          className="btn ghost vs-btn"
          title="Stand here at eye level looking back at the viewshed target"
          onClick={() => void engine?.lookAtViewshedTarget(false)}
        >
          <Icon name="person" size={13} /> Look at target
        </button>
        <button
          className="btn ghost vs-btn"
          title="Stand here at eye level with Viewfinder aimed at the viewshed target"
          onClick={() => void engine?.lookAtViewshedTarget(true)}
        >
          <Icon name="viewfinder" size={13} /> Frame
        </button>
      </div>
    </div>
  )
}
