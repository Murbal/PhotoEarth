import {
  ArcType,
  CallbackProperty,
  Cartesian3,
  Color,
  ColorMaterialProperty,
  Matrix4,
  PolylineArrowMaterialProperty,
  PolylineDashMaterialProperty,
  Transforms,
  type CesiumWidget,
  type Entity
} from 'cesium'
import type { HorizonPosition } from '../lib/celestial'
import { sunDirectionENU } from '../lib/sun'

/**
 * A direction line from the view target towards a body in the sky: an arrow along the ground
 * at the body's azimuth, plus a dashed ray up at its altitude. Its length follows the camera
 * distance so it reads the same at any zoom.
 */
export class DirectionIndicator {
  private entities: Entity[] = []
  private target: Cartesian3 | null = null
  private direction: HorizonPosition = { azimuth: 180, altitude: 45 }
  private readonly color: Color

  constructor(
    private readonly widget: CesiumWidget,
    cssColor: string
  ) {
    this.color = Color.fromCssColorString(cssColor)
  }

  destroy(): void {
    this.remove()
  }

  setTarget(position: Cartesian3): void {
    this.target = position
  }

  setDirection(position: HorizonPosition): void {
    this.direction = position
  }

  /** Shows or hides the line; asks for a frame either way so a moved line is redrawn. */
  update(show: boolean): void {
    if (!show || !this.target) {
      if (this.entities.length) {
        this.remove()
        this.widget.scene.requestRender()
      }
      return
    }
    if (this.entities.length === 0) this.create()
    this.widget.scene.requestRender()
  }

  private remove(): void {
    for (const e of this.entities) this.widget.entities.remove(e)
    this.entities = []
  }

  private positions(alongGround: boolean): Cartesian3[] {
    const target = this.target
    if (!target) return []
    const scene = this.widget.scene
    const length = Math.min(60000, Math.max(40, Cartesian3.distance(scene.camera.positionWC, target) * 0.3))
    const [e, n, u] = sunDirectionENU({ azimuth: this.direction.azimuth, altitude: Math.max(this.direction.altitude, -5) })
    const enu = Transforms.eastNorthUpToFixedFrame(target)
    const local = alongGround ? new Cartesian3(e, n, 0) : new Cartesian3(e, n, u)
    Cartesian3.normalize(local, local)
    Cartesian3.multiplyByScalar(local, length, local)
    const lift = new Cartesian3(0, 0, Math.max(1, length * 0.004))
    const start = Matrix4.multiplyByPoint(enu, lift, new Cartesian3())
    const end = Matrix4.multiplyByPoint(enu, Cartesian3.add(local, lift, new Cartesian3()), new Cartesian3())
    return [start, end]
  }

  private create(): void {
    const color = this.color
    const ground = this.widget.entities.add({
      polyline: {
        positions: new CallbackProperty(() => this.positions(true), false),
        width: 14,
        material: new PolylineArrowMaterialProperty(color),
        depthFailMaterial: new ColorMaterialProperty(color.withAlpha(0.35)),
        arcType: ArcType.NONE
      }
    })
    const ray = this.widget.entities.add({
      polyline: {
        positions: new CallbackProperty(() => this.positions(false), false),
        width: 2,
        material: new PolylineDashMaterialProperty({ color, dashLength: 12 }),
        depthFailMaterial: new PolylineDashMaterialProperty({ color: color.withAlpha(0.3), dashLength: 12 }),
        arcType: ArcType.NONE
      }
    })
    this.entities = [ground, ray]
  }
}
