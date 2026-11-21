import { useEffect, useRef, useState } from 'react'
import { OVERVIEW_ZOOM_OFFSET } from '@shared/settings'
import type { ImageryType } from '@shared/types'
import { GOOGLE_LOGO_URL, type TileSession } from '../engine/GoogleImagery'
import { getEngine } from '../engine/instance'
import {
  chooseZoom,
  dragCamera,
  idealZoom,
  mapBounds,
  mapCenter,
  mapToLonLat,
  metersPerPixel,
  project,
  tileUrl,
  toMap,
  viewReach,
  visibleTiles,
  wedgePath,
  worldSize,
  type LonLat,
  type Point
} from '../lib/overviewMap'
import { appState, useAppStore, type CameraInfo } from '../store/appStore'
import { Icon } from './Icon'

/** Size of the map in CSS pixels (App's overlay layout reserves the same). */
export const OVERVIEW_WIDTH = 240
export const OVERVIEW_HEIGHT = 200
/** A press that moves less than this is a click. */
const CLICK_SLOP = 4
/** Tiles of the previous zoom stay under the new ones this long at most. */
const FADE_MS = 1200
/** The attribution is asked for once the map has stood still this long. */
const ATTRIBUTION_DELAY_MS = 600

const MAP_TYPES: Array<{ id: ImageryType; label: string; title: string }> = [
  { id: 'satellite', label: 'Sat', title: 'Satellite' },
  { id: 'terrain', label: 'Ter', title: 'Terrain' },
  { id: 'roadmap', label: 'Road', title: 'Road map' }
]

interface TileImage {
  img: HTMLImageElement
  z: number
  /** Unwrapped column (the world copy it was placed in) and row. */
  tx: number
  ty: number
  loaded: boolean
}

interface Drag {
  pointerId: number
  startX: number
  startY: number
  startCenter: Point
  startCamera: LonLat
  zoom: number
  /** Past the click slop: the camera is being carried. */
  gliding: boolean
  center: Point
  camera: LonLat
}

/**
 * The overview map's drawing, outside React: a stack of plain <img> tiles from the Google 2D
 * Tiles session, a CSS-positioned camera marker and an SVG view wedge. It redraws when the
 * store's camera readout changes (at most 10 Hz, already computed for the status bar) or the
 * user drags, never per rendered frame, and it never touches the WebGL context (§5.3).
 */
class OverviewRenderer {
  private readonly tiles = new Map<string, TileImage>()
  private template: string | null = null
  private zoom: number | null = null
  private center: Point | null = null
  private fadeTimer: number | null = null
  private attributionTimer: number | null = null
  private attributionKey = ''
  private glideRaf: number | null = null
  private probing = false
  drag: Drag | null = null
  /** Where a finished drag left the camera, until the readout catches up with it. */
  private settled: { camera: LonLat; readout: CameraInfo | null } | null = null

  constructor(
    private readonly layer: HTMLDivElement,
    private readonly wedge: SVGPathElement,
    private readonly marker: SVGGElement,
    private readonly onAttribution: (text: string | null) => void
  ) {}

  destroy(): void {
    if (this.fadeTimer !== null) window.clearTimeout(this.fadeTimer)
    if (this.attributionTimer !== null) window.clearTimeout(this.attributionTimer)
    if (this.glideRaf !== null) cancelAnimationFrame(this.glideRaf)
    if (this.drag?.gliding) getEngine()?.camera.endGlide()
    this.clearTiles()
  }

  private get session(): TileSession | null {
    return appState().tileSession
  }

  private get tileSize(): number {
    return this.session?.tileSize ?? 256
  }

  /** Where the camera is drawn: the drag's own position while dragging (the readout lags). */
  private cameraPosition(cam: CameraInfo): LonLat {
    if (this.drag?.gliding) return this.drag.camera
    if (this.settled) {
      if (sameCamera(this.settled.readout, cam)) return this.settled.camera
      this.settled = null
    }
    return cam
  }

  render(): void {
    const cam = appState().camera
    if (!cam) return
    const ts = this.tileSize
    const at = this.cameraPosition(cam)
    const reach = viewReach(cam.heightAgl ?? cam.heightMsl, cam.pitch, cam.fov)
    const zoom = this.drag?.gliding
      ? this.drag.zoom
      : chooseZoom(idealZoom(at.latitude, reach, Math.min(OVERVIEW_WIDTH, OVERVIEW_HEIGHT), ts), appState().settings.overviewMap.zoomOffset, this.zoom)
    const center = this.drag?.gliding ? this.drag.center : mapCenter(at, cam.heading, reach, zoom, ts)
    this.zoom = zoom
    this.center = center
    this.placeTiles(center, zoom)

    const size = worldSize(zoom, ts)
    const p = toMap(project(at, zoom, ts), center, OVERVIEW_WIDTH, OVERVIEW_HEIGHT, size)
    const length = Math.min(reach / metersPerPixel(at.latitude, zoom, ts), OVERVIEW_WIDTH + OVERVIEW_HEIGHT)
    setAttribute(this.wedge, 'd', wedgePath(p, cam.heading, cam.fov, Math.max(length, 14)))
    setAttribute(this.marker, 'transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)}) rotate(${cam.heading.toFixed(1)})`)
    this.scheduleAttribution()
  }

  /** Map pixel → ground position, for a click. */
  lonLatAt(x: number, y: number): LonLat | null {
    if (!this.center || this.zoom === null) return null
    return mapToLonLat({ x, y }, this.center, OVERVIEW_WIDTH, OVERVIEW_HEIGHT, this.zoom, this.tileSize)
  }

  // ───────────── tiles ─────────────

  private placeTiles(center: Point, zoom: number): void {
    const session = this.session
    if (!session) {
      this.clearTiles()
      return
    }
    if (session.template !== this.template) {
      this.clearTiles()
      this.template = session.template
    }
    const ts = session.tileSize
    const wanted = visibleTiles(center, zoom, OVERVIEW_WIDTH, OVERVIEW_HEIGHT, ts)
    const keep = new Set<string>()
    for (const t of wanted) {
      keep.add(t.key)
      if (this.tiles.has(t.key)) continue
      const img = document.createElement('img')
      img.className = 'overview-tile'
      img.alt = ''
      img.draggable = false
      img.decoding = 'async'
      img.width = ts
      img.height = ts
      const tile: TileImage = { img, z: t.z, tx: t.column, ty: t.y, loaded: false }
      img.onload = () => {
        tile.loaded = true
        img.classList.add('loaded')
        this.dropStaleWhenLoaded()
      }
      img.onerror = () => this.onTileError(img.src)
      img.src = tileUrl(session.template, t.z, t.x, t.y)
      this.tiles.set(t.key, tile)
      this.layer.appendChild(img)
    }
    // Tiles of another zoom stay (scaled) under the new ones until those have loaded.
    let stale = false
    for (const [key, tile] of this.tiles) {
      if (keep.has(key)) continue
      if (tile.z === zoom || !tile.loaded) {
        this.removeTile(key)
        continue
      }
      stale = true
    }
    this.layoutTiles(center, zoom, ts)
    if (stale) {
      if (this.fadeTimer === null) this.fadeTimer = window.setTimeout(() => this.dropStale(), FADE_MS)
      this.dropStaleWhenLoaded()
    }
  }

  private layoutTiles(center: Point, zoom: number, ts: number): void {
    const left = center.x - OVERVIEW_WIDTH / 2
    const top = center.y - OVERVIEW_HEIGHT / 2
    for (const tile of this.tiles.values()) {
      const scale = 2 ** (zoom - tile.z)
      const x = tile.tx * ts * scale - left
      const y = tile.ty * ts * scale - top
      // Current-zoom tiles first, older ones underneath.
      tile.img.style.zIndex = tile.z === zoom ? '1' : '0'
      tile.img.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)${scale === 1 ? '' : ` scale(${scale})`}`
    }
  }

  private dropStaleWhenLoaded(): void {
    const zoom = this.zoom
    for (const tile of this.tiles.values()) if (tile.z === zoom && !tile.loaded) return
    this.dropStale()
  }

  private dropStale(): void {
    if (this.fadeTimer !== null) window.clearTimeout(this.fadeTimer)
    this.fadeTimer = null
    for (const [key, tile] of this.tiles) if (tile.z !== this.zoom) this.removeTile(key)
  }

  private removeTile(key: string): void {
    const tile = this.tiles.get(key)
    if (!tile) return
    tile.img.onload = null
    tile.img.onerror = null
    tile.img.remove()
    this.tiles.delete(key)
  }

  private clearTiles(): void {
    for (const key of [...this.tiles.keys()]) this.removeTile(key)
    this.template = null
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
        if (res.status === 400 || res.status === 401 || res.status === 403) getEngine()?.imagery.reportTileFailure()
      })
      .catch(() => undefined)
      .finally(() => (this.probing = false))
  }

  // ───────────── attribution ─────────────

  /** The map's own copyright line, once it stands still (one request per new view). */
  private scheduleAttribution(): void {
    if (this.attributionTimer !== null) window.clearTimeout(this.attributionTimer)
    this.attributionTimer = window.setTimeout(() => {
      this.attributionTimer = null
      const engine = getEngine()
      const session = this.session
      if (!engine || !session || !this.center || this.zoom === null) return
      const bounds = mapBounds(this.center, this.zoom, OVERVIEW_WIDTH, OVERVIEW_HEIGHT, session.tileSize)
      const key = `${session.template}|${this.zoom}|${bounds.north.toFixed(3)},${bounds.west.toFixed(3)}`
      if (key === this.attributionKey) return
      this.attributionKey = key
      void engine.imagery.copyright(bounds, this.zoom).then((text) => {
        if (key === this.attributionKey) this.onAttribution(text)
      })
    }, ATTRIBUTION_DELAY_MS)
  }

  // ───────────── drag ─────────────

  pointerDown(id: number, x: number, y: number): void {
    const cam = appState().camera
    if (!cam || !this.center || this.zoom === null) return
    const at = this.cameraPosition(cam)
    this.drag = {
      pointerId: id,
      startX: x,
      startY: y,
      startCenter: this.center,
      startCamera: { longitude: at.longitude, latitude: at.latitude },
      zoom: this.zoom,
      gliding: false,
      center: this.center,
      camera: at
    }
  }

  pointerMove(id: number, x: number, y: number): void {
    const d = this.drag
    if (!d || d.pointerId !== id) return
    const dx = x - d.startX
    const dy = y - d.startY
    if (!d.gliding) {
      if (Math.hypot(dx, dy) < CLICK_SLOP) return
      d.gliding = true
      getEngine()?.camera.beginGlide()
    }
    d.center = { x: d.startCenter.x - dx, y: d.startCenter.y - dy }
    d.camera = dragCamera(d.startCamera, dx, dy, d.zoom, this.tileSize)
    this.render()
    // At most one camera move per animation frame, however fast pointer events arrive.
    if (this.glideRaf === null) {
      this.glideRaf = requestAnimationFrame(() => {
        this.glideRaf = null
        const now = this.drag
        if (now?.gliding) getEngine()?.camera.glideTo(now.camera.longitude, now.camera.latitude)
      })
    }
  }

  /** Returns the clicked ground position when the press was a click, not a drag. */
  pointerUp(id: number, x: number, y: number): LonLat | null {
    const d = this.drag
    if (!d || d.pointerId !== id) return null
    this.drag = null
    if (!d.gliding) return this.lonLatAt(x, y)
    if (this.glideRaf !== null) cancelAnimationFrame(this.glideRaf)
    this.glideRaf = null
    const engine = getEngine()
    engine?.camera.glideTo(d.camera.longitude, d.camera.latitude)
    engine?.camera.endGlide()
    this.settled = { camera: d.camera, readout: appState().camera }
    this.render()
    return null
  }

  pointerCancel(): void {
    if (this.drag?.gliding) getEngine()?.camera.endGlide()
    this.drag = null
    this.render()
  }
}

/** Skips writes that change nothing (they would still invalidate style). */
function setAttribute(el: Element, name: string, value: string): void {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value)
}

const CAMERA_FIELDS = ['longitude', 'latitude', 'heightAgl', 'heightMsl', 'heading', 'pitch', 'fov'] as const

function sameCamera(a: CameraInfo | null, b: CameraInfo | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return CAMERA_FIELDS.every((k) => a[k] === b[k])
}

function setZoomOffset(delta: number): void {
  appState().patchSettings((d) => {
    const next = Math.round(d.overviewMap.zoomOffset + delta)
    d.overviewMap.zoomOffset = Math.min(OVERVIEW_ZOOM_OFFSET.max, Math.max(OVERVIEW_ZOOM_OFFSET.min, next))
  })
}

/**
 * The optional 2D overview map (§5.5): where the camera is and which way it looks, on Google
 * 2D Tiles of the map type in settings.imagery. A click centers the view there; a drag carries
 * the camera like grabbing the ground; the wheel and ± zoom the map.
 */
export function OverviewMap() {
  const enabled = useAppStore((s) => s.settings.overviewMap.enabled)
  return enabled ? <OverviewMapPanel /> : null
}

function OverviewMapPanel() {
  const layerRef = useRef<HTMLDivElement>(null)
  const wedgeRef = useRef<SVGPathElement>(null)
  const markerRef = useRef<SVGGElement>(null)
  const rendererRef = useRef<OverviewRenderer | null>(null)
  const wheelRef = useRef(0)
  const [copyright, setCopyright] = useState<string | null>(null)
  const session = useAppStore((s) => s.tileSession)
  const hasKey = useAppStore((s) => !!s.keys.googleApiKey)
  const mapType = useAppStore((s) => s.settings.imagery)
  const zoomOffset = useAppStore((s) => s.settings.overviewMap.zoomOffset)
  const flyMode = useAppStore((s) => s.flyMode)
  const patchSettings = useAppStore((s) => s.patchSettings)

  useEffect(() => {
    const layer = layerRef.current
    const wedge = wedgeRef.current
    const marker = markerRef.current
    if (!layer || !wedge || !marker) return
    const renderer = new OverviewRenderer(layer, wedge, marker, setCopyright)
    rendererRef.current = renderer
    renderer.render()
    const unsubscribe = useAppStore.subscribe(
      (s) => [s.camera, s.tileSession, s.settings.overviewMap.zoomOffset] as const,
      () => {
        // While dragging, the drag drives the drawing; the readout would only pull it back.
        if (!renderer.drag?.gliding) renderer.render()
      },
      // The readout republishes an unchanged camera now and then; that draws nothing new.
      { equalityFn: (a, b) => sameCamera(a[0], b[0]) && a[1] === b[1] && a[2] === b[2] }
    )
    return () => {
      unsubscribe()
      renderer.destroy()
      rendererRef.current = null
    }
  }, [])

  const local = (e: React.PointerEvent | React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const label = session ? `Overview map (${MAP_TYPES.find((t) => t.id === mapType)?.title.toLowerCase()})` : 'Overview map'

  return (
    <div className="panel overview-map" data-testid="overview-map">
      <div
        className={`overview-canvas ${flyMode ? 'disabled' : ''}`}
        role="img"
        aria-label={`${label}: click to look there, drag to move the camera`}
        onPointerDown={(e) => {
          if (e.button !== 0 || flyMode) return
          e.currentTarget.setPointerCapture(e.pointerId)
          const p = local(e)
          rendererRef.current?.pointerDown(e.pointerId, p.x, p.y)
        }}
        onPointerMove={(e) => {
          const p = local(e)
          rendererRef.current?.pointerMove(e.pointerId, p.x, p.y)
        }}
        onPointerUp={(e) => {
          const p = local(e)
          const hit = rendererRef.current?.pointerUp(e.pointerId, p.x, p.y)
          if (hit) void getEngine()?.goToFromOverview(hit.longitude, hit.latitude)
        }}
        onPointerCancel={() => rendererRef.current?.pointerCancel()}
        onWheel={(e) => {
          // One zoom step per notch; trackpads add up small deltas.
          wheelRef.current += e.deltaY
          if (Math.abs(wheelRef.current) < 60) return
          setZoomOffset(wheelRef.current < 0 ? 1 : -1)
          wheelRef.current = 0
        }}
      >
        <div ref={layerRef} className="overview-tiles" />
        <svg className="overview-overlay" width={OVERVIEW_WIDTH} height={OVERVIEW_HEIGHT} aria-hidden="true">
          <path ref={wedgeRef} className="overview-wedge" />
          <g ref={markerRef} className="overview-marker">
            <circle r="5.5" />
            <path d="M0 -11 L4 -4.5 L-4 -4.5 Z" />
          </g>
        </svg>
        {!session && <div className="overview-empty">{hasKey ? 'Loading map…' : 'Add a Google Maps Platform key to see the overview map'}</div>}
        {session && (
          <div className="overview-attribution" data-testid="overview-attribution">
            <img src={GOOGLE_LOGO_URL} alt="Google" draggable={false} />
            {copyright && <span title={copyright}>{copyright}</span>}
          </div>
        )}
      </div>
      <div className="overview-controls">
        <div className="segmented small" role="radiogroup" aria-label="Overview map type (also the Elevation mode imagery)">
          {MAP_TYPES.map((t) => (
            <button
              key={t.id}
              role="radio"
              aria-checked={mapType === t.id}
              className={mapType === t.id ? 'active' : ''}
              title={`${t.title} (also draped in Elevation mode)`}
              onClick={() => patchSettings((d) => void (d.imagery = t.id))}
            >
              {t.label}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button
          className="icon-btn small"
          aria-label="Overview map: zoom out"
          title="Zoom out"
          disabled={zoomOffset <= OVERVIEW_ZOOM_OFFSET.min}
          onClick={() => setZoomOffset(-1)}
        >
          <Icon name="minus" size={14} />
        </button>
        <button
          className="icon-btn small"
          aria-label="Overview map: zoom in"
          title="Zoom in"
          disabled={zoomOffset >= OVERVIEW_ZOOM_OFFSET.max}
          onClick={() => setZoomOffset(1)}
        >
          <Icon name="plus" size={14} />
        </button>
        <button
          className="icon-btn small"
          aria-label="Hide overview map"
          title="Hide overview map (O)"
          onClick={() => patchSettings((d) => void (d.overviewMap.enabled = false))}
        >
          <Icon name="close" size={14} />
        </button>
      </div>
    </div>
  )
}
