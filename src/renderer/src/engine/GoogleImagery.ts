import {
  Credit,
  GoogleMaps,
  ImageryLayer,
  Math as CesiumMath,
  UrlTemplateImageryProvider,
  type CreditDisplay,
  type Scene
} from 'cesium'
import { classifyGoogleError } from '@shared/apiErrors'
import type { ApiCheck, ImageryType } from '@shared/types'
import { httpStatusOf } from './util'

const ENDPOINT = 'https://tile.googleapis.com'

/** The Google logo Cesium credits Google data with (CSP: assets.ion.cesium.com is allowed). */
export const GOOGLE_LOGO_URL = 'https://assets.ion.cesium.com/google-credit.png'

function viewportQuery(b: ViewportBounds, zoom: number): string {
  return [Math.min(85, b.north), Math.max(-85, b.south), b.east, b.west].map((v) => v.toFixed(4)).join(',') + `@${Math.round(zoom)}`
}

interface Session {
  token: string
  /** Epoch ms. */
  expiry: number
  tileWidth: number
  tileHeight: number
}

/** The current 2D Tiles session as a URL template, shared with the overview map (§5.5). */
export interface TileSession {
  /** `{z}`, `{x}` and `{y}` are replaced per tile. */
  template: string
  tileSize: number
  mapType: ImageryType
}

export interface ViewportBounds {
  north: number
  south: number
  east: number
  west: number
}

function sessionBody(mapType: ImageryType): Record<string, unknown> {
  const body: Record<string, unknown> = { mapType, language: 'en-US', region: 'US' }
  // The terrain map type requires the roadmap layer.
  if (mapType === 'terrain') body.layerTypes = ['layerRoadmap']
  return body
}

/**
 * Google 2D Tiles draped on the terrain globe, using the session-token flow.
 * Sessions are renewed before they expire and whenever tiles start failing with 4xx.
 * Attribution comes from the viewport endpoint for what is actually on screen.
 */
export class GoogleImagery {
  layer: ImageryLayer | null = null
  private session: Session | null = null
  private key: string | null = null
  private mapType: ImageryType = 'satellite'
  private renewTimer: number | null = null
  private generation = 0
  private credit: Credit | null = null
  private attributionTimer: number | null = null
  private renewing = false
  private lastAttributionQuery = ''
  /** 4xx tile failures since the session was created (globe layer and overview map). */
  private failures = 0
  private readonly copyrightCache = new Map<string, string | null>()

  constructor(
    private readonly scene: Scene,
    private readonly creditDisplay: CreditDisplay,
    private readonly onError: (check: ApiCheck) => void,
    private readonly onReady: () => void,
    private readonly onSession: (session: TileSession | null) => void = () => undefined
  ) {}

  async configure(key: string | null, mapType: ImageryType): Promise<void> {
    if (key === this.key && mapType === this.mapType && this.layer) return
    this.key = key
    this.mapType = mapType
    await this.rebuild()
  }

  private async createSession(): Promise<Session> {
    const res = await fetch(`${ENDPOINT}/v1/createSession?key=${encodeURIComponent(this.key ?? '')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sessionBody(this.mapType))
    }).catch(() => null)
    if (!res) throw { statusCode: 0, response: '' }
    const text = await res.text()
    if (!res.ok) throw { statusCode: res.status, response: text }
    const json = JSON.parse(text) as { session: string; expiry: string; tileWidth: number; tileHeight: number }
    return {
      token: json.session,
      expiry: Number(json.expiry) * 1000,
      tileWidth: json.tileWidth || 256,
      tileHeight: json.tileHeight || 256
    }
  }

  private async rebuild(): Promise<void> {
    const generation = ++this.generation
    this.removeLayer()
    if (!this.key) return
    try {
      const session = await this.createSession()
      if (generation !== this.generation) return
      this.session = session
      const template = `${ENDPOINT}/v1/2dtiles/{z}/{x}/{y}?session=${encodeURIComponent(session.token)}&key=${encodeURIComponent(this.key)}`
      const provider = new UrlTemplateImageryProvider({
        url: template,
        tileWidth: session.tileWidth,
        tileHeight: session.tileHeight,
        maximumLevel: 22,
        // The Google logo credit Cesium uses for Google data (marked private in its typings).
        credit: (GoogleMaps as unknown as { getDefaultCredit(): Credit }).getDefaultCredit()
      })
      this.failures = 0
      this.copyrightCache.clear()
      provider.errorEvent.addEventListener((err: { error?: unknown }) => {
        const status = httpStatusOf(err.error)
        if (status === 401 || status === 403 || status === 400) this.reportTileFailure()
      })
      this.layer = this.scene.imageryLayers.addImageryProvider(provider, 0)
      this.scheduleRenewal()
      this.updateAttribution()
      this.onSession({ template, tileSize: session.tileWidth, mapType: this.mapType })
      this.onReady()
    } catch (error) {
      if (generation !== this.generation) return
      const e = error as { statusCode?: number; response?: string }
      this.onError(classifyGoogleError('Map Tiles API', e.statusCode, e.response ?? '', navigator.onLine))
    }
  }

  /**
   * A tile failed in a way a fresh session may fix (the globe layer reports 4xx; the overview
   * map's images can't see the status, so it reports failures while online). The third
   * renews the session.
   */
  reportTileFailure(): void {
    this.failures++
    if (this.failures === 3) void this.renew()
  }

  private scheduleRenewal(): void {
    if (this.renewTimer !== null) window.clearTimeout(this.renewTimer)
    if (!this.session) return
    // Renew an hour early; setTimeout can't take more than ~24.8 days.
    const delay = Math.min(Math.max(this.session.expiry - Date.now() - 3600_000, 60_000), 2_000_000_000)
    this.renewTimer = window.setTimeout(() => void this.renew(), delay)
  }

  private async renew(): Promise<void> {
    if (this.renewing) return
    this.renewing = true
    try {
      await this.rebuild()
    } finally {
      this.renewing = false
    }
  }

  setVisible(visible: boolean): void {
    if (this.layer) this.layer.show = visible
    if (visible) this.updateAttribution()
    else this.setCredit(null)
  }

  /** Refreshes the viewport attribution (call after the camera stops moving). */
  updateAttribution(): void {
    if (this.attributionTimer !== null) window.clearTimeout(this.attributionTimer)
    this.attributionTimer = window.setTimeout(() => void this.fetchAttribution(), 400)
  }

  private async fetchAttribution(): Promise<void> {
    if (!this.session || !this.key || !this.layer?.show) return
    const rect = this.scene.camera.computeViewRectangle(this.scene.ellipsoid)
    if (!rect) return
    const deg = CesiumMath.toDegrees
    const bounds = { north: deg(rect.north), south: deg(rect.south), west: deg(rect.west), east: deg(rect.east) }
    const span = Math.max(1e-6, (bounds.east - bounds.west + 360) % 360 || 360)
    const zoom = Math.round(Math.log2((360 * this.scene.canvas.clientWidth) / 256 / span))
    const q = viewportQuery(bounds, zoom)
    if (q === this.lastAttributionQuery) return
    this.lastAttributionQuery = q
    const copyright = await this.queryViewport(bounds, zoom)
    // undefined: the request failed; the Google logo credit stays on screen.
    if (copyright !== undefined) this.setCredit(copyright)
  }

  /**
   * Copyright text for a map viewport from the session's viewport endpoint (for the overview
   * map, §5.5). Null when there is no session or nothing to credit; cached per session.
   */
  async copyright(bounds: ViewportBounds, zoom: number): Promise<string | null> {
    const q = viewportQuery(bounds, zoom)
    const cached = this.copyrightCache.get(q)
    if (cached !== undefined) return cached
    const token = this.session?.token
    const copyright = await this.queryViewport(bounds, zoom)
    if (copyright === undefined) return null
    // Not cached under a session that was replaced meanwhile.
    if (this.session?.token === token) {
      if (this.copyrightCache.size > 200) this.copyrightCache.clear()
      this.copyrightCache.set(q, copyright)
    }
    return copyright
  }

  /** undefined when the request couldn't be made or failed. */
  private async queryViewport(b: ViewportBounds, zoom: number): Promise<string | null | undefined> {
    if (!this.session || !this.key) return undefined
    const z = Math.max(0, Math.min(22, Math.round(zoom)))
    const params = new URLSearchParams({
      session: this.session.token,
      key: this.key,
      zoom: String(z),
      north: Math.min(85, b.north).toFixed(6),
      south: Math.max(-85, b.south).toFixed(6),
      east: b.east.toFixed(6),
      west: b.west.toFixed(6)
    })
    try {
      const res = await fetch(`${ENDPOINT}/tile/v1/viewport?${params.toString()}`)
      if (!res.ok) return undefined
      const json = (await res.json()) as { copyright?: string }
      return json.copyright ? json.copyright : null
    } catch {
      return undefined
    }
  }

  private setCredit(text: string | null): void {
    if (this.credit) {
      this.creditDisplay.removeStaticCredit(this.credit)
      this.credit = null
    }
    if (text) {
      const el = document.createElement('span')
      el.textContent = text
      this.credit = new Credit(el.outerHTML, true)
      this.creditDisplay.addStaticCredit(this.credit)
    }
    this.scene.requestRender()
  }

  private removeLayer(): void {
    if (this.layer) {
      this.scene.imageryLayers.remove(this.layer, true)
      this.layer = null
      this.onSession(null)
    }
    this.session = null
    this.setCredit(null)
    this.lastAttributionQuery = ''
  }

  destroy(): void {
    this.generation++
    if (this.renewTimer !== null) window.clearTimeout(this.renewTimer)
    if (this.attributionTimer !== null) window.clearTimeout(this.attributionTimer)
    this.removeLayer()
  }
}
