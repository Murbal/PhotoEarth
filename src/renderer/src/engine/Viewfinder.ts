import type { Scene } from 'cesium'
import type { ViewfinderSettings } from '@shared/types'
import { cesiumFov, fitFrame, FRAME_INSET, lensView, type Rect } from '../lib/lens'
import type { CameraController } from './CameraController'

/**
 * Viewfinder mode (SPEC §11, first slice): sets the camera's field of view so that the crop
 * frame drawn by the UI (`fitFrame` with the same inset) shows exactly the simulated lens's
 * angle of view. The field of view depends on the window shape, so it is recomputed whenever
 * the canvas changes size. Switching off hands the field of view back to the camera
 * controller, which restores its default (orbit or fly mode) exactly.
 */
export class Viewfinder {
  private active = false
  private settings: ViewfinderSettings | null = null
  private width = 0
  private height = 0
  private readonly disposers: Array<() => void> = []

  constructor(
    private readonly scene: Scene,
    private readonly camera: CameraController
  ) {
    // The widget resizes the canvas (and the frustum's aspect ratio) right before rendering a
    // frame; correct the field of view before that frame is drawn.
    this.disposers.push(
      scene.preUpdate.addEventListener(() => {
        if (!this.active) return
        const canvas = this.scene.canvas
        if (canvas.clientWidth !== this.width || canvas.clientHeight !== this.height) this.apply(false)
      })
    )
  }

  get isActive(): boolean {
    return this.active
  }

  /** The crop frame in CSS pixels of the canvas (null while off). */
  get frame(): Rect | null {
    if (!this.active || !this.settings) return null
    const canvas = this.scene.canvas
    return fitFrame(canvas.clientWidth, canvas.clientHeight, lensView(this.settings).ratio, FRAME_INSET)
  }

  update(active: boolean, settings: ViewfinderSettings): void {
    const toggled = active !== this.active
    this.active = active
    this.settings = settings
    if (active) this.apply(toggled)
    else if (toggled) this.camera.setFovOverride(null, true)
  }

  private apply(ease: boolean): void {
    if (!this.settings) return
    const canvas = this.scene.canvas
    this.width = canvas.clientWidth
    this.height = canvas.clientHeight
    if (this.width === 0 || this.height === 0) return
    const lens = lensView(this.settings)
    const frame = fitFrame(this.width, this.height, lens.ratio, FRAME_INSET)
    this.camera.setFovOverride(cesiumFov(this.width, this.height, frame, lens.horizontal, lens.vertical), ease)
  }

  destroy(): void {
    this.disposers.forEach((d) => d())
  }
}
