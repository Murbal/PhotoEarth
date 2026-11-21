import type { LightPollutionSourceId } from '@shared/types'
import { getEngine } from '../engine/instance'
import { LIGHT_POLLUTION_SOURCE_LIST, lightPollutionSource, readoutSource } from '../lib/lightPollutionSources'
import { estimateFromZone, ratioToMpsas, rgbCss, ZONES, type SkyEstimate } from '../lib/skyBrightness'
import { useAppStore } from '../store/appStore'

const fmtMpsas = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : '—')

/** Zone boundaries labeled under the legend: pristine, artificial = natural (4a), 6a, 7b. */
const LEGEND_TICKS = [0, 7, 11, 14].map((i) => ({
  at: i / ZONES.length,
  label: ratioToMpsas(ZONES[i].min).toFixed(2)
}))

function zoneTitle(i: number): string {
  const z = ZONES[i]
  const e = estimateFromZone(i)
  const [dark, bright] = e.mpsasRange!
  const range = Number.isFinite(bright) ? `${fmtMpsas(dark)}–${fmtMpsas(bright)}` : `< ${fmtMpsas(dark)}`
  const ratio = Number.isFinite(z.max) ? `${z.min}–${z.max}×` : `> ${z.min}×`
  return `Zone ${z.id}: ${range} mag/arcsec², artificial light ${ratio} the natural sky · Bortle ≈ ${e.bortle.label}`
}

/** The atlas color scale: one chip per zone, zenith brightness under it. */
export function SkyBrightnessLegend() {
  return (
    <div className="lp-legend" aria-label="Light pollution zones, zenith sky brightness in mag/arcsec²">
      <div className="lp-zones">
        {ZONES.map((z, i) => (
          <div key={z.id} title={zoneTitle(i)}>
            <div className="lp-swatch" style={{ background: rgbCss(z.rgb) }} />
            {z.id}
          </div>
        ))}
      </div>
      <div className="lp-ticks">
        {LEGEND_TICKS.map((t) => (
          <span key={t.label} style={{ left: `${t.at * 100}%` }}>
            {t.label}
          </span>
        ))}
      </div>
      <div className="small faint">mag/arcsec² at the zenith · darker skies have higher values</div>
    </div>
  )
}

function Opacity({ value, onChange, disabled }: { value: number; onChange: (v: number) => void; disabled?: boolean }) {
  return (
    <input
      type="range"
      min={0}
      max={1}
      step={0.05}
      value={value}
      disabled={disabled}
      aria-label="Light pollution opacity"
      title={`Opacity ${Math.round(value * 100)}%`}
      onChange={(e) => onChange(Number(e.target.value))}
      style={{ width: 90 }}
    />
  )
}

/** The overlay's toggle, opacity, source and legend, in the Elevation panel (§7.5). */
export function LightPollutionSection() {
  const lp = useAppStore((s) => s.settings.lightPollution)
  const elevationMode = useAppStore((s) => s.mode === 'elevation')
  const covered = useAppStore((s) => s.terrainReady && (s.settings.elevation.tint.enabled || s.settings.elevation.slope.enabled))
  const patch = useAppStore((s) => s.patchSettings)
  const source = lightPollutionSource(lp.source)
  return (
    <div className="section light-pollution">
      <div className="row">
        <label className="switch grow">
          <input type="checkbox" checked={lp.enabled} onChange={(ev) => patch((d) => void (d.lightPollution.enabled = ev.target.checked))} />
          Light pollution
        </label>
        <Opacity value={lp.opacity} disabled={!lp.enabled} onChange={(v) => patch((d) => void (d.lightPollution.opacity = v))} />
      </div>
      <div className="row">
        <select
          className="input grow"
          value={lp.source}
          aria-label="Light pollution source"
          onChange={(ev) => patch((d) => void (d.lightPollution.source = ev.target.value as LightPollutionSourceId))}
        >
          {LIGHT_POLLUTION_SOURCE_LIST.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      {lp.enabled && !elevationMode && (
        <div className="notice" style={{ margin: '4px 0' }}>
          The map layer drapes on the terrain globe, so it shows in Elevation mode. Clicked points get a sky brightness estimate in
          either mode.{' '}
          <a href="#" onClick={(ev) => (ev.preventDefault(), getEngine()?.setMode('elevation'))}>
            Switch now
          </a>
        </div>
      )}
      {lp.enabled && elevationMode && covered && (
        <div className="small faint" style={{ margin: '4px 0' }}>
          Hypsometric tint and slope shading draw over this layer; turn them off to read its colors.
        </div>
      )}
      {lp.enabled &&
        (source.kind === 'sky-brightness' ? (
          <SkyBrightnessLegend />
        ) : (
          <div style={{ marginTop: 6 }}>
            <div className="legend-bar" style={{ background: 'linear-gradient(90deg, #000, #3a2a10 30%, #f0b45a 70%, #fff)' }} />
            <div className="legend-labels">
              <span>No light</span>
              <span>Bright</span>
            </div>
            <div className="small faint">
              Light emitted upward, not sky brightness. Clicked points use the {readoutSource(lp.source).label}.
            </div>
          </div>
        ))}
      <div className="small faint" style={{ marginTop: 4 }}>
        {source.kind === 'sky-brightness'
          ? 'Modeled artificial sky brightness on a clear, moonless night. Click a point for its estimate and Bortle class. '
          : ''}
        <a href={source.info} target="_blank" rel="noreferrer">
          About the data
        </a>
      </div>
    </div>
  )
}

/** One line for the clipboard: "21.10 mag/arcsec² (Bortle ≈ 4)". */
export function skySummary(e: SkyEstimate): string {
  return `${fmtMpsas(e.mpsas)} mag/arcsec² (Bortle ≈ ${e.bortle.label}, estimate)`
}

/** Sky brightness and a Bortle estimate at the inspected point. */
export function SkyReadout() {
  const sky = useAppStore((s) => s.sky)
  if (!sky) return null
  const e = sky.estimate
  let body
  if (sky.status === 'loading') body = <span className="faint">Night sky …</span>
  else if (sky.status === 'outside') body = <span className="small faint">No light pollution data beyond 65° S – 75° N.</span>
  else if (!e) body = <span className="small faint">Sky brightness data couldn’t be loaded.</span>
  else {
    const range = e.mpsasRange
    const ratio = e.ratio < 0.1 ? e.ratio.toFixed(3) : e.ratio < 3 ? e.ratio.toFixed(2) : e.ratio.toFixed(1)
    body = (
      <>
        <div className="sky-grid">
          <span className="k">Night sky</span>
          <span className="mono" title="Total zenith brightness (natural 22.0 plus artificial), magnitudes per square arcsecond. Higher is darker.">
            {range
              ? Number.isFinite(range[1])
                ? `${fmtMpsas(range[0])}–${fmtMpsas(range[1])}`
                : `< ${fmtMpsas(range[0])}`
              : fmtMpsas(e.mpsas)}{' '}
            mag/arcsec²
          </span>
          <span className="k">Bortle</span>
          <span title={e.bortle.title}>
            ≈ <b>{e.bortle.label}</b> <span className="faint">{e.bortle.title}</span>
          </span>
          <span className="k">Zone</span>
          <span>
            <span className="zone-chip" style={{ background: rgbCss(e.zone.rgb) }} /> {e.zone.id}
            <span className="faint">
              {' '}
              · artificial {e.precision === 'zone' ? '≈ ' : ''}
              {ratio}× natural
            </span>
          </span>
        </div>
        <div className="small faint" style={{ marginTop: 4 }}>
          Estimate: modeled zenith brightness on a clear, moonless night ({sky.source}
          {e.precision === 'zone' ? ', from the map colors' : ''}). Bortle rates the whole sky by eye; light domes on the horizon can
          make it a class worse.
        </div>
      </>
    )
  }
  return <div className="sky-readout">{body}</div>
}
