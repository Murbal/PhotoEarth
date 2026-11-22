import {
  Cartesian2,
  Cartesian3,
  Color,
  HorizontalOrigin,
  LabelCollection,
  LabelStyle,
  NearFarScalar,
  Ray,
  SceneTransforms,
  VerticalOrigin,
  type Label,
  type Scene
} from 'cesium'
import { CITY_QUERIES, NEARBY_KINDS } from '@shared/places'
import type { ApiCheck, CitiesRequest, NearbyPlace, NearbyRequest, Result } from '@shared/types'
import {
  cellsForView,
  comparePriority,
  declutter,
  mergeResults,
  minRangeOf,
  RateLimiter,
  rangeOf,
  REGION_TIERS,
  TIERS,
  type KnownPlace,
  type QueryCell,
  type ScreenBox
} from '../lib/placeLabels'
import { appState } from '../store/appStore'
import { raycastSurface } from './util'

/**
 * Places requests per minute at most. Cells are cached, so normal exploring stays far below
 * this; it stops a bug from re-requesting endlessly. Spending limits belong in Cloud Console.
 */
const MAX_PER_MINUTE = 60
const MAX_CONCURRENT = 2
const MAX_VISIBLE = 60
/** Wait this long after the camera stops before querying the new view. */
const SETTLE_MS = 450
/** Re-declutter at most this often while the view moves. */
const UPDATE_MS = 90
/**
 * Ray-cast time per update at rest (surface anchors and line of sight; each cast walks tile
 * geometry on the CPU). None while the camera moves: those frames have no time to spare.
 */
const RAY_BUDGET_MS = 6
/** No frame rendered for this long: the camera is at rest. */
const REST_AFTER_MS = 100
/** Surface anchors are found by casting down from this height above the ellipsoid. */
const CLAMP_FROM_M = 10000
/** Above this camera height, labels not yet clamped to the surface use sea level instead. */
const UNCLAMPED_OK_M = 20000

const FAMILY = "'Segoe UI Variable', 'Segoe UI', system-ui, -apple-system, Inter, Roboto, sans-serif"

interface Style {
  font: string
  size: number
  fill: Color
  prefix: string
  upper?: boolean
}

function styleFor(place: KnownPlace): Style {
  if (place.kind === 'country') return { font: `600 15px ${FAMILY}`, size: 15, fill: Color.WHITE, prefix: '', upper: true }
  if (place.kind === 'administrative_area_level_1') {
    return { font: `500 12px ${FAMILY}`, size: 12, fill: Color.fromCssColorString('#dde5ee'), prefix: '', upper: true }
  }
  if (place.kind === 'mountain_peak') return { font: `500 12px ${FAMILY}`, size: 12, fill: Color.fromCssColorString('#f4e3c3'), prefix: '▲ ' }
  if (place.prominence >= 3) return { font: `600 16px ${FAMILY}`, size: 16, fill: Color.WHITE, prefix: '' }
  if (place.prominence > 0) return { font: `600 15px ${FAMILY}`, size: 15, fill: Color.WHITE, prefix: '' }
  if (place.tier >= TIERS[2]) return { font: `600 14px ${FAMILY}`, size: 14, fill: Color.WHITE, prefix: '' }
  return { font: `600 13px ${FAMILY}`, size: 13, fill: Color.fromCssColorString('#f2f4f7'), prefix: '' }
}

interface Entry {
  place: KnownPlace
  label: Label
  width: number
  height: number
  tier: number
  /** Line of sight from `seenFrom`: whether terrain or buildings hide the anchor. */
  occluded: boolean | null
  seenFrom: Cartesian3
  /** Where the label stands on the loaded surface (3D tiles or terrain), once found. */
  anchor: Cartesian3 | null
  /** The surface below may have changed (new detail loaded): find the anchor again. */
  anchorStale: boolean
}

export interface PlaceLabelEvents {
  onError: (check: ApiCheck) => void
  onReady: () => void
}

const scratchScreen = new Cartesian2()
const scratchToLabel = new Cartesian3()
const scratchRay = new Ray()
const scratchTop = new Cartesian3()
/** A `seenFrom` that makes the next update re-check the line of sight. */
const FAR = new Cartesian3(1e12, 0, 0)

/**
 * Google place names in the 3D view, in the style of Google Earth: upright text anchored on
 * the ground at each place (clamped to the 3D tiles or terrain), hidden as a whole when a
 * ridge or building blocks the line of sight to it, fading out with distance and decluttered
 * on screen.
 *
 * Names and positions come from Places API (New) Nearby Search (towns and mountain peaks,
 * most popular first). Queries are made for grid cells around the view after the camera
 * settles; bigger cells return the region's main places, smaller ones the local detail.
 * Results are kept in memory for the session only.
 */
export class PlaceLabels {
  private readonly collection: LabelCollection
  private readonly known = new Map<string, KnownPlace>()
  private readonly entries = new Map<string, Entry>()
  private sorted: Entry[] = []
  private readonly requested = new Set<string>()
  private queue: QueryCell[] = []
  private inflight = 0
  private readonly limiter = new RateLimiter(MAX_PER_MINUTE, 60_000)
  private limitTimer: number | null = null
  private blocked = false
  private generation = 0
  private key: string | null = null
  private enabled = false
  private suspended = false
  private settleTimer: number | null = null
  private trailingTimer: number | null = null
  private lastUpdate = 0
  private dirty = true
  private readonly lastPos = new Cartesian3()
  private readonly lastDir = new Cartesian3()
  /** Camera of the previous rendered frame: whether the view is moving right now. */
  private readonly framePos = new Cartesian3()
  private readonly frameDir = new Cartesian3()
  private moving = false
  private lastFrameAt = 0
  private readonly measure = document.createElement('canvas').getContext('2d')
  private readonly removePostRender: () => void

  constructor(
    private readonly scene: Scene,
    private readonly events: PlaceLabelEvents,
    private readonly fetch: {
      nearby: (req: NearbyRequest) => Promise<Result<NearbyPlace[]>>
      cities: (req: CitiesRequest) => Promise<Result<NearbyPlace[]>>
    }
  ) {
    this.collection = new LabelCollection({ scene })
    this.collection.show = false
    scene.primitives.add(this.collection)
    this.removePostRender = scene.postRender.addEventListener(() => this.onPostRender())
  }

  private get active(): boolean {
    return this.enabled && !!this.key && !this.suspended
  }

  /** Hibernates network queries and label updates while the Globe module is hidden. */
  setSuspended(suspended: boolean): void {
    if (suspended === this.suspended) return
    this.suspended = suspended
    if (suspended) {
      if (this.settleTimer !== null) window.clearTimeout(this.settleTimer)
      if (this.trailingTimer !== null) window.clearTimeout(this.trailingTimer)
      if (this.limitTimer !== null) window.clearTimeout(this.limitTimer)
      this.settleTimer = this.trailingTimer = this.limitTimer = null
    } else if (this.active) {
      this.plan()
      this.poke()
    }
  }

  /**
   * Turns the labels on or off for this Google key (the main process holds the key itself;
   * it is used here only to notice changes). `retry` clears a previous API error.
   */
  configure(key: string | null, enabled: boolean, retry = false): void {
    if (key !== this.key) {
      this.key = key
      this.reset()
    } else if (retry) {
      this.blocked = false
    }
    this.enabled = enabled
    this.collection.show = this.active
    this.dirty = true
    if (this.active) this.plan()
    this.scene.requestRender()
  }

  /** Mountain peaks found so far (the horizon panorama names its skyline with them too). */
  knownPeaks(): KnownPlace[] {
    return [...this.known.values()].filter((p) => p.kind === 'mountain_peak')
  }

  /** Call when the camera stops: queries the new view once it has settled. */
  onMoveEnd(): void {
    if (!this.active) return
    if (this.settleTimer !== null) window.clearTimeout(this.settleTimer)
    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = null
      this.plan()
    }, SETTLE_MS)
  }

  /**
   * Re-runs decluttering and the line-of-sight checks (call when tiles finish loading: labels
   * re-clamp to the finer surface and new geometry may hide them). Labels keep their current
   * visibility until they are re-checked.
   */
  refresh(): void {
    for (const entry of this.entries.values()) {
      Cartesian3.clone(FAR, entry.seenFrom)
      entry.anchorStale = true
    }
    this.poke()
  }

  private poke(): void {
    this.dirty = true
    this.requestUpdate()
  }

  private reset(): void {
    this.generation++
    this.known.clear()
    this.entries.clear()
    this.sorted = []
    this.collection.removeAll()
    this.requested.clear()
    this.queue = []
    this.inflight = 0
    this.blocked = false
  }

  // ───────────────────────────── queries ─────────────────────────────

  private plan(): void {
    const { target, camera } = appState()
    if (!this.active || !target || !camera) return
    // Distance to the view's center, from the height above ground and the pitch.
    const agl = Math.max(50, camera.heightAgl ?? camera.heightMsl)
    const down = Math.sin((Math.min(-10, camera.pitch) * -Math.PI) / 180)
    const distance = agl / down
    // Most urgent first: the view center's cells go to the front of the queue.
    const cells = cellsForView(target, distance, NEARBY_KINDS).filter((c) => !this.requested.has(c.key))
    this.queue = [...cells, ...this.queue.filter((q) => !cells.some((c) => c.key === q.key))].slice(0, 24)
    this.pump()
  }

  private pump(): void {
    while (this.inflight < MAX_CONCURRENT && this.queue.length && !this.blocked && !this.suspended) {
      // A region city query is one Text Search request per CITY_QUERIES entry.
      const cost = this.queue[0].rect ? CITY_QUERIES.length : 1
      const wait = this.limiter.wait(cost, performance.now())
      if (wait > 0) {
        // Over the per-minute limit: carry on once older requests age out.
        if (this.limitTimer === null) {
          this.limitTimer = window.setTimeout(() => {
            this.limitTimer = null
            this.pump()
          }, wait + 50)
        }
        return
      }
      const cell = this.queue.shift()!
      this.requested.add(cell.key)
      this.inflight++
      this.limiter.record(cost, performance.now())
      const generation = this.generation
      const request = cell.rect
        ? this.fetch.cities(cell.rect)
        : this.fetch.nearby({ kind: cell.kind, center: cell.center, radius: cell.radius })
      void request
        .catch((): Result<NearbyPlace[]> => ({ ok: false, error: { status: 'error', message: 'Place names could not be loaded.' } }))
        .then((res) => {
          if (generation !== this.generation) return
          this.inflight--
          if (res.ok) {
            if (mergeResults(this.known, cell.kind, cell.tier, res.data)) this.sync()
            this.events.onReady()
          } else {
            // Offline or a transient error: allow this cell again later. Key, quota or
            // API-not-enabled errors stop requests until the user retries.
            this.requested.delete(cell.key)
            if (res.error.status !== 'offline' && res.error.status !== 'error') this.blocked = true
            if (res.error.status !== 'error') this.events.onError(res.error)
          }
          this.pump()
        })
    }
  }

  // ───────────────────────────── labels ─────────────────────────────

  /** Creates labels for new places and restyles promoted ones. */
  private sync(): void {
    for (const place of this.known.values()) {
      const entry = this.entries.get(place.id)
      const style = styleFor(place)
      if (entry && entry.tier === place.tier && entry.label.font === style.font) continue
      const text = style.prefix + (style.upper ? place.name.toLocaleUpperCase('en') : place.name)
      const range = rangeOf(place)
      const min = minRangeOf(place)
      // Areas fade in as the camera rises; everything else fades out toward its range.
      // Region cities hold on longer: a half-faded city name reads as clutter from high up.
      const fadeFrom = place.tier >= REGION_TIERS[0] ? 0.85 : 0.65
      const translucency = min > 0 ? new NearFarScalar(min, 0, min * 1.6, 1) : new NearFarScalar(range * fadeFrom, 1, range, 0)
      if (entry) {
        entry.label.font = style.font
        entry.label.fillColor = style.fill
        entry.label.translucencyByDistance = translucency
        entry.width = this.textWidth(text, style.font)
        entry.height = style.size + 6
        entry.tier = place.tier
        continue
      }
      const label = this.collection.add({
        position: Cartesian3.fromDegrees(place.longitude, place.latitude, 0),
        text,
        font: style.font,
        fillColor: style.fill,
        outlineColor: Color.BLACK.withAlpha(0.8),
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        horizontalOrigin: HorizontalOrigin.CENTER,
        verticalOrigin: VerticalOrigin.BOTTOM,
        pixelOffset: new Cartesian2(0, -4),
        // Placed on the surface by update() (not CLAMP_TO_GROUND: Cesium re-clamps every
        // label on every newly loaded tile, ray casting each one, which stalls camera motion).
        // Never clipped glyph by glyph by the ground; occlusion is decided per label below.
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        translucencyByDistance: translucency,
        show: false
      })
      this.entries.set(place.id, {
        place,
        label,
        width: this.textWidth(text, style.font),
        height: style.size + 6,
        tier: place.tier,
        occluded: null,
        seenFrom: new Cartesian3(),
        anchor: null,
        anchorStale: true
      })
    }
    this.sorted = [...this.entries.values()].sort((a, b) => comparePriority(a.place, b.place))
    this.poke()
  }

  private textWidth(text: string, font: string): number {
    if (!this.measure) return text.length * 7
    this.measure.font = font
    return this.measure.measureText(text).width + 6
  }

  private onPostRender(): void {
    if (!this.active || this.sorted.length === 0) return
    const camera = this.scene.camera
    this.moving =
      !Cartesian3.equalsEpsilon(camera.positionWC, this.framePos, 0, 0.05) ||
      !Cartesian3.equalsEpsilon(camera.directionWC, this.frameDir, 1e-6)
    Cartesian3.clone(camera.positionWC, this.framePos)
    Cartesian3.clone(camera.directionWC, this.frameDir)
    this.lastFrameAt = performance.now()
    const moved =
      !Cartesian3.equalsEpsilon(camera.positionWC, this.lastPos, 0, 0.05) ||
      !Cartesian3.equalsEpsilon(camera.directionWC, this.lastDir, 1e-6)
    if (!moved && !this.dirty) return
    this.requestUpdate()
  }

  /**
   * Runs update() now, or once UPDATE_MS have passed since the last one. Work left over (ray
   * casts waiting for the camera to rest or for budget) continues on a timer, without
   * rendering frames just for it; the scene renders only when a label's visibility changes.
   */
  private requestUpdate(): void {
    if (!this.active) return
    const wait = UPDATE_MS - (performance.now() - this.lastUpdate)
    if (wait > 0) {
      if (this.trailingTimer === null) {
        this.trailingTimer = window.setTimeout(() => {
          this.trailingTimer = null
          this.runUpdate()
        }, wait)
      }
      return
    }
    this.runUpdate()
  }

  private runUpdate(): void {
    if (!this.active || this.sorted.length === 0) return
    const camera = this.scene.camera
    this.lastUpdate = performance.now()
    this.dirty = false
    Cartesian3.clone(camera.positionWC, this.lastPos)
    Cartesian3.clone(camera.directionWC, this.lastDir)
    const { changed, pending } = this.update()
    if (changed) this.scene.requestRender()
    if (pending) {
      this.dirty = true
      this.requestUpdate()
    }
  }

  /** Picks which labels show. */
  private update(): { changed: boolean; pending: boolean } {
    const scene = this.scene
    const camera = scene.camera
    const width = scene.canvas.clientWidth
    const height = scene.canvas.clientHeight
    const candidates: Entry[] = []
    const boxes: ScreenBox[] = []
    let pending = false
    // A moving camera renders every frame; no frame for a while means it has come to rest.
    const moving = this.moving && performance.now() - this.lastFrameAt < REST_AFTER_MS
    const deadline = moving ? 0 : performance.now() + RAY_BUDGET_MS
    const canCast = () => performance.now() < deadline
    const high = camera.positionCartographic.height > UNCLAMPED_OK_M
    for (const entry of this.sorted) {
      // Until the label stands on the surface its position is on the ellipsoid, which can be
      // deep under the terrain. From high up the difference doesn't matter, and far-away
      // surface may never load in detail.
      if (!high && entry.anchorStale && this.roughlyInView(entry)) {
        if (canCast()) this.clamp(entry)
        else pending = true
      }
      const position = entry.anchor ?? (high ? entry.label.position : undefined)
      if (!position) continue
      const toLabel = Cartesian3.subtract(position, camera.positionWC, scratchToLabel)
      const distance = Cartesian3.magnitude(toLabel)
      if (distance > rangeOf(entry.place) || distance < minRangeOf(entry.place) * 0.9) continue
      if (Cartesian3.dot(toLabel, camera.directionWC) <= 0) continue
      const screen = SceneTransforms.worldToWindowCoordinates(scene, position, scratchScreen)
      // Whole label on screen: one cut off at the edge only adds clutter.
      if (!screen || screen.x - entry.width / 2 < 0 || screen.x + entry.width / 2 > width) continue
      if (screen.y - 4 - entry.height < 0 || screen.y > height) continue
      // Line of sight, re-checked once the camera has moved a little relative to the distance.
      const stale =
        entry.occluded === null || Cartesian3.distance(entry.seenFrom, camera.positionWC) > Math.max(5, distance * 0.02)
      if (stale) {
        if (canCast()) {
          entry.occluded = this.isOccluded(position, toLabel, distance)
          Cartesian3.clone(camera.positionWC, entry.seenFrom)
        } else {
          pending = true
        }
      }
      if (entry.occluded !== false) continue
      candidates.push(entry)
      boxes.push({ x: screen.x - entry.width / 2, y: screen.y - 4 - entry.height, width: entry.width, height: entry.height })
    }
    const kept = new Set(declutter(boxes, 6, MAX_VISIBLE))
    let changed = false
    const shown = new Set<Entry>()
    candidates.forEach((entry, i) => {
      if (kept.has(i)) shown.add(entry)
    })
    for (const entry of this.sorted) {
      const show = shown.has(entry)
      if (entry.label.show !== show) {
        entry.label.show = show
        changed = true
      }
    }
    return { changed, pending }
  }

  /** In range and in front of the camera, judged from the sea-level position (cheap). */
  private roughlyInView(entry: Entry): boolean {
    const camera = this.scene.camera
    const toLabel = Cartesian3.subtract(entry.anchor ?? entry.label.position, camera.positionWC, scratchToLabel)
    const distance = Cartesian3.magnitude(toLabel)
    // Generous: the surface can stand kilometres above sea level.
    if (distance > rangeOf(entry.place) + 9000 || distance < minRangeOf(entry.place) * 0.5) return false
    return Cartesian3.dot(toLabel, camera.directionWC) > -distance * 0.2
  }

  /** Stands the label on the loaded surface below its place (tries again after the next refresh). */
  private clamp(entry: Entry): void {
    entry.anchorStale = false
    const { longitude, latitude } = entry.place
    const top = Cartesian3.fromDegrees(longitude, latitude, CLAMP_FROM_M, this.scene.ellipsoid, scratchTop)
    Cartesian3.clone(top, scratchRay.origin)
    Cartesian3.negate(this.scene.ellipsoid.geodeticSurfaceNormal(top, scratchRay.direction), scratchRay.direction)
    const hit = raycastSurface(this.scene, scratchRay)
    if (!hit) return
    entry.anchor = Cartesian3.clone(hit, entry.anchor ?? new Cartesian3())
    entry.label.position = entry.anchor
    // A new anchor means a new line of sight.
    Cartesian3.clone(FAR, entry.seenFrom)
  }

  /** Whether terrain or buildings sit between the camera and the label's anchor. */
  private isOccluded(position: Cartesian3, toLabel: Cartesian3, distance: number): boolean {
    Cartesian3.clone(this.scene.camera.positionWC, scratchRay.origin)
    Cartesian3.divideByScalar(toLabel, distance, scratchRay.direction)
    const hit = raycastSurface(this.scene, scratchRay)
    if (!hit) return false
    // The anchor sits on the surface itself: only hits clearly in front of it count.
    return Cartesian3.distance(hit, scratchRay.origin) < distance - Math.max(40, distance * 0.03)
  }

  destroy(): void {
    this.generation++
    if (this.settleTimer !== null) window.clearTimeout(this.settleTimer)
    if (this.trailingTimer !== null) window.clearTimeout(this.trailingTimer)
    if (this.limitTimer !== null) window.clearTimeout(this.limitTimer)
    this.removePostRender()
    this.scene.primitives.remove(this.collection)
  }
}
