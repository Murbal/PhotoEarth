import { useMemo } from 'react'
import { formatLatLon } from '@shared/coords'
import { getEngine } from '../engine/instance'
import {
  computeFramingCoverage,
  findAlignments,
  type AlignmentBodyFilter,
  type AlignmentMatch,
  type MoonSkyFilter
} from '../lib/alignment'
import { formatFocal, lensView } from '../lib/lens'
import type { SkyBand } from '../lib/sun'
import { addDays, formatClock, formatLongDate, zoneAbbreviation, zonedToUtc } from '../lib/time'
import { lookupTimeZone } from '../lib/timezone'
import { compassPoint, FEET_PER_METER, formatDistance, formatElevation } from '../lib/units'
import { appState, useAppStore, type AlignmentRangePreset } from '../store/appStore'
import { Icon } from './Icon'
import { MoonDisc } from './MoonDisc'

const RANGE_DAYS: Record<Exclude<AlignmentRangePreset, 'custom'>, number> = {
  '30d': 30,
  '90d': 90,
  '1y': 365,
  '2y': 730
}

const SKY_FILTER_OPTIONS: ReadonlyArray<{ id: MoonSkyFilter; label: string }> = [
  { id: 'any', label: 'Any sky' },
  { id: 'golden-blue', label: 'Golden & blue (−6°..+6°)' },
  { id: 'golden', label: 'Golden hour (−4°..+6°)' },
  { id: 'blue', label: 'Blue hour (−6°..−4°)' },
  { id: 'twilight', label: 'Twilight (−18°..−0.8°)' },
  { id: 'night', label: 'Night (< −18°)' },
  { id: 'day', label: 'Daylight (≥ −0.8°)' }
]

const ILLUM_PRESETS = [0, 25, 50, 75, 90, 95] as const

const SKY_BAND_LABEL: Record<SkyBand, string> = {
  night: 'Night',
  astronomical: 'Astro twi',
  nautical: 'Naut twi',
  blue: 'Blue hr',
  goldenTwilight: 'Golden twi',
  golden: 'Golden hr',
  day: 'Day'
}

function signedDeg(v: number, digits = 2): string {
  const sign = v > 0 ? '+' : v < 0 ? '−' : ''
  return `${sign}${Math.abs(v).toFixed(digits)}°`
}

function signedElev(meters: number, units: 'metric' | 'imperial'): string {
  const sign = meters > 0 ? '+' : meters < 0 ? '−' : ''
  return `${sign}${formatElevation(Math.abs(meters), units)}`
}

function formatLinearSize(meters: number, units: 'metric' | 'imperial'): string {
  if (!Number.isFinite(meters) || meters <= 0) return '—'
  if (units === 'imperial') {
    const ft = meters * FEET_PER_METER
    if (ft < 10) return `${ft.toFixed(1)} ft`
    if (ft < 5280 * 0.25) return `${Math.round(ft).toLocaleString('en-US')} ft`
    return `${(meters / 1609.344).toFixed(2)} mi`
  }
  if (meters < 10) return `${meters.toFixed(1)} m`
  if (meters < 1000) return `${Math.round(meters).toLocaleString('en-US')} m`
  return `${(meters / 1000).toFixed(2)} km`
}

export function AlignmentPanel() {
  const open = useAppStore((s) => s.alignment.open)
  return open ? <AlignmentPanelBody /> : null
}

function AlignmentPanelBody() {
  const state = useAppStore((s) => s.alignment)
  const elevationOpen = useAppStore((s) => s.panels.elevation)
  const units = useAppStore((s) => s.settings.units)
  const coordFormat = useAppStore((s) => s.settings.coordFormat)
  const vfSettings = useAppStore((s) => s.settings.viewfinder)
  const vfActive = useAppStore((s) => s.viewfinder)
  const hasActivePin = useAppStore((s) => !!(s.inspect || s.destination))
  const patchAlignment = useAppStore((s) => s.patchAlignment)
  const patchFilters = useAppStore((s) => s.patchAlignmentFilters)

  const engine = getEngine()
  const { camera, subject, geometry, manualDirection, los, losLoading, losSource, filters, pickMode, eyeHeight, selectedMatchId, frameOnSelect } = state

  const targetAz = geometry ? geometry.bearing : manualDirection?.azimuth ?? null
  const targetAlt = geometry ? geometry.elevationAngle : manualDirection?.altitude ?? null

  const timeZone = useMemo(
    () => (camera ? lookupTimeZone(camera.latitude, camera.longitude) : 'UTC'),
    [camera]
  )

  const effectiveEndDate = useMemo(() => {
    if (filters.rangePreset !== 'custom') return addDays(filters.startDate, RANGE_DAYS[filters.rangePreset])
    // Cap custom span at 5 years to keep synchronous search responsive.
    const maxEnd = addDays(filters.startDate, 365 * 5)
    return filters.endDate > maxEnd ? maxEnd : filters.endDate < filters.startDate ? filters.startDate : filters.endDate
  }, [filters.rangePreset, filters.startDate, filters.endDate])

  const searchResult = useMemo(() => {
    if (!camera || targetAz === null || targetAlt === null) return null
    return findAlignments({
      latitude: camera.latitude,
      longitude: camera.longitude,
      timeZone,
      targetAzimuth: targetAz,
      targetAltitude: targetAlt,
      startDate: filters.startDate,
      endDate: effectiveEndDate,
      bodies: filters.bodies,
      azimuthTolerance: filters.azimuthTolerance,
      altitudeTolerance: filters.altitudeTolerance,
      minMoonIllumination: filters.minMoonIllumination,
      moonSkyFilter: filters.moonSkyFilter
    })
  }, [
    camera,
    targetAz,
    targetAlt,
    timeZone,
    filters.startDate,
    effectiveEndDate,
    filters.bodies,
    filters.azimuthTolerance,
    filters.altitudeTolerance,
    filters.minMoonIllumination,
    filters.moonSkyFilter
  ])

  const lens = useMemo(() => lensView(vfSettings), [vfSettings])
  const selectedMatch = useMemo(
    () => searchResult?.matches.find((m) => m.id === selectedMatchId) ?? null,
    [searchResult, selectedMatchId]
  )
  const framing = useMemo(() => {
    if (!geometry || !(geometry.slopeDistance > 0)) return null
    const moonDeg = selectedMatch?.body === 'moon' ? selectedMatch.angularDiameterDeg : undefined
    return computeFramingCoverage(geometry.slopeDistance, lens, moonDeg)
  }, [geometry, lens, selectedMatch])

  const tzLabel = useMemo(() => {
    if (!camera) return 'UTC'
    const mid = zonedToUtc(filters.startDate, 720, timeZone)
    return zoneAbbreviation(mid, timeZone) || timeZone
  }, [camera, filters.startDate, timeZone])

  const selectMatch = (match: AlignmentMatch, forceFrame = false) => {
    patchAlignment({ selectedMatchId: match.id })
    engine?.sun.setInstant(match.utc, timeZone)
    if (forceFrame || frameOnSelect) void engine?.lookAlongAlignment()
  }

  const eyeValue = units === 'imperial' ? Number((eyeHeight * FEET_PER_METER).toFixed(1)) : Number(eyeHeight.toFixed(1))
  const setEyeFromUi = (val: number) => {
    if (!Number.isFinite(val) || val < 0) return
    engine?.alignment.setEyeHeight(units === 'imperial' ? val / FEET_PER_METER : val)
  }

  const setRangePreset = (preset: AlignmentRangePreset) => {
    if (preset === 'custom') {
      patchFilters({ rangePreset: 'custom', endDate: effectiveEndDate })
    } else {
      patchFilters({ rangePreset: preset, endDate: addDays(filters.startDate, RANGE_DAYS[preset]) })
    }
  }

  const setStartDate = (startDate: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return
    if (filters.rangePreset === 'custom') {
      patchFilters({ startDate, endDate: filters.endDate < startDate ? startDate : filters.endDate })
    } else {
      patchFilters({ startDate, endDate: addDays(startDate, RANGE_DAYS[filters.rangePreset]) })
    }
  }

  const canLook = !!(camera && (geometry || manualDirection))
  const canFrame = !!(camera || subject)

  return (
    <div
      className={`panel side-panel right alignment-panel ${elevationOpen ? 'shifted' : ''}`}
      role="region"
      aria-label="Shot alignment planner"
    >
      <div className="panel-header">
        <Icon name="alignment" size={15} style={{ color: 'var(--accent)', flex: 'none' }} />
        <span>Shot Alignment</span>
        <span className="spacer" />
        <button
          className="icon-btn small"
          disabled={!canLook}
          title="Stand at Camera pin looking toward Subject"
          aria-label="Look from camera toward subject"
          onClick={() => void engine?.lookAlongAlignment()}
        >
          <Icon name="person" size={14} />
        </button>
        <button
          className="icon-btn small"
          disabled={!canFrame}
          title="Frame Camera and Subject pins on the map"
          aria-label="Frame camera and subject"
          onClick={() => void engine?.frameAlignment()}
        >
          <Icon name="globe" size={14} />
        </button>
        <button
          className="icon-btn small"
          disabled={!canFrame && !manualDirection}
          title="Clear Camera and Subject pins"
          aria-label="Clear alignment pins"
          onClick={() => engine?.alignment.clearPins()}
        >
          <Icon name="trash" size={14} />
        </button>
        <button
          className="icon-btn small"
          title="Close Shot Alignment (X)"
          aria-label="Close shot alignment"
          onClick={() => engine?.alignment.close()}
        >
          <Icon name="close" size={14} />
        </button>
      </div>

      <div className="panel-body scroll">
        {/* ─── Camera & Subject Pins ─── */}
        <div className="section">
          <div className="align-pin-card">
            <div className="row" style={{ minHeight: 24 }}>
              <span className="align-dot camera" />
              <strong className="small">Camera</strong>
              <span className="spacer" />
              <button
                className={`btn small-btn ${pickMode === 'camera' ? 'primary' : ''}`}
                aria-pressed={pickMode === 'camera'}
                title="Click on the 3D map to place the Camera pin"
                onClick={() => engine?.alignment.setPickMode(pickMode === 'camera' ? null : 'camera')}
              >
                {pickMode === 'camera' ? 'Picking…' : 'Pick'}
              </button>
              {hasActivePin && (
                <button
                  className="btn ghost small-btn"
                  title="Use the current inspected point or search pin as Camera"
                  onClick={() => engine?.useActivePinForAlignment('camera')}
                >
                  Pin
                </button>
              )}
              <button
                className="btn ghost small-btn"
                title="Set Camera pin to the current view position"
                onClick={() => engine?.useCurrentCameraForAlignment()}
              >
                Here
              </button>
            </div>
            {camera ? (
              <div className="align-pin-meta mono small muted">
                {camera.label && <span className="align-pin-label">{camera.label} · </span>}
                {formatLatLon(camera.latitude, camera.longitude, coordFormat)} · {formatElevation(camera.msl, units)}
              </div>
            ) : (
              <div className="small faint">Click the map or use a pin to place the observer.</div>
            )}
            <div className="row align-eye-row">
              <label className="small muted" htmlFor="align-eye-height">
                Eye / tripod
              </label>
              <input
                id="align-eye-height"
                className="input mono align-num"
                type="number"
                min={0}
                max={units === 'imperial' ? 1640 : 500}
                step={0.1}
                value={eyeValue}
                onChange={(e) => setEyeFromUi(Number(e.target.value))}
              />
              <span className="small faint">{units === 'imperial' ? 'ft' : 'm'}</span>
              <span className="spacer" />
              {[1.7, 3, 10].map((m) => (
                <button
                  key={m}
                  className={`btn ghost tiny-btn mono ${Math.abs(eyeHeight - m) < 0.05 ? 'active' : ''}`}
                  title={`Set camera height above ground to ${m} m`}
                  onClick={() => engine?.alignment.setEyeHeight(m)}
                >
                  {units === 'imperial' ? `${Math.round(m * FEET_PER_METER)}ft` : `${m}m`}
                </button>
              ))}
            </div>
          </div>

          <div className="align-pin-card" style={{ marginTop: 6 }}>
            <div className="row" style={{ minHeight: 24 }}>
              <span className="align-dot subject" />
              <strong className="small">Subject</strong>
              <span className="spacer" />
              {(camera || subject) && (
                <button
                  className="icon-btn small"
                  title="Swap Camera and Subject pins"
                  aria-label="Swap camera and subject"
                  onClick={() => engine?.alignment.swapPins()}
                >
                  <Icon name="swap" size={13} />
                </button>
              )}
              <button
                className={`btn small-btn ${pickMode === 'subject' ? 'primary' : ''}`}
                aria-pressed={pickMode === 'subject'}
                title="Click on the 3D map to place the Subject pin"
                onClick={() => engine?.alignment.setPickMode(pickMode === 'subject' ? null : 'subject')}
              >
                {pickMode === 'subject' ? 'Picking…' : 'Pick'}
              </button>
              {hasActivePin && (
                <button
                  className="btn ghost small-btn"
                  title="Use the current inspected point or search pin as Subject"
                  onClick={() => engine?.useActivePinForAlignment('subject')}
                >
                  Pin
                </button>
              )}
            </div>
            {subject ? (
              <div className="align-pin-meta mono small muted">
                {subject.label && <span className="align-pin-label">{subject.label} · </span>}
                {formatLatLon(subject.latitude, subject.longitude, coordFormat)} · {formatElevation(subject.msl, units)}
              </div>
            ) : manualDirection ? (
              <div className="align-pin-meta mono small muted">
                Horizon direction · {manualDirection.azimuth.toFixed(1)}° {compassPoint(manualDirection.azimuth)} · elev {signedDeg(manualDirection.altitude)}
              </div>
            ) : (
              <div className="small faint">Click a peak, building, or landmark on the map.</div>
            )}
          </div>
        </div>

        {/* ─── Geometry, LOS & Apparent Disc Size ─── */}
        {geometry && (
          <div className="section">
            <div className="align-metrics">
              <div className="align-metric" title={`True bearing from Camera to Subject. Reverse bearing (Subject → Camera): ${geometry.reverseBearing.toFixed(1)}° ${compassPoint(geometry.reverseBearing)}`}>
                <span className="k">Bearing</span>
                <span className="v mono">
                  {geometry.bearing.toFixed(1)}° {compassPoint(geometry.bearing)}
                </span>
                <span className="sub mono faint">
                  ← {geometry.reverseBearing.toFixed(1)}° {compassPoint(geometry.reverseBearing)}
                </span>
              </div>
              <div className="align-metric" title="Apparent elevation angle including Earth curvature and terrestrial refraction (k = 0.13), matching Sun/Moon apparent altitudes">
                <span className="k">Elevation</span>
                <span className="v mono">{signedDeg(geometry.elevationAngle, 2)}</span>
                <span className="sub faint">curv + refr k=0.13</span>
              </div>
              <div className="align-metric" title="Horizontal great-circle distance and 3D straight-line slope distance">
                <span className="k">Distance</span>
                <span className="v mono">{formatDistance(geometry.horizontalDistance, units)}</span>
                <span className="sub mono faint">slope {formatDistance(geometry.slopeDistance, units)}</span>
              </div>
              <div className="align-metric" title="Subject height minus Camera eye height">
                <span className="k">Elev Δ</span>
                <span className="v mono">{signedElev(geometry.elevationDiff, units)}</span>
                <span className="sub mono faint">eye {formatElevation(geometry.eyeHeightMsl, units)}</span>
              </div>
            </div>

            {/* Line-of-sight readout */}
            <div className={`align-los ${losLoading ? 'loading' : los?.status ?? 'unknown'}`} role="status">
              {losLoading ? (
                <span>Checking line of sight…</span>
              ) : los?.status === 'clear' ? (
                <>
                  <span className="badge ok">
                    <Icon name="check" size={12} /> Clear
                  </span>
                  <span className="small muted mono">
                    min {formatElevation(los.minClearance, units)} at {formatDistance(los.minClearanceDistance ?? 0, units)}
                  </span>
                  {losSource && <span className="small faint align-los-src">{losSource}</span>}
                </>
              ) : los?.status === 'obstructed' && los.obstruction ? (
                <>
                  <span className="badge error">
                    <Icon name="warning" size={12} /> Obstructed
                  </span>
                  <span className="small mono">
                    +{formatElevation(los.obstruction.intrusion, units)} at {formatDistance(los.obstruction.distance, units)}
                  </span>
                  {losSource && <span className="small faint align-los-src">{losSource}</span>}
                </>
              ) : (
                <span className="small faint">Line of sight needs terrain or 3D tiles.</span>
              )}
            </div>

            {/* Sun / Moon disc size & Viewfinder lens coverage */}
            <div className="align-disc-box">
              <div className="row" style={{ minHeight: 20 }}>
                <span className="small muted">Sun / Moon disc at subject</span>
                <span className="spacer" />
                <span className="mono small">
                  {formatLinearSize(geometry.sunDiscWidthM, units)}
                </span>
              </div>
              <div className="small faint mono">
                Moon {formatLinearSize(geometry.moonDiscMinM, units)}–{formatLinearSize(geometry.moonDiscMaxM, units)} (apogee–perigee)
              </div>
              {framing && (
                <div className={`align-framing ${vfActive ? 'active' : ''}`}>
                  <div className="row" style={{ minHeight: 20 }}>
                    <span className="small muted">
                      {formatFocal(vfSettings.focalLength)} {lens.sensor.short} frame
                    </span>
                    <span className="spacer" />
                    <button
                      className="link-btn small"
                      onClick={() => appState().set({ viewfinder: !vfActive })}
                      title="Toggle the Viewfinder lens frame overlay (V)"
                    >
                      {vfActive ? 'Hide VF' : 'Viewfinder'}
                    </button>
                  </div>
                  <div className="mono small">
                    {formatLinearSize(framing.frameWidthM, units)} × {formatLinearSize(framing.frameHeightM, units)} · disc{' '}
                    <strong>{framing.sunHeightPct.toFixed(1)}%</strong> H ({framing.sunWidthPct.toFixed(1)}% W)
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ─── Reverse Ephemeris Alignment Finder ─── */}
        <div className="section">
          <div className="row" style={{ minHeight: 24, marginBottom: 6 }}>
            <strong className="small">Sun & Moon Alignments</strong>
            <span className="spacer" />
            {camera && <span className="small faint mono">{tzLabel}</span>}
          </div>

          <div className="align-filters">
            <div className="row">
              <div className="segmented grow" role="group" aria-label="Celestial body">
                {(['both', 'sun', 'moon'] as AlignmentBodyFilter[]).map((b) => (
                  <button
                    key={b}
                    className={`grow ${filters.bodies === b ? 'active' : ''}`}
                    aria-pressed={filters.bodies === b}
                    onClick={() => patchFilters({ bodies: b })}
                  >
                    {b === 'both' ? 'Both' : b === 'sun' ? 'Sun' : 'Moon'}
                  </button>
                ))}
              </div>
              <select
                className="input small"
                aria-label="Date range"
                value={filters.rangePreset}
                onChange={(e) => setRangePreset(e.target.value as AlignmentRangePreset)}
                style={{ width: 106 }}
              >
                <option value="30d">Next 30 d</option>
                <option value="90d">Next 90 d</option>
                <option value="1y">Next 1 yr</option>
                <option value="2y">Next 2 yr</option>
                <option value="custom">Custom…</option>
              </select>
            </div>

            <div className="row align-date-row">
              <label className="small muted" htmlFor="align-start-date">
                From
              </label>
              <input
                id="align-start-date"
                className="input mono small grow"
                type="date"
                value={filters.startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
              {filters.rangePreset === 'custom' && (
                <>
                  <label className="small muted" htmlFor="align-end-date">
                    to
                  </label>
                  <input
                    id="align-end-date"
                    className="input mono small grow"
                    type="date"
                    value={effectiveEndDate}
                    min={filters.startDate}
                    max={addDays(filters.startDate, 365 * 5)}
                    onChange={(e) => /^\d{4}-\d{2}-\d{2}$/.test(e.target.value) && patchFilters({ endDate: e.target.value })}
                  />
                </>
              )}
            </div>

            <div className="row align-tol-row">
              <label className="small muted" htmlFor="align-az-tol">
                Az ±
              </label>
              <input
                id="align-az-tol"
                className="input mono align-num"
                type="number"
                min={0.1}
                max={15}
                step={0.1}
                value={filters.azimuthTolerance}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  if (Number.isFinite(v) && v >= 0.1 && v <= 15) patchFilters({ azimuthTolerance: v })
                }}
              />
              <span className="small faint">°</span>
              <label className="small muted" htmlFor="align-alt-tol" style={{ marginLeft: 8 }}>
                Alt ±
              </label>
              <input
                id="align-alt-tol"
                className="input mono align-num"
                type="number"
                min={0.1}
                max={15}
                step={0.1}
                value={filters.altitudeTolerance}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  if (Number.isFinite(v) && v >= 0.1 && v <= 15) patchFilters({ altitudeTolerance: v })
                }}
              />
              <span className="small faint">°</span>
            </div>

            {filters.bodies !== 'sun' && (
              <div className="row align-moon-filters">
                <label className="small muted" htmlFor="align-moon-illum">
                  Moon ≥
                </label>
                <select
                  id="align-moon-illum"
                  className="input small mono"
                  value={filters.minMoonIllumination}
                  onChange={(e) => patchFilters({ minMoonIllumination: Number(e.target.value) })}
                  style={{ width: 72 }}
                >
                  {ILLUM_PRESETS.map((p) => (
                    <option key={p} value={p}>
                      {p === 0 ? 'Any' : `${p}%`}
                    </option>
                  ))}
                </select>
                <select
                  className="input small grow"
                  aria-label="Moon twilight and sun altitude filter"
                  value={filters.moonSkyFilter}
                  onChange={(e) => patchFilters({ moonSkyFilter: e.target.value as MoonSkyFilter })}
                >
                  {SKY_FILTER_OPTIONS.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="row" style={{ minHeight: 22 }}>
              <label className="switch small muted">
                <input
                  type="checkbox"
                  checked={frameOnSelect}
                  onChange={(e) => patchAlignment({ frameOnSelect: e.target.checked })}
                />
                Frame shot on click
              </label>
              <span className="spacer" />
              {searchResult && (
                <span className="small muted mono">
                  {searchResult.matches.length}
                  {searchResult.truncated ? '+' : ''} {searchResult.matches.length === 1 ? 'match' : 'matches'}
                </span>
              )}
            </div>
          </div>

          {/* Results list */}
          {!searchResult ? (
            <div className="small faint align-empty">
              Place both Camera and Subject pins (or send a direction from Horizon Panorama) to find Sun and Moon alignment dates.
            </div>
          ) : searchResult.matches.length === 0 ? (
            <div className="small muted align-empty">
              {filters.bodies === 'sun' && searchResult.unreachable.sun ? (
                'The Sun never reaches this bearing and elevation angle at this latitude.'
              ) : filters.bodies === 'moon' && searchResult.unreachable.moon ? (
                'The Moon never reaches this bearing and elevation angle at this latitude.'
              ) : filters.bodies === 'both' && searchResult.unreachable.sun && searchResult.unreachable.moon ? (
                'Neither the Sun nor the Moon reaches this bearing and elevation angle at this latitude.'
              ) : (
                'No alignments in this range with the current tolerances and filters. Try widening the range, tolerance, or Moon sky filter.'
              )}
            </div>
          ) : (
            <div className="align-results" role="list" aria-label="Alignment dates">
              {searchResult.matches.map((m) => {
                const active = m.id === selectedMatchId
                return (
                  <div key={m.id} className={`align-result ${active ? 'active' : ''}`} role="listitem">
                    <button
                      className="align-result-main"
                      onClick={() => selectMatch(m)}
                      title={`Set simulation to ${formatLongDate(m.date)} ${formatClock(m.minutes, true)} (${tzLabel})`}
                    >
                      <span className="align-body-icon" aria-hidden="true">
                        {m.body === 'sun' ? (
                          <span className="align-sun-dot" />
                        ) : (
                          <MoonDisc
                            illumination={m.moonIllumination ?? 0.5}
                            brightLimb={m.moonBrightLimb ?? 90}
                            size={16}
                            label={`${m.moonPhaseName ?? 'Moon'}, ${Math.round((m.moonIllumination ?? 0) * 100)}%`}
                          />
                        )}
                      </span>
                      <span className="align-result-info">
                        <span className="align-result-top">
                          <span className="align-result-date">{formatLongDate(m.date)}</span>
                          <span className="mono align-result-time">{formatClock(m.minutes, true)}</span>
                        </span>
                        <span className="align-result-sub small muted">
                          <span className="mono">
                            Δaz {signedDeg(m.deltaAz, 1)} · Δalt {signedDeg(m.deltaAlt, 1)}
                          </span>
                          {m.body === 'moon' && m.moonIllumination !== undefined && (
                            <>
                              <span>·</span>
                              <span className="mono">{Math.round(m.moonIllumination * 100)}%</span>
                              <span className={`align-sky-pill ${m.skyBand}`}>{SKY_BAND_LABEL[m.skyBand]}</span>
                            </>
                          )}
                        </span>
                      </span>
                    </button>
                    <button
                      className="icon-btn small align-result-look"
                      title="Set time and stand at Camera pin looking toward Subject"
                      aria-label={`Frame shot for ${m.date} ${formatClock(m.minutes)}`}
                      onClick={() => selectMatch(m, true)}
                    >
                      <Icon name="person" size={13} />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
