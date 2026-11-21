import {
  ArcType,
  CallbackProperty,
  Cartesian3,
  Cartographic,
  Color,
  ColorMaterialProperty,
  type CesiumWidget,
  type Entity,
  type TerrainProvider
} from 'cesium'
import type { NearbyPlace, NearbyRequest, Result } from '@shared/types'
import { geoidUndulation } from '../lib/geoid'
import {
  createHorizon,
  EYE_HEIGHT,
  HORIZON_LEVELS,
  peaksOnSkyline,
  sampleIndex,
  skylineSummits,
  traceHorizon,
  type Horizon,
  type PeakCandidate
} from '../lib/panorama'
import { cellAt, RateLimiter, type QueryCell } from '../lib/placeLabels'
import { heightAt, type ShadowLevel } from '../lib/terrainShadow'
import { appState } from '../store/appStore'
import { HeightField, LocalFrame, yieldToMain } from './shadows/HeightField'
import { toDeg, toRad } from './util'

export interface HorizonDeps {
  provider: () => TerrainProvider | null
  nearby: (req: NearbyRequest) => Promise<Result<NearbyPlace[]>>
  /** Peaks the map's place labels already know (saves queries). */
  knownPeaks: () => Array<{ id: string; name: string; latitude: number; longitude: number }>
  /** Whether a Google key is set (peak names come from Places API). */
  canNamePeaks: () => boolean
}

/** Places queries for one panorama, at most (each covers a cell around a skyline summit). */
const PEAK_QUERIES = 10
/** Query cell size by the summit's distance: near summits need small, detailed cells. */
const peakTier = (distance: number): number => (distance < 6000 ? 6000 : distance < 20000 ? 15000 : 40000)
/** Azimuths traced between yields to the event loop. */
const TRACE_CHUNK = 120
/** Clicked surfaces (roofs, towers) count as the observer's footing up to this far above the terrain. */
const MAX_SURFACE_ABOVE_GROUND = 400

const OBSERVER = Color.fromCssColorString('#4fd1ff')
const RAY = Color.fromCssColorString('#ffd54f')

/**
 * Horizon panorama (PhotoPills / PeakFinder style). For an observer point it loads nested
 * grids of Cesium World Terrain heights around it (±2 km at 12.5 m out to ±300 km at 2.5 km,
 * coarse first so a rough skyline shows within a second), traces the skyline through 360°,
 * and names the summits on it from Places API mountain peaks. The chart itself, with the sun
 * and moon paths, is drawn by components/HorizonPanel.tsx from the store.
 */
export class HorizonTool {
  private field: HeightField | null = null
  private frame: LocalFrame | null = null
  private levels: Array<ShadowLevel | null> = []
  private ground: Cartesian3 | null = null
  private eye: Cartesian3 | null = null
  private entities: Entity[] = []
  private request = 0
  private peakRequest = 0
  private readonly cells = new Map<string, Promise<NearbyPlace[] | null>>()
  private readonly limiter = new RateLimiter(30, 60_000)

  constructor(
    private readonly widget: CesiumWidget,
    private readonly deps: HorizonDeps
  ) {}

  get isOpen(): boolean {
    return appState().horizon.open
  }

  /** The observer's footing (for eye level). */
  get spot(): Cartesian3 | null {
    return this.ground
  }

  /**
   * Opens the panorama for an observer standing on `position`. `surface` is the ellipsoidal
   * height of what stands there (a roof, say: it counts when it is above the terrain); it may
   * still be sampling while the terrain loads.
   */
  async open(position: Cartesian3, surface?: Promise<number | undefined>): Promise<void> {
    const id = ++this.request
    this.peakRequest++
    const cancelled = () => id !== this.request
    const c = Cartographic.fromCartesian(position)
    const longitude = toDeg(c.longitude)
    const latitude = toDeg(c.latitude)
    const geoid = geoidUndulation(latitude, longitude)
    this.removeEntities()
    this.ground = Cartesian3.fromRadians(c.longitude, c.latitude, c.height)
    this.eye = null
    this.levels = HORIZON_LEVELS.map(() => null)
    const provider = this.deps.provider()
    appState().patchHorizon({
      open: true,
      status: provider ? 'loading' : 'error',
      loaded: 0,
      levels: HORIZON_LEVELS.length,
      observer: { longitude, latitude, eyeMsl: Number.NaN },
      horizon: null,
      geoid,
      peaks: [],
      peakStatus: 'off',
      hoverAzimuth: null,
      error: provider ? null : 'The skyline is traced on Cesium World Terrain: add a Cesium ion access token in Settings.'
    })
    if (!provider) return
    if (!this.field || this.field.provider !== provider) this.field = HeightField.for(provider)
    const field = this.field
    const frame = (this.frame = new LocalFrame(c.longitude, c.latitude))
    this.addEntities()
    let surfaceHeight: number | undefined
    let surfaceKnown = !surface

    // Coarse first: each level fills its gaps from the next coarser one, and the skyline is
    // re-traced as finer ground arrives.
    for (let k = HORIZON_LEVELS.length - 1; k >= 0; k--) {
      const { half, n } = HORIZON_LEVELS[k]
      const level = await field.loadLevel(frame, 0, 0, half, n, this.levels[k + 1] ?? null, cancelled).catch(() => null)
      if (cancelled()) return
      if (!level) {
        if (k === HORIZON_LEVELS.length - 1) {
          appState().patchHorizon({ status: 'error', error: 'Could not load the terrain around this point. Check the connection and try again.' })
          return
        }
        appState().patchHorizon({ loaded: HORIZON_LEVELS.length - k })
        continue
      }
      this.levels[k] = level
      if (!surfaceKnown) {
        surfaceHeight = await surface!.catch(() => undefined)
        surfaceKnown = true
        if (cancelled()) return
      }
      const terrain = heightAt(this.levels, 0, 0)?.height ?? level.minHeight
      const footing = surfaceHeight !== undefined && surfaceHeight > terrain && surfaceHeight - terrain < MAX_SURFACE_ABOVE_GROUND ? surfaceHeight : terrain
      const eye = footing + EYE_HEIGHT
      const horizon = createHorizon(eye)
      for (let i = 0; i < horizon.altitude.length; i += TRACE_CHUNK) {
        traceHorizon(horizon, this.levels, i, Math.min(horizon.altitude.length, i + TRACE_CHUNK), { radius: frame.radius })
        await yieldToMain()
        if (cancelled()) return
      }
      this.ground = Cartesian3.fromRadians(c.longitude, c.latitude, footing)
      this.eye = Cartesian3.fromRadians(c.longitude, c.latitude, eye)
      appState().patchHorizon({
        horizon,
        loaded: HORIZON_LEVELS.length - k,
        observer: { longitude, latitude, eyeMsl: eye - geoid }
      })
      this.widget.scene.requestRender()
    }
    appState().patchHorizon({ status: 'ready' })
    void this.namePeaks()
  }

  /**
   * End-to-end tests: opens the panorama on given grids (fine → coarse, centered on the
   * observer) and named peaks, instead of loading terrain and querying Places.
   */
  debugOpen(longitude: number, latitude: number, levels: ShadowLevel[], candidates: PeakCandidate[] = []): void {
    this.request++
    this.peakRequest++
    this.removeEntities()
    const frame = (this.frame = new LocalFrame(toRad(longitude), toRad(latitude)))
    this.levels = levels
    const ground = heightAt(levels, 0, 0)?.height ?? 0
    const horizon = createHorizon(ground + EYE_HEIGHT)
    traceHorizon(horizon, levels, 0, horizon.altitude.length, { radius: frame.radius })
    this.ground = Cartesian3.fromDegrees(longitude, latitude, ground)
    this.eye = Cartesian3.fromDegrees(longitude, latitude, horizon.eye)
    this.addEntities()
    const peaks = peaksOnSkyline(horizon, levels, candidates, { radius: frame.radius }).map((p) => ({ ...p, heightMsl: p.height }))
    appState().patchHorizon({
      open: true,
      status: 'ready',
      loaded: levels.length,
      levels: levels.length,
      observer: { longitude, latitude, eyeMsl: horizon.eye },
      horizon,
      geoid: 0,
      peaks,
      peakStatus: 'ready',
      hoverAzimuth: null,
      error: null
    })
    this.widget.scene.requestRender()
  }

  close(): void {
    this.request++
    this.peakRequest++
    this.removeEntities()
    this.levels = []
    this.frame = null
    this.ground = null
    this.eye = null
    appState().resetHorizon()
    this.widget.scene.requestRender()
  }

  setHover(azimuth: number | null): void {
    if (appState().horizon.hoverAzimuth === azimuth) return
    appState().patchHorizon({ hoverAzimuth: azimuth })
    this.widget.scene.requestRender()
  }

  /** (Re)labels the skyline's summits, or clears the labels when peak names are off. */
  async namePeaks(): Promise<void> {
    const id = ++this.peakRequest
    const { horizon: state, settings } = appState()
    const horizon = state.horizon
    const frame = this.frame
    if (!horizon || !frame || state.status !== 'ready') return
    if (!settings.horizon.peakNames) {
      appState().patchHorizon({ peaks: [], peakStatus: 'off' })
      return
    }
    if (!this.deps.canNamePeaks()) {
      appState().patchHorizon({ peaks: [], peakStatus: 'unavailable' })
      return
    }
    appState().patchHorizon({ peakStatus: 'loading' })
    const cells = this.peakCells(horizon, frame)
    const results = await Promise.all(cells.map((cell) => this.queryCell(cell)))
    if (id !== this.peakRequest) return
    const seen = new Set<string>()
    const candidates: PeakCandidate[] = []
    const scratch = new Cartesian3()
    const add = (p: { id: string; name: string; latitude: number; longitude: number }) => {
      if (seen.has(p.id)) return
      seen.add(p.id)
      const local = frame.toLocal(toRad(p.longitude), toRad(p.latitude), scratch)
      candidates.push({ id: p.id, name: p.name, x: local.x, y: local.y })
    }
    for (const list of results) for (const p of list ?? []) add({ id: p.id, name: p.name, ...p.location })
    for (const p of this.deps.knownPeaks()) add(p)
    const geoid = appState().horizon.geoid
    const peaks = peaksOnSkyline(horizon, this.levels, candidates, { radius: frame.radius }).map((p) => ({ ...p, heightMsl: p.height - geoid }))
    const failed = results.every((r) => r === null)
    appState().patchHorizon({ peaks, peakStatus: failed && peaks.length === 0 ? 'unavailable' : 'ready' })
  }

  /** Query cells around the observer and the most prominent skyline summits. */
  private peakCells(horizon: Horizon, frame: LocalFrame): QueryCell[] {
    const { latitude, longitude } = appState().horizon.observer!
    const cells = new Map<string, QueryCell>()
    const add = (cell: QueryCell) => {
      if (cells.size < PEAK_QUERIES && !cells.has(cell.key)) cells.set(cell.key, cell)
    }
    add(cellAt('mountain_peak', 15000, latitude, longitude))
    for (const s of skylineSummits(horizon, 0.25)) {
      if (s.distance < 300 || s.distance > horizon.reach) continue
      const az = toRad(s.azimuth)
      const at = frame.toCartographic(Math.sin(az) * s.distance, Math.cos(az) * s.distance)
      add(cellAt('mountain_peak', peakTier(s.distance), toDeg(at.latitude), toDeg(at.longitude)))
      if (cells.size >= PEAK_QUERIES) break
    }
    return [...cells.values()]
  }

  /** One cached Nearby Search for peaks; null when it failed (and may be retried later). */
  private queryCell(cell: QueryCell): Promise<NearbyPlace[] | null> {
    let job = this.cells.get(cell.key)
    if (job) return job
    if (this.limiter.wait(1, performance.now()) > 0) return Promise.resolve(null)
    this.limiter.record(1, performance.now())
    job = this.deps
      .nearby({ kind: 'mountain_peak', center: cell.center, radius: cell.radius })
      .then((r) => (r.ok ? r.data : null))
      .catch(() => null)
    this.cells.set(cell.key, job)
    void job.then((r) => {
      if (r === null) this.cells.delete(cell.key)
    })
    return job
  }

  /** World position of the skyline point at an azimuth. */
  private skylinePoint(azimuth: number): Cartesian3 | undefined {
    const horizon = appState().horizon.horizon
    if (!horizon || !this.frame) return undefined
    const i = sampleIndex(horizon, azimuth)
    const d = horizon.distance[i]
    if (!(d > 0) || !Number.isFinite(horizon.height[i])) return undefined
    const az = toRad(i * horizon.step)
    const c = this.frame.toCartographic(Math.sin(az) * d, Math.cos(az) * d)
    return Cartesian3.fromRadians(c.longitude, c.latitude, horizon.height[i])
  }

  private addEntities(): void {
    const entities = this.widget.entities
    const hovered = () => {
      const az = appState().horizon.hoverAzimuth
      return az === null ? undefined : this.skylinePoint(az)
    }
    this.entities.push(
      entities.add({
        position: new CallbackProperty(() => this.eye ?? this.ground ?? undefined, false) as unknown as Cartesian3,
        point: {
          pixelSize: 10,
          color: Color.WHITE,
          outlineColor: OBSERVER,
          outlineWidth: 3,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      }),
      // The line of sight to the hovered skyline point, also drawn where terrain hides it.
      entities.add({
        polyline: {
          positions: new CallbackProperty(() => {
            const p = hovered()
            return p && this.eye ? [this.eye, p] : []
          }, false),
          width: 2,
          arcType: ArcType.NONE,
          material: new ColorMaterialProperty(RAY),
          depthFailMaterial: new ColorMaterialProperty(RAY.withAlpha(0.35))
        }
      }),
      entities.add({
        position: new CallbackProperty(hovered, false) as unknown as Cartesian3,
        point: {
          pixelSize: 9,
          color: RAY,
          outlineColor: Color.BLACK.withAlpha(0.6),
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      })
    )
  }

  private removeEntities(): void {
    for (const e of this.entities) this.widget.entities.remove(e)
    this.entities = []
  }
}
