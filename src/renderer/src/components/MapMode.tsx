import { useEffect, useRef, useState } from 'react'
import { matchesFilter } from '@shared/locations'
import type { Bookmark } from '@shared/types'
import { GOOGLE_LOGO_URL } from '../engine/googleTiles'
import { getEngine } from '../engine/instance'
import { setMapControl, type MapControl } from '../engine/mapControl'
import { WheelClassifier } from '../engine/WheelInput'
import {
  creditText,
  lightPollutionSource,
  mapLightPollutionZoom,
  tileUrl as lightPollutionTileUrl,
  type LightPollutionSource
} from '../lib/lightPollutionSources'
import { niceScale } from '../lib/units'
import {
  clampZoom,
  fromScreen,
  metersPerPixel,
  panBy,
  project,
  sameView,
  TILE,
  backdropZoomFor,
  centerNear,
  tileRange,
  tileUrl,
  tileZoomFor,
  toScreen,
  unproject,
  viewBounds,
  viewReach,
  wedgePath,
  worldSize,
  wrapColumn,
  zoomAround,
  type MapView,
  type Point
} from '../lib/webMercator'
import { shellState, useShellStore } from '../shell/shellStore'
import { appState, useAppStore } from '../store/appStore'
import { projectsState, useProjectsStore } from '../store/projectsStore'

/** Light pollution tiles kept (1024 px atlas tiles are ~4 MB decoded). */
const LIGHT_POLLUTION_CACHE = 40
/** A light pollution tile still loading is stood in for by an ancestor up to this many zooms coarser. */
const LIGHT_POLLUTION_FALLBACK_LEVELS = 3

/** A press that moves less than this is a click. */
const CLICK_SLOP = 4
/**
 * Tiles of other zooms stay underneath until the current zoom's tiles cover the view, or this
 * long after it became current (tiles that never arrive mustn't keep them forever).
 */
const STALE_MS = 2500
/** At most this many other zooms are kept underneath (the nearest to the current one). */
const MAX_STALE_LAYERS = 3
/** A new zoom's tiles show as a whole when they cover the view, or after this long anyway. */
const REVEAL_MS = 600
/** The view is saved and its attribution fetched once it stands still this long. */
const SETTLE_MS = 250
/** One mouse-wheel notch (100 px) zooms one level. */
const WHEEL_PIXELS_PER_ZOOM = 100
/** A wheel or button zoom step takes this long. */
const WHEEL_EASE_MS = 220
/** Held arrow / WASD keys pan this many screen pixels per second (Shift: 2.5×). */
const KEY_PAN_SPEED = 700
/** Inertia after a drag: velocity halves every this many ms. */
const INERTIA_HALF_LIFE = 110
const PAN_KEYS: Record<string, Point> = {
  ArrowUp: { x: 0, y: 1 },
  KeyW: { x: 0, y: 1 },
  ArrowDown: { x: 0, y: -1 },
  KeyS: { x: 0, y: -1 },
  ArrowLeft: { x: 1, y: 0 },
  KeyA: { x: 1, y: 0 },
  ArrowRight: { x: -1, y: 0 },
  KeyD: { x: -1, y: 0 }
}

interface TileImage {
  /** Not in the DOM: only drawn into the canvas. */
  img: HTMLImageElement
  x: number
  y: number
  /** Downloaded and decoded: drawable without a stall. */
  ready: boolean
}

/** A light pollution tile; `failed`: missing (open ocean has none) or unreachable. */
interface OverlayTile {
  img: HTMLImageElement
  ready: boolean
  failed: boolean
}

/** The tiles of one whole zoom. */
interface Layer {
  zoom: number
  /** The view's center x when the layer was made: picks its copy of the world. */
  anchorX: number
  /** The current zoom is hidden until it covers the view (or REVEAL_MS), then shown whole. */
  shown: boolean
  tiles: Map<string, TileImage>
  /** When this zoom last became the drawn one. */
  currentSince: number
}

/** A tile drawn in the last frame, in CSS pixels (for tests). */
export interface DrawnTile {
  zoom: number
  url: string
  left: number
  top: number
  right: number
  bottom: number
}

interface Animation {
  from: MapView
  to: MapView
  start: number
  duration: number
}

interface Pin {
  el: HTMLButtonElement
  longitude: number
  latitude: number
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable
}

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)

/**
 * The map's drawing and input, outside React. Decoded tile images are drawn into
 * one 2D canvas the size of the window: a frame clears it and draws a few dozen images, and
 * frames run only while something moves. One canvas means one compositor surface whatever
 * the zoom or the levels kept underneath (CSS-scaled layers of <img> tiles each became a
 * window-sized GPU raster, and ran out of Chromium's tile memory), and nothing reads back.
 * It never touches the WebGL context, which is paused under the map.
 */
class MapRenderer implements MapControl {
  private current: MapView
  private width = 1
  private height = 1
  private readonly layers = new Map<number, Layer>()
  private template: string | null = null
  /** The whole zoom whose tiles are drawn on top. */
  private tileZoom: number | null = null
  /** The current zoom is revealed and covers the view: nothing under it needs drawing. */
  private currentCovers = false
  /** The zoom of the always-loaded coarse backdrop. */
  private backdropZoom: number | null = null
  private raf: number | null = null
  private lastFrame = 0
  private animation: Animation | null = null
  /**
   * Smooth wheel zoom: from which zoom, when, to which, about which screen point. Eased by
   * elapsed time, so it ends on time at any frame rate.
   */
  private wheelZoom: { from: number; start: number; target: number; anchor: Point } | null = null
  private readonly wheel = new WheelClassifier()
  private drag: { id: number; x: number; y: number; t: number; moved: boolean } | null = null
  /** Screen pixels per ms, for inertia. */
  private velocity: Point = { x: 0, y: 0 }
  private inertia = false
  private readonly keys = new Set<string>()
  private shift = false
  /** Until when held keys have panned the map. */
  private keyPanAt = 0
  private settleTimer: number | null = null
  private attributionKey = ''
  private lastReadout = 0
  private probing = false
  /** A drag just ended with movement: the click that follows it isn't one. */
  dragged = false
  private readonly ctx: CanvasRenderingContext2D
  private dpr = 1
  /** What the last frame drew, kept only when asked for (tests). */
  private drawn: DrawnTile[] | null = null
  private pins = new Map<string, Pin>()
  private destination: Pin | null = null
  /** Light pollution tiles by `z/x/y` (wrapped x), oldest first; and the source they're from. */
  private readonly lightTiles = new Map<string, OverlayTile>()
  private lightSource: LightPollutionSource | null = null
  private readonly disposers: Array<() => void> = []

  constructor(
    private readonly root: HTMLDivElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly pinsEl: HTMLDivElement,
    private readonly wedge: SVGPathElement,
    private readonly marker: SVGGElement,
    private readonly onAttribution: (text: string | null) => void
  ) {
    const { longitude, latitude, zoom } = appState().settings.map
    this.current = { longitude, latitude, zoom: clampZoom(zoom) }
    this.ctx = canvas.getContext('2d', { alpha: true })!
    const resize = () => {
      this.width = Math.max(1, root.clientWidth)
      this.height = Math.max(1, root.clientHeight)
      this.dpr = window.devicePixelRatio || 1
      // Device pixels, so tiles are drawn sharp and their edges snapped to whole pixels.
      canvas.width = Math.round(this.width * this.dpr)
      canvas.height = Math.round(this.height * this.dpr)
      this.invalidate()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(root)
    resize()
    const onWheel = (e: WheelEvent) => this.onWheel(e)
    const onKey = (e: KeyboardEvent) => this.onKey(e, e.type === 'keydown')
    const onBlur = () => this.keys.clear()
    root.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    window.addEventListener('blur', onBlur)
    this.disposers.push(
      () => observer.disconnect(),
      () => root.removeEventListener('wheel', onWheel),
      () => window.removeEventListener('keydown', onKey),
      () => window.removeEventListener('keyup', onKey),
      () => window.removeEventListener('blur', onBlur),
      // A new session (first one, renewal, map type): new tiles, and its own attribution.
      useAppStore.subscribe(
        (s) => s.mapSession?.template ?? null,
        () => {
          this.attributionKey = ''
          this.onAttribution(null)
          this.moved()
        }
      ),
      useAppStore.subscribe(
        (s) => s.camera,
        () => this.invalidate()
      ),
      useAppStore.subscribe(
        (s) => s.settings.lightPollution,
        () => this.invalidate()
      ),
      useAppStore.subscribe(
        (s) => [s.bookmarks, s.locationFilter, s.locationScope, s.dimOtherLocations, s.activeLocation, s.settings.showLocationMarkers, s.destination] as const,
        () => this.syncPins(),
        { equalityFn: (a, b) => a.every((v, i) => v === b[i]) }
      ),
      useShellStore.subscribe((s) => s.activeProjectId, () => this.syncPins()),
      useProjectsStore.subscribe((s) => s.projects, () => this.syncPins())
    )
    this.syncPins()
    this.invalidate()
    this.scheduleSettle()
  }

  destroy(): void {
    this.disposers.forEach((d) => d())
    if (this.raf !== null) cancelAnimationFrame(this.raf)
    if (this.settleTimer !== null) window.clearTimeout(this.settleTimer)
    for (const zoom of [...this.layers.keys()]) this.removeLayer(zoom)
    this.clearLightTiles()
    appState().set({ cursor: null })
  }

  // ───────────── MapControl ─────────────

  view(): MapView {
    return { ...this.current }
  }

  setView(view: MapView, animate: boolean): void {
    const to = { ...view, zoom: clampZoom(view.zoom) }
    this.stopMotion()
    // Further than a few screens away an eased glide would only blur past: jump.
    const z = Math.min(this.current.zoom, to.zoom)
    const a = project(this.current, z)
    const b = project(to, z)
    const screens = Math.hypot(a.x - b.x, a.y - b.y) / Math.max(this.width, this.height)
    if (!animate || screens > 4) {
      this.current = to
      this.moved()
      return
    }
    this.animation = { from: this.view(), to, start: performance.now(), duration: 450 }
    this.invalidate()
  }

  zoomBy(steps: number): void {
    this.zoomTo(clampZoom((this.wheelZoom?.target ?? this.current.zoom) + steps), { x: this.width / 2, y: this.height / 2 })
  }

  private zoomTo(target: number, anchor: Point): void {
    this.animation = null
    this.inertia = false
    this.wheelZoom = { from: this.current.zoom, start: performance.now(), target, anchor }
    this.invalidate()
  }

  // ───────────── frames ─────────────

  private invalidate(): void {
    if (this.raf === null) this.raf = requestAnimationFrame((t) => this.frame(t))
  }

  private frame(now: number): void {
    this.raf = null
    // Capped, so a stalled frame doesn't throw the map across the world.
    const dt = this.lastFrame ? Math.min(now - this.lastFrame, 100) : 16
    this.lastFrame = now
    let moving = false
    if (this.animation) {
      const a = this.animation
      const t = Math.min(1, (performance.now() - a.start) / a.duration)
      this.current = interpolate(a.from, a.to, ease(t))
      if (t >= 1) this.animation = null
      moving = true
    }
    if (this.wheelZoom) {
      const w = this.wheelZoom
      const t = Math.min(1, (performance.now() - w.start) / WHEEL_EASE_MS)
      // Ease-out; the last frame lands exactly on the target.
      const zoom = t >= 1 ? w.target : w.from + (w.target - w.from) * (1 - (1 - t) ** 3)
      this.current = zoomAround(this.current, zoom, w.anchor, this.width, this.height)
      if (t >= 1) this.wheelZoom = null
      moving = true
    }
    if (this.inertia) {
      const decay = Math.pow(0.5, dt / INERTIA_HALF_LIFE)
      this.velocity = { x: this.velocity.x * decay, y: this.velocity.y * decay }
      this.current = panBy(this.current, this.velocity.x * dt, this.velocity.y * dt)
      if (Math.hypot(this.velocity.x, this.velocity.y) < 0.02) this.inertia = false
      moving = true
    }
    if (this.keys.size > 0) {
      this.keyPan()
      moving = true
    }
    this.draw()
    if (moving) {
      this.lastReadoutUpdate(now)
      this.scheduleSettle()
      this.invalidate()
    } else {
      this.lastFrame = 0
    }
  }

  /** The view changed outside a running frame (drag, jump): draw and settle. */
  private moved(): void {
    this.invalidate()
    this.scheduleSettle()
  }

  private stopMotion(): void {
    this.animation = null
    this.wheelZoom = null
    this.inertia = false
  }

  private draw(): void {
    const view = this.current
    this.placeTiles(view)
    this.drawTiles(view)
    this.drawLightPollution(view)
    this.positionOverlay(view)
  }

  /** Test builds: what the last frame drew (from now on). */
  drawnTiles(): DrawnTile[] {
    if (!this.drawn) {
      this.drawn = []
      this.invalidate()
    }
    return this.drawn
  }

  /** Test builds: tile and layer counts. */
  tileState(): { layers: number; tiles: number; ready: number; urls: string[] } {
    let tiles = 0
    let ready = 0
    const urls: string[] = []
    for (const layer of this.layers.values()) {
      for (const t of layer.tiles.values()) {
        tiles++
        if (t.ready) ready++
        urls.push(t.img.src)
      }
    }
    return { layers: this.layers.size, tiles, ready, urls }
  }

  /**
   * Draws the backdrop, then the previous zooms from the farthest to the nearest, then the
   * current zoom (once revealed). Each tile's edges are rounded to whole device pixels from
   * the same formula as its neighbor's, so tiles meet exactly: no seams, at any scale.
   */
  private drawTiles(view: MapView): void {
    const ctx = this.ctx
    const dpr = this.dpr
    const cw = this.canvas.width
    const ch = this.canvas.height
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, cw, ch)
    const tz = this.tileZoom
    const backdrop = this.backdropZoom
    // Bottom to top: the backdrop, the previous zooms from the farthest, the current zoom.
    const rank = (l: Layer): number => (l.zoom === tz ? -1 : l.zoom === backdrop ? 1000 : tz === null ? 0 : Math.abs(l.zoom - tz))
    // When the current zoom covers the view, the layers under it would only be painted over.
    const order = this.currentCovers
      ? [...this.layers.values()].filter((l) => l.zoom === tz)
      : [...this.layers.values()].filter((l) => l.zoom !== tz || l.shown).sort((a, b) => rank(b) - rank(a))
    const drawn: DrawnTile[] | null = this.drawn ? [] : null
    ctx.imageSmoothingEnabled = true
    // Bilinear: tiles are drawn at 64–157 % (the backdrop larger), where mipmapped filtering
    // ('medium' / 'high') costs far more and looks the same.
    ctx.imageSmoothingQuality = 'low'
    for (const layer of order) {
      const scale = 2 ** (view.zoom - layer.zoom)
      const cx = centerNear(view, layer.zoom, layer.anchorX)
      const cy = project(view, layer.zoom).y
      const size = TILE * scale
      const ox = this.width / 2 - cx * scale
      const oy = this.height / 2 - cy * scale
      for (const t of layer.tiles.values()) {
        if (!t.ready) continue
        const left = ox + t.x * size
        const top = oy + t.y * size
        if (left > this.width || top > this.height || left + size < 0 || top + size < 0) continue
        const x0 = Math.round(left * dpr)
        const y0 = Math.round(top * dpr)
        const x1 = Math.round((left + size) * dpr)
        const y1 = Math.round((top + size) * dpr)
        ctx.drawImage(t.img, x0, y0, x1 - x0, y1 - y0)
        drawn?.push({ zoom: layer.zoom, url: t.img.src, left: x0 / dpr, top: y0 / dpr, right: x1 / dpr, bottom: y1 / dpr })
      }
    }
    if (drawn) this.drawn = drawn
  }

  // ───────────── light pollution ─────────────

  /**
   * The light pollution layer over the map (the same tiles the 3D view's globe layer shows), at
   * the panel's opacity. A tile still loading is stood in for by the matching part of an
   * ancestor, so zooming doesn't blink.
   */
  private drawLightPollution(view: MapView): void {
    const lp = appState().settings.lightPollution
    if (!lp.enabled) {
      if (this.lightTiles.size) this.clearLightTiles()
      return
    }
    const source = lightPollutionSource(lp.source)
    if (source !== this.lightSource) {
      this.clearLightTiles()
      this.lightSource = source
    }
    const { tileSize, bounds } = source.imagery
    const z = mapLightPollutionZoom(this.tileZoom ?? tileZoomFor(view.zoom), source.imagery)
    const scale = 2 ** (view.zoom - z)
    const c = project(view, z)
    const size = TILE * scale
    const ox = this.width / 2 - c.x * scale
    const oy = this.height / 2 - c.y * scale
    const range = tileRange(view, z, this.width, this.height, 0, c.x)
    // No tiles outside the source's coverage.
    const north = Math.floor(project({ longitude: 0, latitude: bounds.north }, z).y / TILE)
    const south = Math.floor((project({ longitude: 0, latitude: bounds.south }, z).y - 1e-9) / TILE)
    const ctx = this.ctx
    const dpr = this.dpr
    ctx.globalAlpha = lp.opacity
    for (let y = Math.max(range.y0, north); y <= Math.min(range.y1, south); y++) {
      for (let x = range.x0; x <= range.x1; x++) {
        let tile: OverlayTile | null = this.lightTile(source, z, wrapColumn(x, z), y)
        let sx = 0
        let sy = 0
        let sw = tileSize
        for (let k = 1; !tile?.ready && k <= LIGHT_POLLUTION_FALLBACK_LEVELS && z - k >= 0; k++) {
          const f = 2 ** k
          const ax = Math.floor(x / f)
          const ay = Math.floor(y / f)
          tile = this.lightTiles.get(`${z - k}/${wrapColumn(ax, z - k)}/${ay}`) ?? null
          sw = tileSize / f
          sx = (x - ax * f) * sw
          sy = (y - ay * f) * sw
        }
        if (!tile?.ready) continue
        const left = ox + x * size
        const top = oy + y * size
        const x0 = Math.round(left * dpr)
        const y0 = Math.round(top * dpr)
        const x1 = Math.round((left + size) * dpr)
        const y1 = Math.round((top + size) * dpr)
        ctx.drawImage(tile.img, sx, sy, sw, sw, x0, y0, x1 - x0, y1 - y0)
      }
    }
    ctx.globalAlpha = 1
  }

  /** A light pollution tile, requested on first use; the cache keeps the most recently used. */
  private lightTile(source: LightPollutionSource, z: number, x: number, y: number): OverlayTile {
    const key = `${z}/${x}/${y}`
    const cached = this.lightTiles.get(key)
    if (cached) {
      this.lightTiles.delete(key)
      this.lightTiles.set(key, cached)
      return cached
    }
    const img = new Image()
    img.decoding = 'async'
    const created: OverlayTile = { img, ready: false, failed: false }
    img.onerror = () => (created.failed = true)
    img.src = lightPollutionTileUrl(source.imagery.url, z, x, y)
    img
      .decode()
      .then(() => {
        if (this.lightTiles.get(key) !== created) return
        created.ready = true
        this.invalidate()
      })
      .catch(() => (created.failed = true))
    this.lightTiles.set(key, created)
    while (this.lightTiles.size > LIGHT_POLLUTION_CACHE) {
      const [oldKey, old] = this.lightTiles.entries().next().value!
      if (!old.ready) old.img.src = ''
      this.lightTiles.delete(oldKey)
    }
    return created
  }

  private clearLightTiles(): void {
    for (const tile of this.lightTiles.values()) {
      tile.img.onerror = null
      // Stops a download in flight.
      if (!tile.ready) tile.img.src = ''
    }
    this.lightTiles.clear()
    this.lightSource = null
  }

  // ───────────── tiles ─────────────

  /**
   * Three kinds of layers, so the map never shows bare background:
   * - the current zoom's tiles on top, revealed as a whole once they cover the view (no
   *   patchwork of sharp and blurry tiles), or after REVEAL_MS;
   * - the previous zooms underneath, scaled, until then;
   * - a coarse backdrop BACKDROP_LEVELS zooms down, always loaded (a handful of tiles), for
   *   whatever the others don't cover (a quick zoom out, a fast pan).
   */
  private placeTiles(view: MapView): void {
    const session = appState().mapSession
    if (session?.template !== this.template) {
      for (const zoom of [...this.layers.keys()]) this.removeLayer(zoom)
      this.template = session?.template ?? null
      this.tileZoom = null
      this.currentCovers = false
    }
    if (!this.template) return
    const now = performance.now()
    const tz = tileZoomFor(view.zoom, this.tileZoom)
    const current = this.ensureLayer(tz, view)
    if (tz !== this.tileZoom) {
      current.currentSince = now
      current.shown = false
    }
    this.tileZoom = tz
    const bz = backdropZoomFor(tz)
    this.backdropZoom = bz
    const backdrop = bz === null ? null : this.ensureLayer(bz, view)
    if (backdrop) backdrop.shown = true
    const backdropCovers = backdrop ? this.fill(backdrop, view, 1) : false
    const covered = this.fill(current, view, 0)
    const others = [...this.layers.values()]
      .filter((l) => l.zoom !== tz && l.zoom !== bz)
      .sort((a, b) => Math.abs(a.zoom - tz) - Math.abs(b.zoom - tz))
    const waited = now - current.currentSince
    // Nothing else to look at (first tiles): show tiles as they come.
    const alone = others.length === 0 && !backdropCovers
    if (!current.shown && (covered || alone || waited > REVEAL_MS)) current.shown = true
    this.currentCovers = covered && current.shown
    others.forEach((other, i) => {
      if ((current.shown && covered) || waited > STALE_MS || i >= MAX_STALE_LAYERS) this.removeLayer(other.zoom)
    })
    // Waiting for tiles: look again next frame (decodes also invalidate).
    if (!covered && waited <= STALE_MS) this.invalidate()
  }

  private ensureLayer(zoom: number, view: MapView): Layer {
    let layer = this.layers.get(zoom)
    if (layer) return layer
    layer = { zoom, anchorX: project(view, zoom).x, tiles: new Map(), currentSince: performance.now(), shown: true }
    this.layers.set(zoom, layer)
    return layer
  }

  /**
   * Creates `layer`'s tiles over the view plus `margin` tiles and drops those further than a
   * ring beyond. Returns whether decoded tiles cover the view.
   */
  private fill(layer: Layer, view: MapView, margin: number): boolean {
    const template = this.template!
    const z = layer.zoom
    // Columns counted in the copy of the world the layer is drawn in (see positionLayer).
    const cx = centerNear(view, z, layer.anchorX)
    const range = tileRange(view, z, this.width, this.height, margin, cx)
    for (let y = range.y0; y <= range.y1; y++) {
      for (let x = range.x0; x <= range.x1; x++) {
        const key = `${x}/${y}`
        if (layer.tiles.has(key)) continue
        const img = new Image()
        img.decoding = 'async'
        const tile: TileImage = { img, x, y, ready: false }
        img.onerror = () => this.onTileError(img.src)
        img.src = tileUrl(template, z, wrapColumn(x, z), y)
        // Drawn, and counted as covering, only once decoded: drawing an undecoded image would
        // decode it on the frame, and dropping the tiles underneath before then would flash.
        img
          .decode()
          .then(() => {
            if (layer.tiles.get(key) !== tile) return
            tile.ready = true
            this.invalidate()
          })
          .catch(() => undefined)
        layer.tiles.set(key, tile)
      }
    }
    // Tiles well out of view go; a ring of one tile stays, so small pans back don't refetch.
    for (const [key, tile] of layer.tiles) {
      const [x, y] = key.split('/').map(Number)
      if (x < range.x0 - 1 || x > range.x1 + 1 || y < range.y0 - 1 || y > range.y1 + 1) {
        tile.img.onerror = null
        // Stops a download in flight.
        tile.img.src = ''
        layer.tiles.delete(key)
      }
    }
    const inner = margin === 0 ? range : tileRange(view, z, this.width, this.height, 0, cx)
    for (let y = inner.y0; y <= inner.y1; y++) {
      for (let x = inner.x0; x <= inner.x1; x++) if (!layer.tiles.get(`${x}/${y}`)?.ready) return false
    }
    return true
  }

  private removeLayer(zoom: number): void {
    const layer = this.layers.get(zoom)
    if (!layer) return
    for (const tile of layer.tiles.values()) {
      tile.img.onerror = null
      if (!tile.ready) tile.img.src = ''
    }
    this.layers.delete(zoom)
  }

  /**
   * An <img> can't see the HTTP status. Ask once more with fetch: an expired or rejected
   * session (400/401/403) counts towards renewing it; missing tiles and network errors don't.
   */
  private onTileError(url: string): void {
    if (this.probing || !navigator.onLine) return
    this.probing = true
    void fetch(url)
      .then((res) => {
        if (res.status === 400 || res.status === 401 || res.status === 403) getEngine()?.mapTiles.reportFailure()
      })
      .catch(() => undefined)
      .finally(() => (this.probing = false))
  }

  // ───────────── camera, pins ─────────────

  private positionOverlay(view: MapView): void {
    const cam = appState().camera
    if (cam) {
      const p = toScreen(cam, view, this.width, this.height)
      const reach = viewReach(cam.heightAgl ?? cam.heightMsl, cam.pitch, cam.fov)
      const length = Math.min(reach / metersPerPixel(cam.latitude, view.zoom), 2 * Math.max(this.width, this.height))
      this.wedge.setAttribute('d', wedgePath(p, cam.heading, cam.fov, Math.max(length, 16)))
      this.marker.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)}) rotate(${cam.heading.toFixed(1)})`)
    }
    for (const pin of this.pins.values()) this.positionPin(pin, view)
    if (this.destination) this.positionPin(this.destination, view)
  }

  private positionPin(pin: Pin, view: MapView): void {
    const p = toScreen(pin, view, this.width, this.height)
    const off = p.x < -200 || p.y < -50 || p.x > this.width + 200 || p.y > this.height + 50
    pin.el.style.display = off ? 'none' : ''
    if (!off) pin.el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`
  }

  /** Saved locations (as the panel's filter & active project scope show them) and the search pin. */
  private syncPins(): void {
    const { bookmarks, locationFilter, locationScope, dimOtherLocations, activeLocation, panels, settings, destination } = appState()
    const active = panels.bookmarks ? activeLocation : null
    const activeProjectId = shellState().activeProjectId
    const activeProject = activeProjectId ? projectsState().projects.find((p) => p.id === activeProjectId) ?? null : null
    const scopedToProject = locationScope === 'project' && !!activeProject
    const projectIds = scopedToProject ? new Set(activeProject.locationIds) : null
    const shown: Bookmark[] = []
    const dimmed = new Set<string>()
    if (settings.showLocationMarkers) {
      for (const b of bookmarks) {
        const passesFilter = b.id === active || matchesFilter(b, locationFilter)
        if (!passesFilter) continue
        if (!projectIds || projectIds.has(b.id) || b.id === active) {
          shown.push(b)
        } else if (dimOtherLocations) {
          shown.push(b)
          dimmed.add(b.id)
        }
      }
    }
    const keep = new Set(shown.map((b) => b.id))
    for (const [id, pin] of this.pins) {
      if (!keep.has(id)) {
        pin.el.remove()
        this.pins.delete(id)
      }
    }
    for (const b of shown) {
      let pin = this.pins.get(b.id)
      if (!pin) {
        const el = document.createElement('button')
        el.type = 'button'
        el.addEventListener('click', () => {
          if (this.dragged) return
          appState().set({ activeLocation: b.id })
          appState().togglePanel('bookmarks', true)
        })
        el.addEventListener('pointerdown', (e) => e.stopPropagation())
        this.pinsEl.appendChild(el)
        pin = { el, longitude: 0, latitude: 0 }
        this.pins.set(b.id, pin)
      }
      pin.longitude = b.position.longitude
      pin.latitude = b.position.latitude
      pin.el.className = `map-pin ${b.status === 'visited' ? 'visited' : ''} ${b.id === active ? 'active' : ''} ${dimmed.has(b.id) ? 'dimmed' : ''}`
      pin.el.setAttribute('aria-label', `Saved location: ${b.name}`)
      pin.el.innerHTML = '<span class="dot"></span><span class="name"></span>'
      pin.el.querySelector('.name')!.textContent = b.name
    }
    if (destination && !this.destination) {
      const el = document.createElement('button')
      el.type = 'button'
      el.className = 'map-pin destination'
      el.tabIndex = -1
      el.innerHTML = '<span class="dot"></span><span class="name"></span>'
      this.pinsEl.appendChild(el)
      this.destination = { el, longitude: 0, latitude: 0 }
    }
    if (!destination && this.destination) {
      this.destination.el.remove()
      this.destination = null
    }
    if (destination && this.destination) {
      this.destination.longitude = destination.longitude
      this.destination.latitude = destination.latitude
      this.destination.el.setAttribute('aria-label', `Search result: ${destination.name}`)
      this.destination.el.querySelector('.name')!.textContent = destination.name
    }
    this.invalidate()
  }

  // ───────────── input ─────────────

  pointerDown(e: React.PointerEvent): void {
    if (e.button !== 0) return
    this.stopMotion()
    this.velocity = { x: 0, y: 0 }
    this.dragged = false
    this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, moved: false }
  }

  pointerMove(e: React.PointerEvent): void {
    const d = this.drag
    if (d && d.id === e.pointerId) {
      const dx = e.clientX - d.x
      const dy = e.clientY - d.y
      if (!d.moved && Math.hypot(dx, dy) < CLICK_SLOP) return
      if (!d.moved) this.root.setPointerCapture(e.pointerId)
      d.moved = true
      const dt = Math.max(1, e.timeStamp - d.t)
      // Smoothed, so the last jittery event doesn't decide the throw.
      this.velocity = { x: this.velocity.x * 0.4 + (dx / dt) * 0.6, y: this.velocity.y * 0.4 + (dy / dt) * 0.6 }
      d.x = e.clientX
      d.y = e.clientY
      d.t = e.timeStamp
      this.current = panBy(this.current, dx, dy)
      this.moved()
      this.lastReadoutUpdate(performance.now())
      return
    }
    this.hover(e.clientX, e.clientY)
  }

  pointerUp(e: React.PointerEvent): void {
    const d = this.drag
    if (!d || d.id !== e.pointerId) return
    this.drag = null
    this.dragged = d.moved
    // A throw keeps going; a drag that stopped before release doesn't.
    if (d.moved && e.timeStamp - d.t < 60 && Math.hypot(this.velocity.x, this.velocity.y) > 0.25) {
      this.inertia = true
      this.invalidate()
    }
  }

  doubleClick(e: React.MouseEvent): void {
    const r = this.root.getBoundingClientRect()
    this.zoomTo(clampZoom(Math.round(this.current.zoom) + 1), { x: e.clientX - r.left, y: e.clientY - r.top })
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault()
    const r = this.root.getBoundingClientRect()
    const anchor = { x: e.clientX - r.left, y: e.clientY - r.top }
    const device = this.wheel.classify({
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      deltaMode: e.deltaMode,
      ctrlKey: e.ctrlKey,
      wheelDeltaY: (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY,
      timeStamp: e.timeStamp
    })
    this.animation = null
    this.inertia = false
    const pixels = (v: number) => (e.deltaMode === 1 ? v * 40 : e.deltaMode === 2 ? v * 800 : v)
    if (device === 'trackpad' && !e.ctrlKey) {
      // Two fingers move the map with them.
      this.wheelZoom = null
      this.current = panBy(this.current, -pixels(e.deltaX), -pixels(e.deltaY))
      this.moved()
      return
    }
    if (device === 'trackpad') {
      // Pinch: follows the fingers directly.
      this.wheelZoom = null
      this.current = zoomAround(this.current, this.current.zoom - pixels(e.deltaY) / WHEEL_PIXELS_PER_ZOOM, anchor, this.width, this.height)
      this.moved()
      return
    }
    const from = this.wheelZoom?.target ?? this.current.zoom
    this.zoomTo(clampZoom(from - pixels(e.deltaY) / WHEEL_PIXELS_PER_ZOOM), anchor)
  }

  /**
   * Pans for the time held keys have been down since the last call, so a key pans for exactly
   * as long as it is held, however few frames run meanwhile.
   */
  private keyPan(): void {
    const now = performance.now()
    const elapsed = Math.min(now - this.keyPanAt, 250)
    this.keyPanAt = now
    let x = 0
    let y = 0
    for (const code of this.keys) {
      x += PAN_KEYS[code].x
      y += PAN_KEYS[code].y
    }
    const distance = (KEY_PAN_SPEED * (this.shift ? 2.5 : 1) * elapsed) / 1000
    if (x || y) this.current = panBy(this.current, x * distance, y * distance)
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (this.keys.size > 0) this.keyPan()
    this.shift = e.shiftKey
    if (!(e.code in PAN_KEYS)) return
    if (!down) {
      if (this.keys.delete(e.code)) this.moved()
      return
    }
    const sh = shellState()
    if (sh.activeModule !== 'globe' || sh.isModalOpen() || isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return
    e.preventDefault()
    if (!this.keys.has(e.code)) this.stopMotion()
    if (this.keys.size === 0) this.keyPanAt = performance.now()
    this.keys.add(e.code)
    this.invalidate()
  }

  private hoverPending: Point | null = null

  private hover(x: number, y: number): void {
    const first = this.hoverPending === null
    this.hoverPending = { x, y }
    if (!first) return
    window.setTimeout(() => {
      const p = this.hoverPending
      this.hoverPending = null
      if (!p) return
      const r = this.root.getBoundingClientRect()
      const g = fromScreen({ x: p.x - r.left, y: p.y - r.top }, this.current, this.width, this.height)
      appState().set({ cursor: { longitude: g.longitude, latitude: g.latitude, elevation: null } })
    }, 60)
  }

  leave(): void {
    this.hoverPending = null
    appState().set({ cursor: null })
  }

  // ───────────── readouts, saving, attribution ─────────────

  /** Scale bar while moving, at most every 100 ms (the status bar re-renders on it). */
  private lastReadoutUpdate(now: number): void {
    if (now - this.lastReadout < 100) return
    this.lastReadout = now
    this.updateScale()
  }

  private updateScale(): void {
    const mpp = metersPerPixel(this.current.latitude, this.current.zoom)
    const nice = niceScale(mpp * 120, appState().settings.units)
    appState().set({ scale: nice ? { pixels: nice.meters / mpp, label: nice.label } : null })
  }

  private scheduleSettle(): void {
    if (this.settleTimer !== null) window.clearTimeout(this.settleTimer)
    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = null
      if (this.animation || this.wheelZoom || this.inertia || this.keys.size || this.drag?.moved) {
        this.scheduleSettle()
        return
      }
      this.settle()
    }, SETTLE_MS)
  }

  /** The view stood still: save it, update the scale bar and the attribution. */
  private settle(): void {
    const v = this.current
    const saved = appState().settings.map
    if (saved.open && !sameView(v, saved)) {
      appState().patchSettings((d) => {
        d.map.longitude = v.longitude
        d.map.latitude = v.latitude
        d.map.zoom = v.zoom
      })
    }
    this.updateScale()
    const engine = getEngine()
    if (!engine || !this.template) return
    const zoom = Math.round(v.zoom)
    const bounds = viewBounds(v, this.width, this.height)
    const key = `${this.template}|${zoom}|${bounds.north.toFixed(3)},${bounds.west.toFixed(3)},${bounds.south.toFixed(3)},${bounds.east.toFixed(3)}`
    if (key === this.attributionKey) return
    this.attributionKey = key
    void engine.mapTiles.copyright(bounds, zoom).then((text) => {
      if (key === this.attributionKey) this.onAttribution(text)
    })
  }
}

function interpolate(a: MapView, b: MapView, t: number): MapView {
  const zoom = a.zoom + (b.zoom - a.zoom) * t
  // Centers interpolate in Web Mercator at a common zoom (straight on the map).
  const z = Math.min(a.zoom, b.zoom)
  const pa = project(a, z)
  const pb = project(b, z)
  const size = worldSize(z)
  const bx = pb.x + Math.round((pa.x - pb.x) / size) * size
  const p = { x: pa.x + (bx - pa.x) * t, y: pa.y + (pb.y - pa.y) * t }
  return { ...unproject(p, z), zoom }
}

/**
 * Map mode: a full-window 2D map for getting around. It covers the 3D view, which
 * is paused meanwhile; switching back opens the 3D view at the map's center.
 */
export function MapMode() {
  const open = useAppStore((s) => s.settings.map.open)
  return open ? <MapModeView /> : null
}

function MapModeView() {
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pinsRef = useRef<HTMLDivElement>(null)
  const wedgeRef = useRef<SVGPathElement>(null)
  const markerRef = useRef<SVGGElement>(null)
  const rendererRef = useRef<MapRenderer | null>(null)
  const [copyright, setCopyright] = useState<string | null>(null)
  const session = useAppStore((s) => s.mapSession)
  const mapType = useAppStore((s) => s.settings.map.type)
  const hasKey = useAppStore((s) => !!s.keys.googleApiKey)
  const lightCredit = useAppStore((s) =>
    s.settings.lightPollution.enabled ? creditText(lightPollutionSource(s.settings.lightPollution.source).imagery.credit) : null
  )

  useEffect(() => {
    const root = rootRef.current
    if (!root || !canvasRef.current || !pinsRef.current || !wedgeRef.current || !markerRef.current) return
    const renderer = new MapRenderer(root, canvasRef.current, pinsRef.current, wedgeRef.current, markerRef.current, setCopyright)
    rendererRef.current = renderer
    setMapControl(renderer)
    return () => {
      setMapControl(null)
      renderer.destroy()
      rendererRef.current = null
    }
  }, [])

  return (
    <div
      ref={rootRef}
      className="map-mode"
      data-type={mapType}
      data-testid="map-mode"
      role="application"
      aria-label="Map: drag to move, scroll to zoom, arrow keys to pan. Switch to Photorealistic or Elevation to see the map's center in 3D."
      onPointerDown={(e) => rendererRef.current?.pointerDown(e)}
      onPointerMove={(e) => rendererRef.current?.pointerMove(e)}
      onPointerUp={(e) => rendererRef.current?.pointerUp(e)}
      onPointerCancel={(e) => rendererRef.current?.pointerUp(e)}
      onPointerLeave={() => rendererRef.current?.leave()}
      onDoubleClick={(e) => rendererRef.current?.doubleClick(e)}
    >
      <canvas ref={canvasRef} className="map-tiles" />
      <svg className="map-camera" aria-hidden="true">
        <path ref={wedgeRef} className="map-wedge" />
        <g ref={markerRef} className="map-marker">
          <circle r="6" />
          <path d="M0 -12 L4.5 -5 L-4.5 -5 Z" />
        </g>
      </svg>
      <div ref={pinsRef} className="map-pins" />
      {/* Where the 3D view opens when switching back. */}
      <div className="map-center" aria-hidden="true" />
      {!session && (
        <div className="map-empty">
          {hasKey ? 'Loading the map…' : 'Add a Google Maps Platform key in Settings to see the map.'}
        </div>
      )}
      {(session || lightCredit) && (
        <div className="map-attribution" data-testid="map-attribution">
          {session && <img src={GOOGLE_LOGO_URL} alt="Google" draggable={false} />}
          {(copyright || lightCredit) && <span>{[session ? copyright : null, lightCredit].filter(Boolean).join(' · ')}</span>}
        </div>
      )}
    </div>
  )
}
