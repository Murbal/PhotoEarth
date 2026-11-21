import { CONTOUR_INTERVALS, CONTOUR_INTERVALS_FT, MAX_EXAGGERATION, MIN_EXAGGERATION, PALETTES } from '@shared/settings'
import type { ImageryType, PaletteId } from '@shared/types'
import { getEngine } from '../engine/instance'
import { PALETTE_LABELS, paletteGradientCss, SLOPE_CLASSES } from '../lib/palettes'
import { FEET_PER_METER, formatElevation } from '../lib/units'
import { useAppStore } from '../store/appStore'
import { Icon } from './Icon'
import { LightPollutionSection } from './LightPollution'

function Opacity({ value, onChange, disabled }: { value: number; onChange: (v: number) => void; disabled?: boolean }) {
  return (
    <input
      type="range"
      min={0}
      max={1}
      step={0.05}
      value={value}
      disabled={disabled}
      aria-label="Opacity"
      title={`Opacity ${Math.round(value * 100)}%`}
      onChange={(e) => onChange(Number(e.target.value))}
      style={{ width: 90 }}
    />
  )
}

export function ElevationPanel() {
  const open = useAppStore((s) => s.panels.elevation)
  const mode = useAppStore((s) => s.mode)
  const settings = useAppStore((s) => s.settings)
  const autoRange = useAppStore((s) => s.autoRange)
  const terrainReady = useAppStore((s) => s.terrainReady)
  const patch = useAppStore((s) => s.patchSettings)
  const togglePanel = useAppStore((s) => s.togglePanel)
  if (!open) return null

  const e = settings.elevation
  const units = settings.units
  const range = e.tint.autoRange && autoRange ? autoRange : { min: e.tint.min, max: e.tint.max }
  const elevationMode = mode === 'elevation'
  const unitLabel = units === 'imperial' ? 'ft' : 'm'
  const toUnit = (m: number) => Math.round(units === 'imperial' ? m * FEET_PER_METER : m)
  const fromUnit = (v: number) => (units === 'imperial' ? v / FEET_PER_METER : v)
  // Intervals are stored in meters; imperial users pick round numbers of feet.
  const intervals =
    units === 'imperial'
      ? CONTOUR_INTERVALS_FT.map((ft) => ({ meters: ft / FEET_PER_METER, label: `${ft} ft` }))
      : CONTOUR_INTERVALS.map((m) => ({ meters: m, label: `${m} m` }))
  const currentInterval =
    intervals.find((i) => Math.abs(i.meters - e.contours.interval) < 0.01) ??
    { meters: e.contours.interval, label: formatElevation(e.contours.interval, units) }
  const intervalOptions = intervals.includes(currentInterval) ? intervals : [currentInterval, ...intervals]

  return (
    <div className="panel side-panel right">
      <div className="panel-header">
        Elevation <span className="spacer" />
        <button className="icon-btn small" title="Close" onClick={() => togglePanel('elevation', false)}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="panel-body scroll">
        {!elevationMode && (
          <div className="notice" style={{ marginBottom: 8 }}>
            Styling needs real height data, so it shows in Elevation mode.{' '}
            <a href="#" onClick={(ev) => (ev.preventDefault(), getEngine()?.setMode('elevation'))}>
              Switch now
            </a>
          </div>
        )}
        {elevationMode && !terrainReady && (
          <div className="notice" style={{ marginBottom: 8 }}>
            Waiting for Cesium World Terrain. Add a Cesium ion token in Settings if you haven’t.
          </div>
        )}

        <div className="section">
          <div className="row">
            <span className="grow muted">Imagery</span>
            <select
              className="input"
              value={settings.imagery}
              onChange={(ev) => patch((d) => void (d.imagery = ev.target.value as ImageryType))}
            >
              <option value="satellite">Satellite</option>
              <option value="terrain">Terrain map</option>
              <option value="roadmap">Road map</option>
            </select>
          </div>
          <div className="row">
            <span className="grow muted">Vertical exaggeration</span>
            <span className="mono" style={{ color: settings.verticalExaggeration !== 1 ? 'var(--warn)' : undefined }}>
              {settings.verticalExaggeration.toFixed(1)}×
            </span>
          </div>
          <input
            type="range"
            min={MIN_EXAGGERATION}
            max={MAX_EXAGGERATION}
            step={0.1}
            value={settings.verticalExaggeration}
            aria-label="Vertical exaggeration"
            onChange={(ev) => patch((d) => void (d.verticalExaggeration = Number(ev.target.value)))}
          />
        </div>

        <div className="section">
          <div className="row">
            <label className="switch grow">
              <input type="checkbox" checked={e.tint.enabled} onChange={(ev) => patch((d) => void (d.elevation.tint.enabled = ev.target.checked))} />
              Hypsometric tint
            </label>
            <Opacity value={e.tint.opacity} disabled={!e.tint.enabled} onChange={(v) => patch((d) => void (d.elevation.tint.opacity = v))} />
          </div>
          <div className="row">
            <select
              className="input grow"
              value={e.tint.palette}
              aria-label="Palette"
              onChange={(ev) => patch((d) => void (d.elevation.tint.palette = ev.target.value as PaletteId))}
            >
              {PALETTES.map((p) => (
                <option key={p} value={p}>
                  {PALETTE_LABELS[p]}
                </option>
              ))}
            </select>
            <label className="switch small">
              <input type="checkbox" checked={e.tint.autoRange} onChange={(ev) => patch((d) => void (d.elevation.tint.autoRange = ev.target.checked))} />
              Auto-fit
            </label>
          </div>
          {!e.tint.autoRange && (
            <div className="row">
              <input
                className="input mono"
                type="number"
                aria-label="Minimum elevation"
                value={toUnit(e.tint.min)}
                onChange={(ev) => patch((d) => void (d.elevation.tint.min = fromUnit(Number(ev.target.value))))}
                style={{ width: 90 }}
              />
              <span className="faint">to</span>
              <input
                className="input mono"
                type="number"
                aria-label="Maximum elevation"
                value={toUnit(e.tint.max)}
                onChange={(ev) => patch((d) => void (d.elevation.tint.max = fromUnit(Number(ev.target.value))))}
                style={{ width: 90 }}
              />
              <span className="faint">{unitLabel}</span>
            </div>
          )}
          {e.tint.enabled && (
            <div style={{ marginTop: 6 }}>
              <div className="legend-bar" style={{ background: paletteGradientCss(e.tint.palette) }} />
              <div className="legend-labels">
                <span>{formatElevation(range.min, units)}</span>
                <span>{formatElevation((range.min + range.max) / 2, units)}</span>
                <span>{formatElevation(range.max, units)}</span>
              </div>
            </div>
          )}
        </div>

        <div className="section">
          <div className="row">
            <label className="switch grow">
              <input type="checkbox" checked={e.contours.enabled} onChange={(ev) => patch((d) => void (d.elevation.contours.enabled = ev.target.checked))} />
              Contour lines
            </label>
            <Opacity value={e.contours.opacity} disabled={!e.contours.enabled} onChange={(v) => patch((d) => void (d.elevation.contours.opacity = v))} />
          </div>
          <div className="row">
            <span className="muted">Interval</span>
            <select
              className="input"
              style={{ width: 96 }}
              value={String(currentInterval.meters)}
              onChange={(ev) => patch((d) => void (d.elevation.contours.interval = Number(ev.target.value)))}
            >
              {intervalOptions.map((i) => (
                <option key={i.label} value={String(i.meters)}>
                  {i.label}
                </option>
              ))}
            </select>
            <span className="muted">Width</span>
            <input
              type="range"
              min={0.5}
              max={4}
              step={0.1}
              value={e.contours.width}
              aria-label="Line width"
              onChange={(ev) => patch((d) => void (d.elevation.contours.width = Number(ev.target.value)))}
              style={{ width: 60 }}
            />
            <input type="color" value={e.contours.color} aria-label="Line color" onChange={(ev) => patch((d) => void (d.elevation.contours.color = ev.target.value))} />
          </div>
          {e.contours.enabled && (
            <div className="small faint">Every 5th line ({formatElevation(e.contours.interval * 5, units)}) is a bold index contour.</div>
          )}
        </div>

        <div className="section">
          <div className="row">
            <label className="switch grow">
              <input type="checkbox" checked={e.slope.enabled} onChange={(ev) => patch((d) => void (d.elevation.slope.enabled = ev.target.checked))} />
              Slope shading
            </label>
            <Opacity value={e.slope.opacity} disabled={!e.slope.enabled} onChange={(v) => patch((d) => void (d.elevation.slope.opacity = v))} />
          </div>
          {e.slope.enabled && (
            <div className="slope-legend" style={{ marginTop: 4 }}>
              {SLOPE_CLASSES.map((c, i) => (
                <div key={c.from}>
                  <div className="chip" style={{ background: c.color }} />
                  {i === SLOPE_CLASSES.length - 1 ? `${c.from}°+` : `${c.from}–${SLOPE_CLASSES[i + 1].from}°`}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="section">
          <div className="row">
            <label className="switch grow">
              <input type="checkbox" checked={e.hillshade.enabled} onChange={(ev) => patch((d) => void (d.elevation.hillshade.enabled = ev.target.checked))} />
              Hillshade
            </label>
            <Opacity value={e.hillshade.opacity} disabled={!e.hillshade.enabled} onChange={(v) => patch((d) => void (d.elevation.hillshade.opacity = v))} />
          </div>
          <div className="row">
            <div className="segmented">
              <button className={e.hillshade.followSun ? 'active' : ''} onClick={() => patch((d) => void (d.elevation.hillshade.followSun = true))}>
                Follow sun
              </button>
              <button className={!e.hillshade.followSun ? 'active' : ''} onClick={() => patch((d) => void (d.elevation.hillshade.followSun = false))}>
                Classic NW 45°
              </button>
            </div>
          </div>
          <div className="small faint">
            {e.hillshade.followSun
              ? 'Lit from the simulated sun; scrub the time to re-light the relief.'
              : 'Fixed light from the north-west for reading terrain shape.'}
          </div>
        </div>

        <LightPollutionSection />
      </div>
    </div>
  )
}
