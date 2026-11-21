import { describe, expect, it } from 'vitest'
import { aggregateCities, buildNearbyBody, CITIES_MAX_SPAN_DEG, NEARBY_KINDS, parseNearby } from '@shared/places'
import {
  cellAt,
  cellsAround,
  cellsForView,
  comparePriority,
  declutter,
  distanceMeters,
  mergeResults,
  minRangeOf,
  RANGE_FACTOR,
  rangeOf,
  RateLimiter,
  REGION_TIERS,
  regionCellsForView,
  TIERS,
  tiersForDistance,
  type KnownPlace
} from '@renderer/lib/placeLabels'

const place = (id: string, name: string, latitude: number, longitude: number, seat: 0 | 1 | 2 = 0) => ({
  id,
  name,
  location: { latitude, longitude },
  seat
})

describe('query cells', () => {
  it('snaps nearby points to the same cell, and the query circle covers the whole cell', () => {
    const a = cellAt('locality', 6000, 46.6801, 7.8601)
    const b = cellAt('locality', 6000, 46.6805, 7.8608)
    expect(a.key).toBe(b.key)
    // Every corner of the cell is inside the circle.
    const half = 6000 / 2
    for (const [dy, dx] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
      const corner = {
        latitude: a.center.latitude + (dy * half) / 110540,
        longitude: a.center.longitude + (dx * half) / (111320 * Math.cos((a.center.latitude * Math.PI) / 180))
      }
      expect(distanceMeters(a.center, corner)).toBeLessThan(a.radius)
    }
  })

  it('keeps kinds and tiers apart', () => {
    expect(cellAt('locality', 6000, 46.68, 7.86).key).not.toBe(cellAt('mountain_peak', 6000, 46.68, 7.86).key)
    expect(cellAt('locality', 6000, 46.68, 7.86).key).not.toBe(cellAt('locality', 15000, 46.68, 7.86).key)
  })

  it('picks the finest tier that reaches the view center, plus one coarser', () => {
    expect(tiersForDistance(1000)).toEqual([TIERS[0], TIERS[1]])
    expect(tiersForDistance(TIERS[1] * RANGE_FACTOR)).toEqual([TIERS[1], TIERS[2]])
    // The widest views still get a smaller query at their center.
    expect(tiersForDistance(TIERS[3] * RANGE_FACTOR)).toEqual([TIERS[2], TIERS[3]])
    expect(tiersForDistance(1e7)).toEqual([TIERS[2], TIERS[3]])
  })

  it('queries the 2×2 coarse block around the center first, then the fine cell', () => {
    const target = { latitude: 46.68, longitude: 7.86 }
    const cells = cellsForView(target, 4000, ['locality', 'mountain_peak'])
    expect(cells.map((c) => c.tier)).toEqual([...Array(8).fill(TIERS[1]), TIERS[0], TIERS[0]])
    const block = cellsAround('locality', TIERS[1], target.latitude, target.longitude)
    expect(new Set(block.map((c) => c.key)).size).toBe(4)
    expect(block.map((c) => c.key)).toContain(cellAt('locality', TIERS[1], target.latitude, target.longitude).key)
    // The target lies within the square spanned by the four centers, so it is at least half
    // a cell from the block's edge.
    const lats = block.map((c) => c.center.latitude)
    const lons = block.map((c) => c.center.longitude)
    expect(target.latitude).toBeGreaterThanOrEqual(Math.min(...lats))
    expect(target.latitude).toBeLessThanOrEqual(Math.max(...lats))
    expect(target.longitude).toBeGreaterThanOrEqual(Math.min(...lons))
    expect(target.longitude).toBeLessThanOrEqual(Math.max(...lons))
  })
})

describe('merging results', () => {
  it('drops same-name duplicates close together and promotes places found by coarser queries', () => {
    const known = new Map<string, KnownPlace>()
    mergeResults(known, 'locality', 6000, [place('a', 'Interlaken', 46.686, 7.863), place('b', 'Interlaken', 46.69, 7.86), place('c', 'Bönigen', 46.687, 7.893)])
    expect([...known.keys()]).toEqual(['a', 'c'])
    expect(mergeResults(known, 'locality', 15000, [place('a', 'Interlaken', 46.686, 7.863)])).toBe(true)
    expect(known.get('a')).toMatchObject({ tier: 15000, rank: 0 })
    expect(known.get('c')!.tier).toBe(6000)
    // Same name far apart is a different place.
    mergeResults(known, 'locality', 6000, [place('d', 'Interlaken', 40.7, -73.9)])
    expect(known.has('d')).toBe(true)
  })

  it('ranks places by the smallest circle that found them, counting duplicates once', () => {
    const known = new Map<string, KnownPlace>()
    const filler = (n: number) => Array.from({ length: n }, (_, i) => place(`f${i}`, `Filler ${i}`, 46 + i * 0.1, 7))
    // A big circle ranks the town behind its suburb; a small one around both ranks it first.
    mergeResults(known, 'locality', 15000, [...filler(10), place('m', 'Matten', 46.68, 7.866), ...filler(15).slice(10), place('a', 'Interlaken', 46.686, 7.863)])
    mergeResults(known, 'locality', 6000, [place('a', 'Interlaken', 46.686, 7.863), place('a', 'Interlaken', 46.686, 7.863), place('m', 'Matten', 46.68, 7.866)])
    // A later big circle doesn't override the small circle's order.
    mergeResults(known, 'locality', 15000, [place('m', 'Matten', 46.68, 7.866), place('a', 'Interlaken', 46.686, 7.863)])
    expect(known.get('a')).toMatchObject({ tier: 15000, fineTier: 6000, rank: 0 })
    expect(known.get('m')).toMatchObject({ tier: 15000, fineTier: 6000, rank: 1 })
    expect(comparePriority(known.get('a')!, known.get('m')!)).toBeLessThan(0)
  })

  it('puts district towns and towns others are named after first', () => {
    const known = new Map<string, KnownPlace>()
    mergeResults(known, 'locality', 15000, [
      place('u', 'Unterseen', 46.685, 7.848),
      place('m', 'Matten bei Interlaken', 46.681, 7.867),
      place('a', 'Interlaken', 46.686, 7.863),
      place('t', 'Thun', 46.758, 7.628, 1)
    ])
    expect(Object.fromEntries([...known.values()].map((p) => [p.id, p.prominence]))).toEqual({ u: 0, m: -1, a: 1, t: 1 })
    expect([...known.values()].sort(comparePriority).map((p) => p.id)).toEqual(['a', 't', 'u', 'm'])
    // A same-named town far away isn't the anchor.
    mergeResults(known, 'locality', 15000, [place('n', 'North Thun', 40, -100)])
    expect(known.get('n')!.prominence).toBe(0)
  })

  it('orders important places first', () => {
    const known = new Map<string, KnownPlace>()
    mergeResults(known, 'locality', 6000, [place('v', 'Village', 46.6, 7.9)])
    mergeResults(known, 'mountain_peak', 15000, [place('p', 'Peak', 46.5, 7.9)])
    mergeResults(known, 'locality', 15000, [place('t', 'Town', 46.7, 7.9)])
    expect([...known.values()].sort(comparePriority).map((p) => p.id)).toEqual(['t', 'p', 'v'])
  })
})

describe('declutter', () => {
  it('keeps higher-priority boxes and drops the ones overlapping them', () => {
    const boxes = [
      { x: 0, y: 0, width: 100, height: 20 },
      { x: 50, y: 10, width: 100, height: 20 },
      { x: 0, y: 40, width: 100, height: 20 },
      { x: 103, y: 0, width: 40, height: 20 }
    ]
    expect(declutter(boxes, 4)).toEqual([0, 2])
    expect(declutter(boxes, 0)).toEqual([0, 2, 3])
    expect(declutter(boxes, 4, 1)).toEqual([0])
  })
})

describe('Nearby Search request and response', () => {
  it('asks for one type, ranked by popularity, inside a capped circle', () => {
    const body = buildNearbyBody({ kind: 'mountain_peak', center: { latitude: 46.6, longitude: 7.95 }, radius: 90000 })
    expect(body).toMatchObject({ includedTypes: ['mountain_peak'], rankPreference: 'POPULARITY', maxResultCount: 20 })
    expect((body.locationRestriction as { circle: { radius: number } }).circle.radius).toBe(50000)
  })

  it('keeps named places with a location, in order', () => {
    const parsed = parseNearby({
      places: [
        { id: '1', displayName: { text: 'Eiger' }, location: { latitude: 46.577, longitude: 8.005 } },
        { id: '2', displayName: { text: '' }, location: { latitude: 1, longitude: 1 } },
        { id: '3', displayName: { text: 'Mönch' } },
        { id: '4', displayName: { text: ' Jungfrau ' }, location: { latitude: 46.536, longitude: 7.962 } }
      ]
    })
    expect(parsed.map((p) => p.name)).toEqual(['Eiger', 'Jungfrau'])
  })

  it('marks towns named like their district or state', () => {
    const components = (district: string, state: string) => [
      { longText: district, types: ['administrative_area_level_2', 'political'] },
      { longText: state, types: ['administrative_area_level_1', 'political'] }
    ]
    const parsed = parseNearby({
      places: [
        { id: 'i', displayName: { text: 'Interlaken' }, location: { latitude: 1, longitude: 1 }, addressComponents: components('Interlaken-Oberhasli District', 'Canton of Bern') },
        { id: 'b', displayName: { text: 'Bern' }, location: { latitude: 1, longitude: 1 }, addressComponents: components('Bern-Mittelland', 'Canton of Bern') },
        { id: 'o', displayName: { text: 'Bönigen' }, location: { latitude: 1, longitude: 1 }, addressComponents: components('Interlaken-Oberhasli District', 'Canton of Bern') },
        { id: 'm', displayName: { text: 'Matten bei Interlaken' }, location: { latitude: 1, longitude: 1 }, addressComponents: components('Interlaken-Oberhasli District', 'Canton of Bern') },
        { id: 'n', displayName: { text: 'Nowhere' }, location: { latitude: 1, longitude: 1 } }
      ]
    })
    expect(parsed.map((p) => p.seat)).toEqual([1, 2, 0, 0, 0])
  })
})

describe('wide views', () => {
  const target = { latitude: 46.8, longitude: 8.2 }

  it('asks for the region’s cities and areas from high up, and skips town cells when too far', () => {
    expect(regionCellsForView(target, 10000)).toEqual([])
    const mid = cellsForView(target, 70000, NEARBY_KINDS)
    expect(mid.filter((c) => c.rect)).toHaveLength(4)
    expect(mid.filter((c) => c.kind === 'administrative_area_level_1')).toHaveLength(4)
    expect(mid.some((c) => c.kind === 'country')).toBe(false)
    expect(mid.some((c) => !c.rect && c.kind === 'locality')).toBe(true)
    // Region queries come first.
    expect(mid[0].rect).toBeDefined()

    const far = cellsForView(target, 400000, NEARBY_KINDS)
    expect(far.some((c) => c.kind === 'country')).toBe(true)
    expect(far.some((c) => c.kind === 'mountain_peak' || (c.kind === 'locality' && !c.rect))).toBe(false)
    for (const c of far.filter((c) => c.rect)) {
      // Each rectangle is one region tier square and lies around the view.
      expect(c.rect!.north - c.rect!.south).toBeCloseTo(REGION_TIERS[1] / 110540, 3)
      expect(c.rect!.north - c.rect!.south).toBeLessThanOrEqual(CITIES_MAX_SPAN_DEG)
    }
    // Area queries use the biggest circle Nearby Search allows.
    expect(far.filter((c) => !c.rect).every((c) => c.radius === 50000)).toBe(true)
  })

  it('groups stations and attractions into cities, most mentioned first', () => {
    const poi = (city: string, latitude: number, longitude: number, admin = 'Somewhere') => ({
      location: { latitude, longitude },
      addressComponents: [
        { longText: city, types: ['locality', 'political'] },
        { longText: admin, types: ['administrative_area_level_1', 'political'] }
      ]
    })
    const cities = aggregateCities([
      { places: [poi('Zug', 47.17, 8.51), poi('Zürich', 47.37, 8.54, 'Canton of Zurich'), poi('Zürich', 47.38, 8.53), { location: { latitude: 1, longitude: 1 } }] },
      { places: [poi('Zürich', 47.36, 8.55), poi('Bern', 46.95, 7.44), poi('Zug', 47.17, 8.52)] }
    ])
    expect(cities.map((c) => [c.name, c.fame])).toEqual([
      ['Zürich', 3],
      ['Zug', 2],
      ['Bern', 1]
    ])
    expect(cities[0].location.latitude).toBeCloseTo(47.37, 2)
    expect(cities[0].seat).toBe(2)
    // Same name far apart is two cities.
    expect(aggregateCities([{ places: [poi('Springfield', 39.8, -89.6), poi('Springfield', 42.1, -72.6)] }])).toHaveLength(2)
  })

  it('merges a region city with the same town from Nearby Search and ranks main cities first', () => {
    const known = new Map<string, KnownPlace>()
    mergeResults(known, 'locality', 15000, [place('a', 'Interlaken', 46.686, 7.863), place('u', 'Unterseen', 46.685, 7.848)])
    mergeResults(known, 'locality', REGION_TIERS[0], [{ ...place('city:interlaken', 'Interlaken', 46.69, 7.85), fame: 3 }])
    expect(known.has('city:interlaken')).toBe(false)
    expect(known.get('a')).toMatchObject({ tier: REGION_TIERS[0], fame: 3, prominence: 2 })
    mergeResults(known, 'administrative_area_level_1', REGION_TIERS[0], [place('be', 'Canton of Bern', 46.8, 7.6)])
    mergeResults(known, 'country', REGION_TIERS[0], [place('ch', 'Switzerland', 46.8, 8.2)])
    expect([...known.values()].sort(comparePriority).map((p) => p.id)).toEqual(['ch', 'a', 'be', 'u'])
    // Areas only show from high up; region cities stay visible far out.
    expect(minRangeOf(known.get('be')!)).toBeGreaterThan(0)
    expect(minRangeOf(known.get('a')!)).toBe(0)
    expect(rangeOf(known.get('a')!)).toBeGreaterThanOrEqual(REGION_TIERS[0] * 3)
    // A city mentioned once (a suburb, a resort) doesn't stay labeled from high up.
    mergeResults(known, 'locality', REGION_TIERS[1], [{ ...place('city:w', 'Woodmere', 40.63, -73.71), fame: 1 }])
    expect(rangeOf(known.get('city:w')!)).toBeLessThan(REGION_TIERS[1])
    expect(known.get('city:w')!.prominence).toBe(0)
    // A town named like a canton in view is its main town, even without that in its address.
    mergeResults(known, 'locality', REGION_TIERS[1], [{ ...place('city:sg', 'St. Gallen', 47.42, 9.37), fame: 1 }])
    expect(known.get('city:sg')!.prominence).toBe(0)
    mergeResults(known, 'administrative_area_level_1', REGION_TIERS[1], [place('sg', 'St. Gallen', 47.2, 9.3)])
    expect(known.get('city:sg')!.prominence).toBe(2)
    expect(rangeOf(known.get('city:sg')!)).toBeGreaterThan(REGION_TIERS[1])
  })
})

describe('RateLimiter', () => {
  it('allows up to the limit per window and says when the next request fits', () => {
    const limiter = new RateLimiter(5, 60_000)
    limiter.record(3, 0)
    limiter.record(1, 10_000)
    expect(limiter.wait(1, 20_000)).toBe(0)
    limiter.record(1, 20_000)
    // Full: the first three age out at 60 s.
    expect(limiter.wait(1, 30_000)).toBe(30_000)
    expect(limiter.wait(3, 30_000)).toBe(30_000)
    // Four more need the request from 10 s gone too.
    expect(limiter.wait(4, 30_000)).toBe(40_000)
    expect(limiter.wait(3, 60_000)).toBe(0)
  })
})
