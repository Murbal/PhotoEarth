import { Cartesian2, Cartesian3, Color, HorizontalOrigin, JulianDate, LabelStyle, VerticalOrigin, type CesiumWidget, type Entity } from 'cesium'
import { appState, type Destination } from '../store/appStore'

const PIN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="44" viewBox="0 0 34 44">
<path d="M17 42.5S3 27.8 3 16.5a14 14 0 0 1 28 0C31 27.8 17 42.5 17 42.5z" fill="#ff5d5d" stroke="#ffffff" stroke-width="2.5"/>
<circle cx="17" cy="16.5" r="5.5" fill="#ffffff"/></svg>`
const PIN_IMAGE = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(PIN_SVG)}`

/**
 * The pin and name label left where a search (place or coordinates) lands, so the exact
 * destination stays visible after the palette closes. Cleared by the next search or on dismiss.
 */
export class SearchMarker {
  private entity: Entity | null = null
  private request = 0

  constructor(
    private readonly widget: CesiumWidget,
    private readonly sampleGround: (longitude: number, latitude: number) => Promise<number | undefined>
  ) {}

  /** The pinned ground point, if any. */
  get point(): Cartesian3 | null {
    return this.entity?.position?.getValue(JulianDate.now()) ?? null
  }

  /** Shows the pin at an approximate ground height; `refine` moves it onto the detailed surface. */
  show(destination: Destination, groundHeight: number): number {
    const id = ++this.request
    const position = Cartesian3.fromDegrees(destination.longitude, destination.latitude, groundHeight)
    if (this.entity) this.widget.entities.remove(this.entity)
    this.entity = this.widget.entities.add({
      position,
      billboard: {
        image: PIN_IMAGE,
        width: 30,
        height: 39,
        verticalOrigin: VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      },
      label: {
        text: destination.name,
        font: '600 14px system-ui, -apple-system, "Segoe UI", sans-serif',
        fillColor: Color.WHITE,
        outlineColor: Color.BLACK.withAlpha(0.7),
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        showBackground: true,
        backgroundColor: Color.fromCssColorString('rgba(17, 21, 29, 0.78)'),
        backgroundPadding: new Cartesian2(8, 5),
        horizontalOrigin: HorizontalOrigin.CENTER,
        verticalOrigin: VerticalOrigin.BOTTOM,
        pixelOffset: new Cartesian2(0, -46),
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      }
    })
    appState().set({ destination })
    this.widget.scene.requestRender()
    return id
  }

  /** Re-samples the ground once the camera has arrived and detail has loaded. */
  async refine(id: number): Promise<void> {
    const dest = appState().destination
    if (id !== this.request || !dest || !this.entity) return
    const height = await this.sampleGround(dest.longitude, dest.latitude).catch(() => undefined)
    if (id !== this.request || height === undefined || !this.entity) return
    this.entity.position = Cartesian3.fromDegrees(dest.longitude, dest.latitude, height) as never
    this.widget.scene.requestRender()
  }

  clear(): void {
    this.request++
    if (this.entity) this.widget.entities.remove(this.entity)
    this.entity = null
    if (appState().destination) appState().set({ destination: null })
    this.widget.scene.requestRender()
  }
}
