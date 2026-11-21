import { Credit, ImageryLayer, Rectangle, UrlTemplateImageryProvider, WebMercatorTilingScheme, type Scene } from 'cesium'
import type { LightPollutionSettings } from '@shared/types'
import { lightPollutionSource, readoutSource, tileUrl, type LightPollutionSource } from '../lib/lightPollutionSources'
import {
  atlasCell,
  atlasRatioAt,
  decodeZoneColor,
  estimateFromRatio,
  estimateFromZone,
  mercatorPixel,
  type SkyEstimate
} from '../lib/skyBrightness'
import { appState, useAppStore } from '../store/appStore'

/** Inflated data tiles kept for repeat clicks (~360 kB each). */
const DATA_CACHE = 8

async function inflate(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  const head = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength))
  // Served as application/gzip (not Content-Encoding), but don't double-inflate if that changes.
  if (head[0] !== 0x1f || head[1] !== 0x8b) return buffer
  return new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
}

/**
 * The light pollution overlay: one imagery layer on the globe, so it shows in
 * Elevation mode (and wherever the globe is the backdrop). It exists only while switched on,
 * so off costs nothing. Inspected points get a sky brightness estimate from the source's
 * point data, else from the color of its tile.
 */
export class LightPollution {
  private layer: ImageryLayer | null = null
  private layerSource: LightPollutionSource | null = null
  private settings: LightPollutionSettings
  private readonly data = new Map<string, Promise<Int8Array>>()
  private request = 0
  private readonly unsubscribe: Array<() => void>

  constructor(
    private readonly scene: Scene,
    /** Called when the layer appears or disappears on screen. */
    private readonly onShownChange: (shown: boolean) => void
  ) {
    this.settings = appState().settings.lightPollution
    this.unsubscribe = [
      // Coordinates only: the card's screen position changes every frame while moving.
      useAppStore.subscribe(
        (s) => (s.inspect ? `${s.inspect.longitude},${s.inspect.latitude}` : null),
        () => void this.updateReadout()
      )
    ]
  }

  destroy(): void {
    this.request++
    this.unsubscribe.forEach((u) => u())
    this.removeLayer()
  }

  /** Whether the overlay is drawn right now. */
  get shown(): boolean {
    return !!this.layer?.show
  }

  /** Applies settings; `globeVisible`: whether the globe (which carries the layer) is drawn. */
  configure(settings: LightPollutionSettings, globeVisible: boolean): void {
    const readoutChanged =
      settings.enabled !== this.settings.enabled || readoutSource(settings.source) !== readoutSource(this.settings.source)
    const wasShown = this.shown
    this.settings = settings
    if (!settings.enabled) this.removeLayer()
    else {
      const source = lightPollutionSource(settings.source)
      if (source !== this.layerSource) {
        this.removeLayer()
        this.addLayer(source)
      }
      const layer = this.layer!
      layer.alpha = settings.opacity
      layer.show = globeVisible
    }
    if (this.shown !== wasShown) this.onShownChange(this.shown)
    if (readoutChanged) void this.updateReadout()
    this.scene.requestRender()
  }

  private addLayer(source: LightPollutionSource): void {
    const { url, tileSize, maximumLevel, bounds, credit } = source.imagery
    const provider = new UrlTemplateImageryProvider({
      url,
      tilingScheme: new WebMercatorTilingScheme(),
      tileWidth: tileSize,
      tileHeight: tileSize,
      minimumLevel: 0,
      maximumLevel,
      rectangle: Rectangle.fromDegrees(bounds.west, bounds.south, bounds.east, bounds.north),
      credit: new Credit(credit, false)
    })
    // Tiles with no light (open ocean) are simply missing; the globe keeps the coarser parent.
    provider.errorEvent.addEventListener(() => undefined)
    // Above the Google imagery (which is inserted at the bottom).
    this.layer = this.scene.imageryLayers.addImageryProvider(provider)
    this.layerSource = source
  }

  private removeLayer(): void {
    if (this.layer) this.scene.imageryLayers.remove(this.layer, true)
    this.layer = null
    this.layerSource = null
  }

  // ───────────────────────────── point readout ─────────────────────────────

  private async updateReadout(): Promise<void> {
    const id = ++this.request
    const inspect = appState().inspect
    if (!inspect || !this.settings.enabled) {
      if (appState().sky) appState().set({ sky: null })
      return
    }
    const source = readoutSource(this.settings.source)
    appState().set({ sky: { status: 'loading', source: source.label, estimate: null } })
    let estimate: SkyEstimate | null | 'outside'
    try {
      estimate = await this.sample(source, inspect.longitude, inspect.latitude)
    } catch (error) {
      console.warn('[photoearth] sky brightness unavailable', error)
      estimate = null
    }
    if (id !== this.request) return
    appState().set({
      sky: {
        status: estimate === 'outside' ? 'outside' : estimate ? 'ready' : 'unavailable',
        source: source.label,
        estimate: estimate === 'outside' ? null : estimate
      }
    })
  }

  /**
   * Sky brightness at a point: the modeled value of its ~1 km cell from the data tiles, else
   * (data unavailable) its zone from the color tile. `outside`: beyond the data's coverage.
   */
  async sample(source: LightPollutionSource, longitude: number, latitude: number): Promise<SkyEstimate | null | 'outside'> {
    const cell = atlasCell(longitude, latitude)
    const b = source.imagery.bounds
    if (!cell || latitude < b.south || latitude >= b.north) return 'outside'
    if (source.dataUrl) {
      try {
        const tile = await this.dataTile(source.dataUrl(cell.tileX, cell.tileY))
        return estimateFromRatio(atlasRatioAt(tile, cell.row, cell.col))
      } catch (error) {
        console.warn('[photoearth] atlas data tile failed; falling back to tile colors', error)
      }
    }
    if (!source.atlasPalette) return null
    const zone = await this.tileZone(source, longitude, latitude)
    return zone === null ? null : estimateFromZone(zone)
  }

  private dataTile(url: string): Promise<Int8Array> {
    const cached = this.data.get(url)
    if (cached) {
      // Most recently used last.
      this.data.delete(url)
      this.data.set(url, cached)
      return cached
    }
    const load = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.arrayBuffer()
      })
      .then(inflate)
      .then((buffer) => new Int8Array(buffer))
    load.catch(() => this.data.delete(url))
    this.data.set(url, load)
    while (this.data.size > DATA_CACHE) this.data.delete(this.data.keys().next().value!)
    return load
  }

  /** The atlas zone drawn at a point on its most detailed color tile (CPU decode, no GPU). */
  private async tileZone(source: LightPollutionSource, longitude: number, latitude: number): Promise<number | null> {
    const { url, tileSize, maximumLevel } = source.imagery
    const p = mercatorPixel(longitude, latitude, maximumLevel, tileSize)
    const res = await fetch(tileUrl(url, maximumLevel, p.x, p.y))
    // No tile: no light anywhere in it.
    if (res.status === 404) return 0
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const bitmap = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
    try {
      const canvas = new OffscreenCanvas(1, 1)
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return null
      ctx.drawImage(bitmap, p.px, p.py, 1, 1, 0, 0, 1, 1)
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
      return decodeZoneColor(r, g, b)
    } finally {
      bitmap.close()
    }
  }
}
