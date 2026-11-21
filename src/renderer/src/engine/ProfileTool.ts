import {
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Cartographic,
  ClassificationType,
  Color,
  SceneTransforms,
  type CesiumWidget,
  type Entity
} from 'cesium'
import { toMsl } from '../lib/geoid'
import { densifyPath, profileStats, type GeoPoint, type ProfileSample } from '../lib/profile'
import { appState } from '../store/appStore'
import { toDeg } from './util'

export type ElevationSampler = (
  points: GeoPoint[]
) => Promise<{ heights: Array<number | null>; source: 'terrain' | 'tiles' }>

const LINE = Color.fromCssColorString('#4fd1ff')
const HOVER = Color.fromCssColorString('#ffd54f')

/**
 * Click two or more points to draw a path; the profile (distance vs. elevation) is sampled
 * from the heightmap when available, otherwise from the 3D tiles.
 */
export class ProfileTool {
  private vertices: Cartesian3[] = []
  private rubber: Cartesian3 | null = null
  private samplePositions: Cartesian3[] = []
  private entities: Entity[] = []
  private hoverEntity: Entity | null = null
  private request = 0

  constructor(
    private readonly widget: CesiumWidget,
    private readonly sampler: ElevationSampler
  ) {}

  get drawing(): boolean {
    return appState().profile.active
  }

  get hasProfile(): boolean {
    return this.vertices.length > 1
  }

  start(): void {
    this.clear()
    appState().patchProfile({ active: true })
    const line = this.widget.entities.add({
      polyline: {
        positions: new CallbackProperty(
          () => (this.rubber && this.drawing ? [...this.vertices, this.rubber] : this.vertices),
          false
        ),
        width: 3,
        material: LINE,
        clampToGround: true,
        classificationType: ClassificationType.BOTH
      }
    })
    this.hoverEntity = this.widget.entities.add({
      position: new CallbackProperty(() => {
        const i = appState().profile.hoverIndex
        return i !== null ? this.samplePositions[i] : undefined
      }, false) as unknown as Cartesian3,
      point: {
        pixelSize: 11,
        color: HOVER,
        outlineColor: Color.BLACK.withAlpha(0.6),
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      }
    })
    this.entities.push(line, this.hoverEntity)
    this.widget.scene.requestRender()
  }

  addPoint(position: Cartesian3): void {
    if (!this.drawing) return
    this.vertices.push(position)
    this.entities.push(
      this.widget.entities.add({
        position,
        point: {
          pixelSize: 8,
          color: Color.WHITE,
          outlineColor: LINE,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      })
    )
    this.syncPoints()
    if (this.vertices.length > 1) void this.compute()
    this.widget.scene.requestRender()
  }

  undo(): void {
    if (!this.drawing || this.vertices.length === 0) return
    this.vertices.pop()
    const marker = this.entities.pop()
    if (marker && marker !== this.hoverEntity) this.widget.entities.remove(marker)
    this.syncPoints()
    if (this.vertices.length > 1) void this.compute()
    else appState().patchProfile({ samples: [], stats: null })
    this.widget.scene.requestRender()
  }

  /**
   * Stops adding points; the profile stays until cleared. A path needs two points: with only
   * a start point, drawing continues (with a hint) rather than silently discarding it.
   */
  finish(): void {
    if (!this.drawing) return
    if (this.vertices.length === 0) {
      this.clear()
      return
    }
    if (this.vertices.length < 2) {
      appState().showToast('Click a second point on the map to finish the profile (Esc cancels).')
      return
    }
    this.rubber = null
    appState().patchProfile({ active: false })
    this.widget.scene.requestRender()
  }

  /** Esc: finishes a drawable path, otherwise cancels drawing and says so. */
  cancelOrFinish(): void {
    if (!this.drawing) return
    if (this.vertices.length >= 2) {
      this.finish()
      return
    }
    const hadPoint = this.vertices.length > 0
    this.clear()
    if (hadPoint) appState().showToast('Elevation profile cancelled')
  }

  clear(): void {
    this.request++
    for (const e of this.entities) this.widget.entities.remove(e)
    this.entities = []
    this.hoverEntity = null
    this.vertices = []
    this.rubber = null
    this.samplePositions = []
    appState().resetProfile()
    this.widget.scene.requestRender()
  }

  private syncPoints(): void {
    appState().patchProfile({
      points: this.vertices.map((v) => {
        const c = Cartographic.fromCartesian(v)
        return { longitude: toDeg(c.longitude), latitude: toDeg(c.latitude) }
      })
    })
  }

  private async compute(): Promise<void> {
    const id = ++this.request
    const { points } = appState().profile
    const path = densifyPath(points, 400)
    appState().patchProfile({ loading: true, error: null })
    try {
      const { heights, source } = await this.sampler(path)
      if (id !== this.request) return
      const samples: ProfileSample[] = path.map((p, i) => {
        const h = heights[i]
        return { ...p, elevation: h === null ? null : toMsl(p.latitude, p.longitude, h) }
      })
      this.samplePositions = path.map((p, i) => Cartesian3.fromDegrees(p.longitude, p.latitude, (heights[i] ?? 0) + 1))
      appState().patchProfile({ samples, stats: profileStats(samples, 2), loading: false, source, hoverIndex: null })
    } catch (err) {
      if (id !== this.request) return
      appState().patchProfile({ loading: false, error: `Could not sample elevations: ${String(err)}` })
    }
  }

  /** Rubber band while drawing; map → chart hover sync otherwise. */
  onMouseMove(window: Cartesian2, picked: Cartesian3 | undefined): void {
    if (this.drawing) {
      this.rubber = picked ?? null
      if (this.vertices.length) this.widget.scene.requestRender()
      return
    }
    if (this.samplePositions.length === 0) return
    let best = -1
    let bestDist = 14
    const scene = this.widget.scene
    const scratch = new Cartesian2()
    for (let i = 0; i < this.samplePositions.length; i += 1) {
      const p = SceneTransforms.worldToWindowCoordinates(scene, this.samplePositions[i], scratch)
      if (!p) continue
      const d = Math.hypot(p.x - window.x, p.y - window.y)
      if (d < bestDist) {
        bestDist = d
        best = i
      }
    }
    const hoverIndex = best >= 0 ? best : null
    if (hoverIndex !== appState().profile.hoverIndex) {
      appState().patchProfile({ hoverIndex })
      scene.requestRender()
    }
  }

  setHover(index: number | null): void {
    appState().patchProfile({ hoverIndex: index })
    this.widget.scene.requestRender()
  }
}
