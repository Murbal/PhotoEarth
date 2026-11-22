import {
  Cartesian4,
  Credit,
  ImageryLayer,
  Rectangle,
  Sampler,
  Texture,
  TextureMagnificationFilter,
  TextureMinificationFilter,
  UrlTemplateImageryProvider,
  WebMercatorTilingScheme,
  type CesiumContext,
  type CreditDisplay,
  type Scene
} from 'cesium'
import type { LightPollutionSettings } from '@shared/types'
import {
  lightPollutionSource,
  planOverlay,
  readoutSource,
  tileRowInBounds,
  tileUrl,
  type LightPollutionSource,
  type MosaicPlan
} from '../lib/lightPollutionSources'
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

/** Where the overlay on the 3D Tiles is centered, and how high the camera is above the ground. */
export interface OverlayView {
  longitude: number
  latitude: number
  heightAgl: number
}

/** One mosaic as the shader sees it. */
export interface MosaicLayer {
  /** Null while there is none. */
  readonly texture: Texture | null
  /** The mosaic in world Web Mercator units (0–1, y from the north): west, north, width, height. */
  readonly rect: Cartesian4
}

/** What the 3D Tiles' shader reads for the overlay (TilesetManager binds it). */
export interface LightPollutionBinding {
  /** Near the view (detailed), then out to the horizon (coarser, only when the view reaches that far). */
  readonly levels: readonly [MosaicLayer, MosaicLayer]
  /** x: opacity (0: off), y: 1 when the far level is in use. */
  readonly params: Cartesian4
}

/** Near-level fade into the far one, in units of the near block's width. */
const FADE = 0.06

export const LIGHT_POLLUTION_UNIFORMS = {
  textures: ['u_lpTexture0', 'u_lpTexture1'],
  rects: ['u_lpRect0', 'u_lpRect1'],
  params: 'u_lpParams'
} as const

/**
 * The overlay on the 3D Tiles: the mosaics' color at a fragment's latitude and longitude (the
 * near level where it reaches, else the far one), as linear straight-alpha color. The model
 * shader works in linear color and converts back to sRGB at the end, so the colors come out
 * as the source draws them.
 */
export const LIGHT_POLLUTION_RECEIVER_GLSL = /* glsl */ `
// Samples one level; edge: distance from the point to the level's border in its own units (0–0.5
// inside, < 0 outside). Sampled before any bounds test, since mip selection needs derivatives
// from every fragment of a quad.
vec4 pe_lp_level(sampler2D t, vec4 r, vec2 merc, out float edge) {
  // Columns wrap around the antimeridian.
  vec2 uv = vec2(fract(merc.x - r.x), merc.y - r.y) / r.zw;
  edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  return texture(t, clamp(uv, 0.0, 1.0));
}

vec4 pe_lightPollution(vec3 positionWC) {
  if (u_lpParams.x <= 0.0) return vec4(0.0);
  float lon = atan(positionWC.y, positionWC.x);
  // Geodetic latitude (WGS84 e²): exact on the ellipsoid, under 30 m off at mountain heights.
  float lat = atan(positionWC.z, length(positionWC.xy) * (1.0 - 0.00669437999014));
  lat = clamp(lat, -1.4844222, 1.4844222);
  vec2 merc = vec2(lon / czm_twoPi + 0.5, 0.5 - log(tan(czm_piOverFour + 0.5 * lat)) / czm_twoPi);
  float e0;
  float e1;
  vec4 c0 = pe_lp_level(u_lpTexture0, u_lpRect0, merc, e0);
  vec4 c1 = pe_lp_level(u_lpTexture1, u_lpRect1, merc, e1);
  float in0 = step(0.0, e0);
  float in1 = step(0.0, e1) * u_lpParams.y;
  // The near level fades into the far one over the outer ${FADE * 100} % of its width.
  float w = in1 > 0.5 ? clamp(e0 / ${FADE.toFixed(2)}, 0.0, 1.0) : in0;
  vec4 c = mix(c1, c0, w);
  return vec4(czm_srgbToLinear(c.rgb), c.a * u_lpParams.x * max(in0, in1));
}
`

/** A source tile's image; null when the source has none there (no light anywhere in it). */
async function fetchTile(url: string, signal: AbortSignal): Promise<ImageBitmap | null> {
  const res = await fetch(url, { signal })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  // Unconverted, so the colors match the legend (and the atlas palette decodes, as for readouts).
  return createImageBitmap(await res.blob(), { colorSpaceConversion: 'none' })
}

/**
 * One level of the overlay on the 3D Tiles: the source's tiles in a block around the view,
 * drawn into one texture. A new block is drawn off screen and swapped in when all its tiles
 * have settled, so the old one stays up meanwhile.
 */
class MosaicLevel implements MosaicLayer {
  texture: Texture | null = null
  readonly rect = new Cartesian4(0, 0, 1, 1)
  /** The block in the texture (`complete`: every tile arrived). */
  private current: { key: string; complete: boolean } | null = null
  private pendingKey: string | null = null
  private abort: AbortController | null = null

  constructor(
    private readonly scene: Scene,
    /** Texture pixels per source pixel. */
    private readonly scale: number,
    private readonly onChange: () => void
  ) {}

  /** Shows `plan`'s block of `source` (null: none). */
  show(source: LightPollutionSource, plan: MosaicPlan | null): void {
    if (!plan) return this.release()
    const key = `${source.id}/${plan.z}/${plan.x0}/${plan.y0}/${plan.nx}/${plan.ny}`
    if (key === this.pendingKey || (key === this.current?.key && this.current.complete)) return
    void this.load(source, plan, key)
  }

  release(): void {
    this.abort?.abort()
    this.abort = null
    this.pendingKey = null
    this.current = null
    if (!this.texture) return
    this.texture.destroy()
    this.texture = null
    this.onChange()
  }

  private async load(source: LightPollutionSource, plan: MosaicPlan, key: string): Promise<void> {
    this.abort?.abort()
    const abort = (this.abort = new AbortController())
    this.pendingKey = key
    const { url, tileSize: sourceSize, bounds } = source.imagery
    const size = Math.round(sourceSize * this.scale)
    const canvas = document.createElement('canvas')
    canvas.width = plan.nx * size
    canvas.height = plan.ny * size
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      this.pendingKey = null
      return
    }
    const n = 2 ** plan.z
    let complete = true
    const jobs: Array<Promise<void>> = []
    for (let j = 0; j < plan.ny; j++) {
      const y = plan.y0 + j
      if (!tileRowInBounds(plan.z, y, bounds)) continue
      for (let i = 0; i < plan.nx; i++) {
        const x = (plan.x0 + i) % n
        jobs.push(
          fetchTile(tileUrl(url, plan.z, x, y), abort.signal).then(
            (image) => {
              if (abort.signal.aborted) return image?.close()
              if (!image) {
                // No tile: no light there (the darkest color both sources draw).
                ctx.fillStyle = '#000'
                ctx.fillRect(i * size, j * size, size, size)
                return
              }
              ctx.drawImage(image, i * size, j * size, size, size)
              image.close()
            },
            (error: unknown) => {
              // A missing piece stays transparent and is fetched again when the camera next stops.
              complete = false
              if (!abort.signal.aborted) console.warn('[photoearth] light pollution tile failed', error)
            }
          )
        )
      }
    }
    await Promise.all(jobs)
    if (abort.signal.aborted) return
    this.abort = null
    this.pendingKey = null
    const context = (this.scene as unknown as { context: CesiumContext }).context
    const texture = new Texture({
      context,
      source: canvas,
      flipY: false,
      sampler: new Sampler({
        minificationFilter: TextureMinificationFilter.LINEAR_MIPMAP_LINEAR,
        magnificationFilter: TextureMagnificationFilter.LINEAR,
        // The overlay is mostly seen at grazing angles, toward the horizon.
        maximumAnisotropy: 4
      })
    })
    texture.generateMipmap()
    this.texture?.destroy()
    this.texture = texture
    Cartesian4.fromArray(plan.rect, 0, this.rect)
    this.current = { key, complete }
    this.onChange()
  }
}

/**
 * The light pollution overlay on the 3D view. While the terrain globe stands in for the 3D
 * Tiles it is an imagery layer on the globe. On the 3D Tiles it is two mosaics of the source's
 * tiles around the view (see MosaicLevel and planOverlay), which the tileset's shader drapes by
 * latitude and longitude; they move along when the camera stops, never while it moves. It
 * exists only while switched on, so off costs nothing. Inspected points get a sky brightness
 * estimate from the source's point data, else from the color of its tile.
 */
export class LightPollution {
  private readonly near: MosaicLevel
  /** Seen only far off, so drawn at half resolution. */
  private readonly far: MosaicLevel
  readonly binding: LightPollutionBinding
  private layer: ImageryLayer | null = null
  private layerSource: LightPollutionSource | null = null
  private settings: LightPollutionSettings
  /** The overlay is drawn on the 3D Tiles (else on the globe, if at all). */
  private onTiles = false
  /** The source the mosaics are drawn from. */
  private mosaicSource: LightPollutionSource | null = null
  private wasShown = false
  /** The source credit, shown while the overlay is on the 3D Tiles (the globe layer credits itself). */
  private credit: { source: LightPollutionSource; credit: Credit } | null = null
  private readonly data = new Map<string, Promise<Int8Array>>()
  private request = 0
  private readonly unsubscribe: Array<() => void>

  constructor(
    private readonly scene: Scene,
    private readonly creditDisplay: CreditDisplay,
    /** Where the view is now; null before the camera is known. */
    private readonly view: () => OverlayView | null,
    /** Called when the overlay appears or disappears on screen. */
    private readonly onShownChange: (shown: boolean) => void
  ) {
    this.near = new MosaicLevel(scene, 1, () => this.applyMosaics())
    this.far = new MosaicLevel(scene, 0.5, () => this.applyMosaics())
    this.binding = { levels: [this.near, this.far], params: new Cartesian4(0, 0, 0, 0) }
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
    this.near.release()
    this.far.release()
  }

  /** Whether the overlay is drawn right now. */
  get shown(): boolean {
    return this.onTiles ? this.near.texture !== null : !!this.layer?.show
  }

  /** Applies settings; `globeVisible`: the globe stands in for the 3D Tiles (else they are the view). */
  configure(settings: LightPollutionSettings, globeVisible: boolean): void {
    const readoutChanged =
      settings.enabled !== this.settings.enabled || readoutSource(settings.source) !== readoutSource(this.settings.source)
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
    this.onTiles = settings.enabled && !globeVisible
    const source = this.onTiles ? lightPollutionSource(settings.source) : null
    // Another source's mosaics must not stay on screen while this one's load.
    if (source !== this.mosaicSource) {
      this.near.release()
      this.far.release()
      this.mosaicSource = source
    }
    this.recenter()
    this.updateCredit()
    this.applyMosaics()
    if (readoutChanged) void this.updateReadout()
  }

  /** The camera stopped: moves the mosaics along if the view has left them. */
  onViewSettled(): void {
    this.recenter()
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

  // ───────────────────────────── 3D Tiles mosaics ─────────────────────────────

  private recenter(): void {
    const source = this.mosaicSource
    const view = source && this.view()
    if (!source || !view) return
    const plan = planOverlay(source.imagery, view.longitude, view.latitude, view.heightAgl)
    this.near.show(source, plan.near)
    this.far.show(source, plan.far)
  }

  /** Points the shader at the current mosaics and reports the overlay appearing or going. */
  private applyMosaics(): void {
    const { params } = this.binding
    params.x = this.onTiles && this.near.texture ? this.settings.opacity : 0
    params.y = this.far.texture ? 1 : 0
    // Never divide by an empty rectangle in the shader, even where the far level is ignored.
    if (!this.far.texture) Cartesian4.clone(this.near.rect, this.far.rect)
    const shown = this.shown
    if (shown !== this.wasShown) {
      this.wasShown = shown
      this.onShownChange(shown)
    }
    this.scene.requestRender()
  }

  private updateCredit(): void {
    const source = this.onTiles ? lightPollutionSource(this.settings.source) : null
    if (this.credit?.source === source) return
    if (this.credit) this.creditDisplay.removeStaticCredit(this.credit.credit)
    this.credit = source ? { source, credit: new Credit(source.imagery.credit, false) } : null
    if (this.credit) this.creditDisplay.addStaticCredit(this.credit.credit)
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
