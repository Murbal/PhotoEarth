import {
  ArcType,
  CallbackProperty,
  Cartesian3,
  Cartographic,
  Color,
  ColorMaterialProperty,
  Matrix4,
  type CesiumWidget,
  type Entity,
  type Material,
  type TerrainProvider
} from 'cesium'
import type { Units, ViewshedSettings } from '@shared/types'
import { geoidUndulation } from '../lib/geoid'
import { heightAt, type ShadowLevel } from '../lib/terrainShadow'
import {
  checkPointVisibility,
  computeViewshedProfile,
  VIEWSHED_LEVEL_COUNT,
  viewshedCoverageStats,
  viewshedLevelHalves,
  viewshedLevelResolutions,
  viewshedRingInterval,
  type ViewshedPointCheck,
  type ViewshedRadialProfile
} from '../lib/viewshed'
import { appState } from '../store/appStore'
import { HeightField, LocalFrame } from './shadows/HeightField'
import { ViewshedCompute, type ViewshedBinding } from './viewshed/ViewshedCompute'
import { toDeg } from './util'

/** Uniform names expected by VIEWSHED_RECEIVER_GLSL in the globe material and 3D Tiles shader. */
export const VIEWSHED_RECEIVER_UNIFORMS = {
  masks: ['u_vsMask0', 'u_vsMask1', 'u_vsMask2'],
  rects: ['u_vsRect0', 'u_vsRect1', 'u_vsRect2'],
  params: 'u_vsParams',
  style: 'u_vsStyle',
  eyeToLocal: 'u_vsEyeToLocal',
  exaggeration: 'u_vsExaggeration'
} as const

/** Clicked 3D-tile roofs/towers count as the target's footing up to this far above terrain. */
const MAX_SURFACE_ABOVE_GROUND = 400
const TARGET_COLOR = Color.fromCssColorString('#2ee8a5')

/**
 * Viewshed analysis overlay. Given a selected target point and analysis radius, loads three
 * nested Cesium World Terrain grids centered on the target via the shared `HeightField` cache,
 * ray-marches line-of-sight on the GPU in Cesium's compute pass (`ViewshedCompute`), and binds
 * the resulting masks to both the 3D Tiles custom shader and the Elevation-mode globe material.
 */
export class ViewshedTool {
  readonly compute: ViewshedCompute
  private field: HeightField | null = null
  private frame: LocalFrame | null = null
  private levels: Array<ShadowLevel | null> = [null, null, null]
  private profile: ViewshedRadialProfile | null = null
  private spot: Cartesian3 | null = null
  private targetGroundEllipsoidal = 0
  private targetPoint: Cartesian3 | null = null
  private targetBasePoint: Cartesian3 | null = null
  private entities: Entity[] = []
  private resolution = 512
  private settings: ViewshedSettings = appState().settings.viewshed
  private units: Units = appState().settings.units
  private loadedRadius = 0
  private loadedResolution = 0
  private request = 0
  private readonly materials = new Set<Material>()
  private readonly removePreRender: () => void

  constructor(
    private readonly widget: CesiumWidget,
    private getProvider: () => TerrainProvider | null,
    private readonly onVisibilityChange: () => void
  ) {
    const scene = widget.scene
    this.compute = new ViewshedCompute(() => scene.requestRender())
    scene.primitives.add(this.compute)
    this.removePreRender = scene.preRender.addEventListener(() => this.onPreRender())
    this.applyStyleUniforms()
  }

  get binding(): ViewshedBinding {
    return this.compute.binding
  }

  get isOpen(): boolean {
    return appState().viewshed.open
  }

  get picking(): boolean {
    return appState().viewshed.picking
  }

  /** True while an active viewshed has at least one computed mask to drape. */
  get ready(): boolean {
    return this.isOpen && this.compute.hasMasks
  }

  /** The currently targeted ground position, if any. */
  get targetSpot(): Cartesian3 | null {
    return this.spot
  }

  /** Target world point including its configured height offset above ground. */
  get targetWorldPoint(): Cartesian3 | null {
    return this.targetPoint
  }

  destroy(): void {
    this.request++
    this.removePreRender()
    this.removeEntities()
    this.materials.clear()
    if (!this.widget.scene.isDestroyed()) this.widget.scene.primitives.remove(this.compute)
  }

  bindMaterial(material: Material): void {
    this.materials.add(material)
    this.syncMaterial(material)
  }

  setPicking(picking: boolean): void {
    if (appState().viewshed.picking === picking) return
    appState().patchViewshed({ picking })
  }

  setResolution(resolution: number): void {
    const n = viewshedLevelResolutions(resolution)[0]
    if (n === this.resolution) return
    this.resolution = n
    if (this.spot && this.isOpen && appState().viewshed.status !== 'error') {
      void this.loadLevelsForCurrentSpot()
    }
  }

  /** Applies updated viewshed settings and units from the store. */
  configure(settings: ViewshedSettings, units: Units): void {
    const prev = this.settings
    const radiusChanged = settings.radius !== prev.radius
    const targetOffsetChanged = settings.targetOffset !== prev.targetOffset
    const viewerOffsetChanged = settings.viewerOffset !== prev.viewerOffset
    this.settings = { ...settings }
    this.units = units
    this.applyStyleUniforms()

    if (!this.isOpen || !this.spot || !this.frame) return

    if (targetOffsetChanged) {
      this.updateTargetMarker()
      this.compute.setTarget(this.targetHeight, settings.radius)
      this.recomputeStats()
    } else if (viewerOffsetChanged) {
      this.publishStatsOnly()
    }

    if (radiusChanged) {
      this.compute.setTarget(this.targetHeight, settings.radius)
      if (appState().viewshed.status !== 'error') {
        void this.loadLevelsForCurrentSpot()
      }
    }
  }

  /** Opens or moves the viewshed analysis to `position`. */
  async open(position: Cartesian3, surface?: Promise<number | undefined>): Promise<void> {
    const id = ++this.request
    const cancelled = () => id !== this.request
    const c = Cartographic.fromCartesian(position)
    const longitude = toDeg(c.longitude)
    const latitude = toDeg(c.latitude)
    const geoid = geoidUndulation(latitude, longitude)

    this.spot = Cartesian3.fromRadians(c.longitude, c.latitude, c.height)
    this.targetGroundEllipsoidal = c.height
    this.profile = null
    this.levels = [null, null, null]
    this.loadedRadius = 0
    this.loadedResolution = 0
    this.compute.clear()

    const provider = this.getProvider()
    if (!provider) {
      this.frame = null
      this.compute.setEnabled(false)
      this.removeEntities()
      appState().patchViewshed({
        open: true,
        picking: false,
        status: 'error',
        loaded: 0,
        levels: VIEWSHED_LEVEL_COUNT,
        target: { longitude, latitude, groundEllipsoidal: c.height, groundMsl: c.height - geoid, geoid },
        stats: null,
        error: 'Viewshed analysis uses Cesium World Terrain: add a Cesium ion access token in Settings.'
      })
      this.onVisibilityChange()
      this.widget.scene.requestRender()
      return
    }

    this.frame = new LocalFrame(c.longitude, c.latitude)
    this.compute.setEarthRadius(this.frame.radius)
    this.compute.setEnabled(true)
    this.addEntities()
    this.updateTargetMarker()

    appState().patchViewshed({
      open: true,
      picking: false,
      status: 'loading',
      loaded: 0,
      levels: VIEWSHED_LEVEL_COUNT,
      target: { longitude, latitude, groundEllipsoidal: c.height, groundMsl: c.height - geoid, geoid },
      stats: null,
      error: null
    })
    this.onVisibilityChange()
    await this.loadLevelsForCurrentSpot(id, surface, cancelled)
  }

  clear(): void {
    this.request++
    this.spot = null
    this.frame = null
    this.levels = [null, null, null]
    this.profile = null
    this.loadedRadius = 0
    this.loadedResolution = 0
    this.targetPoint = null
    this.targetBasePoint = null
    this.removeEntities()
    this.compute.setEnabled(false)
    this.compute.clear()
    appState().resetViewshed()
    this.onVisibilityChange()
    this.widget.scene.requestRender()
  }

  /** Line-of-sight check from an inspected world position back to the active viewshed target. */
  checkPoint(position: Cartesian3): ViewshedPointCheck | null {
    if (!this.isOpen || !this.frame || !this.levels.some(Boolean)) return null
    const c = Cartographic.fromCartesian(position)
    if (!c) return null
    const local = this.frame.toLocal(c.longitude, c.latitude)
    const terrain = heightAt(this.levels, local.x, local.y)?.height
    const footing =
      terrain !== undefined
        ? c.height > terrain && c.height - terrain < MAX_SURFACE_ABOVE_GROUND
          ? c.height
          : terrain
        : c.height
    return checkPointVisibility(
      this.levels,
      local.x,
      local.y,
      footing,
      this.targetHeight,
      this.settings.viewerOffset,
      this.settings.radius,
      { radius: this.frame.radius }
    )
  }

  private get targetHeight(): number {
    return this.targetGroundEllipsoidal + this.settings.targetOffset
  }

  private applyStyleUniforms(): void {
    const s = this.settings
    const ringStep = s.showRings ? viewshedRingInterval(s.radius, this.units) : 0
    this.compute.setStyle(s.viewerOffset, s.opacity, ringStep, s.colorMode === 'distance')
  }

  private async loadLevelsForCurrentSpot(
    existingId?: number,
    surface?: Promise<number | undefined>,
    existingCancelled?: () => boolean
  ): Promise<void> {
    const spot = this.spot
    const frame = this.frame
    if (!spot || !frame) return
    const id = existingId ?? ++this.request
    const cancelled = existingCancelled ?? (() => id !== this.request)
    const provider = this.getProvider()
    if (!provider) return

    if (!this.field || this.field.provider !== provider) this.field = HeightField.for(provider)
    const field = this.field
    const radius = this.settings.radius
    const halves = viewshedLevelHalves(radius)
    const ns = viewshedLevelResolutions(this.resolution)

    // Keep levels that already match half-width and resolution; clear mismatched ones.
    const sameGrid = this.loadedRadius === radius && this.loadedResolution === ns[0]
    if (!sameGrid) {
      for (let i = 0; i < VIEWSHED_LEVEL_COUNT; i++) {
        const l = this.levels[i]
        if (!l || l.half !== halves[i] || l.n !== ns[i]) {
          this.levels[i] = null
          this.compute.setLevel(i, null, true)
        }
      }
      this.loadedRadius = radius
      this.loadedResolution = ns[0]
    }

    const c = Cartographic.fromCartesian(spot)
    const longitude = toDeg(c.longitude)
    const latitude = toDeg(c.latitude)
    const geoid = geoidUndulation(latitude, longitude)

    appState().patchViewshed({
      status: 'loading',
      loaded: this.levels.filter(Boolean).length,
      levels: VIEWSHED_LEVEL_COUNT,
      error: null
    })

    let surfaceHeight: number | undefined
    let surfaceKnown = !surface

    // Coarse first: L2 covers the entire analysis circle immediately, then L1 and L0 sharpen.
    for (let k = VIEWSHED_LEVEL_COUNT - 1; k >= 0; k--) {
      if (this.levels[k]) continue
      const level = await field
        .loadLevel(frame, 0, 0, halves[k], ns[k], this.levels[k + 1] ?? null, cancelled)
        .catch(() => null)
      if (cancelled()) return
      if (!level) {
        if (k === VIEWSHED_LEVEL_COUNT - 1) {
          this.compute.setEnabled(false)
          appState().patchViewshed({
            status: 'error',
            error: 'Could not load terrain around this point. Check your connection and try again.'
          })
          this.onVisibilityChange()
          return
        }
        continue
      }
      this.levels[k] = level
      if (!surfaceKnown) {
        surfaceHeight = await surface!.catch(() => undefined)
        surfaceKnown = true
        if (cancelled()) return
      }
      const terrain = heightAt(this.levels, 0, 0)?.height ?? level.minHeight
      const footing =
        surfaceHeight !== undefined && surfaceHeight > terrain && surfaceHeight - terrain < MAX_SURFACE_ABOVE_GROUND
          ? surfaceHeight
          : terrain
      this.targetGroundEllipsoidal = footing
      this.spot = Cartesian3.fromRadians(c.longitude, c.latitude, footing)
      this.updateTargetMarker()
      this.compute.setTarget(this.targetHeight, radius)
      this.compute.setLevel(k, level)
      this.recomputeStats()
      appState().patchViewshed({
        loaded: this.levels.filter(Boolean).length,
        target: { longitude, latitude, groundEllipsoidal: footing, groundMsl: footing - geoid, geoid }
      })
      this.onVisibilityChange()
      this.widget.scene.requestRender()
    }

    if (cancelled()) return
    appState().patchViewshed({ status: 'ready', loaded: this.levels.filter(Boolean).length })
    this.onVisibilityChange()
    this.widget.scene.requestRender()
  }

  private recomputeStats(): void {
    if (!this.frame || !this.levels.some(Boolean)) return
    this.profile = computeViewshedProfile(this.levels, this.targetHeight, this.settings.radius, {
      radius: this.frame.radius
    })
    this.publishStatsOnly()
  }

  private publishStatsOnly(): void {
    if (!this.profile) return
    const stats = viewshedCoverageStats(this.profile, this.settings.viewerOffset)
    appState().patchViewshed({ stats })
  }

  private updateTargetMarker(): void {
    if (!this.spot) {
      this.targetBasePoint = null
      this.targetPoint = null
      return
    }
    const c = Cartographic.fromCartesian(this.spot)
    this.targetBasePoint = Cartesian3.fromRadians(c.longitude, c.latitude, this.targetGroundEllipsoidal)
    this.targetPoint = Cartesian3.fromRadians(c.longitude, c.latitude, this.targetHeight)
    this.widget.scene.requestRender()
  }

  private addEntities(): void {
    if (this.entities.length > 0) return
    const entities = this.widget.entities
    this.entities.push(
      entities.add({
        position: new CallbackProperty(() => this.targetPoint ?? this.targetBasePoint ?? undefined, false) as unknown as Cartesian3,
        point: {
          pixelSize: 11,
          color: TARGET_COLOR,
          outlineColor: Color.WHITE,
          outlineWidth: 2.5,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      }),
      // Vertical stem when the target sits noticeably above ground (tower / drone).
      entities.add({
        polyline: {
          positions: new CallbackProperty(() => {
            if (!this.targetBasePoint || !this.targetPoint || this.settings.targetOffset <= 3) return []
            return [this.targetBasePoint, this.targetPoint]
          }, false),
          width: 2,
          arcType: ArcType.NONE,
          material: new ColorMaterialProperty(TARGET_COLOR.withAlpha(0.9))
        }
      })
    )
  }

  private removeEntities(): void {
    for (const e of this.entities) this.widget.entities.remove(e)
    this.entities = []
  }

  private onPreRender(): void {
    const b = this.compute.binding
    if (this.frame) Matrix4.multiply(this.frame.fixedToEnu, this.widget.scene.camera.inverseViewMatrix, b.eyeToLocal)
    b.exaggeration.x = this.widget.scene.verticalExaggeration
    b.exaggeration.y = this.widget.scene.verticalExaggerationRelativeHeight
    for (const m of this.materials) this.syncMaterial(m)
  }

  private syncMaterial(m: Material): void {
    const b = this.compute.binding
    const u = m.uniforms as Record<string, unknown>
    for (let k = 0; k < VIEWSHED_LEVEL_COUNT; k++) {
      const mask = b.masks[k]
      if (mask && u[VIEWSHED_RECEIVER_UNIFORMS.masks[k]] !== mask) u[VIEWSHED_RECEIVER_UNIFORMS.masks[k]] = mask
      u[VIEWSHED_RECEIVER_UNIFORMS.rects[k]] = b.rects[k]
    }
    u[VIEWSHED_RECEIVER_UNIFORMS.params] = b.params
    u[VIEWSHED_RECEIVER_UNIFORMS.style] = b.style
    u[VIEWSHED_RECEIVER_UNIFORMS.eyeToLocal] = b.eyeToLocal
    u[VIEWSHED_RECEIVER_UNIFORMS.exaggeration] = b.exaggeration
  }

  // ───────────────────────────── test support ─────────────────────────────
}
