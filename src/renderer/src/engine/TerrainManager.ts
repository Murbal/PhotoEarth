import {
  Cartographic,
  CesiumTerrainProvider,
  EllipsoidTerrainProvider,
  Ion,
  sampleTerrainMostDetailed,
  type TerrainProvider
} from 'cesium'
import { classifyIonError } from '@shared/apiErrors'
import type { ApiCheck } from '@shared/types'
import { httpStatusOf, responseTextOf } from './util'

const WORLD_TERRAIN_ASSET = 1

/**
 * Heightmap terrain for the stand-in globe, profiles, the horizon, viewshed and the terrain shadow overlay.
 * Everything outside this class only sees `provider` and `sample()`, so another source
 * (e.g. AWS Terrain Tiles) can be swapped in here without touching the rest of the app.
 */
export class TerrainManager {
  readonly ellipsoid = new EllipsoidTerrainProvider()
  provider: TerrainProvider | null = null
  private generation = 0

  constructor(
    private readonly onError: (check: ApiCheck) => void,
    private readonly onReady: () => void
  ) {}

  get available(): boolean {
    return this.provider !== null
  }

  async load(token: string | null): Promise<void> {
    const generation = ++this.generation
    this.provider = null
    if (!token) return
    Ion.defaultAccessToken = token
    try {
      const provider = await CesiumTerrainProvider.fromIonAssetId(WORLD_TERRAIN_ASSET, {
        // Normals drive the globe's lighting; the water mask isn't needed.
        requestVertexNormals: true,
        requestWaterMask: false
      })
      if (generation !== this.generation) return
      provider.errorEvent.addEventListener((err: { error?: unknown; message?: string }) => {
        const status = httpStatusOf(err.error)
        if (status === 401 || status === 403 || status === 429) {
          this.onError(classifyIonError(status, responseTextOf(err.error), navigator.onLine))
        }
      })
      this.provider = provider
      this.onReady()
    } catch (error) {
      if (generation !== this.generation) return
      this.onError(classifyIonError(httpStatusOf(error), responseTextOf(error), navigator.onLine))
    }
  }

  /** Ellipsoidal terrain heights (meters) at the most detailed level available. */
  async sample(points: Array<{ longitude: number; latitude: number }>): Promise<Array<number | null>> {
    if (!this.provider || points.length === 0) return points.map(() => null)
    const cartos = points.map((p) => Cartographic.fromDegrees(p.longitude, p.latitude))
    const out = await sampleTerrainMostDetailed(this.provider, cartos)
    return out.map((c) => (Number.isFinite(c.height) ? c.height : null))
  }
}
