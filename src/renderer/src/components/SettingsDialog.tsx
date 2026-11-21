import { useRef, useState, type ReactNode } from 'react'
import { EMPTY_OVERRIDES, QUALITY_PRESETS } from '@shared/settings'
import type { QualityOverrides, QualityPreset } from '@shared/types'
import { PRESETS } from '../engine/quality'
import { useAppInfo } from '../hooks/useAppInfo'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { saveKeys } from '../lib/keys'
import { useAppStore } from '../store/appStore'
import { Icon } from './Icon'
import { KeyFields, useKeyFields } from './KeyFields'

type Section = 'keys' | 'display' | 'quality' | 'navigation' | 'about'

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      <div>
        <div className="label">{label}</div>
        {hint && <div className="hint">{hint}</div>}
      </div>
      <div className="control">{children}</div>
    </div>
  )
}

export function SettingsDialog() {
  const open = useAppStore((s) => s.settingsOpen)
  return open ? <SettingsContent /> : null
}

function KeysSection() {
  const initial = useAppStore((s) => s.keys)
  const secrets = useAppStore((s) => s.secrets)
  const showToast = useAppStore((s) => s.showToast)
  const info = useAppInfo()
  const { keys, setKeys, result, validating, validate, setResult } = useKeyFields(initial)
  return (
    <div>
      {secrets && (
        <div className="small muted" style={{ marginBottom: 4 }}>
          {secrets.memoryOnly
            ? `No system keyring (${secrets.backend}): keys are held in memory for this session only.`
            : 'Keys are encrypted with the operating system’s keyring (Electron safeStorage).'}
        </div>
      )}
      <KeyFields keys={keys} setKeys={setKeys} result={result} referer={info?.googleReferer ?? ''} />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button
          className="btn danger"
          onClick={() => {
            const cleared = { googleApiKey: null, cesiumIonToken: null }
            setKeys(cleared)
            setResult(null)
            void saveKeys(cleared).then(() => showToast('Keys cleared'))
          }}
        >
          Clear keys
        </button>
        <button className="btn" disabled={validating} onClick={() => void validate()}>
          {validating ? 'Checking…' : 'Re-validate'}
        </button>
        <button className="btn primary" onClick={() => void saveKeys(keys).then(() => showToast('Keys saved'))}>
          Save keys
        </button>
      </div>
    </div>
  )
}

function OverrideNumber({
  label,
  field,
  options
}: {
  label: string
  field: 'maximumScreenSpaceError' | 'shadowMapSize' | 'msaaSamples' | 'resolutionScale' | 'terrainShadowResolution'
  options: number[]
}) {
  const settings = useAppStore((s) => s.settings)
  const patch = useAppStore((s) => s.patchSettings)
  const value = settings.quality.overrides[field]
  const presetValue = PRESETS[settings.quality.preset][field]
  return (
    <Field label={label} hint={`Preset: ${presetValue}`}>
      <select
        className="input"
        value={value === null ? '' : String(value)}
        onChange={(e) =>
          patch((d) => {
            d.quality.overrides[field] = e.target.value === '' ? null : Number(e.target.value)
          })
        }
      >
        <option value="">Preset</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </Field>
  )
}

function OverrideBool({ label, field }: { label: string; field: 'softShadows' | 'fxaa' }) {
  const settings = useAppStore((s) => s.settings)
  const patch = useAppStore((s) => s.patchSettings)
  const value = settings.quality.overrides[field]
  return (
    <Field label={label} hint={`Preset: ${PRESETS[settings.quality.preset][field] ? 'on' : 'off'}`}>
      <select
        className="input"
        value={value === null ? '' : value ? 'on' : 'off'}
        onChange={(e) => patch((d) => void (d.quality.overrides[field] = e.target.value === '' ? null : e.target.value === 'on'))}
      >
        <option value="">Preset</option>
        <option value="on">On</option>
        <option value="off">Off</option>
      </select>
    </Field>
  )
}

function SettingsContent() {
  const [section, setSection] = useState<Section>('keys')
  const settings = useAppStore((s) => s.settings)
  const patch = useAppStore((s) => s.patchSettings)
  const set = useAppStore((s) => s.set)
  const info = useAppInfo()
  const close = () => set({ settingsOpen: false })
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef)
  const nav = settings.navigation
  const o: QualityOverrides = settings.quality.overrides
  const hasOverrides = Object.values(o).some((v) => v !== null)

  return (
    <div className="scrim center" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={dialogRef} tabIndex={-1} className="panel dialog" role="dialog" aria-modal="true" aria-label="Settings" style={{ width: 'min(820px, calc(100% - 32px))' }}>
        <div className="dialog-header">
          <h2>Settings</h2>
          <button className="icon-btn small" title="Close" onClick={close}>
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="settings-layout">
          <div className="settings-nav">
            {(
              [
                ['keys', 'API keys'],
                ['display', 'Units & display'],
                ['quality', 'Quality'],
                ['navigation', 'Navigation'],
                ['about', 'About']
              ] as Array<[Section, string]>
            ).map(([id, label]) => (
              <button key={id} className={section === id ? 'active' : ''} aria-current={section === id ? 'page' : undefined} onClick={() => setSection(id)}>
                {label}
              </button>
            ))}
          </div>
          <div className="settings-content">
            {section === 'keys' && <KeysSection />}
            {section === 'display' && (
              <>
                <Field label="Units">
                  <div className="segmented">
                    <button className={settings.units === 'metric' ? 'active' : ''} onClick={() => patch((d) => void (d.units = 'metric'))}>
                      Metric
                    </button>
                    <button className={settings.units === 'imperial' ? 'active' : ''} onClick={() => patch((d) => void (d.units = 'imperial'))}>
                      Imperial
                    </button>
                  </div>
                </Field>
                <Field label="Coordinate format">
                  <div className="segmented">
                    <button className={settings.coordFormat === 'decimal' ? 'active' : ''} onClick={() => patch((d) => void (d.coordFormat = 'decimal'))}>
                      Decimal
                    </button>
                    <button className={settings.coordFormat === 'dms' ? 'active' : ''} onClick={() => patch((d) => void (d.coordFormat = 'dms'))}>
                      DMS
                    </button>
                  </div>
                </Field>
                <Field label="Theme" hint="Applies to the interface only, never the map.">
                  <div className="segmented">
                    <button className={settings.theme === 'dark' ? 'active' : ''} onClick={() => patch((d) => void (d.theme = 'dark'))}>
                      Dark
                    </button>
                    <button className={settings.theme === 'light' ? 'active' : ''} onClick={() => patch((d) => void (d.theme = 'light'))}>
                      Light
                    </button>
                  </div>
                </Field>
              </>
            )}
            {section === 'quality' && (
              <>
                <Field label="Quality preset" hint="Controls tile detail, shadow maps, anti-aliasing and resolution.">
                  <div className="segmented">
                    {QUALITY_PRESETS.map((p: QualityPreset) => (
                      <button key={p} className={settings.quality.preset === p ? 'active' : ''} onClick={() => patch((d) => void (d.quality.preset = p))}>
                        {p[0].toUpperCase() + p.slice(1)}
                      </button>
                    ))}
                  </div>
                </Field>
                <Field label="Device-pixel-ratio rendering" hint="Render at full display resolution on HiDPI screens. Sharper, slower.">
                  <input
                    type="checkbox"
                    checked={settings.quality.devicePixelRatioAware}
                    onChange={(e) => patch((d) => void (d.quality.devicePixelRatioAware = e.target.checked))}
                  />
                </Field>
                <Field label="FPS and tile indicator">
                  <input type="checkbox" checked={settings.quality.showFps} onChange={(e) => patch((d) => void (d.quality.showFps = e.target.checked))} />
                </Field>
                <div className="row" style={{ marginTop: 10 }}>
                  <strong className="grow">Advanced overrides</strong>
                  {hasOverrides && (
                    <button className="btn ghost" onClick={() => patch((d) => void (d.quality.overrides = { ...EMPTY_OVERRIDES }))}>
                      Reset to preset
                    </button>
                  )}
                </div>
                <OverrideNumber label="3D Tiles screen-space error" field="maximumScreenSpaceError" options={[4, 6, 8, 12, 16, 20, 24, 32]} />
                <OverrideNumber label="Shadow map size" field="shadowMapSize" options={[1024, 2048, 4096, 8192]} />
                <Field label="Shadow cascades" hint={`Preset: ${PRESETS[settings.quality.preset].shadowCascades}`}>
                  <select
                    className="input"
                    value={o.shadowCascades === null ? '' : String(o.shadowCascades)}
                    onChange={(e) => patch((d) => void (d.quality.overrides.shadowCascades = e.target.value === '' ? null : (Number(e.target.value) as 1 | 4)))}
                  >
                    <option value="">Preset</option>
                    <option value="1">1</option>
                    <option value="4">4</option>
                  </select>
                </Field>
                <OverrideBool label="Soft shadows" field="softShadows" />
                <OverrideNumber label="Terrain shadow resolution" field="terrainShadowResolution" options={[256, 384, 512, 768, 1024]} />
                <OverrideNumber label="MSAA samples" field="msaaSamples" options={[1, 2, 4, 8]} />
                <OverrideBool label="FXAA" field="fxaa" />
                <OverrideNumber label="Resolution scale" field="resolutionScale" options={[0.5, 0.75, 1, 1.25, 1.5]} />
              </>
            )}
            {section === 'navigation' && (
              <>
                <Field label="Inertia" hint="How long the camera glides after you let go. 0 turns it off.">
                  <input
                    type="range"
                    min={0}
                    max={0.95}
                    step={0.05}
                    value={nav.inertia}
                    onChange={(e) => patch((d) => void (d.navigation.inertia = Number(e.target.value)))}
                    style={{ width: 140 }}
                  />
                  <span className="mono" style={{ width: 36 }}>
                    {nav.inertia === 0 ? 'Off' : nav.inertia.toFixed(2)}
                  </span>
                </Field>
                <Field label="Keyboard speed" hint="Multiplier for WASD movement. Speed also scales with height above ground.">
                  <input
                    type="range"
                    min={0.25}
                    max={4}
                    step={0.25}
                    value={nav.speedMultiplier}
                    onChange={(e) => patch((d) => void (d.navigation.speedMultiplier = Number(e.target.value)))}
                    style={{ width: 140 }}
                  />
                  <span className="mono" style={{ width: 36 }}>
                    {nav.speedMultiplier}×
                  </span>
                </Field>
                <Field label="Scrolling" hint="Auto: two-finger scroll on a trackpad pans and pinch zooms; a mouse wheel zooms.">
                  <div className="segmented">
                    {(
                      [
                        ['auto', 'Auto'],
                        ['pan', 'Pans'],
                        ['zoom', 'Zooms']
                      ] as const
                    ).map(([id, label]) => (
                      <button key={id} className={nav.scrollGesture === id ? 'active' : ''} onClick={() => patch((d) => void (d.navigation.scrollGesture = id))}>
                        {label}
                      </button>
                    ))}
                  </div>
                </Field>
                <Field label="Invert Y in fly mode">
                  <input type="checkbox" checked={nav.invertFlyY} onChange={(e) => patch((d) => void (d.navigation.invertFlyY = e.target.checked))} />
                </Field>
                <Field label="Minimum ground clearance" hint="The camera never goes closer to the surface than this (eye-level mode uses 1.7 m).">
                  <input
                    className="input mono"
                    type="number"
                    min={0.5}
                    max={100}
                    step={0.5}
                    value={nav.minClearance}
                    onChange={(e) => patch((d) => void (d.navigation.minClearance = Math.max(0.5, Number(e.target.value) || 2)))}
                    style={{ width: 80 }}
                  />
                  <span className="faint">m</span>
                </Field>
              </>
            )}
            {section === 'about' && (
              <div style={{ lineHeight: 1.6 }}>
                <p>
                  <strong>PhotoEarth {info?.version}</strong> — a 3D globe for photography location scouting.
                </p>
                <p className="muted">
                  Map data: Google Photorealistic 3D Tiles and 2D Tiles (Map Tiles API), Google Places API (New). Elevation: Cesium World
                  Terrain via Cesium ion. Sun positions: SunCalc. Time zones resolved offline. Geoid: EGM96.
                </p>
                <p className="muted">
                  Attributions are shown at the bottom right whenever their data is on screen. Google imagery and 3D geometry can’t be
                  exported.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
