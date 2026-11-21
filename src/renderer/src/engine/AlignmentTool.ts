import {
  ArcType,
  Cartesian2,
  Cartesian3,
  Cartographic,
  ClassificationType,
  Color,
  ColorMaterialProperty,
  LabelStyle,
  PolylineDashMaterialProperty,
  VerticalOrigin,
  type CesiumWidget,
  type Entity
} from 'cesium'
import {
  computeAlignmentGeometry,
  DEFAULT_EYE_HEIGHT,
  destinationPoint,
  evaluateLineOfSight,
  type AlignmentPin,
  type LineOfSightSample
} from '../lib/alignment'
import { toMsl } from '../lib/geoid'
import { densifyPath, type GeoPoint } from '../lib/profile'
import { addDays } from '../lib/time'
import { appState, type AlignmentPickMode } from '../store/appStore'
import { toDeg } from './util'

export interface AlignmentDeps {
  sampleGround: (longitude: number, latitude: number) => Promise<number | undefined>
  samplePath: (points: GeoPoint[]) => Promise<{ heights: Array<number | null>; source: 'terrain' | 'tiles' }>
}

const CAM_COLOR = Color.fromCssColorString('#4fd1ff')
const SUB_COLOR = Color.fromCssColorString('#ff8a4c')
const CLEAR_COLOR = Color.fromCssColorString('#4cd18a')
const BLOCKED_COLOR = Color.fromCssColorString('#ff6b6b')
const TRACK_COLOR = Color.fromCssColorString('#4fd1ff').withAlpha(0.35)
const LABEL_FONT = '600 11px "Segoe UI", system-ui, sans-serif'

/**
 * Two-pin Camera → Subject shot alignment tool on the 3D globe.
 * Renders the Camera and Subject pins, ground track, 3D sightline (colored by line-of-sight
 * status), and worst obstruction marker when terrain blocks the view.
 * Never performs per-frame GPU readbacks and respects requestRenderMode.
 */
export class AlignmentTool {
  private entities: Entity[] = []
  private cameraGround: Cartesian3 | null = null
  private cameraEye: Cartesian3 | null = null
  private subjectPos: Cartesian3 | null = null
  private obstructionPos: Cartesian3 | null = null
  private cachedSamples: LineOfSightSample[] = []
  private losRequest = 0
  /**
   * Per pin, so placing the Subject right after the Camera doesn't drop the Camera's precise
   * ground height while it is still being sampled (and the other way round).
   */
  private readonly pinRequest = { camera: 0, subject: 0 }

  constructor(
    private readonly widget: CesiumWidget,
    private readonly deps: AlignmentDeps
  ) {}

  get isOpen(): boolean {
    return appState().alignment.open
  }

  get pickMode(): AlignmentPickMode {
    return appState().alignment.pickMode
  }

  get cameraSpot(): Cartesian3 | null {
    return this.cameraGround
  }

  get subjectSpot(): Cartesian3 | null {
    return this.subjectPos
  }

  open(pick?: AlignmentPickMode): void {
    const s = appState()
    // Sync default search start date to the simulated date if pins aren't set yet.
    if (!s.alignment.camera && !s.alignment.subject) {
      const start = s.sim.date
      const days = s.alignment.filters.rangePreset === '30d' ? 30 : s.alignment.filters.rangePreset === '90d' ? 90 : s.alignment.filters.rangePreset === '2y' ? 730 : 365
      s.patchAlignmentFilters({ startDate: start, endDate: addDays(start, days) })
    }
    // Close Elevation side panel so right-side panels don't compete for space (styling stays active).
    if (s.panels.elevation) s.togglePanel('elevation', false)
    const nextPick = pick !== undefined ? pick : !s.alignment.camera ? 'camera' : !s.alignment.subject ? 'subject' : null
    s.patchAlignment({ open: true, pickMode: nextPick })
    this.syncEntities()
  }

  close(): void {
    this.losRequest++
    this.invalidatePins()
    this.removeEntities()
    this.cameraGround = null
    this.cameraEye = null
    this.subjectPos = null
    this.obstructionPos = null
    this.cachedSamples = []
    appState().resetAlignment()
    this.widget.scene.requestRender()
  }

  clearPins(): void {
    this.losRequest++
    this.invalidatePins()
    this.cameraGround = null
    this.cameraEye = null
    this.subjectPos = null
    this.obstructionPos = null
    this.cachedSamples = []
    appState().patchAlignment({
      camera: null,
      subject: null,
      manualDirection: null,
      geometry: null,
      los: null,
      losLoading: false,
      losSource: null,
      selectedMatchId: null,
      pickMode: 'camera'
    })
    this.syncEntities()
  }

  setPickMode(mode: AlignmentPickMode): void {
    appState().patchAlignment({ pickMode: mode })
  }

  async setCamera(position: Cartesian3, label?: string): Promise<void> {
    const c = Cartographic.fromCartesian(position)
    await this.setCameraFromCoords(toDeg(c.longitude), toDeg(c.latitude), c.height, label)
  }

  async setSubject(position: Cartesian3, label?: string): Promise<void> {
    const c = Cartographic.fromCartesian(position)
    await this.setSubjectFromCoords(toDeg(c.longitude), toDeg(c.latitude), c.height, label)
  }

  async setCameraFromCoords(longitude: number, latitude: number, initialGroundHeight?: number, label?: string): Promise<void> {
    const id = ++this.pinRequest.camera
    const ground0 = initialGroundHeight !== undefined && Number.isFinite(initialGroundHeight) ? initialGroundHeight : 0
    const pin: AlignmentPin = {
      longitude,
      latitude,
      groundHeight: ground0,
      msl: toMsl(latitude, longitude, ground0),
      label
    }
    const hasSubject = appState().alignment.subject !== null
    appState().patchAlignment({
      open: true,
      camera: pin,
      manualDirection: hasSubject ? null : appState().alignment.manualDirection,
      selectedMatchId: null,
      pickMode: hasSubject ? null : 'subject'
    })
    this.recompute(true)

    const precise = await this.deps.sampleGround(longitude, latitude).catch(() => undefined)
    if (id !== this.pinRequest.camera) return
    const current = appState().alignment.camera
    if (!current || Math.abs(current.longitude - longitude) > 1e-7 || Math.abs(current.latitude - latitude) > 1e-7) return
    if (precise !== undefined && Number.isFinite(precise)) {
      appState().patchAlignment({
        camera: { ...current, groundHeight: precise, msl: toMsl(latitude, longitude, precise) }
      })
      this.recompute(true)
    }
  }

  async setSubjectFromCoords(longitude: number, latitude: number, initialGroundHeight?: number, label?: string): Promise<void> {
    const id = ++this.pinRequest.subject
    const ground0 = initialGroundHeight !== undefined && Number.isFinite(initialGroundHeight) ? initialGroundHeight : 0
    const pin: AlignmentPin = {
      longitude,
      latitude,
      groundHeight: ground0,
      msl: toMsl(latitude, longitude, ground0),
      label
    }
    const hasCamera = appState().alignment.camera !== null
    appState().patchAlignment({
      open: true,
      subject: pin,
      manualDirection: null,
      selectedMatchId: null,
      pickMode: hasCamera ? null : 'camera'
    })
    this.recompute(true)

    const precise = await this.deps.sampleGround(longitude, latitude).catch(() => undefined)
    if (id !== this.pinRequest.subject) return
    const current = appState().alignment.subject
    if (!current || Math.abs(current.longitude - longitude) > 1e-7 || Math.abs(current.latitude - latitude) > 1e-7) return
    if (precise !== undefined && Number.isFinite(precise)) {
      appState().patchAlignment({
        subject: { ...current, groundHeight: precise, msl: toMsl(latitude, longitude, precise) }
      })
      this.recompute(true)
    }
  }

  /**
   * Populates the alignment planner from a Horizon Panorama observer and selected skyline
   * direction. When skyline distance & height are known, places a Subject pin at that ridge;
   * otherwise sets a manual direction so reverse Sun/Moon search works immediately.
   */
  openFromHorizon(
    observer: { longitude: number; latitude: number; groundHeight: number; eyeHeight?: number },
    azimuth: number,
    altitude: number,
    skyline?: { distance: number; height: number; label?: string }
  ): void {
    const s = appState()
    if (s.panels.elevation) s.togglePanel('elevation', false)
    const eyeHeight = observer.eyeHeight ?? DEFAULT_EYE_HEIGHT
    const camera: AlignmentPin = {
      longitude: observer.longitude,
      latitude: observer.latitude,
      groundHeight: observer.groundHeight,
      msl: toMsl(observer.latitude, observer.longitude, observer.groundHeight),
      label: 'Horizon observer'
    }
    let subject: AlignmentPin | null = null
    let manualDirection: { azimuth: number; altitude: number } | null = { azimuth, altitude }
    if (skyline && skyline.distance > 10 && Number.isFinite(skyline.height)) {
      const dest = destinationPoint(observer, azimuth, skyline.distance)
      subject = {
        longitude: dest.longitude,
        latitude: dest.latitude,
        groundHeight: skyline.height,
        msl: toMsl(dest.latitude, dest.longitude, skyline.height),
        label: skyline.label ?? 'Skyline point'
      }
      manualDirection = null
    }
    const start = s.sim.date
    const days = s.alignment.filters.rangePreset === '30d' ? 30 : s.alignment.filters.rangePreset === '90d' ? 90 : s.alignment.filters.rangePreset === '2y' ? 730 : 365
    s.patchAlignmentFilters({ startDate: start, endDate: addDays(start, days) })
    s.patchAlignment({
      open: true,
      pickMode: null,
      camera,
      subject,
      eyeHeight,
      manualDirection,
      selectedMatchId: null
    })
    this.recompute(true)
  }

  setEyeHeight(meters: number): void {
    if (!Number.isFinite(meters)) return
    const clamped = Math.max(0, Math.min(500, meters))
    appState().patchAlignment({ eyeHeight: clamped })
    // Reuse cached terrain samples so tripod height changes update LOS immediately.
    this.recompute(false)
  }

  swapPins(): void {
    const { camera, subject } = appState().alignment
    if (!camera && !subject) return
    this.cachedSamples = []
    appState().patchAlignment({
      camera: subject,
      subject: camera,
      manualDirection: null,
      selectedMatchId: null
    })
    this.recompute(true)
  }

  /** Drops every pending precise-height lookup (pins cleared, replaced or swapped). */
  private invalidatePins(): void {
    this.pinRequest.camera++
    this.pinRequest.subject++
  }

  destroy(): void {
    this.losRequest++
    this.invalidatePins()
    this.removeEntities()
  }

  // ───────────────────────────── geometry & LOS ─────────────────────────────

  private recompute(resamplePath: boolean): void {
    const { camera, subject, eyeHeight } = appState().alignment
    if (!camera || !subject) {
      this.losRequest++
      this.cachedSamples = []
      this.updateCartesians(camera, subject, camera ? camera.groundHeight + eyeHeight : 0, null)
      appState().patchAlignment({ geometry: null, los: null, losLoading: false, losSource: null })
      this.syncEntities()
      return
    }
    const geometry = computeAlignmentGeometry(camera, subject, eyeHeight)
    appState().patchAlignment({ geometry })

    if (!resamplePath && this.cachedSamples.length > 0) {
      const los = evaluateLineOfSight(geometry.eyeHeightEllipsoid, subject.groundHeight, geometry.horizontalDistance, this.cachedSamples)
      appState().patchAlignment({ los, losLoading: false })
      this.updateCartesians(camera, subject, geometry.eyeHeightEllipsoid, los.obstruction)
      this.syncEntities()
      return
    }

    this.cachedSamples = []
    this.updateCartesians(camera, subject, geometry.eyeHeightEllipsoid, null)
    appState().patchAlignment({ los: null, losLoading: true, losSource: null })
    this.syncEntities()
    void this.sampleLos(camera, subject)
  }

  private async sampleLos(camera: AlignmentPin, subject: AlignmentPin): Promise<void> {
    const id = ++this.losRequest
    const path = densifyPath([camera, subject], 200)
    try {
      const { heights, source } = await this.deps.samplePath(path)
      if (id !== this.losRequest) return
      const cur = appState().alignment
      if (!cur.camera || !cur.subject || !cur.geometry) return
      const samples: LineOfSightSample[] = path.map((p, i) => ({
        longitude: p.longitude,
        latitude: p.latitude,
        distance: p.distance,
        height: heights[i] ?? null
      }))
      this.cachedSamples = samples
      const los = evaluateLineOfSight(cur.geometry.eyeHeightEllipsoid, cur.subject.groundHeight, cur.geometry.horizontalDistance, samples)
      appState().patchAlignment({ los, losLoading: false, losSource: source })
      this.updateCartesians(cur.camera, cur.subject, cur.geometry.eyeHeightEllipsoid, los.obstruction)
      this.syncEntities()
    } catch {
      if (id !== this.losRequest) return
      appState().patchAlignment({
        los: { status: 'unknown', minClearance: null, minClearanceDistance: null, obstruction: null, sampleCount: 0 },
        losLoading: false,
        losSource: null
      })
      this.syncEntities()
    }
  }

  private updateCartesians(
    camera: AlignmentPin | null,
    subject: AlignmentPin | null,
    eyeEllipsoid: number,
    obstruction: { longitude: number; latitude: number; terrainHeight: number } | null
  ): void {
    this.cameraGround = camera ? Cartesian3.fromDegrees(camera.longitude, camera.latitude, camera.groundHeight) : null
    this.cameraEye = camera ? Cartesian3.fromDegrees(camera.longitude, camera.latitude, eyeEllipsoid) : null
    this.subjectPos = subject ? Cartesian3.fromDegrees(subject.longitude, subject.latitude, subject.groundHeight) : null
    this.obstructionPos = obstruction
      ? Cartesian3.fromDegrees(obstruction.longitude, obstruction.latitude, obstruction.terrainHeight)
      : null
  }

  // ───────────────────────────── Cesium entities ─────────────────────────────

  private syncEntities(): void {
    this.removeEntities()
    const { open, los } = appState().alignment
    if (!open) {
      this.widget.scene.requestRender()
      return
    }
    const entities = this.widget.entities
    const obstructed = los?.status === 'obstructed'
    const clear = los?.status === 'clear'
    const sightColor = obstructed ? BLOCKED_COLOR : clear ? CLEAR_COLOR : CAM_COLOR

    if (this.cameraGround && this.subjectPos) {
      // Subtle ground-clamped bearing reference line.
      this.entities.push(
        entities.add({
          polyline: {
            positions: [this.cameraGround, this.subjectPos],
            width: 2,
            material: TRACK_COLOR,
            clampToGround: true,
            classificationType: ClassificationType.BOTH
          }
        })
      )
    }

    if (this.cameraEye && this.subjectPos) {
      // 3D straight sightline from Camera eye height to Subject.
      this.entities.push(
        entities.add({
          polyline: {
            positions: [this.cameraEye, this.subjectPos],
            width: 2.5,
            arcType: ArcType.NONE,
            material: obstructed
              ? new PolylineDashMaterialProperty({ color: sightColor, dashLength: 14 })
              : new ColorMaterialProperty(sightColor),
            depthFailMaterial: new ColorMaterialProperty(sightColor.withAlpha(0.32))
          }
        })
      )
    }

    if (this.cameraGround) {
      this.entities.push(
        entities.add({
          position: this.cameraEye ?? this.cameraGround,
          point: {
            pixelSize: 11,
            color: CAM_COLOR,
            outlineColor: Color.WHITE,
            outlineWidth: 2.5,
            disableDepthTestDistance: Number.POSITIVE_INFINITY
          },
          label: {
            text: 'Camera',
            font: LABEL_FONT,
            style: LabelStyle.FILL_AND_OUTLINE,
            fillColor: Color.WHITE,
            outlineColor: Color.BLACK.withAlpha(0.85),
            outlineWidth: 3,
            verticalOrigin: VerticalOrigin.BOTTOM,
            pixelOffset: new Cartesian2(0, -11),
            disableDepthTestDistance: Number.POSITIVE_INFINITY
          }
        })
      )
    }

    if (this.subjectPos) {
      this.entities.push(
        entities.add({
          position: this.subjectPos,
          point: {
            pixelSize: 11,
            color: SUB_COLOR,
            outlineColor: Color.WHITE,
            outlineWidth: 2.5,
            disableDepthTestDistance: Number.POSITIVE_INFINITY
          },
          label: {
            text: 'Subject',
            font: LABEL_FONT,
            style: LabelStyle.FILL_AND_OUTLINE,
            fillColor: Color.WHITE,
            outlineColor: Color.BLACK.withAlpha(0.85),
            outlineWidth: 3,
            verticalOrigin: VerticalOrigin.BOTTOM,
            pixelOffset: new Cartesian2(0, -11),
            disableDepthTestDistance: Number.POSITIVE_INFINITY
          }
        })
      )
    }

    if (obstructed && this.obstructionPos) {
      this.entities.push(
        entities.add({
          position: this.obstructionPos,
          point: {
            pixelSize: 9,
            color: BLOCKED_COLOR,
            outlineColor: Color.WHITE,
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY
          },
          label: {
            text: 'Blocked',
            font: LABEL_FONT,
            style: LabelStyle.FILL_AND_OUTLINE,
            fillColor: BLOCKED_COLOR,
            outlineColor: Color.BLACK.withAlpha(0.85),
            outlineWidth: 3,
            verticalOrigin: VerticalOrigin.BOTTOM,
            pixelOffset: new Cartesian2(0, -10),
            disableDepthTestDistance: Number.POSITIVE_INFINITY
          }
        })
      )
    }

    this.widget.scene.requestRender()
  }

  private removeEntities(): void {
    for (const e of this.entities) this.widget.entities.remove(e)
    this.entities = []
  }
}
