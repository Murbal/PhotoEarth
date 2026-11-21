import { describe, expect, it } from 'vitest'
import {
  angularDiameterDeg,
  apparentDiscSize,
  apparentElevationAngle,
  computeAlignmentGeometry,
  computeFramingCoverage,
  DEFAULT_EYE_HEIGHT,
  destinationPoint,
  evaluateLineOfSight,
  findAlignments,
  geometricElevationAngle,
  initialBearing,
  matchesMoonSkyFilter,
  MOON_MEAN_DIAMETER_DEG,
  MOON_RADIUS_KM,
  reverseBearing,
  sightlineRayHeight,
  skySeparation,
  SUN_MEAN_DIAMETER_DEG,
  type AlignmentPin,
  type LineOfSightSample
} from '@renderer/lib/alignment'
import { lensView } from '@renderer/lib/lens'
import { moonPosition, moonState } from '@renderer/lib/moon'
import { apparentAltitude, azDelta } from '@renderer/lib/panorama'
import { densifyPath } from '@renderer/lib/profile'
import { geometricAltitude, sunPosition } from '@renderer/lib/sun'
import { EARTH_RADIUS, REFRACTION_K } from '@renderer/lib/terrainShadow'
import { utcToZoned, zonedToUtc } from '@renderer/lib/time'
import { defaultViewfinder } from '@shared/settings'

const DEG = 180 / Math.PI
const C = (1 - REFRACTION_K) / (2 * EARTH_RADIUS)

describe('alignment geometry', () => {
  it('computes cardinal bearings, reverse bearings, and destinationPoint round-trip', () => {
    const origin = { latitude: 46.5, longitude: 7.9 }
    for (const brng of [0, 45, 90, 135, 180, 225, 270, 315]) {
      const dest = destinationPoint(origin, brng, 10_000)
      expect(Math.abs(azDelta(initialBearing(origin, dest), brng))).toBeLessThan(0.01)
      // At 10 km mid-latitude, back azimuth differs slightly from brng + 180° by meridian convergence (~0.05°).
      const rev = reverseBearing(origin, dest)
      expect(Math.abs(azDelta(rev, (brng + 180) % 360))).toBeLessThan(0.15)
    }
    // High latitude meridian convergence: going east along a great circle bends south, so reverse bearing != 270°.
    const arctic = { latitude: 70, longitude: 10 }
    const east200km = destinationPoint(arctic, 90, 200_000)
    const rev = reverseBearing(arctic, east200km)
    expect(rev).toBeGreaterThan(272)
    expect(rev).toBeLessThan(278)
  })

  it('matches lib/panorama.ts apparentAltitude with Earth curvature and k = 0.13 refraction', () => {
    for (const [eye, target, dist] of [
      [1000, 2500, 10_000],
      [1.7, 0, 30_000],
      [400, 400, 50_000],
      [2000, 1200, 15_000]
    ]) {
      const a = apparentElevationAngle(eye, target, dist)
      const p = apparentAltitude(eye, dist, 0, target)
      expect(a).toBeCloseTo(p, 10)
      // Unrefracted geometric angle is always lower than refracted apparent angle by k*d/(2R) rad.
      const g = geometricElevationAngle(eye, target, dist)
      expect(a).toBeGreaterThan(g)
      expect(a - g).toBeCloseTo(((REFRACTION_K * dist) / (2 * EARTH_RADIUS)) * DEG, 2)
    }
  })

  it('computes full Camera → Subject geometry, eye height, and Sun/Moon disc widths', () => {
    const cam: AlignmentPin = { latitude: 46.55, longitude: 7.9, groundHeight: 800, msl: 752 }
    const subPt = destinationPoint(cam, 120, 10_000)
    const sub: AlignmentPin = { latitude: subPt.latitude, longitude: subPt.longitude, groundHeight: 1801.7, msl: 1753.7 }
    const geom = computeAlignmentGeometry(cam, sub, DEFAULT_EYE_HEIGHT)

    expect(geom.bearing).toBeCloseTo(120, 1)
    expect(geom.horizontalDistance).toBeCloseTo(10_000, -1)
    expect(geom.elevationDiff).toBeCloseTo(1000, 1)
    expect(geom.slopeDistance).toBeCloseTo(Math.hypot(10_000, 1000), -1)
    expect(geom.eyeHeightEllipsoid).toBeCloseTo(801.7, 4)
    expect(geom.eyeHeightMsl).toBeCloseTo(753.7, 4)
    expect(geom.elevationAngle).toBeCloseTo(Math.atan(1000 / 10_000 - 10_000 * C) * DEG, 3)

    // Sun disc ~0.533° at ~10.05 km is ~93.5 m wide.
    expect(geom.sunDiscWidthM).toBeCloseTo(apparentDiscSize(geom.slopeDistance, SUN_MEAN_DIAMETER_DEG), 6)
    expect(geom.sunDiscWidthM).toBeGreaterThan(90)
    expect(geom.sunDiscWidthM).toBeLessThan(97)
    expect(geom.moonDiscMinM).toBeLessThan(geom.moonDiscWidthM)
    expect(geom.moonDiscMaxM).toBeGreaterThan(geom.moonDiscWidthM)
    expect(angularDiameterDeg(MOON_RADIUS_KM, 384_400)).toBeCloseTo(MOON_MEAN_DIAMETER_DEG, 2)
  })

  it('computes Viewfinder lens framing coverage at subject distance', () => {
    const vf = defaultViewfinder()
    vf.focalLength = 200
    const lens = lensView(vf)
    const cov = computeFramingCoverage(10_000, lens)
    // 200 mm on 36x24 mm full-frame at 10 km covers 1800 m x 1200 m (rectilinear: d * sensor / f).
    expect(cov.frameWidthM).toBeCloseTo(1800, 0)
    expect(cov.frameHeightM).toBeCloseTo(1200, 0)
    // 93 m Sun disc is ~7.75% of 1200 m frame height and ~5.17% of 1800 m frame width.
    expect(cov.sunHeightPct).toBeCloseTo(7.75, 1)
    expect(cov.sunWidthPct).toBeCloseTo(5.17, 1)
  })
})

describe('line-of-sight evaluation', () => {
  const cam: AlignmentPin = { latitude: 46.5, longitude: 7.9, groundHeight: 1000, msl: 1000 }
  const subPt = destinationPoint(cam, 90, 10_000)
  const sub: AlignmentPin = { latitude: subPt.latitude, longitude: subPt.longitude, groundHeight: 1500, msl: 1500 }

  it('reports clear over a valley and finds minimum clearance', () => {
    const path = densifyPath([cam, sub], 101)
    const samples: LineOfSightSample[] = path.map((p) => {
      const t = p.distance / 10_000
      // Terrain dips 200 m below the straight line in the valley middle.
      const valley = 1000 + 500 * t - 200 * Math.sin(Math.PI * t)
      return { ...p, height: valley }
    })
    const los = evaluateLineOfSight(1001.7, 1500, 10_000, samples)
    expect(los.status).toBe('clear')
    expect(los.obstruction).toBeNull()
    expect(los.minClearance).toBeGreaterThan(0)
    expect(los.sampleCount).toBeGreaterThan(90)
  })

  it('detects a ridge obstruction with accurate distance and intrusion height', () => {
    const path = densifyPath([cam, sub], 201)
    const ridgeDist = 4000
    const rayAtRidge = sightlineRayHeight(1001.7, 1500, 10_000, ridgeDist)
    const samples: LineOfSightSample[] = path.map((p) => {
      const bump = 120 * Math.exp(-(((p.distance - ridgeDist) / 300) ** 2))
      const base = sightlineRayHeight(1001.7, 1500, 10_000, p.distance) - 40
      return { ...p, height: base + bump }
    })
    const los = evaluateLineOfSight(1001.7, 1500, 10_000, samples)
    expect(los.status).toBe('obstructed')
    expect(los.obstruction).not.toBeNull()
    expect(los.obstruction!.distance).toBeCloseTo(ridgeDist, -2)
    expect(los.obstruction!.intrusion).toBeCloseTo(80, 0)
    expect(los.obstruction!.rayHeight).toBeCloseTo(rayAtRidge, 0)
    expect(los.minClearance).toBeCloseTo(-80, 0)
  })

  it('detects Earth curvature bulge over long flat distances and clears when eye height rises', () => {
    // 50 km across flat sea level: curvature bulge at midpoint (25 km) with k = 0.13 is
    // c * d*(D-d) = (0.87 / (2 * 6371000)) * 25000 * 25000 ≈ 42.67 m!
    const seaA = { latitude: 0, longitude: 0 }
    const seaB = destinationPoint(seaA, 90, 50_000)
    const path = densifyPath([seaA, seaB], 101)
    const flatSamples: LineOfSightSample[] = path.map((p) => ({ ...p, height: 0 }))

    const low = evaluateLineOfSight(1.7, 5, 50_000, flatSamples)
    expect(low.status).toBe('obstructed')
    const expectedBulge = C * 25_000 * 25_000
    // At midpoint, ray height without bulge is (1.7 + 5)/2 = 3.35 m; minus bulge ≈ -39.3 m.
    expect(low.obstruction!.intrusion).toBeCloseTo(expectedBulge - 3.35, 0)

    // Optical horizon sum for 100 m + 5 m is ~46.8 km (< 50 km), so 100 m is still grazed near 38 km;
    // raising the camera to 160 m gives horizon sum ~57.0 km (> 50 km) and clears cleanly.
    const high = evaluateLineOfSight(160, 5, 50_000, flatSamples)
    expect(high.status).toBe('clear')
    expect(high.minClearance).toBeGreaterThan(2)
  })

  it('returns unknown when all interior samples are missing', () => {
    const los = evaluateLineOfSight(100, 200, 1000, [
      { latitude: 0, longitude: 0, distance: 0, height: 100 },
      { latitude: 0, longitude: 0.005, distance: 500, height: null },
      { latitude: 0, longitude: 0.01, distance: 1000, height: 200 }
    ])
    expect(los.status).toBe('unknown')
    expect(los.sampleCount).toBe(0)
  })
})

describe('reverse Sun & Moon alignment search', () => {
  it('recovers known Sun alignment instants to within seconds and finds both annual dates', () => {
    // New York City (Manhattanhenge-like sunset direction in late May & mid July).
    const lat = 40.758
    const lon = -73.9855
    const tz = 'America/New_York'
    // Exact Sun position on 2026-05-30 at 20:05 local EDT.
    const targetUtc = zonedToUtc('2026-05-30', 20 * 60 + 5, tz)
    const pos = sunPosition(targetUtc, lat, lon)

    const res = findAlignments({
      latitude: lat,
      longitude: lon,
      timeZone: tz,
      targetAzimuth: pos.azimuth,
      targetAltitude: pos.altitude,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      bodies: 'sun',
      azimuthTolerance: 0.3,
      altitudeTolerance: 0.3
    })

    expect(res.unreachable.sun).toBe(false)
    // Should find the late-May cluster AND the symmetric mid-July cluster.
    const mayMatch = res.matches.find((m) => m.date === '2026-05-30')
    expect(mayMatch).toBeDefined()
    expect(Math.abs(mayMatch!.utc - targetUtc)).toBeLessThan(15_000)
    expect(mayMatch!.angularError).toBeLessThan(0.05)

    const julyMatch = res.matches.find((m) => m.date.startsWith('2026-07-'))
    expect(julyMatch).toBeDefined()
    expect(Math.abs(julyMatch!.deltaAz)).toBeLessThanOrEqual(0.3)
    expect(Math.abs(julyMatch!.deltaAlt)).toBeLessThanOrEqual(0.3)
  })

  it('recovers known Moon alignment instants with accurate phase, illumination and angular error', () => {
    // Lauterbrunnen / Jungfrau region, Switzerland.
    const lat = 46.5935
    const lon = 7.9091
    const tz = 'Europe/Zurich'
    // Pick an instant when the Moon is above the horizon near full moon (2026-05-01 full moon).
    const probeUtc = zonedToUtc('2026-05-01', 21 * 60 + 30, tz)
    const actual = moonState(probeUtc, lat, lon)

    const res = findAlignments({
      latitude: lat,
      longitude: lon,
      timeZone: tz,
      targetAzimuth: actual.azimuth,
      targetAltitude: actual.altitude,
      startDate: '2026-04-20',
      endDate: '2026-06-15',
      bodies: 'moon',
      azimuthTolerance: 0.5,
      altitudeTolerance: 0.5
    })

    const match = res.matches.find((m) => m.date === '2026-05-01')
    expect(match).toBeDefined()
    expect(Math.abs(match!.utc - probeUtc)).toBeLessThan(15_000)
    expect(match!.angularError).toBeLessThan(0.05)
    expect(match!.moonIllumination).toBeCloseTo(actual.illumination, 2)
    expect(match!.moonPhaseName).toBe(actual.phaseName)
    expect(match!.moonDistanceKm).toBeCloseTo(actual.distanceKm, -1)
    expect(match!.angularDiameterDeg).toBeGreaterThan(0.48)
    expect(match!.angularDiameterDeg).toBeLessThan(0.57)
  })

  it('enforces Moon illumination and twilight/sun-altitude filters accurately', () => {
    const lat = 46.55
    const lon = 7.9
    const tz = 'Europe/Zurich'
    // Search a full year for an eastern low-elevation target (classic moonrise direction).
    const allMoon = findAlignments({
      latitude: lat,
      longitude: lon,
      timeZone: tz,
      targetAzimuth: 100,
      targetAltitude: 4,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      bodies: 'moon',
      azimuthTolerance: 2.0,
      altitudeTolerance: 1.5
    })
    expect(allMoon.matches.length).toBeGreaterThan(5)

    const brightOnly = findAlignments({
      latitude: lat,
      longitude: lon,
      timeZone: tz,
      targetAzimuth: 100,
      targetAltitude: 4,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      bodies: 'moon',
      azimuthTolerance: 2.0,
      altitudeTolerance: 1.5,
      minMoonIllumination: 85
    })
    expect(brightOnly.matches.length).toBeLessThan(allMoon.matches.length)
    for (const m of brightOnly.matches) {
      expect((m.moonIllumination ?? 0) * 100).toBeGreaterThanOrEqual(84.999)
    }

    const goldenBlue = findAlignments({
      latitude: lat,
      longitude: lon,
      timeZone: tz,
      targetAzimuth: 100,
      targetAltitude: 4,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      bodies: 'moon',
      azimuthTolerance: 2.0,
      altitudeTolerance: 1.5,
      moonSkyFilter: 'golden-blue'
    })
    for (const m of goldenBlue.matches) {
      const sunAlt = geometricAltitude(m.utc, lat, lon)
      expect(matchesMoonSkyFilter(sunAlt, 'golden-blue')).toBe(true)
      expect(sunAlt).toBeGreaterThanOrEqual(-6)
      expect(sunAlt).toBeLessThanOrEqual(6)
    }

    const nightOnly = findAlignments({
      latitude: lat,
      longitude: lon,
      timeZone: tz,
      targetAzimuth: 100,
      targetAltitude: 4,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      bodies: 'moon',
      azimuthTolerance: 2.0,
      altitudeTolerance: 1.5,
      moonSkyFilter: 'night'
    })
    for (const m of nightOnly.matches) {
      expect(m.sunAltitude).toBeLessThan(-18)
      expect(m.skyBand).toBe('night')
    }
  })

  it('handles DST transitions and multiple time zones (including quarter-hour offsets) without missing or duplicating events', () => {
    const cases: Array<{ name: string; lat: number; lon: number; tz: string; date: string; minutes: number }> = [
      // US spring-forward DST day (2026-03-08, 23-hour day)
      { name: 'New York spring DST', lat: 40.7128, lon: -74.006, tz: 'America/New_York', date: '2026-03-08', minutes: 17 * 60 + 30 },
      // US fall-back DST day (2026-11-01, 25-hour day)
      { name: 'New York fall DST', lat: 40.7128, lon: -74.006, tz: 'America/New_York', date: '2026-11-01', minutes: 7 * 60 + 15 },
      // Europe fall-back DST day (2026-10-25)
      { name: 'Zurich fall DST', lat: 47.3769, lon: 8.5417, tz: 'Europe/Zurich', date: '2026-10-25', minutes: 16 * 60 + 30 },
      // Southern hemisphere DST (Sydney, spring forward 2026-10-04)
      { name: 'Sydney spring DST', lat: -33.8688, lon: 151.2093, tz: 'Australia/Sydney', date: '2026-10-04', minutes: 6 * 60 + 45 },
      // Non-integer UTC offset (+12:45 / +13:45)
      { name: 'Chatham Islands', lat: -43.95, lon: -176.55, tz: 'Pacific/Chatham', date: '2026-04-05', minutes: 17 * 60 + 10 },
      // Asia/Tokyo (no DST)
      { name: 'Tokyo', lat: 35.6762, lon: 139.6503, tz: 'Asia/Tokyo', date: '2026-06-21', minutes: 5 * 60 + 30 }
    ]

    for (const c of cases) {
      const exactUtc = zonedToUtc(c.date, c.minutes, c.tz)
      const sun = sunPosition(exactUtc, c.lat, c.lon)
      const res = findAlignments({
        latitude: c.lat,
        longitude: c.lon,
        timeZone: c.tz,
        targetAzimuth: sun.azimuth,
        targetAltitude: sun.altitude,
        startDate: c.date,
        endDate: c.date,
        bodies: 'sun',
        azimuthTolerance: 0.4,
        altitudeTolerance: 0.4
      })
      expect(res.matches, c.name).toHaveLength(1)
      const m = res.matches[0]
      expect(Math.abs(m.utc - exactUtc), c.name).toBeLessThan(15_000)
      const expectedZoned = utcToZoned(m.utc, c.tz)
      expect(m.date, c.name).toBe(c.date)
      expect(m.minutes, c.name).toBeCloseTo(expectedZoned.minutes, 4)
    }
  })

  it('flags unreachable directions cleanly and returns 0 matches', () => {
    // At 47°N, due North at +45° altitude has declination +88° (near Polaris) — neither Sun nor Moon ever reaches it.
    const res = findAlignments({
      latitude: 47,
      longitude: 8,
      timeZone: 'Europe/Zurich',
      targetAzimuth: 0,
      targetAltitude: 45,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      bodies: 'both',
      azimuthTolerance: 1,
      altitudeTolerance: 1
    })
    expect(res.unreachable).toEqual({ sun: true, moon: true })
    expect(res.matches).toHaveLength(0)
  })

  it('finds high-latitude midnight sun alignments above the Arctic Circle', () => {
    // Tromsø, Norway: midnight sun around June 21 due north.
    const lat = 69.6492
    const lon = 18.9553
    const tz = 'Europe/Oslo'
    const midnightUtc = zonedToUtc('2026-06-21', 0 * 60 + 45, tz)
    const pos = sunPosition(midnightUtc, lat, lon)
    expect(pos.altitude).toBeGreaterThan(0)

    const res = findAlignments({
      latitude: lat,
      longitude: lon,
      timeZone: tz,
      targetAzimuth: pos.azimuth,
      targetAltitude: pos.altitude,
      startDate: '2026-06-15',
      endDate: '2026-06-28',
      bodies: 'sun',
      azimuthTolerance: 0.5,
      altitudeTolerance: 0.5
    })
    const hit = res.matches.find((m) => m.date === '2026-06-21')
    expect(hit).toBeDefined()
    expect(Math.abs(hit!.utc - midnightUtc)).toBeLessThan(30_000)
    expect(skySeparation(hit!.azimuth, hit!.altitude, pos.azimuth, pos.altitude)).toBeLessThan(0.1)
  })

  it('searches a full year for both Sun and Moon quickly and keeps all matches within tolerance', () => {
    const t0 = performance.now()
    const res = findAlignments({
      latitude: 37.7749,
      longitude: -122.4194,
      timeZone: 'America/Los_Angeles',
      targetAzimuth: 255,
      targetAltitude: 3.5,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      bodies: 'both',
      azimuthTolerance: 1.0,
      altitudeTolerance: 0.8
    })
    const elapsedMs = performance.now() - t0
    expect(elapsedMs).toBeLessThan(1000)
    expect(res.matches.length).toBeGreaterThan(4)
    expect(res.matches.some((m) => m.body === 'sun')).toBe(true)
    expect(res.matches.some((m) => m.body === 'moon')).toBe(true)
    for (let i = 0; i < res.matches.length; i++) {
      const m = res.matches[i]
      expect(Math.abs(m.deltaAz)).toBeLessThanOrEqual(1.0)
      expect(Math.abs(m.deltaAlt)).toBeLessThanOrEqual(0.8)
      if (i > 0) expect(m.utc).toBeGreaterThanOrEqual(res.matches[i - 1].utc)
      // Verify reported position agrees with direct ephemeris call.
      const check = m.body === 'sun' ? sunPosition(m.utc, 37.7749, -122.4194) : moonPosition(m.utc, 37.7749, -122.4194)
      expect(Math.abs(azDelta(check.azimuth, m.azimuth))).toBeLessThan(1e-6)
      expect(check.altitude).toBeCloseTo(m.altitude, 6)
    }
  })
})
