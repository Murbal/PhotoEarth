import type { Scene } from 'cesium'

/**
 * Turns for creating 3D tile content. Cesium parses each tile's glTF and sets up its model on
 * this thread as soon as the response arrives, so a burst of arrivals runs back to back
 * between two frames and the camera stutters. While the camera moves, one tile gets its turn
 * after each rendered frame; at rest every waiting tile goes at once. (vite/cesium.ts makes
 * Cesium wait on `tileset.contentGate`.)
 */
export class ContentGate {
  private readonly waiting: Array<() => void> = []
  private perFrame = Number.POSITIVE_INFINITY
  private readonly removeListener: () => void

  constructor(scene: Scene) {
    this.removeListener = scene.postRender.addEventListener(() => this.release())
  }

  destroy(): void {
    this.removeListener()
    this.flush()
  }

  setMoving(moving: boolean): void {
    this.perFrame = moving ? TILES_PER_FRAME_MOVING : Number.POSITIVE_INFINITY
    if (!moving) this.flush()
  }

  /** For `tileset.contentGate`: resolves when this tile may create its content. */
  readonly acquire = (): Promise<void> => {
    if (this.perFrame === Number.POSITIVE_INFINITY && this.waiting.length === 0) return Promise.resolve()
    return new Promise((resolve) => this.waiting.push(resolve))
  }

  private release(): void {
    for (let n = this.perFrame; n > 0 && this.waiting.length > 0; n--) this.waiting.shift()!()
  }

  private flush(): void {
    while (this.waiting.length > 0) this.waiting.shift()!()
  }
}

/** Tiles whose content may be created after each frame while the camera moves. */
const TILES_PER_FRAME_MOVING = 1
