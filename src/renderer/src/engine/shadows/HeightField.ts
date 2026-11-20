import {
  Cartesian3,
  Cartographic,
  Ellipsoid,
  Matrix4,
  Rectangle,
  Request,
  RequestType,
  Transforms,
  type TerrainData,
  type TerrainProvider
} from 'cesium'
import { fillGaps, heightRange, rasterizeTriangles, terrainLevelFor, type ShadowLevel } from '../../lib/terrainShadow'

/**
 * Local tangent-plane frame (x east, y north, z up) at a point on the ellipsoid. Grid
 * coordinates are the orthographic projection onto this plane of the nadir ground point.
 */
export class LocalFrame {
  readonly enuToFixed: Matrix4
  readonly fixedToEnu: Matrix4
  /** Gaussian mean radius of curvature at the origin. */
  readonly radius: number
  readonly longitude: number
  readonly latitude: number

  constructor(longitude: number, latitude: number) {
    this.longitude = longitude
    this.latitude = latitude
    const origin = Cartesian3.fromRadians(longitude, latitude, 0)
    this.enuToFixed = Transforms.eastNorthUpToFixedFrame(origin)
    this.fixedToEnu = Matrix4.inverseTransformation(this.enuToFixed, new Matrix4())
    const { x: a, z: b } = Ellipsoid.WGS84.radii
    const e2 = 1 - (b * b) / (a * a)
    const s2 = Math.sin(latitude) ** 2
    const n = a / Math.sqrt(1 - e2 * s2)
    const m = (a * (1 - e2)) / (1 - e2 * s2) ** 1.5
    this.radius = Math.sqrt(m * n)
  }

  private readonly scratch = new Cartesian3()

  /** Plane coordinates of the ground point at (lon, lat) radians. */
  toLocal(longitude: number, latitude: number, out = new Cartesian3()): Cartesian3 {
    const p = Cartesian3.fromRadians(longitude, latitude, 0, Ellipsoid.WGS84, this.scratch)
    return Matrix4.multiplyByPoint(this.fixedToEnu, p, out)
  }

  /** Ground point (lon/lat radians) whose nadir projection is (x, y). */
  toCartographic(x: number, y: number): Cartographic {
    const z = -(x * x + y * y) / (2 * this.radius)
    const p = Matrix4.multiplyByPoint(this.enuToFixed, new Cartesian3(x, y, z), new Cartesian3())
    return Cartographic.fromCartesian(p) ?? new Cartographic(this.longitude, this.latitude)
  }

  /** Rotates an earth-fixed direction into the frame. */
  directionToLocal(direction: Cartesian3, out = new Cartesian3()): Cartesian3 {
    return Matrix4.multiplyByPointAsVector(this.fixedToEnu, direction, out)
  }
}

interface TileResult {
  data: TerrainData
  level: number
  x: number
  y: number
}

interface QuantizedMesh {
  _quantizedVertices?: Uint16Array
  _indices?: Uint16Array | Uint32Array
  _minimumHeight?: number
  _maximumHeight?: number
}

const MAX_CONCURRENT = 12
// ~80 kB per decoded tile: enough to re-center without refetching the overlap.
const CACHE_LIMIT = 600
const TILE_TIMEOUT_MS = 20000
/** Rasterizing yields to the event loop after this much work, so panning stays smooth. */
const SLICE_MS = 4

/** Yields to pending input and rendering; scheduler.yield resumes ahead of other tasks. */
function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  return scheduler?.yield ? scheduler.yield() : new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Loads terrain heights into shadow levels. Tiles come straight from the terrain provider
 * (independent of what the globe has loaded), are cached for re-centering, and are
 * rasterized triangle by triangle into the grid.
 */
export class HeightField {
  private readonly cache = new Map<string, Promise<TileResult | null>>()
  private active = 0
  private readonly waiting: Array<() => void> = []
  /** Per-vertex grid coordinates, reused across tiles (grown as needed). */
  private gx = new Float64Array(0)
  private gy = new Float64Array(0)
  private gh = new Float64Array(0)

  constructor(readonly provider: TerrainProvider) {}

  async loadLevel(
    frame: LocalFrame,
    cx: number,
    cy: number,
    half: number,
    n: number,
    coarser: ShadowLevel | null,
    cancelled: () => boolean
  ): Promise<ShadowLevel | null> {
    const cell = (2 * half) / n
    const level = terrainLevelFor(cell)
    const rect = this.boundsOf(frame, cx, cy, half + 2 * cell)
    const scheme = this.provider.tilingScheme
    const nw = scheme.positionToTileXY(Cartographic.fromRadians(rect.west, rect.north), level)
    const se = scheme.positionToTileXY(Cartographic.fromRadians(rect.east, rect.south), level)
    if (!nw || !se) return null
    const jobs: Array<Promise<TileResult | null>> = []
    for (let x = nw.x; x <= se.x; x++) for (let y = nw.y; y <= se.y; y++) jobs.push(this.tile(x, y, level))
    const tiles = (await Promise.all(jobs)).filter((t): t is TileResult => t !== null)
    if (cancelled()) return null

    // Coarser fallbacks first, so finer tiles overwrite them where both exist.
    tiles.sort((a, b) => a.level - b.level)
    const heights = new Float32Array(n * n).fill(Number.NaN)
    const minX = cx - half
    const minY = cy - half
    const seen = new Set<string>()
    let sliceStart = performance.now()
    for (const t of tiles) {
      const id = `${t.level}/${t.x}/${t.y}`
      if (seen.has(id)) continue
      seen.add(id)
      this.rasterize(t, frame, minX, minY, cell, n, heights)
      if (performance.now() - sliceStart >= SLICE_MS) {
        await yieldToMain()
        if (cancelled()) return null
        sliceStart = performance.now()
      }
    }
    await yieldToMain()
    if (cancelled()) return null
    const result: ShadowLevel = { cx, cy, half, n, heights, minHeight: 0, maxHeight: 0 }
    if (fillGaps(result, coarser) < 0.5) return null
    const range = heightRange(heights)
    result.minHeight = range.min
    result.maxHeight = range.max
    return result
  }

  /** Lon/lat bounds of a square in the frame (sampled along its edges). */
  private boundsOf(frame: LocalFrame, cx: number, cy: number, half: number): Rectangle {
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity
    for (let i = 0; i <= 4; i++) {
      for (let j = 0; j <= 4; j++) {
        if (i !== 0 && i !== 4 && j !== 0 && j !== 4) continue
        const c = frame.toCartographic(cx - half + (i / 2) * half, cy - half + (j / 2) * half)
        west = Math.min(west, c.longitude)
        east = Math.max(east, c.longitude)
        south = Math.min(south, c.latitude)
        north = Math.max(north, c.latitude)
      }
    }
    return new Rectangle(west, south, east, north)
  }

  private tile(x: number, y: number, level: number): Promise<TileResult | null> {
    const key = `${level}/${x}/${y}`
    let job = this.cache.get(key)
    if (job) {
      // Refresh LRU order.
      this.cache.delete(key)
      this.cache.set(key, job)
      return job
    }
    job = this.fetchWithFallback(x, y, level)
    this.cache.set(key, job)
    void job.then((r) => {
      if (!r) this.cache.delete(key)
    })
    while (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!)
    return job
  }

  private async fetchWithFallback(x: number, y: number, level: number): Promise<TileResult | null> {
    let lx = x
    let ly = y
    let l = level
    // Skip levels the provider says it doesn't have.
    while (l > 0 && this.provider.getTileDataAvailable(lx, ly, l) === false) {
      lx >>= 1
      ly >>= 1
      l--
    }
    // Then fall back to ancestors if the request itself fails (e.g. at the edge of coverage).
    for (; l >= 0; l--, lx >>= 1, ly >>= 1) {
      const data = await this.limited(() => this.request(lx, ly, l))
      if (data) return { data, level: l, x: lx, y: ly }
    }
    return null
  }

  private async request(x: number, y: number, level: number): Promise<TerrainData | null> {
    const request = new Request({ throttle: false, throttleByServer: false, type: RequestType.TERRAIN })
    const pending = this.provider.requestTileGeometry(x, y, level, request)
    if (!pending) return null
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<null>((resolve) => {
      timer = globalThis.setTimeout(() => {
        ;(request as unknown as { cancel(): void }).cancel()
        resolve(null)
      }, TILE_TIMEOUT_MS)
    })
    try {
      return await Promise.race([pending, timeout])
    } catch {
      return null
    } finally {
      globalThis.clearTimeout(timer)
    }
  }

  private async limited<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_CONCURRENT) await new Promise<void>((r) => this.waiting.push(r))
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      this.waiting.shift()?.()
    }
  }

  private rasterize(t: TileResult, frame: LocalFrame, minX: number, minY: number, cell: number, n: number, out: Float32Array): void {
    const tileRect = this.provider.tilingScheme.tileXYToRectangle(t.x, t.y, t.level)
    const mesh = t.data as unknown as QuantizedMesh
    const q = mesh._quantizedVertices
    const indices = mesh._indices
    if (!q || !indices) {
      this.rasterizeByInterpolation(t.data, tileRect, frame, minX, minY, cell, n, out)
      return
    }
    const count = q.length / 3
    const minH = mesh._minimumHeight ?? 0
    const maxH = mesh._maximumHeight ?? 0
    const MAX = 32767
    if (this.gx.length < count) {
      this.gx = new Float64Array(count)
      this.gy = new Float64Array(count)
      this.gh = new Float64Array(count)
    }
    const { gx, gy, gh } = this
    const tw = tileRect.east - tileRect.west
    const th = tileRect.north - tileRect.south
    const p = new Cartesian3()
    for (let k = 0; k < count; k++) {
      frame.toLocal(tileRect.west + (q[k] / MAX) * tw, tileRect.south + (q[k + count] / MAX) * th, p)
      gx[k] = (p.x - minX) / cell - 0.5
      gy[k] = (p.y - minY) / cell - 0.5
      gh[k] = minH + (q[k + 2 * count] / MAX) * (maxH - minH)
    }
    rasterizeTriangles(gx, gy, gh, indices, out, n)
  }

  /** Other terrain formats: per-cell interpolation (slower, but correct). */
  private rasterizeByInterpolation(
    data: TerrainData,
    tileRect: Rectangle,
    frame: LocalFrame,
    minX: number,
    minY: number,
    cell: number,
    n: number,
    out: Float32Array
  ): void {
    const t = data as unknown as { interpolateHeight(r: Rectangle, lon: number, lat: number): number }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const c = frame.toCartographic(minX + (i + 0.5) * cell, minY + (j + 0.5) * cell)
        if (c.longitude < tileRect.west || c.longitude > tileRect.east || c.latitude < tileRect.south || c.latitude > tileRect.north) continue
        const h = t.interpolateHeight(tileRect, c.longitude, c.latitude)
        if (Number.isFinite(h)) out[j * n + i] = h
      }
    }
  }
}
