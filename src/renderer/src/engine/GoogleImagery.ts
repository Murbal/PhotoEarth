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

interface Session {
  token: string
  /** Epoch ms. */
  expiry: number
  tileWidth: number
  tileHeight: number
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

  constructor(
    private readonly scene: Scene,
    private readonly creditDisplay: CreditDisplay,
    private readonly onError: (check: ApiCheck) => void,
    private readonly onReady: () => void
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
      const provider = new UrlTemplateImageryProvider({
        url: `${ENDPOINT}/v1/2dtiles/{z}/{x}/{y}?session=${encodeURIComponent(session.token)}&key=${encodeURIComponent(this.key)}`,
        tileWidth: session.tileWidth,
        tileHeight: session.tileHeight,
        maximumLevel: 22,
        // The Google logo credit Cesium uses for Google data (marked private in its typings).
        credit: (GoogleMaps as unknown as { getDefaultCredit(): Credit }).getDefaultCredit()
      })
      let failures = 0
      provider.errorEvent.addEventListener((err: { error?: unknown }) => {
        const status = httpStatusOf(err.error)
        if (status === 401 || status === 403 || status === 400) {
          failures++
          if (failures === 3) void this.renew()
        }
      })
      this.layer = this.scene.imageryLayers.addImageryProvider(provider, 0)
      this.scheduleRenewal()
      this.updateAttribution()
      this.onReady()
    } catch (error) {
      if (generation !== this.generation) return
      const e = error as { statusCode?: number; response?: string }
      this.onError(classifyGoogleError('Map Tiles API', e.statusCode, e.response ?? '', navigator.onLine))
    }
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
    const north = Math.min(85, deg(rect.north))
    const south = Math.max(-85, deg(rect.south))
    const west = deg(rect.west)
    const east = deg(rect.east)
    const span = Math.max(1e-6, (east - west + 360) % 360 || 360)
    const zoom = Math.max(0, Math.min(22, Math.round(Math.log2((360 * this.scene.canvas.clientWidth) / 256 / span))))
    const q = [north, south, east, west].map((v) => v.toFixed(4)).join(',') + `@${zoom}`
    if (q === this.lastAttributionQuery) return
    this.lastAttributionQuery = q
    const params = new URLSearchParams({
      session: this.session.token,
      key: this.key,
      zoom: String(zoom),
      north: north.toFixed(6),
      south: south.toFixed(6),
      east: east.toFixed(6),
      west: west.toFixed(6)
    })
    try {
      const res = await fetch(`${ENDPOINT}/tile/v1/viewport?${params.toString()}`)
      if (!res.ok) return
      const json = (await res.json()) as { copyright?: string }
      this.setCredit(json.copyright ? json.copyright : null)
    } catch {
      /* attribution refresh is best effort; the Google logo credit stays on screen */
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
    }
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
