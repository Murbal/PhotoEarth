import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { getEngine } from '../engine/instance'
import { formatLatLon } from '@shared/coords'
import {
  aboveSkyline,
  azDelta,
  bodyPath,
  horizonAt,
  horizonRange,
  MOON_RADIUS,
  pathRuns,
  sampleIndex,
  skylineCrossings,
  SUN_RADIUS,
  wrap360,
  type Horizon,
  type PathPoint,
  type SkylineDay
} from '../lib/panorama'
import { moonPhase, moonPosition } from '../lib/moon'
import { sunDay, sunPosition } from '../lib/sun'
import { addDays, formatClock, formatDuration, localMinutesOf, utcToZoned, zoneAbbreviation, zonedToUtc } from '../lib/time'
import { lookupTimeZone } from '../lib/timezone'
import { compassPoint, formatDistance, formatElevation } from '../lib/units'
import { useAppStore, type HorizonPeak } from '../store/appStore'
import { Icon } from './Icon'

const HEIGHT = 210
const PAD = { left: 36, right: 10, top: 8, bottom: 20 }
const MIN_SPAN = 6
/** Span of the sunrise / sunset close-ups, degrees. */
const CLOSE_UP = 40
const PATH_STEP_MS = 4 * 60000
const HIT_PX = 10
const LABEL_ROW = 13

type Scale = 'fit' | 'true'

interface View {
  center: number
  span: number
}

interface BodySky {
  path: PathPoint[]
  hours: Array<PathPoint & { label: string }>
  day: SkylineDay
  radius: number
}

interface Sky {
  start: number
  end: number
  sun: BodySky
  moon: BodySky | null
  sunrise: number | null
  sunset: number | null
  moonPhase: ReturnType<typeof moonPhase>
}

const clock = (utc: number, timeZone: string) => formatClock(localMinutesOf(utc, timeZone))

function niceStep(range: number, maxTicks: number, steps: number[]): number {
  return steps.find((s) => range / s <= maxTicks) ?? steps[steps.length - 1]
}

const CARDINALS: Record<number, string> = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' }

function bodySky(h: Horizon, at: (utc: number) => { azimuth: number; altitude: number }, date: string, timeZone: string, start: number, end: number, radius: number): BodySky {
  const hours: BodySky['hours'] = []
  for (let hr = 0; hr < 24; hr++) {
    const utc = zonedToUtc(date, hr * 60, timeZone)
    // Clock changes repeat or skip an hour.
    if (utc < start || utc >= end || hours.some((p) => p.utc === utc)) continue
    hours.push({ utc, ...at(utc), label: String(hr).padStart(2, '0') })
  }
  return { path: bodyPath(at, start, end, PATH_STEP_MS), hours, day: skylineCrossings(h, at, start, end, radius), radius }
}

/** The horizon panorama: skyline altitude against azimuth with the sun and moon paths. */
export function HorizonPanel() {
  const open = useAppStore((s) => s.horizon.open)
  return open ? <HorizonPanelBody /> : null
}

function HorizonPanelBody() {
  const state = useAppStore((s) => s.horizon)
  const sunUtc = useAppStore((s) => s.sun?.utc ?? null)
  const units = useAppStore((s) => s.settings.units)
  const coordFormat = useAppStore((s) => s.settings.coordFormat)
  const prefs = useAppStore((s) => s.settings.horizon)
  const patchSettings = useAppStore((s) => s.patchSettings)
  const { horizon, observer } = state
  // The observer's own day and clock, which may differ from the view center's.
  const timeZone = useMemo(() => (observer ? lookupTimeZone(observer.latitude, observer.longitude) : 'UTC'), [observer])
  const date = utcToZoned(sunUtc ?? Date.now(), timeZone).date

  const wrapRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [width, setWidth] = useState(820)
  const [view, setView] = useState<View>(() => ({ center: (observer?.latitude ?? 0) >= 0 ? 180 : 0, span: 360 }))
  const [scale, setScale] = useState<Scale>('fit')
  const [selected, setSelected] = useState<number | null>(null)
  const drag = useRef<{ x: number; center: number; moved: boolean } | null>(null)

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = () => setWidth(Math.max(320, Math.round(el.clientWidth)))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const sky = useMemo((): Sky | null => {
    if (!horizon || !observer) return null
    const { latitude, longitude } = observer
    const start = zonedToUtc(date, 0, timeZone)
    const end = zonedToUtc(addDays(date, 1), 0, timeZone)
    const sun = bodySky(horizon, (t) => sunPosition(t, latitude, longitude), date, timeZone, start, end, SUN_RADIUS)
    const moon = prefs.moon ? bodySky(horizon, (t) => moonPosition(t, latitude, longitude), date, timeZone, start, end, MOON_RADIUS) : null
    const day = sunDay(date, timeZone, latitude, longitude)
    return { start, end, sun, moon, sunrise: day.sunrise, sunset: day.sunset, moonPhase: moonPhase((start + end) / 2) }
  }, [horizon, observer, date, timeZone, prefs.moon])

  const plotW = width - PAD.left - PAD.right
  const plotH = HEIGHT - PAD.top - PAD.bottom

  const frame = useMemo(() => {
    if (!horizon) return null
    const { center, span } = view
    const range = horizonRange(horizon, center, span)
    const low = Math.min(Number.isFinite(range.min) ? range.min : 0, 0)
    const high = Number.isFinite(range.max) ? range.max : 1
    let lo: number
    let hi: number
    if (scale === 'true') {
      // One degree is as tall as it is wide, as in a photograph.
      const total = plotH / (plotW / span)
      lo = Math.max(-90, low - Math.min(2, total * 0.12))
      hi = Math.min(90, lo + total)
    } else {
      const pad = Math.max(0.6, (high - low) * 0.22)
      lo = low - pad
      hi = Math.max(high + pad * 1.6, lo + 4)
    }
    const x = (az: number) => PAD.left + ((azDelta(az, center) + span / 2) / span) * plotW
    const y = (alt: number) => PAD.top + ((hi - alt) / (hi - lo)) * plotH
    const pxPerDegX = plotW / span
    const pxPerDegY = plotH / (hi - lo)
    return { lo, hi, x, y, pxPerDegX, pxPerDegY, exaggeration: pxPerDegY / pxPerDegX }
  }, [horizon, view, scale, plotW, plotH])

  // Skyline, grid and labels: everything that doesn't change while hovering.
  const terrain = useMemo(() => {
    if (!horizon || !frame) return null
    const { center, span } = view
    const n = horizon.altitude.length
    const step = horizon.step
    const left = center - span / 2
    const startIndex = sampleIndex(horizon, left)
    const offset0 = azDelta(startIndex * step, left)
    const count = Math.min(n, Math.ceil(span / step) + 2)
    const bins = ['', '', '', '']
    const binOf = (d: number) => (d < 4000 ? 0 : d < 15000 ? 1 : d < 50000 ? 2 : 3)
    let line = ''
    let area = ''
    let first: number | null = null
    let lastX = 0
    let prev: { x: number; y: number; bin: number } | null = null
    for (let k = 0; k <= count; k++) {
      const i = (startIndex + k) % n
      const alt = horizon.altitude[i]
      const px = PAD.left + ((offset0 + k * step) / span) * plotW
      if (!Number.isFinite(alt)) {
        prev = null
        continue
      }
      const py = frame.y(alt)
      const bin = binOf(horizon.distance[i])
      line += `${prev ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`
      if (first === null) {
        first = px
        area += `M${px.toFixed(1)},${HEIGHT - PAD.bottom}`
      }
      area += `L${px.toFixed(1)},${py.toFixed(1)}`
      lastX = px
      if (prev) bins[prev.bin] += `M${prev.x.toFixed(1)},${prev.y.toFixed(1)}L${px.toFixed(1)},${py.toFixed(1)}`
      prev = { x: px, y: py, bin }
    }
    if (first !== null) area += `L${lastX.toFixed(1)},${HEIGHT - PAD.bottom}Z`

    const altStep = niceStep(frame.hi - frame.lo, 5, [0.5, 1, 2, 5, 10, 15, 30, 45])
    const altTicks: number[] = []
    for (let a = Math.ceil(frame.lo / altStep) * altStep; a <= frame.hi; a += altStep) altTicks.push(Math.round(a * 10) / 10)
    const azStep = niceStep(span, Math.max(2, plotW / 60), [1, 2, 5, 10, 15, 30, 45, 90])
    const azTicks: number[] = []
    // The full circle's last tick would repeat its first.
    const end = left + span + (span >= 360 ? -1e-6 : 1e-6)
    for (let a = Math.ceil(left / azStep) * azStep; a <= end; a += azStep) azTicks.push(wrap360(a))
    return { line, area, bins, altTicks, azTicks }
  }, [horizon, frame, view, plotW])

  const peakLabels = useMemo(() => {
    if (!frame || !horizon) return []
    const placed: Array<{ peak: HorizonPeak; x: number; y: number; row: number; text: string }> = []
    const rows: Array<Array<[number, number]>> = [[], [], []]
    for (const peak of state.peaks) {
      if (Math.abs(azDelta(peak.azimuth, view.center)) > view.span / 2) continue
      const x = frame.x(peak.azimuth)
      const y = frame.y(Math.max(peak.altitude, horizonAt(horizon, peak.azimuth)))
      const text = `${peak.name} ${formatElevation(peak.heightMsl, units)}`
      const w = text.length * 5.6 + 8
      for (let row = 0; row < rows.length; row++) {
        const ly = PAD.top + 10 + row * LABEL_ROW
        if (ly > y - 10) break
        const a = x - w / 2
        const b = x + w / 2
        if (a < PAD.left - 4 || b > width - PAD.right + 4) break
        if (rows[row].some(([p, q]) => a < q + 6 && b > p - 6)) continue
        rows[row].push([a, b])
        placed.push({ peak, x, y, row, text })
        break
      }
    }
    return placed
  }, [state.peaks, frame, horizon, view, units, width])

  // Non-passive, so the wheel zooms the chart instead of scrolling anything.
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const fx = Math.min(1, Math.max(0, (e.clientX - r.left - PAD.left) / plotW))
      setView((v) => {
        const span = Math.min(360, Math.max(MIN_SPAN, v.span * Math.exp(e.deltaY * 0.0015)))
        const at = v.center + (fx - 0.5) * v.span
        return { center: span >= 360 ? v.center : wrap360(at - (fx - 0.5) * span), span }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [plotW, horizon])

  const engine = getEngine()
  const hoverAz = state.hoverAzimuth
  const azAt = (clientX: number) => {
    const r = svgRef.current!.getBoundingClientRect()
    return wrap360(view.center + ((clientX - r.left - PAD.left) / plotW - 0.5) * view.span)
  }

  /** The path point (sun or moon) under the pointer, if any. */
  const pathHit = (clientX: number, clientY: number): PathPoint | null => {
    if (!sky || !frame) return null
    const r = svgRef.current!.getBoundingClientRect()
    const px = clientX - r.left
    const py = clientY - r.top
    let best: PathPoint | null = null
    let bestD = HIT_PX
    for (const body of [sky.sun, sky.moon]) {
      if (!body) continue
      for (const p of body.path) {
        if (Math.abs(azDelta(p.azimuth, view.center)) > view.span / 2) continue
        const d = Math.hypot(frame.x(p.azimuth) - px, frame.y(p.altitude) - py)
        if (d < bestD) {
          bestD = d
          best = p
        }
      }
    }
    return best
  }

  const zoomTo = (azimuth: number | null) => {
    if (azimuth === null) return
    setView({ center: wrap360(azimuth), span: CLOSE_UP })
    setSelected(wrap360(azimuth))
  }
  const firstRise = sky?.sun.day.events.find((e) => e.kind === 'rise') ?? null
  const lastSet = sky ? [...sky.sun.day.events].reverse().find((e) => e.kind === 'set') ?? null : null
  const fallbackAz = (utc: number | null) => (utc !== null && observer ? sunPosition(utc, observer.latitude, observer.longitude).azimuth : null)

  const lookAz = selected ?? hoverAz
  const look = () => {
    if (!horizon) return
    const az = lookAz ?? (sunUtc !== null && observer ? sunPosition(sunUtc, observer.latitude, observer.longitude).azimuth : view.center)
    void engine?.lookFromHorizon(az, Math.max(-10, Math.min(30, horizonAt(horizon, az) || 0)))
  }

  const loading = state.status === 'loading'
  const hover = hoverAz !== null && horizon ? hoverInfo(horizon, hoverAz, sky, state.geoid) : null

  return (
    <div className="panel horizon-panel" role="region" aria-label="Horizon panorama">
      <div className="row horizon-head">
        <strong>Horizon</strong>
        {observer && <span className="mono small muted">{formatLatLon(observer.latitude, observer.longitude, coordFormat)}</span>}
        {observer && Number.isFinite(observer.eyeMsl) && <span className="small faint">eye {formatElevation(observer.eyeMsl, units)}</span>}
        {loading && (
          <span className="small muted" role="status">
            terrain {state.loaded}/{state.levels}…
          </span>
        )}
        {state.peakStatus === 'loading' && <span className="small muted">naming peaks…</span>}
        <span className="grow" />
        <div className="segmented" role="group" aria-label="Zoom">
          <button className={view.span >= 360 ? 'active' : ''} onClick={() => setView((v) => ({ center: v.center, span: 360 }))}>
            360°
          </button>
          <button disabled={!sky} onClick={() => zoomTo(firstRise?.azimuth ?? fallbackAz(sky?.sunrise ?? null))} title="Close-up on where the sun first clears the skyline">
            Sunrise
          </button>
          <button disabled={!sky} onClick={() => zoomTo(lastSet?.azimuth ?? fallbackAz(sky?.sunset ?? null))} title="Close-up on where the sun disappears behind the skyline">
            Sunset
          </button>
        </div>
        <div className="segmented" role="group" aria-label="Vertical scale">
          <button className={scale === 'fit' ? 'active' : ''} onClick={() => setScale('fit')} title="Stretch the skyline to fill the chart">
            Fit
          </button>
          <button className={scale === 'true' ? 'active' : ''} onClick={() => setScale('true')} title="True angles: a degree is as tall as it is wide">
            1:1
          </button>
        </div>
        <label className="switch small" title="Moon path">
          <input type="checkbox" checked={prefs.moon} onChange={(e) => patchSettings((d) => void (d.horizon.moon = e.target.checked))} />
          Moon
        </label>
        <label className="switch small" title="Name the peaks on the skyline (Google Places)">
          <input type="checkbox" checked={prefs.peakNames} onChange={(e) => patchSettings((d) => void (d.horizon.peakNames = e.target.checked))} />
          Peaks
        </label>
        <button className="btn" disabled={!horizon} onClick={look} title="Stand at the observer at eye level, facing the selected direction (or the sun)">
          <Icon name="person" size={14} /> Look
        </button>
        <button className="icon-btn small" title="Close horizon panorama (H)" aria-label="Close horizon panorama" onClick={() => engine?.horizon.close()}>
          <Icon name="close" size={14} />
        </button>
      </div>

      {state.error && <div className="notice">{state.error}</div>}

      <div ref={wrapRef} className="horizon-chart-wrap">
        {!horizon && !state.error && <div className="muted horizon-empty">Loading terrain around the observer…</div>}
        {horizon && frame && terrain && (
          <svg
            ref={svgRef}
            className="horizon-chart"
            width={width}
            height={HEIGHT}
            viewBox={`0 0 ${width} ${HEIGHT}`}
            role="img"
            aria-label="Skyline altitude by compass direction, with the sun and moon paths"
            tabIndex={0}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId)
              drag.current = { x: e.clientX, center: view.center, moved: false }
            }}
            onPointerMove={(e) => {
              const d = drag.current
              if (d) {
                const dx = e.clientX - d.x
                if (Math.abs(dx) > 3) d.moved = true
                // Dragging turns the panorama (at 360° too: it moves the seam).
                if (d.moved) setView((v) => ({ ...v, center: wrap360(d.center - (dx / plotW) * v.span) }))
              }
              engine?.horizon.setHover(azAt(e.clientX))
            }}
            onPointerUp={(e) => {
              const d = drag.current
              drag.current = null
              if (!d || d.moved) return
              const hit = pathHit(e.clientX, e.clientY)
              if (hit) engine?.sun.setInstant(hit.utc)
              else setSelected(azAt(e.clientX))
            }}
            onPointerLeave={() => engine?.horizon.setHover(null)}
            onDoubleClick={() => setView((v) => ({ center: v.center, span: 360 }))}
            onKeyDown={(e) => {
              const stepDeg = e.shiftKey ? 10 : 1
              if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault()
                e.stopPropagation()
                const next = wrap360((selected ?? view.center) + (e.key === 'ArrowLeft' ? -stepDeg : stepDeg))
                setSelected(next)
                if (Math.abs(azDelta(next, view.center)) > view.span / 2) setView((v) => ({ ...v, center: next }))
              } else if (e.key === '+' || e.key === '=' || e.key === '-') {
                e.preventDefault()
                e.stopPropagation()
                const f = e.key === '-' ? 1.5 : 1 / 1.5
                setView((v) => ({ center: selected ?? v.center, span: Math.min(360, Math.max(MIN_SPAN, v.span * f)) }))
              }
            }}
          >
            <defs>
              <clipPath id="horizon-plot">
                <rect x={PAD.left} y={PAD.top} width={plotW} height={plotH} />
              </clipPath>
              <linearGradient id="horizon-ground" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="var(--text)" stopOpacity="0.2" />
                <stop offset="1" stopColor="var(--text)" stopOpacity="0.07" />
              </linearGradient>
            </defs>

            {terrain.altTicks.map((a) => (
              <g key={`alt${a}`}>
                <line x1={PAD.left} x2={width - PAD.right} y1={frame.y(a)} y2={frame.y(a)} stroke="currentColor" strokeOpacity={a === 0 ? 0.28 : 0.07} strokeDasharray={a === 0 ? '4 3' : undefined} />
                <text x={PAD.left - 5} y={frame.y(a) + 3} textAnchor="end" fontSize="10" fill="var(--text-faint)">
                  {a}°
                </text>
              </g>
            ))}
            {terrain.azTicks.map((a) => {
              const x = frame.x(a)
              const cardinal = CARDINALS[Math.round(a) % 360]
              return (
                <g key={`az${a}`}>
                  <line x1={x} x2={x} y1={PAD.top} y2={HEIGHT - PAD.bottom} stroke="currentColor" strokeOpacity={cardinal ? 0.12 : 0.05} />
                  <text x={x} y={HEIGHT - 6} textAnchor="middle" fontSize="10" fontWeight={cardinal ? 600 : 400} fill={cardinal ? 'var(--text-muted)' : 'var(--text-faint)'}>
                    {cardinal ?? `${Math.round(a)}°`}
                  </text>
                </g>
              )
            })}

            <g clipPath="url(#horizon-plot)">
              <path d={terrain.area} fill="url(#horizon-ground)" />
              {/* Nearer ridges stronger, distant ones fainter: atmospheric perspective. */}
              {terrain.bins.map((d, i) => (
                <path key={i} d={d} fill="none" stroke="var(--text)" strokeOpacity={[0.95, 0.75, 0.55, 0.4][i]} strokeWidth={1.4} strokeLinejoin="round" />
              ))}

              {sky?.moon && <BodyLayer body={sky.moon} horizon={horizon} frame={frame} view={view} plotW={plotW} color="var(--moon)" timeZone={timeZone} small />}
              {sky && <BodyLayer body={sky.sun} horizon={horizon} frame={frame} view={view} plotW={plotW} color="var(--sun)" timeZone={timeZone} />}
              {sky?.moon && sunUtc !== null && observer && sunUtc >= sky.start && sunUtc < sky.end && (
                <Disc pos={moonPosition(sunUtc, observer.latitude, observer.longitude)} radius={MOON_RADIUS} frame={frame} view={view} color="var(--moon)" />
              )}
              {sky && sunUtc !== null && observer && sunUtc >= sky.start && sunUtc < sky.end && (
                <Disc pos={sunPosition(sunUtc, observer.latitude, observer.longitude)} radius={SUN_RADIUS} frame={frame} view={view} color="var(--sun)" glow />
              )}

              {peakLabels.map(({ peak, x, y, row, text }) => {
                const ly = PAD.top + 10 + row * LABEL_ROW
                return (
                  <g key={peak.id} className="horizon-peak">
                    <line x1={x} x2={x} y1={ly + 3} y2={y - 3} stroke="var(--text-faint)" strokeOpacity="0.7" strokeWidth="0.8" />
                    <path d={`M${x - 3},${y - 1}L${x},${y - 6}L${x + 3},${y - 1}Z`} fill="var(--text-muted)" />
                    <text x={x} y={ly} textAnchor="middle" fontSize="10.5" fill="var(--text)" stroke="var(--panel-solid)" strokeWidth="3" paintOrder="stroke">
                      {text}
                    </text>
                  </g>
                )
              })}

              {selected !== null && Math.abs(azDelta(selected, view.center)) <= view.span / 2 && (
                <line x1={frame.x(selected)} x2={frame.x(selected)} y1={PAD.top} y2={HEIGHT - PAD.bottom} stroke="var(--accent)" strokeWidth="1.2" strokeDasharray="3 3" />
              )}
              {hover && (
                <g pointerEvents="none">
                  <line x1={frame.x(hover.azimuth)} x2={frame.x(hover.azimuth)} y1={PAD.top} y2={HEIGHT - PAD.bottom} stroke="#ffd54f" strokeWidth="1" />
                  {Number.isFinite(hover.altitude) && <circle cx={frame.x(hover.azimuth)} cy={frame.y(hover.altitude)} r="3.5" fill="#ffd54f" />}
                </g>
              )}
            </g>
            {scale === 'fit' && frame.exaggeration > 1.5 && (
              <text x={width - PAD.right - 2} y={PAD.top + 10} textAnchor="end" fontSize="10" fill="var(--text-faint)">
                vertical ×{frame.exaggeration < 10 ? frame.exaggeration.toFixed(1) : Math.round(frame.exaggeration)}
              </text>
            )}
          </svg>
        )}
      </div>

      {sky && horizon && (
        <div className="horizon-stats">
          <span className="faint">times {zoneAbbreviation(sky.start + 12 * 3600000, timeZone) || timeZone}</span>
          <SunSummary sky={sky} timeZone={timeZone} />
          {sky.moon && <MoonSummary sky={sky} timeZone={timeZone} />}
          {state.peakStatus === 'unavailable' && prefs.peakNames && <span className="faint">Peak names need a Google Maps Platform key with Places API (New).</span>}
          {hover && (
            <span className="horizon-hover">
              <span className="mono">
                {hover.azimuth.toFixed(1)}° {compassPoint(hover.azimuth)}
              </span>
              <span className="k">skyline</span>
              <span className="mono">{Number.isFinite(hover.altitude) ? `${hover.altitude >= 0 ? '+' : ''}${hover.altitude.toFixed(2)}°` : '—'}</span>
              {hover.distance > 0 && (
                <>
                  <span className="mono">{formatDistance(hover.distance, units)}</span>
                  <span className="mono">{formatElevation(hover.heightMsl, units)}</span>
                </>
              )}
              {hover.sunTime !== null && (
                <>
                  <span className="k">sun here</span>
                  <span className="mono">{clock(hover.sunTime, timeZone)}</span>
                </>
              )}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

interface Frame {
  lo: number
  hi: number
  x: (az: number) => number
  y: (alt: number) => number
  pxPerDegX: number
  pxPerDegY: number
}

function hoverInfo(h: Horizon, azimuth: number, sky: Sky | null, geoid: number) {
  const i = sampleIndex(h, azimuth)
  // When the sun passes this azimuth (above −2°), for "sun here at …".
  let sunTime: number | null = null
  if (sky) {
    const path = sky.sun.path
    for (let k = 1; k < path.length; k++) {
      const a = path[k - 1]
      const b = path[k]
      const da = azDelta(azimuth, a.azimuth)
      const db = azDelta(azimuth, b.azimuth)
      if (Math.abs(da - db) < 90 && Math.sign(da) !== Math.sign(db) && Math.max(a.altitude, b.altitude) > -2) {
        const t = da / (da - db)
        sunTime = a.utc + (b.utc - a.utc) * t
        break
      }
    }
  }
  return {
    azimuth,
    altitude: horizonAt(h, azimuth),
    distance: h.distance[i],
    heightMsl: h.height[i] - geoid,
    sunTime
  }
}

/** A body's path: solid above the skyline, dashed behind it, with hour marks and skyline events. */
function BodyLayer({
  body,
  horizon,
  frame,
  view,
  plotW,
  color,
  timeZone,
  small
}: {
  body: BodySky
  horizon: Horizon
  frame: Frame
  view: View
  plotW: number
  color: string
  timeZone: string
  small?: boolean
}) {
  const visibleIn = (p: { azimuth: number; altitude: number }) => Math.abs(azDelta(p.azimuth, view.center)) <= view.span / 2 + 2
  const below = frame.lo - 1
  const runs = pathRuns(
    body.path.filter((p) => p.altitude > below - 5),
    (p) => aboveSkyline(horizon, p, body.radius),
    (p) => frame.x(p.azimuth),
    (180 / view.span) * plotW
  )
  const d = (pts: PathPoint[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${frame.x(p.azimuth).toFixed(1)},${frame.y(p.altitude).toFixed(1)}`).join('')
  return (
    <g pointerEvents="none">
      {runs.map((r, i) => (
        <path
          key={i}
          d={d(r.points)}
          fill="none"
          stroke={color}
          strokeWidth={r.visible ? (small ? 1.6 : 2) : 1.2}
          strokeOpacity={r.visible ? 0.95 : 0.55}
          strokeDasharray={r.visible ? undefined : '3 3'}
        />
      ))}
      {body.hours
        .filter((p) => p.altitude > frame.lo && p.altitude < frame.hi && visibleIn(p))
        .map((p) => {
          const x = frame.x(p.azimuth)
          const y = frame.y(p.altitude)
          return (
            <g key={p.utc}>
              <circle cx={x} cy={y} r={small ? 2 : 2.6} fill={color} />
              <text x={x + 4} y={y - 4} fontSize={small ? 9 : 10} fill={color} stroke="var(--panel-solid)" strokeWidth="2.5" paintOrder="stroke">
                {p.label}
              </text>
            </g>
          )
        })}
      {body.day.events
        .filter((e) => visibleIn(e))
        .map((e) => {
          const x = frame.x(e.azimuth)
          const y = frame.y(e.altitude)
          const rise = e.kind === 'rise'
          // Rises are labeled to the left, sets to the right, unless that runs off the chart.
          const left = rise ? x - 50 > PAD.left : x + 50 > PAD.left + plotW
          return (
            <g key={`${e.kind}${e.utc}`}>
              <path d={`M${x},${y - 4}L${x + 4},${y}L${x},${y + 4}L${x - 4},${y}Z`} fill={color} stroke="var(--panel-solid)" strokeWidth="1" />
              <text
                x={x + (left ? -6 : 6)}
                y={y + 14}
                textAnchor={left ? 'end' : 'start'}
                fontSize="10"
                fontWeight="600"
                fill={color}
                stroke="var(--panel-solid)"
                strokeWidth="3"
                paintOrder="stroke"
              >
                {rise ? '↑' : '↓'} {clock(e.utc, timeZone)}
              </text>
            </g>
          )
        })}
    </g>
  )
}

/** The body at the current time, drawn at its true angular size (at least a few pixels). */
function Disc({ pos, radius, frame, view, color, glow }: { pos: { azimuth: number; altitude: number }; radius: number; frame: Frame; view: View; color: string; glow?: boolean }) {
  if (Math.abs(azDelta(pos.azimuth, view.center)) > view.span / 2 + 1) return null
  const cx = frame.x(pos.azimuth)
  const cy = frame.y(pos.altitude)
  const rx = Math.max(4, radius * frame.pxPerDegX)
  const ry = Math.max(4, radius * frame.pxPerDegY)
  return (
    <g pointerEvents="none">
      {glow && <ellipse cx={cx} cy={cy} rx={rx + 5} ry={ry + 5} fill={color} fillOpacity="0.22" />}
      <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill={color} stroke="var(--panel-solid)" strokeWidth="1" />
    </g>
  )
}

function events(day: SkylineDay, timeZone: string): string {
  if (day.events.length === 0) return day.visibleAtStart ? 'above the skyline all day' : 'behind the skyline all day'
  return day.events.map((e) => `${e.kind === 'rise' ? '↑' : '↓'} ${clock(e.utc, timeZone)}`).join('  ')
}

function SunSummary({ sky, timeZone }: { sky: Sky; timeZone: string }) {
  const { day } = sky.sun
  const first = day.events.find((e) => e.kind === 'rise')
  const last = [...day.events].reverse().find((e) => e.kind === 'set')
  const delta = (a: number | undefined, b: number | null) => {
    if (a === undefined || b === null) return null
    const m = Math.round((a - b) / 60000)
    return m === 0 ? null : `${m > 0 ? '+' : '−'}${formatDuration(Math.abs(m) * 60000)}`
  }
  const late = delta(first?.utc, sky.sunrise)
  const early = delta(last?.utc, sky.sunset)
  return (
    <span className="horizon-summary">
      <span className="dot" style={{ background: 'var(--sun)' }} />
      <span className="k">Sun over terrain</span>
      <span className="mono">{events(day, timeZone)}</span>
      {(late || early) && (
        <span className="faint" title="Compared with sunrise and sunset over a flat horizon">
          ({[late && `rise ${late}`, early && `set ${early}`].filter(Boolean).join(', ')} vs flat horizon)
        </span>
      )}
      {day.events.length > 0 && (
        <>
          <span className="k">direct sun</span>
          <span className="mono">{formatDuration(day.visibleMs)}</span>
        </>
      )}
    </span>
  )
}

function MoonSummary({ sky, timeZone }: { sky: Sky; timeZone: string }) {
  const phase = sky.moonPhase
  return (
    <span className="horizon-summary">
      <span className="dot" style={{ background: 'var(--moon)' }} />
      <span className="k">Moon</span>
      <span>
        {phase.name}, {Math.round(phase.fraction * 100)} %
      </span>
      <span className="mono">{events(sky.moon!.day, timeZone)}</span>
    </span>
  )
}
