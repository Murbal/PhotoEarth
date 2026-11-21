import { Cartesian2, Cartesian3, Cartographic, Color, SceneTransforms, type CesiumWidget, type Entity } from 'cesium'
import { toMsl } from '../lib/geoid'
import { appState } from '../store/appStore'
import { toDeg } from './util'

/** Click a point to drop a temporary marker with its coordinates and elevation (§7.4). */
export class PointInspector {
  private marker: Entity | null = null
  private position: Cartesian3 | null = null
  private request = 0

  constructor(
    private readonly widget: CesiumWidget,
    private readonly sampleGround: (longitude: number, latitude: number) => Promise<number | undefined>
  ) {}

  /** The marked ground point, if any. */
  get point(): Cartesian3 | null {
    return this.position
  }

  async inspect(position: Cartesian3): Promise<void> {
    const id = ++this.request
    this.position = position
    const c = Cartographic.fromCartesian(position)
    const longitude = toDeg(c.longitude)
    const latitude = toDeg(c.latitude)
    if (!this.marker) {
      this.marker = this.widget.entities.add({
        position,
        point: {
          pixelSize: 10,
          color: Color.fromCssColorString('#ff6b6b'),
          outlineColor: Color.WHITE,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      })
    } else {
      this.marker.position = position as never
    }
    appState().set({
      inspect: { longitude, latitude, elevation: toMsl(latitude, longitude, c.height), loading: true, screen: null }
    })
    this.updateScreen()
    this.widget.scene.requestRender()
    const precise = await this.sampleGround(longitude, latitude).catch(() => undefined)
    if (id !== this.request) return
    const current = appState().inspect
    if (!current) return
    appState().set({
      inspect: {
        ...current,
        elevation: precise !== undefined ? toMsl(latitude, longitude, precise) : current.elevation,
        loading: false
      }
    })
  }

  clear(): void {
    this.request++
    if (this.marker) this.widget.entities.remove(this.marker)
    this.marker = null
    this.position = null
    if (appState().inspect) appState().set({ inspect: null })
    this.widget.scene.requestRender()
  }

  /** Keeps the info card attached to the marker as the camera moves. */
  updateScreen(): void {
    const current = appState().inspect
    if (!this.position || !current) return
    const p = SceneTransforms.worldToWindowCoordinates(this.widget.scene, this.position, new Cartesian2())
    const screen = p ? { x: p.x, y: p.y } : null
    const prev = current.screen
    if (
      (screen === null) !== (prev === null) ||
      (screen && prev && (Math.abs(screen.x - prev.x) > 0.5 || Math.abs(screen.y - prev.y) > 0.5))
    ) {
      appState().set({ inspect: { ...current, screen } })
    }
  }
}
