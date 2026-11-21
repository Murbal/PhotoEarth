import { AREA_KINDS, containsWords, NEARBY_MAX_RADIUS_M, nameTokens } from '@shared/places'
import type { CitiesRequest, LatLng, NearbyKind, NearbyPlace } from '@shared/types'

/**
 * Pure logic behind the map's place-name labels (engine/PlaceLabels.ts): which Places
 * queries cover a view, how results from different query sizes merge, and which labels fit
 * on screen without overlapping.
 *
 * Up close, Nearby Search in small cells finds towns and peaks. From high up that only finds
 * whatever is nearest each cell's center, so wide views also ask Text Search for the region's
 * main cities (CITY_QUERIES) and Nearby Search for the states and countries in view.
 */

/**
 * Query radii in meters. A query returns at most 20 places, so big ones cover the sparse
 * parts of a wide view and small ones fill in detail where places are dense.
 */
export const TIERS = [2500, 6000, 15000, 40000] as const

/** A tier serves views whose center is up to this many times its size away (see rangeOf). */
export const RANGE_FACTOR = 2.2

/**
 * Region sizes in meters for the city and area queries of wide views: square cells whose
 * size roughly matches the view's distance.
 */
export const REGION_TIERS = [150000, 450000] as const
/** Views farther than this skip the small town and peak cells (their labels are out of range). */
export const LOCAL_MAX_VIEW_M = 150000
/** Region city queries start at views this far away. */
export const CITIES_MIN_VIEW_M = 25000
/** State or canton labels fade in from this distance, country labels from COUNTRY_MIN_M. */
export const AREA_MIN_M = 60000
export const COUNTRY_MIN_M = 250000

const M_PER_DEG_LAT = 110540
const M_PER_DEG_LON = 111320

export interface QueryCell {
  key: string
  kind: NearbyKind
  tier: number
  center: LatLng
  radius: number
  /** Present for a region city query (Text Search over this rectangle). */
  rect?: CitiesRequest
}

function cell(kind: NearbyKind, tier: number, ix: number, iy: number): QueryCell {
  const dLat = tier / M_PER_DEG_LAT
  const lat = (iy + 0.5) * dLat
  const dLon = lonStep(tier, iy)
  return {
    key: `${kind}:${tier}:${ix}:${iy}`,
    kind,
    tier,
    center: { latitude: lat, longitude: (ix + 0.5) * dLon },
    // Covers the whole cell, so adjacent cells overlap slightly and nothing falls between.
    radius: tier * 0.75
  }
}

/** Columns are sized at their row's center latitude. */
function lonStep(tier: number, iy: number): number {
  const lat = (iy + 0.5) * (tier / M_PER_DEG_LAT)
  return tier / (M_PER_DEG_LON * Math.max(0.05, Math.cos((lat * Math.PI) / 180)))
}

function gridPosition(tier: number, latitude: number, longitude: number): { x: number; y: number } {
  const y = latitude / (tier / M_PER_DEG_LAT)
  return { x: longitude / lonStep(tier, Math.floor(y)), y }
}

/** The grid cell (one grid per tier size) containing a point. */
export function cellAt(kind: NearbyKind, tier: number, latitude: number, longitude: number): QueryCell {
  const { x, y } = gridPosition(tier, latitude, longitude)
  return cell(kind, tier, Math.floor(x), Math.floor(y))
}

/** The 2×2 block of cells whose centers are nearest a point, so it is never near an edge. */
export function cellsAround(kind: NearbyKind, tier: number, latitude: number, longitude: number): QueryCell[] {
  const { x, y } = gridPosition(tier, latitude, longitude)
  const x0 = Math.floor(x - 0.5)
  const y0 = Math.floor(y - 0.5)
  return [cell(kind, tier, x0, y0), cell(kind, tier, x0 + 1, y0), cell(kind, tier, x0, y0 + 1), cell(kind, tier, x0 + 1, y0 + 1)]
}

/**
 * Query tiers for a view whose target is `distance` meters from the camera, fine first: the
 * finest tier that still reaches across the view's center, plus the next coarser one for
 * context. For the widest views that is the two biggest tiers: a query returns the 20 places
 * nearest its center, so the view's center needs a smaller query of its own.
 */
export function tiersForDistance(distance: number): number[] {
  const i = TIERS.findIndex((t) => t * RANGE_FACTOR >= distance)
  const fine = Math.min(i < 0 ? TIERS.length - 1 : i, TIERS.length - 2)
  return TIERS.slice(fine, fine + 2)
}

/** The region tier for a view: about as big as the view is far away. */
export function regionTierFor(distance: number): number {
  return REGION_TIERS.find((t) => t >= distance) ?? REGION_TIERS[REGION_TIERS.length - 1]
}

/** A region city query for the square of a cell. */
function cityCell(c: QueryCell): QueryCell {
  const halfLat = c.tier / M_PER_DEG_LAT / 2
  const halfLon = c.tier / (M_PER_DEG_LON * Math.max(0.05, Math.cos((c.center.latitude * Math.PI) / 180))) / 2
  const rect = {
    south: Math.max(-89, c.center.latitude - halfLat),
    north: Math.min(89, c.center.latitude + halfLat),
    west: Math.max(-180, c.center.longitude - halfLon),
    east: Math.min(180, c.center.longitude + halfLon)
  }
  return { ...c, key: `cities:${c.key}`, rect }
}

/** City and area queries for a wide view; none for close views. */
export function regionCellsForView(target: LatLng, distance: number): QueryCell[] {
  if (distance < CITIES_MIN_VIEW_M) return []
  const tier = regionTierFor(distance)
  const cells = cellsAround('locality', tier, target.latitude, target.longitude).map(cityCell)
  for (const kind of AREA_KINDS) {
    if (distance < (kind === 'country' ? COUNTRY_MIN_M : AREA_MIN_M) * 0.7) continue
    // A circle returns every area it overlaps, so one per cell is plenty.
    const area = (c: QueryCell): QueryCell => ({ ...c, radius: NEARBY_MAX_RADIUS_M })
    if (kind === 'country') cells.push(area(cellAt(kind, tier, target.latitude, target.longitude)))
    else cells.push(...cellsAround(kind, tier, target.latitude, target.longitude).map(area))
  }
  return cells
}

/**
 * The cells to query for a view, most important first: for wide views the region's cities
 * and areas, then the town and peak cells (unless the view is too far away for their labels).
 * The coarse local tier gets the 2×2 block around the center for wide coverage; the fine
 * tier, whose labels only show nearby, just the center's cell.
 */
export function cellsForView(target: LatLng, distance: number, kinds: readonly NearbyKind[]): QueryCell[] {
  const cells: QueryCell[] = regionCellsForView(target, distance)
  if (distance > LOCAL_MAX_VIEW_M) return cells
  const tiers = tiersForDistance(distance).reverse()
  tiers.forEach((tier, i) => {
    const coarse = i === 0
    for (const kind of kinds) {
      if (coarse) cells.push(...cellsAround(kind, tier, target.latitude, target.longitude))
      else cells.push(cellAt(kind, tier, target.latitude, target.longitude))
    }
  })
  return cells
}

export interface KnownPlace {
  id: string
  name: string
  kind: NearbyKind
  latitude: number
  longitude: number
  /** Coarsest query radius that returned it. */
  tier: number
  /** Smallest query radius that returned it. */
  fineTier: number
  /**
   * Best position in the popularity-ordered results of `fineTier` queries. Google's ranking
   * leans on where the circle sits (in a big circle a town can come 18th of 20, behind its
   * own suburbs), so the smallest circles, which compare a place with its neighbors, give
   * the fairest order among the labels that compete for the same spot on screen.
   */
  rank: number
  /** See NearbyPlace.seat. */
  seat: 0 | 1 | 2
  /** See NearbyPlace.fame (0 for places only found by Nearby Search). */
  fame: number
  /** How much the label matters; see updateProminence. */
  prominence: number
}

export function distanceMeters(a: LatLng, b: LatLng): number {
  const toRad = Math.PI / 180
  const dLat = (b.latitude - a.latitude) * toRad
  const dLon = (b.longitude - a.longitude) * toRad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * toRad) * Math.cos(b.latitude * toRad) * Math.sin(dLon / 2) ** 2
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Same name this close together is one place listed twice (Places often returns both). */
const DUPLICATE_M = 2500
/** A region city sits at the mean of its stations and attractions, so it matches farther. */
const CITY_DUPLICATE_M = 20000

/**
 * Merges one query's results into the known places. A place found again by a coarser query
 * is promoted to that tier. Returns whether anything changed.
 */
export function mergeResults(known: Map<string, KnownPlace>, kind: NearbyKind, tier: number, results: NearbyPlace[]): boolean {
  let changed = false
  // Google often lists a place twice; rank each place once.
  const seen = new Set<string>()
  const unique = results.filter((r) => !seen.has(r.id) && !!seen.add(r.id))
  unique.forEach((r, rank) => {
    let existing = known.get(r.id)
    if (!existing) {
      for (const p of known.values()) {
        const near = Math.max(tier, p.tier) >= REGION_TIERS[0] ? CITY_DUPLICATE_M : DUPLICATE_M
        if (p.kind === kind && p.name === r.name && distanceMeters(p, r.location) < near) {
          existing = p
          break
        }
      }
    }
    if (existing) {
      if (tier > existing.tier) {
        existing.tier = tier
        changed = true
      }
      if (tier < existing.fineTier || (tier === existing.fineTier && rank < existing.rank)) {
        existing.fineTier = tier
        existing.rank = rank
        changed = true
      }
      if (r.seat > existing.seat) {
        existing.seat = r.seat
        changed = true
      }
      if ((r.fame ?? 0) > existing.fame) {
        existing.fame = r.fame ?? 0
        changed = true
      }
      return
    }
    known.set(r.id, {
      id: r.id,
      name: r.name,
      kind,
      latitude: r.location.latitude,
      longitude: r.location.longitude,
      tier,
      fineTier: tier,
      rank,
      seat: r.seat,
      fame: r.fame ?? 0,
      prominence: 0
    })
    changed = true
  })
  if (changed) updateProminence(known)
  return changed
}

/**
 * How far away a place stays labeled. Region cities and areas stay readable from high up,
 * and prominent towns farther than other towns.
 */
export function rangeOf(place: Pick<KnownPlace, 'kind' | 'tier' | 'prominence' | 'fame'>): number {
  if (place.kind === 'country') return 2e7
  if (place.kind === 'administrative_area_level_1') return 3e6
  // A city with a single station or attraction among the region's top results is as often a
  // suburb or a resort as a real city: only well-attested ones stay up to the region's range.
  if (place.tier >= REGION_TIERS[0] && (place.fame >= 2 || place.prominence >= 2)) {
    return place.tier * (place.tier >= REGION_TIERS[REGION_TIERS.length - 1] ? 6 : 3)
  }
  if (place.tier >= REGION_TIERS[0]) return SINGLE_MENTION_RANGE_M
  const top = TIERS[TIERS.length - 1]
  const tier = place.prominence > 0 ? top : place.tier
  return tier * RANGE_FACTOR * (tier >= top ? 2 : 1.4)
}

/** Areas are only labeled from high up, where the towns in them get too small to show. */
export function minRangeOf(place: Pick<KnownPlace, 'kind'>): number {
  if (place.kind === 'country') return COUNTRY_MIN_M
  if (place.kind === 'administrative_area_level_1') return AREA_MIN_M
  return 0
}

/** How far a region city mentioned only once stays labeled. */
const SINGLE_MENTION_RANGE_M = 250000

/** A town named in another town's name is that one's anchor only if they're this close. */
const REFERENCE_M = 30000
/** A town named like a state or canton is its main town only within this distance. */
const AREA_SEAT_M = 150000

/**
 * Prominence of each town: its seat level (see NearbyPlace.seat), plus one when a nearby
 * town is named after it ("Matten bei Interlaken", "South San Francisco"), minus one for the
 * town named after another, plus one or two when it is among the region's main cities
 * (two or more of its top stations and attractions). Peaks and areas stay at 0.
 */
export function updateProminence(known: Map<string, KnownPlace>): void {
  const byName = new Map<string, KnownPlace[]>()
  const towns: Array<{ place: KnownPlace; words: string[] }> = []
  for (const place of known.values()) {
    place.prominence = 0
    if (place.kind !== 'locality') continue
    const words = nameTokens(place.name)
    towns.push({ place, words })
    const key = words.join(' ')
    byName.set(key, [...(byName.get(key) ?? []), place])
  }
  // Town named like a state or canton in view (St. Gallen, Canton of St. Gallen): the
  // address of a station or attraction doesn't always name the state.
  const areas = [...known.values()]
    .filter((p) => p.kind === 'administrative_area_level_1')
    .map((p) => ({ place: p, words: nameTokens(p.name) }))
  const seats = new Set<KnownPlace>()
  for (const area of areas) {
    for (const { place, words } of towns) {
      if (containsWords(area.words, words) && distanceMeters(place, area.place) < AREA_SEAT_M) seats.add(place)
    }
  }
  const referenced = new Set<KnownPlace>()
  const satellites = new Set<KnownPlace>()
  for (const { place, words } of towns) {
    // Every shorter run of words in the name ("interlaken" in "matten bei interlaken").
    for (let len = 1; len < words.length; len++) {
      for (let i = 0; i + len <= words.length; i++) {
        for (const other of byName.get(words.slice(i, i + len).join(' ')) ?? []) {
          if (other === place || distanceMeters(place, other) > REFERENCE_M) continue
          referenced.add(other)
          satellites.add(place)
        }
      }
    }
  }
  for (const { place } of towns) {
    const fame = place.fame >= 3 ? 2 : place.fame >= 2 ? 1 : 0
    const seat = seats.has(place) ? 2 : place.seat
    place.prominence = seat + fame + (referenced.has(place) ? 1 : 0) - (satellites.has(place) ? 1 : 0)
  }
}

/** Countries, then main cities, then states, then everything else. */
function classOf(place: KnownPlace): number {
  if (place.kind === 'country') return 0
  if (place.kind === 'locality' && place.prominence >= 2) return 1
  if (place.kind === 'administrative_area_level_1') return 2
  return 3
}

/**
 * Label order: countries, main cities and states first (they only show from high up), then
 * prominent towns, then places found by bigger queries (they stand for a wider area), then by
 * popularity rank; towns before peaks on ties.
 */
export function comparePriority(a: KnownPlace, b: KnownPlace): number {
  return (
    classOf(a) - classOf(b) ||
    b.prominence - a.prominence ||
    b.tier - a.tier ||
    a.rank - b.rank ||
    (a.kind === b.kind ? 0 : a.kind === 'locality' ? -1 : 1)
  )
}

/**
 * Sliding-window rate limit: at most `limit` requests in any `windowMs`. Guards against a
 * bug re-requesting endlessly without ever cutting off normal exploring.
 */
export class RateLimiter {
  private sent: number[] = []

  constructor(
    private readonly limit: number,
    private readonly windowMs: number
  ) {}

  /** Milliseconds until `cost` more requests fit (0: now). */
  wait(cost: number, now: number): number {
    this.sent = this.sent.filter((t) => now - t < this.windowMs)
    const over = this.sent.length + cost - this.limit
    if (over <= 0) return 0
    // The window frees up as the oldest requests age out.
    return this.sent[Math.min(over, this.sent.length) - 1] + this.windowMs - now
  }

  record(cost: number, now: number): void {
    for (let i = 0; i < cost; i++) this.sent.push(now)
  }
}

export interface ScreenBox {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Greedy decluttering: walks boxes in priority order and keeps each one that doesn't overlap
 * (with `padding` px of air) any box already kept. Returns the kept indices.
 */
export function declutter(boxes: ScreenBox[], padding = 4, limit = Infinity): number[] {
  const kept: number[] = []
  for (let i = 0; i < boxes.length && kept.length < limit; i++) {
    const a = boxes[i]
    const clear = kept.every((k) => {
      const b = boxes[k]
      return (
        a.x + a.width + padding <= b.x ||
        b.x + b.width + padding <= a.x ||
        a.y + a.height + padding <= b.y ||
        b.y + b.height + padding <= a.y
      )
    })
    if (clear) kept.push(i)
  }
  return kept
}
