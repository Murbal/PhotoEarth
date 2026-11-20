import {
  CallbackProperty,
  Cartographic,
  ClassificationType,
  ImageMaterialProperty,
  Rectangle,
  type CesiumWidget,
  type Entity,
  type TerrainData,
  type TerrainProvider
} from 'cesium'
import { buildShadowMask, type HeightGrid } from '../lib/terrainShadow'

const DEG = Math.PI / 180

/**
 * Fallback for §8.1.1: a terrain shadow overlay computed from the heightmap. For each ground
 * cell it marches toward the sun and tests whether terrain blocks it. Unlike shadow maps this
 * doesn't depend on what the camera has loaded, so distant and off-screen ridges still cast.
 *
 * Two grids are used: a fine one for the view and a coarse one reaching ~25 km beyond it
 * for distant casters.
 */
export class TerrainShadowOverlay {
  private entity: Entity | null = null
  private canvas: HTMLCanvasElement | null = null
  private inner: HeightGrid | null = null
  private outer: HeightGrid | null = null
  private areaKey = ''
  private loading = false
  private enabled = false
  private sun = { azimuth: 0, altitude: -90 }
  private lastSunKey = ''
  private timer: number | null = null
  private generation = 0

  constructor(
    private readonly widget: CesiumWidget,
    private readonly getProvider: () => TerrainProvider | null,
    private readonly onStatus: (message: string | null) => void
  ) {}

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return
    this.enabled = enabled
    if (!enabled) {
      this.generation++
      this.remove()
      this.onStatus(null)
    }
  }

  /** Re-samples heights when the view moved to a new area. */
  async updateArea(longitude: number, latitude: number, viewDistance: number): Promise<void> {
    const provider = this.getProvider()
    if (!this.enabled || !provider) return
    const innerHalf = Math.min(9000, Math.max(1500, viewDistance * 1.1))
    const outerHalf = innerHalf + 25000
    // Snap to a coarse lattice so small pans reuse the grid.
    const snap = innerHalf / 4
    const key = [
      Math.round((longitude * DEG * 6371000 * Math.cos(latitude * DEG)) / snap),
      Math.round((latitude * DEG * 6371000) / snap),
      Math.round(innerHalf)
    ].join(':')
    if (key === this.areaKey && this.inner) return
    if (this.loading) return
    this.loading = true
    const generation = ++this.generation
    this.onStatus('Sampling terrain for shadow overlay…')
    try {
      const inner = await sampleGrid(provider, around(longitude, latitude, innerHalf), 224, 13)
      const outer = await sampleGrid(provider, around(longitude, latitude, outerHalf), 192, 10)
      if (generation !== this.generation) return
      this.inner = inner
      this.outer = outer
      this.areaKey = key
      this.lastSunKey = ''
      this.recompute()
      this.onStatus(null)
    } catch (err) {
      this.onStatus(`Terrain shadow overlay unavailable: ${String(err)}`)
    } finally {
      this.loading = false
    }
  }

  /** Throttled recompute when the sun moves. */
  setSun(azimuth: number, altitude: number): void {
    this.sun = { azimuth, altitude }
    if (!this.enabled || !this.inner) return
    if (this.timer !== null) return
    this.timer = window.setTimeout(() => {
      this.timer = null
      this.recompute()
    }, 120)
  }

  private recompute(): void {
    if (!this.enabled || !this.inner || !this.outer) return
    const key = `${this.sun.azimuth.toFixed(1)}:${this.sun.altitude.toFixed(2)}`
    if (key === this.lastSunKey) return
    this.lastSunKey = key
    const mask = buildShadowMask(this.inner, this.outer, this.sun.azimuth, this.sun.altitude)
    const { nx, ny } = this.inner
    const canvas = document.createElement('canvas')
    canvas.width = nx
    canvas.height = ny
    const ctx = canvas.getContext('2d')!
    const img = ctx.createImageData(nx, ny)
    for (let j = 0; j < ny; j++) {
      // Grid rows run south → north; image rows run top (north) → bottom.
      const row = ny - 1 - j
      for (let i = 0; i < nx; i++) {
        const shade = mask[j * nx + i]
        const o = (row * nx + i) * 4
        img.data[o] = 12
        img.data[o + 1] = 18
        img.data[o + 2] = 48
        img.data[o + 3] = Math.round(shade * 150)
      }
    }
    ctx.putImageData(img, 0, 0)
    this.canvas = canvas
    this.show(Rectangle.fromRadians(this.inner.west, this.inner.south, this.inner.east, this.inner.north))
    this.widget.scene.requestRender()
  }

  private show(rect: Rectangle): void {
    if (this.entity) {
      this.entity.rectangle!.coordinates = rect as never
      return
    }
    this.entity = this.widget.entities.add({
      rectangle: {
        coordinates: rect,
        material: new ImageMaterialProperty({
          image: new CallbackProperty(() => this.canvas ?? undefined, false) as never,
          transparent: true
        }),
        classificationType: ClassificationType.BOTH
      }
    })
  }

  private remove(): void {
    if (this.entity) this.widget.entities.remove(this.entity)
    this.entity = null
    this.inner = null
    this.outer = null
    this.areaKey = ''
    this.widget.scene.requestRender()
  }
}

function around(longitude: number, latitude: number, halfMeters: number): Rectangle {
  const dLat = halfMeters / 6371000
  const dLon = halfMeters / (6371000 * Math.max(0.05, Math.cos(latitude * DEG)))
  return Rectangle.fromRadians(longitude * DEG - dLon, latitude * DEG - dLat, longitude * DEG + dLon, latitude * DEG + dLat)
}

interface QuantizedMesh {
  _quantizedVertices?: Uint16Array
  _indices?: Uint16Array | Uint32Array
  _minimumHeight?: number
  _maximumHeight?: number
}

async function requestTile(
  provider: TerrainProvider,
  x: number,
  y: number,
  level: number
): Promise<{ data: TerrainData; level: number; x: number; y: number }> {
  let lx = x
  let ly = y
  let l = level
  // Skip levels the provider says it doesn't have.
  while (l > 0 && provider.getTileDataAvailable(lx, ly, l) === false) {
    lx >>= 1
    ly >>= 1
    l--
  }
  // Then fall back to ancestors if the request itself fails (e.g. 404 at the edge of coverage).
  for (; l >= 0; l--, lx >>= 1, ly >>= 1) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const pending = provider.requestTileGeometry(lx, ly, l)
      if (!pending) {
        await new Promise((r) => setTimeout(r, 50))
        continue
      }
      try {
        return { data: await pending, level: l, x: lx, y: ly }
      } catch {
        break
      }
    }
  }
  throw new Error('terrain tile unavailable')
}

/**
 * Samples terrain heights on a regular lon/lat grid by rasterizing the terrain tiles'
 * triangles directly, which is far faster than per-point interpolation.
 */
async function sampleGrid(provider: TerrainProvider, rect: Rectangle, n: number, level: number): Promise<HeightGrid> {
  const scheme = provider.tilingScheme
  const nx = n
  const ny = n
  const data = new Float32Array(nx * ny).fill(Number.NaN)
  const grid: HeightGrid = { west: rect.west, south: rect.south, east: rect.east, north: rect.north, nx, ny, data, maxHeight: -Infinity }
  const nw = scheme.positionToTileXY(Cartographic.fromRadians(rect.west, rect.north), level)!
  const se = scheme.positionToTileXY(Cartographic.fromRadians(rect.east, rect.south), level)!
  const jobs: Array<Promise<void>> = []
  const seen = new Set<string>()
  for (let x = nw.x; x <= se.x; x++) {
    for (let y = nw.y; y <= se.y; y++) {
      jobs.push(
        requestTile(provider, x, y, level).then(({ data: tile, level: l, x: tx, y: ty }) => {
          const id = `${l}/${tx}/${ty}`
          if (seen.has(id)) return
          seen.add(id)
          rasterize(tile, scheme.tileXYToRectangle(tx, ty, l), grid)
        })
      )
    }
  }
  await Promise.all(jobs)
  for (let i = 0; i < data.length; i++) {
    if (Number.isNaN(data[i])) data[i] = 0
    else if (data[i] > grid.maxHeight) grid.maxHeight = data[i]
  }
  return grid
}

function rasterize(tile: TerrainData, tileRect: Rectangle, grid: HeightGrid): void {
  const mesh = tile as unknown as QuantizedMesh
  const { nx, ny, data } = grid
  const cellW = (grid.east - grid.west) / nx
  const cellH = (grid.north - grid.south) / ny
  const q = mesh._quantizedVertices
  const indices = mesh._indices
  if (!q || !indices) {
    // Other terrain formats: per-cell interpolation (slower, but correct).
    const t = tile as unknown as { interpolateHeight(r: Rectangle, lon: number, lat: number): number }
    for (let j = 0; j < ny; j++) {
      const lat = grid.south + (j + 0.5) * cellH
      if (lat < tileRect.south || lat > tileRect.north) continue
      for (let i = 0; i < nx; i++) {
        const lon = grid.west + (i + 0.5) * cellW
        if (lon < tileRect.west || lon > tileRect.east) continue
        const h = t.interpolateHeight(tileRect, lon, lat)
        if (Number.isFinite(h)) data[j * nx + i] = h
      }
    }
    return
  }
  const count = q.length / 3
  const minH = mesh._minimumHeight ?? 0
  const maxH = mesh._maximumHeight ?? 0
  const MAX = 32767
  const gx = new Float64Array(count)
  const gy = new Float64Array(count)
  const gh = new Float64Array(count)
  const tw = tileRect.east - tileRect.west
  const th = tileRect.north - tileRect.south
  for (let k = 0; k < count; k++) {
    const lon = tileRect.west + (q[k] / MAX) * tw
    const lat = tileRect.south + (q[k + count] / MAX) * th
    gx[k] = (lon - grid.west) / cellW - 0.5
    gy[k] = (lat - grid.south) / cellH - 0.5
    gh[k] = minH + (q[k + 2 * count] / MAX) * (maxH - minH)
  }
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]
    const b = indices[t + 1]
    const c = indices[t + 2]
    const x0 = gx[a], y0 = gy[a], x1 = gx[b], y1 = gy[b], x2 = gx[c], y2 = gy[c]
    const minX = Math.max(0, Math.ceil(Math.min(x0, x1, x2)))
    const maxX = Math.min(nx - 1, Math.floor(Math.max(x0, x1, x2)))
    const minY = Math.max(0, Math.ceil(Math.min(y0, y1, y2)))
    const maxY = Math.min(ny - 1, Math.floor(Math.max(y0, y1, y2)))
    if (minX > maxX || minY > maxY) continue
    const det = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
    if (Math.abs(det) < 1e-12) continue
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const w0 = ((y1 - y2) * (x - x2) + (x2 - x1) * (y - y2)) / det
        const w1 = ((y2 - y0) * (x - x2) + (x0 - x2) * (y - y2)) / det
        const w2 = 1 - w0 - w1
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue
        data[y * nx + x] = w0 * gh[a] + w1 * gh[b] + w2 * gh[c]
      }
    }
  }
}
