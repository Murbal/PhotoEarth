import { classifyGoogleError } from '@shared/apiErrors'
import type { ApiCheck, ImageryType } from '@shared/types'
import {
  createTileSession,
  renewalDelay,
  tileTemplate,
  viewportCopyright,
  viewportKey,
  type TileSession,
  type TileSessionError,
  type ViewportBounds
} from './googleTiles'

/** What Map mode needs to draw tiles (published through the store). */
export interface MapSession {
  /** Tile URL template: `{z}`, `{x}`, `{y}`. */
  template: string
  mapType: ImageryType
}

/**
 * The 2D Tiles session of Map mode, separate from the globe imagery's so the map
 * can show its own map type (road map or terrain) at 2× on
 * dense displays. Created the first time Map mode opens, renewed an hour before it expires,
 * and when its tiles start failing with 400/401/403.
 */
export class MapTiles {
  private key: string | null = null
  private mapType: ImageryType | null = null
  private session: TileSession | null = null
  private generation = 0
  private renewTimer: number | null = null
  private failures = 0
  private readonly copyrights = new Map<string, string | null>()

  constructor(
    private readonly onSession: (session: MapSession | null) => void,
    private readonly onError: (check: ApiCheck) => void,
    private readonly onReady: () => void
  ) {}

  async configure(key: string | null, mapType: ImageryType): Promise<void> {
    if (key === this.key && mapType === this.mapType && this.session) return
    this.key = key
    this.mapType = mapType
    await this.rebuild()
  }

  /** `renew`: keep showing the current session's tiles until the new one is there. */
  private async rebuild(renew = false): Promise<void> {
    const generation = ++this.generation
    if (!renew) this.clear()
    const { key, mapType } = this
    if (!key || !mapType) return
    try {
      const session = await createTileSession(key, mapType, { highDpi: window.devicePixelRatio > 1 })
      if (generation !== this.generation) return
      if (this.renewTimer !== null) window.clearTimeout(this.renewTimer)
      this.session = session
      this.failures = 0
      this.copyrights.clear()
      this.renewTimer = window.setTimeout(() => void this.rebuild(true), renewalDelay(session))
      this.onSession({ template: tileTemplate(session, key), mapType })
      this.onReady()
    } catch (error) {
      if (generation !== this.generation) return
      const e = error as Partial<TileSessionError>
      this.onError(classifyGoogleError('Map Tiles API', e.statusCode, e.response ?? '', navigator.onLine))
    }
  }

  /** A tile failed with 400/401/403; the third such failure renews the session. */
  reportFailure(): void {
    this.failures++
    if (this.failures === 3) void this.rebuild(true)
  }

  /** The copyright line for a map viewport; cached per session. Null when unknown. */
  async copyright(bounds: ViewportBounds, zoom: number): Promise<string | null> {
    const session = this.session
    if (!session || !this.key) return null
    const k = viewportKey(bounds, zoom)
    const cached = this.copyrights.get(k)
    if (cached !== undefined) return cached
    const text = await viewportCopyright(session, this.key, bounds, zoom)
    if (text === undefined) return null
    if (this.session === session) {
      if (this.copyrights.size > 500) this.copyrights.clear()
      this.copyrights.set(k, text)
    }
    return text
  }

  private clear(): void {
    if (this.renewTimer !== null) window.clearTimeout(this.renewTimer)
    this.renewTimer = null
    if (this.session) this.onSession(null)
    this.session = null
  }

  destroy(): void {
    this.generation++
    this.clear()
  }
}
