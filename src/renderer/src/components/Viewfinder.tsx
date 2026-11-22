import { useEffect, useRef, useState } from 'react'
import { SENSOR_SIZE_RANGE } from '@shared/settings'
import type { CompositionGuide, FrameAspect, SensorId, ViewfinderSettings } from '@shared/types'
import {
  ASPECTS,
  FOCAL_MAX,
  FOCAL_MIN,
  FOCAL_PRESETS,
  FRAME_INSET,
  GUIDES,
  SENSORS,
  clampFocal,
  fitFrame,
  focalToSlider,
  formatFocal,
  guideLines,
  lensView,
  sliderToFocal,
  type LensView
} from '../lib/lens'
import { captureGlobeToMoodboard, createMoodboard } from '../lib/moodboards'
import { compassPoint } from '../lib/units'
import { useShellStore } from '../shell/shellStore'
import { useAppStore } from '../store/appStore'
import { useMoodboardStore } from '../store/moodboardStore'
import { Icon } from './Icon'

function useViewportSize(): { width: number; height: number } {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))
  useEffect(() => {
    const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return size
}

/**
 * The crop frame: the window outside it dimmed, plus composition guides. Purely visual
 * (pointer-events: none), so every navigation gesture still reaches the map. The engine's
 * Viewfinder sizes the field of view for the same rectangle (`fitFrame` with FRAME_INSET).
 */
export function ViewfinderFrame() {
  const on = useAppStore((s) => s.viewfinder)
  const settings = useAppStore((s) => s.settings.viewfinder)
  const { width, height } = useViewportSize()
  if (!on || width === 0 || height === 0) return null
  const lens = lensView(settings)
  const f = fitFrame(width, height, lens.ratio, FRAME_INSET)
  const lines = guideLines(settings.guide)
  const corner = Math.min(22, f.width / 6, f.height / 6)
  const px = (t: number, size: number, offset: number) => offset + t * size
  return (
    <svg className="viewfinder" width={width} height={height} aria-hidden="true" data-frame={`${f.x} ${f.y} ${f.width} ${f.height}`}>
      <path
        className="vf-mask"
        fillRule="evenodd"
        d={`M0 0H${width}V${height}H0Z M${f.x} ${f.y}v${f.height}h${f.width}v${-f.height}Z`}
      />
      {lines.map(([x1, y1, x2, y2], i) => {
        const p = { x1: px(x1, f.width, f.x), y1: px(y1, f.height, f.y), x2: px(x2, f.width, f.x), y2: px(y2, f.height, f.y) }
        return (
          <g key={i}>
            <line className="vf-guide-shadow" {...p} />
            <line className="vf-guide" {...p} />
          </g>
        )
      })}
      <rect className="vf-frame" x={f.x} y={f.y} width={f.width} height={f.height} />
      <path
        className="vf-corners"
        d={[
          `M${f.x} ${f.y + corner}V${f.y}H${f.x + corner}`,
          `M${f.x + f.width - corner} ${f.y}H${f.x + f.width}V${f.y + corner}`,
          `M${f.x + f.width} ${f.y + f.height - corner}V${f.y + f.height}H${f.x + f.width - corner}`,
          `M${f.x + corner} ${f.y + f.height}H${f.x}V${f.y + f.height - corner}`
        ].join(' ')}
      />
    </svg>
  )
}

/** "50 mm · FF · 3:2 · 39.6° × 27.0°" */
export function lensSummary(settings: ViewfinderSettings, lens: LensView = lensView(settings)): string {
  const aspect = settings.aspect === 'native' ? nativeRatioLabel(lens) : settings.aspect
  const oriented = settings.portrait ? aspect.split(':').reverse().join(':') : aspect
  const eq = lens.sensor.equivalentFocal ? ' eq.' : ''
  return `${formatFocal(settings.focalLength)}${eq} · ${lens.sensor.short} · ${oriented} · ${lens.horizontal.toFixed(1)}° × ${lens.vertical.toFixed(1)}°`
}

/** The sensor's own ratio as a familiar label when it is one (3:2, 4:3), else decimal. */
function nativeRatioLabel(lens: LensView): string {
  const r = lens.sensor.width / lens.sensor.height
  for (const a of ASPECTS) if (a.ratio !== null && Math.abs(a.ratio - r) < 0.02) return a.id
  return `${r.toFixed(2)}:1`
}

/** A number field that only commits valid values (typing "2" on the way to "200" is fine). */
function NumberField({
  value,
  min,
  max,
  step = 1,
  label,
  width,
  onCommit
}: {
  value: number
  min: number
  max: number
  step?: number
  label: string
  width: number
  onCommit: (v: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = (text: string) => {
    const v = Number(text.replace(',', '.'))
    if (text.trim() !== '' && Number.isFinite(v) && v >= min && v <= max) onCommit(v)
  }
  return (
    <input
      className="input mono"
      type="number"
      inputMode="decimal"
      min={min}
      max={max}
      step={step}
      aria-label={label}
      value={draft ?? String(Math.round(value * 10) / 10)}
      style={{ width }}
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

/** Lens controls and the readout, in the bottom stack while viewfinder mode is on. */
export function ViewfinderPanel() {
  const on = useAppStore((s) => s.viewfinder)
  const settings = useAppStore((s) => s.settings.viewfinder)
  const showCore = useAppStore((s) => s.settings.showMilkyWayIndicator)
  const milkyWay = useAppStore((s) => s.milkyWay)
  const heading = useAppStore((s) => s.camera?.heading ?? null)
  const pitch = useAppStore((s) => s.camera?.pitch ?? null)
  const patchSettings = useAppStore((s) => s.patchSettings)
  const set = useAppStore((s) => s.set)
  const [collapsed, setCollapsed] = useState(false)
  if (!on) return null

  const lens = lensView(settings)
  const patch = (fn: (v: ViewfinderSettings) => void) => patchSettings((d) => fn(d.viewfinder))
  const setFocal = (mm: number) => patch((v) => void (v.focalLength = clampFocal(mm)))
  const bearing = heading === null ? null : ((heading % 360) + 360) % 360
  const equivalentNote = lens.sensor.equivalentFocal
    ? `real ${lens.focal.toFixed(1)} mm`
    : Math.abs(lens.crop - 1) > 0.01
      ? `35 mm eq. ${Math.round(lens.equivalent)} mm`
      : null

  return (
    <div className="panel viewfinder-panel" role="region" aria-label="Viewfinder">
      <div className="vf-header">
        <Icon name="viewfinder" size={18} style={{ color: 'var(--accent)', flex: 'none' }} />
        <div className="vf-readout">
          <div className="mono vf-summary">{lensSummary(settings, lens)}</div>
          <div className="small muted mono">
            {equivalentNote && <>{equivalentNote} · </>}diag {lens.diagonal.toFixed(1)}° · crop {lens.crop.toFixed(2)}×
          </div>
        </div>
        <div className="vf-bearing" title="Where the lens points: compass bearing (true north) and tilt above / below the horizon">
          <span className="k">Lens</span>
          <span className="mono">{bearing === null ? '—' : `${bearing.toFixed(1)}° ${compassPoint(bearing)}`}</span>
          <span className="k">Tilt</span>
          <span className="mono">{pitch === null ? '—' : `${pitch > 0 ? '+' : pitch < 0 ? '−' : ''}${Math.abs(pitch).toFixed(1)}°`}</span>
          {showCore && milkyWay && (
            <>
              <span className="k" style={{ color: 'var(--milky-way)' }} title="Galactic Core (Sagittarius A*) azimuth and altitude">
                Core
              </span>
              <span className="mono" style={{ color: 'var(--milky-way)' }}>
                {milkyWay.azimuth.toFixed(1)}° {compassPoint(milkyWay.azimuth)} / {milkyWay.altitude >= 0 ? '+' : '−'}
                {Math.abs(milkyWay.altitude).toFixed(1)}°
              </span>
            </>
          )}
        </div>
        <SnapToMoodboardButton />
        <button
          className="icon-btn small"
          title={collapsed ? 'Show lens controls' : 'Hide lens controls'}
          aria-label={collapsed ? 'Show lens controls' : 'Hide lens controls'}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
        >
          <Icon name={collapsed ? 'chevronUp' : 'chevronDown'} size={14} />
        </button>
        <button className="icon-btn small" title="Close viewfinder (V)" aria-label="Close viewfinder" onClick={() => set({ viewfinder: false })}>
          <Icon name="close" size={14} />
        </button>
      </div>

      {!collapsed && (
        <>
          <div className="row vf-focal">
            <span className="muted vf-label">Focal length</span>
            <input
              type="range"
              className="grow"
              min={0}
              max={1}
              step={0.001}
              aria-label="Focal length (logarithmic)"
              aria-valuetext={formatFocal(settings.focalLength)}
              value={focalToSlider(settings.focalLength)}
              onChange={(e) => setFocal(sliderToFocal(Number(e.target.value)))}
            />
            <NumberField label="Focal length in mm" value={settings.focalLength} min={FOCAL_MIN} max={FOCAL_MAX} width={74} onCommit={setFocal} />
            <span className="faint">mm</span>
          </div>
          <div className="vf-presets" role="group" aria-label="Focal length presets">
            {FOCAL_PRESETS.map((mm) => (
              <button
                key={mm}
                className={`btn ghost vf-preset ${Math.abs(settings.focalLength - mm) < 0.5 ? 'active' : ''}`}
                aria-pressed={Math.abs(settings.focalLength - mm) < 0.5}
                onClick={() => setFocal(mm)}
              >
                {mm}
              </button>
            ))}
            <span className="small faint vf-keys">
              <span className="kbd">,</span> <span className="kbd">.</span> step · <span className="kbd">Shift</span> fine
            </span>
          </div>
          <div className="row vf-options">
            <label className="vf-field">
              <span className="muted">Sensor</span>
              <select
                className="input"
                value={settings.sensor}
                onChange={(e) => patch((v) => void (v.sensor = e.target.value as SensorId))}
                style={{ width: 210 }}
              >
                {SENSORS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            {settings.sensor === 'custom' && (
              <span className="vf-field">
                <NumberField
                  label="Custom sensor width in mm"
                  value={settings.customSensor.width}
                  min={SENSOR_SIZE_RANGE.min}
                  max={SENSOR_SIZE_RANGE.max}
                  step={0.1}
                  width={66}
                  onCommit={(w) => patch((v) => void (v.customSensor.width = w))}
                />
                <span className="faint">×</span>
                <NumberField
                  label="Custom sensor height in mm"
                  value={settings.customSensor.height}
                  min={SENSOR_SIZE_RANGE.min}
                  max={SENSOR_SIZE_RANGE.max}
                  step={0.1}
                  width={66}
                  onCommit={(h) => patch((v) => void (v.customSensor.height = h))}
                />
                <span className="faint">mm</span>
              </span>
            )}
            <label className="vf-field">
              <span className="muted">Frame</span>
              <select className="input" value={settings.aspect} onChange={(e) => patch((v) => void (v.aspect = e.target.value as FrameAspect))} style={{ width: 118 }}>
                {ASPECTS.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.id === 'native' ? `Sensor (${nativeRatioLabel(lens)})` : a.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="segmented" role="group" aria-label="Orientation">
              <button className={!settings.portrait ? 'active' : ''} aria-pressed={!settings.portrait} onClick={() => patch((v) => void (v.portrait = false))}>
                Landscape
              </button>
              <button className={settings.portrait ? 'active' : ''} aria-pressed={settings.portrait} onClick={() => patch((v) => void (v.portrait = true))}>
                Portrait
              </button>
            </div>
            <label className="vf-field">
              <span className="muted">Guides</span>
              <select
                className="input"
                value={settings.guide}
                onChange={(e) => patch((v) => void (v.guide = e.target.value as CompositionGuide))}
                style={{ width: 200 }}
              >
                {GUIDES.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </>
      )}
    </div>
  )
}

function SnapToMoodboardButton() {
  const summaries = useMoodboardStore((s) => s.summaries)
  const activeProjectId = useShellStore((s) => s.activeProjectId)
  const [menuOpen, setMenuOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [menuOpen])

  const snap = async (boardId?: string | null) => {
    setMenuOpen(false)
    setBusy(true)
    try {
      await captureGlobeToMoodboard(boardId)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <button
        type="button"
        className="btn ghost small"
        disabled={busy}
        title="Snap current Viewfinder frame onto a Moodboard"
        onClick={() => {
          if (summaries.length <= 1) void snap(summaries[0]?.id ?? null)
          else setMenuOpen((o) => !o)
        }}
      >
        <Icon name="camera" size={14} />
        <span>{busy ? 'Snapping…' : 'Snap to Moodboard'}</span>
      </button>

      {menuOpen && (
        <div
          className="panel"
          role="menu"
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 8px)',
            right: 0,
            minWidth: 220,
            padding: 5,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            zIndex: 40
          }}
        >
          <div className="small faint" style={{ padding: '4px 8px' }}>
            Send Viewfinder snapshot to…
          </div>
          {summaries.slice(0, 8).map((b) => (
            <button
              key={b.id}
              type="button"
              role="menuitem"
              className="btn ghost small"
              style={{ justifyContent: 'flex-start', width: '100%' }}
              onClick={() => void snap(b.id)}
            >
              <Icon name="moodboard" size={13} />
              <span className="truncate">{b.title}</span>
            </button>
          ))}
          <div style={{ height: 1, background: 'var(--panel-border)', margin: '3px 6px' }} />
          <button
            type="button"
            role="menuitem"
            className="btn ghost small"
            style={{ justifyContent: 'flex-start', width: '100%', color: 'var(--accent)' }}
            onClick={async () => {
              setMenuOpen(false)
              setBusy(true)
              try {
                const created = await createMoodboard(
                  { title: 'Viewfinder Captures', projectId: activeProjectId, template: 'blank' },
                  { open: false }
                )
                await captureGlobeToMoodboard(created.summary.id)
              } finally {
                setBusy(false)
              }
            }}
          >
            <Icon name="plus" size={13} />
            <span>New Moodboard…</span>
          </button>
        </div>
      )}
    </div>
  )
}
