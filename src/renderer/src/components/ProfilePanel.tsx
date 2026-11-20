import { useMemo, useRef } from 'react'
import { getEngine } from '../engine/instance'
import { nearestSampleIndex } from '../lib/profile'
import { FEET_PER_METER, formatDistance, formatElevation } from '../lib/units'
import { useAppStore } from '../store/appStore'
import { Icon } from './Icon'

const W = 820
const H = 150
const PAD = { left: 52, right: 12, top: 10, bottom: 22 }

export function ProfilePanel() {
  const profile = useAppStore((s) => s.profile)
  const units = useAppStore((s) => s.settings.units)
  const svgRef = useRef<SVGSVGElement>(null)
  const { samples, stats, hoverIndex } = profile

  const geometry = useMemo(() => {
    if (!stats || samples.length < 2) return null
    const conv = (m: number) => (units === 'imperial' ? m * FEET_PER_METER : m)
    const lo = conv(stats.min)
    const hi = conv(stats.max)
    const span = Math.max(hi - lo, 10)
    const yMin = lo - span * 0.08
    const yMax = hi + span * 0.08
    const total = stats.distance || 1
    const x = (d: number) => PAD.left + (d / total) * (W - PAD.left - PAD.right)
    const y = (e: number) => PAD.top + (1 - (conv(e) - yMin) / (yMax - yMin)) * (H - PAD.top - PAD.bottom)
    let line = ''
    let started = false
    for (const s of samples) {
      if (s.elevation === null) {
        started = false
        continue
      }
      line += `${started ? 'L' : 'M'}${x(s.distance).toFixed(1)},${y(s.elevation).toFixed(1)}`
      started = true
    }
    const valid = samples.filter((s) => s.elevation !== null)
    const area =
      valid.length > 1
        ? `M${x(valid[0].distance)},${H - PAD.bottom}` +
          valid.map((s) => `L${x(s.distance).toFixed(1)},${y(s.elevation as number).toFixed(1)}`).join('') +
          `L${x(valid[valid.length - 1].distance)},${H - PAD.bottom}Z`
        : ''
    const ticks = Array.from({ length: 4 }, (_, i) => yMin + ((i + 0.5) / 4) * (yMax - yMin))
    return { x, y, line, area, ticks, yMin, yMax, total }
  }, [samples, stats, units])

  if (!profile.active && samples.length === 0 && !profile.loading && profile.points.length < 2) return null

  const hover = hoverIndex !== null ? samples[hoverIndex] : null
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!geometry) return
    const r = svgRef.current!.getBoundingClientRect()
    const px = ((e.clientX - r.left) / r.width) * W
    const d = ((px - PAD.left) / (W - PAD.left - PAD.right)) * geometry.total
    getEngine()?.profile.setHover(nearestSampleIndex(samples, Math.max(0, Math.min(geometry.total, d))))
  }

  return (
    <div className="panel profile-panel">
      <div className="row">
        <strong>Elevation profile</strong>
        {profile.loading && <span className="small muted">sampling…</span>}
        {profile.source && !profile.loading && (
          <span className="badge">{profile.source === 'terrain' ? 'Cesium World Terrain' : '3D Tiles surface'}</span>
        )}
        <span className="grow" />
        {profile.active ? (
          <>
            <button className="btn ghost" onClick={() => getEngine()?.profile.undo()} title="Remove last point (Backspace)">
              <Icon name="undo" size={14} /> Undo
            </button>
            <button className="btn primary" onClick={() => getEngine()?.profile.finish()} title="Finish (Enter)">
              Finish
            </button>
          </>
        ) : (
          <button className="btn" onClick={() => getEngine()?.startProfile()}>
            New path
          </button>
        )}
        <button className="icon-btn small" title="Clear profile" onClick={() => getEngine()?.profile.clear()}>
          <Icon name="close" size={14} />
        </button>
      </div>
      {profile.error && <div className="notice">{profile.error}</div>}
      {!geometry && !profile.error && (
        <div className="muted" style={{ padding: '18px 0' }}>
          {profile.points.length < 2 ? 'Click at least two points on the map to draw a path across the terrain.' : 'Sampling elevations…'}
        </div>
      )}
      {geometry && stats && (
        <>
          <svg
            ref={svgRef}
            className="profile-chart"
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            onPointerMove={onMove}
            onPointerLeave={() => getEngine()?.profile.setHover(null)}
            role="img"
            aria-label="Elevation profile chart"
          >
            {geometry.ticks.map((t) => {
              const yy = PAD.top + (1 - (t - geometry.yMin) / (geometry.yMax - geometry.yMin)) * (H - PAD.top - PAD.bottom)
              return (
                <g key={t}>
                  <line x1={PAD.left} x2={W - PAD.right} y1={yy} y2={yy} stroke="currentColor" strokeOpacity="0.08" />
                  <text x={PAD.left - 6} y={yy + 3} textAnchor="end" fontSize="10" fill="var(--text-faint)">
                    {Math.round(t).toLocaleString('en-US')}
                  </text>
                </g>
              )
            })}
            <text x={PAD.left} y={H - 6} fontSize="10" fill="var(--text-faint)">
              0
            </text>
            <text x={W - PAD.right} y={H - 6} fontSize="10" fill="var(--text-faint)" textAnchor="end">
              {formatDistance(geometry.total, units)}
            </text>
            <path d={geometry.area} fill="var(--accent)" fillOpacity="0.16" />
            <path d={geometry.line} fill="none" stroke="var(--accent)" strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
            {hover && hover.elevation !== null && (
              <g>
                <line x1={geometry.x(hover.distance)} x2={geometry.x(hover.distance)} y1={PAD.top} y2={H - PAD.bottom} stroke="#ffd54f" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                <circle cx={geometry.x(hover.distance)} cy={geometry.y(hover.elevation)} r="3.5" fill="#ffd54f" />
              </g>
            )}
          </svg>
          <div className="profile-stats">
            <span>
              <span className="k">Distance</span>
              <span className="mono">{formatDistance(stats.distance, units)}</span>
            </span>
            <span>
              <span className="k">Min</span>
              <span className="mono">{formatElevation(stats.min, units)}</span>
            </span>
            <span>
              <span className="k">Max</span>
              <span className="mono">{formatElevation(stats.max, units)}</span>
            </span>
            <span>
              <span className="k">Ascent</span>
              <span className="mono">↑ {formatElevation(stats.ascent, units)}</span>
            </span>
            <span>
              <span className="k">Descent</span>
              <span className="mono">↓ {formatElevation(stats.descent, units)}</span>
            </span>
            {hover && (
              <span style={{ marginLeft: 'auto' }}>
                <span className="k">At {formatDistance(hover.distance, units)}</span>
                <span className="mono">{formatElevation(hover.elevation, units)}</span>
              </span>
            )}
          </div>
        </>
      )}
    </div>
  )
}
