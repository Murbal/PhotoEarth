import {
  BillboardCollection,
  Cartesian2,
  Cartesian3,
  Color,
  DistanceDisplayCondition,
  HorizontalOrigin,
  LabelCollection,
  LabelStyle,
  SceneTransforms,
  VerticalOrigin,
  type Billboard,
  type Label,
  type Scene
} from 'cesium'
import type { Bookmark, LocationStatus } from '@shared/types'

const COLORS: Record<LocationStatus, string> = { 'to-visit': '#4fb3ff', visited: '#4cd18a' }

function pinImage(color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="42" viewBox="0 0 32 42">
<path d="M16 40.5S3 26.6 3 15.8a13 13 0 0 1 26 0C29 26.6 16 40.5 16 40.5z" fill="${color}" stroke="#ffffff" stroke-width="2.5"/>
<path d="M9.5 20.5l4.2-6 2.8 3.6 1.8-2.2 4.2 4.6z" fill="#ffffff"/></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

const PIN = { width: 24, height: 31.5 }
/** Names show only within this distance of the camera, so a zoomed-out globe stays readable. */
const LABEL_RANGE = new DistanceDisplayCondition(0, 250_000)

interface Marker {
  id: string
  position: Cartesian3
  billboard: Billboard
  label: Label
  /** Height still unknown (estimated position): placed once sampled. */
  pending: boolean
}

/** Looks up surface heights (ellipsoidal) for points without one; null where unknown. */
export type HeightSampler = (points: Array<{ longitude: number; latitude: number }>) => Promise<Array<number | null>>

/**
 * Pins for the saved locations. A billboard and a label collection (no entities, no ground
 * clamping, nothing per frame): positions are fixed when the list changes, and drawn on top
 * like the search pin. Clicks are hit-tested on the CPU against the projected pins, so a
 * click costs no GPU pick either.
 */
export class LocationMarkers {
  private readonly billboards: BillboardCollection
  private readonly labels: LabelCollection
  private markers: Marker[] = []
  /** Sampled heights of locations stored without one, by id and coordinates. */
  private readonly heights = new Map<string, number>()
  private sampling = false
  private last: { locations: Bookmark[]; active: string | null } = { locations: [], active: null }

  constructor(
    private readonly scene: Scene,
    private readonly sampleHeights: HeightSampler
  ) {
    this.billboards = new BillboardCollection({ scene })
    this.labels = new LabelCollection({ scene })
    scene.primitives.add(this.billboards)
    scene.primitives.add(this.labels)
  }

  setVisible(visible: boolean): void {
    if (this.billboards.show === visible) return
    this.billboards.show = visible
    this.labels.show = visible
    this.scene.requestRender()
  }

  get visible(): boolean {
    return this.billboards.show
  }

  /** Rebuilds the pins (a handful to a few hundred: cheap, and only when the list changes). */
  update(locations: Bookmark[], active: string | null): void {
    this.last = { locations, active }
    this.billboards.removeAll()
    this.labels.removeAll()
    this.markers = []
    for (const b of locations) {
      const key = heightKey(b)
      const known = b.position.height ?? this.heights.get(key)
      const position = Cartesian3.fromDegrees(b.position.longitude, b.position.latitude, known ?? 0)
      const isActive = b.id === active
      const billboard = this.billboards.add({
        position,
        image: pinImage(COLORS[b.status]),
        width: PIN.width,
        height: PIN.height,
        scale: isActive ? 1.25 : 1,
        verticalOrigin: VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        id: b.id
      })
      const label = this.labels.add({
        position,
        text: b.name,
        font: `${isActive ? 700 : 600} 12px system-ui, -apple-system, "Segoe UI", sans-serif`,
        fillColor: Color.WHITE,
        outlineColor: Color.BLACK.withAlpha(0.75),
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        horizontalOrigin: HorizontalOrigin.CENTER,
        verticalOrigin: VerticalOrigin.BOTTOM,
        pixelOffset: new Cartesian2(0, -PIN.height * (isActive ? 1.25 : 1) - 3),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: isActive ? undefined : LABEL_RANGE
      })
      this.markers.push({ id: b.id, position, billboard, label, pending: known === undefined })
    }
    this.scene.requestRender()
    void this.samplePending()
  }

  /** Forgets sampled heights (e.g. once terrain loads, so estimates made without it improve). */
  resample(): void {
    this.heights.clear()
    this.update(this.last.locations, this.last.active)
  }

  /** The location whose pin is under a window position (CSS pixels), nearest first. */
  hitTest(x: number, y: number): string | null {
    if (!this.visible) return null
    let best: string | null = null
    let bestDistance = Infinity
    for (const m of this.markers) {
      const p = this.screenPosition(m.id)
      if (!p) continue
      const s = m.billboard.scale
      const dx = x - p.x
      const dy = y - p.y
      if (Math.abs(dx) > (PIN.width / 2 + 3) * s || dy > 4 || dy < -(PIN.height + 3) * s) continue
      const d = Math.hypot(dx, dy + (PIN.height * s) / 2)
      if (d < bestDistance) {
        bestDistance = d
        best = m.id
      }
    }
    return best
  }

  /** Where a pin's tip is drawn (CSS pixels), or null when it is behind the camera or off screen. */
  screenPosition(id: string): { x: number; y: number } | null {
    const m = this.markers.find((k) => k.id === id)
    if (!m) return null
    const cam = this.scene.camera
    const toPin = Cartesian3.subtract(m.position, cam.positionWC, new Cartesian3())
    if (Cartesian3.dot(toPin, cam.directionWC) <= 0) return null
    const p = SceneTransforms.worldToWindowCoordinates(this.scene, m.position)
    if (!p) return null
    const canvas = this.scene.canvas
    if (p.x < 0 || p.y < 0 || p.x > canvas.clientWidth || p.y > canvas.clientHeight) return null
    return { x: p.x, y: p.y }
  }

  destroy(): void {
    this.scene.primitives.remove(this.billboards)
    this.scene.primitives.remove(this.labels)
  }

  private async samplePending(): Promise<void> {
    if (this.sampling) return
    const pending = this.markers.filter((m) => m.pending)
    if (pending.length === 0) return
    const byId = new Map(this.last.locations.map((b) => [b.id, b]))
    const locations = pending.map((m) => byId.get(m.id)).filter((b): b is Bookmark => !!b)
    this.sampling = true
    try {
      const heights = await this.sampleHeights(locations.map((b) => b.position))
      let changed = false
      locations.forEach((b, i) => {
        const h = heights[i]
        if (h === null || h === undefined) return
        this.heights.set(heightKey(b), h)
        changed = true
      })
      if (changed) this.update(this.last.locations, this.last.active)
    } catch {
      /* stay at the estimate */
    } finally {
      this.sampling = false
    }
  }
}

function heightKey(b: Bookmark): string {
  return `${b.id}:${b.position.longitude}:${b.position.latitude}`
}
