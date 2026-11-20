import {
  ArcType,
  CallbackProperty,
  Cartesian3,
  Color,
  ColorMaterialProperty,
  DynamicAtmosphereLightingType,
  JulianDate,
  PolylineArrowMaterialProperty,
  PolylineDashMaterialProperty,
  ShadowMap,
  ShadowMode,
  SunLight,
  Transforms,
  Matrix4,
  type CesiumWidget,
  type Entity
} from 'cesium'
import type { LightingMode, MapMode } from '@shared/types'
import { SUN, type CelestialBody } from '../lib/celestial'
import { altitudeProfile, sunDirectionENU, type SunDay } from '../lib/sun'
import { addDays, addMinutes, isValidTimeZone, offsetMinutes, utcToZoned, zoneAbbreviation, zonedToUtc } from '../lib/time'
import { lookupTimeZone } from '../lib/timezone'
import { appState, useAppStore, type PlaybackSpeedId, type SunInfo } from '../store/appStore'
import type { QualityConfig } from './quality'
import { detailShadowPatchWorking } from './shadows/detailShadowPatch'
import type { TilesetManager } from './TilesetManager'
import { clamp, smoothstep } from './util'

export const PLAYBACK_SPEEDS: Record<PlaybackSpeedId, { label: string; kind: 'time' | 'days'; rate: number }> = {
  '1m': { label: '1 min/s', kind: 'time', rate: 1 },
  '10m': { label: '10 min/s', kind: 'time', rate: 10 },
  '1h': { label: '1 h/s', kind: 'time', rate: 60 },
  '1d': { label: '1 day/s', kind: 'days', rate: 1 },
  '7d': { label: '1 week/s', kind: 'days', rate: 7 }
}

/**
 * Drives the Cesium clock from the simulated local date/time at the camera target,
 * and with it scene lighting, sky, shadow maps and the sun readouts.
 * Rendering uses Cesium's own sun model; readouts use SunCalc (§2).
 */
export class SunController {
  private readonly sunLight = new SunLight()
  private raf: number | null = null
  private lastFrame = 0
  private dayAccumulator = 0
  private profileKey = ''
  private profile: number[] = []
  private dayKey = ''
  private day: SunDay | null = null
  private indicator: Entity[] = []
  private mode: MapMode = 'photorealistic'
  private lighting: LightingMode = 'sun'
  private shadowsWanted = true
  private detailWanted = true
  /** Heightmap terrain shadows are shading the view (the shadow map then only adds detail). */
  private terrainShadows = false
  private cameraNear = true
  private cameraAgl: number | null = null
  private detailDistance = 1200
  private legacyDistance = 20000
  private shadowMapSize = 4096
  private altitude = 45
  private azimuth = 180
  private targetPosition: Cartesian3 | null = null
  private cascades: 1 | 4 = 4
  private readonly unsubscribe: Array<() => void> = []

  constructor(
    private readonly widget: CesiumWidget,
    private readonly tiles: TilesetManager,
    private readonly body: CelestialBody = SUN
  ) {
    const { scene, clock } = widget
    clock.shouldAnimate = false
    scene.light = this.sunLight
    if (scene.sun) scene.sun.show = true
    if (scene.moon) scene.moon.show = true
    const shadowMap = scene.shadowMap
    // Low sun is the main use case: don't fade shadows out near the horizon.
    shadowMap.fadingEnabled = false
    shadowMap.darkness = 0.35
    shadowMap.normalOffset = true

    this.unsubscribe.push(
      useAppStore.subscribe((s) => s.sim, () => this.update()),
      useAppStore.subscribe(
        (s) => s.target,
        (t) => this.onTarget(t)
      )
    )
  }

  destroy(): void {
    this.pause()
    this.unsubscribe.forEach((u) => u())
    this.removeIndicator()
  }

  /** UTC instant of the current simulated local time. */
  get utc(): number {
    const { sim } = appState()
    return zonedToUtc(sim.date, sim.minutes, sim.timeZone)
  }

  private onTarget(target: { longitude: number; latitude: number } | null): void {
    if (!target) return
    const zone = lookupTimeZone(target.latitude, target.longitude)
    const { sim, patchSim } = appState()
    // Keep the local wall-clock time when crossing into another zone.
    if (zone !== sim.timeZone && isValidTimeZone(zone)) patchSim({ timeZone: zone })
    else this.update()
  }

  setTargetPosition(position: Cartesian3): void {
    this.targetPosition = position
    this.updateIndicator()
  }

  configure(mode: MapMode, lighting: LightingMode, shadows: boolean, detailShadows: boolean): void {
    this.mode = mode
    this.lighting = lighting
    this.shadowsWanted = shadows
    this.detailWanted = detailShadows
    this.applyLighting()
  }

  setTerrainShadows(active: boolean): void {
    if (active === this.terrainShadows) return
    this.terrainShadows = active
    this.applyLighting()
  }

  /** Camera height above ground: detail shadows are pointless from far above. */
  setCameraHeight(agl: number | null): void {
    this.cameraAgl = agl
    const near = agl === null || agl < this.detailDistance * 1.2
    if (near === this.cameraNear) return
    this.cameraNear = near
    this.applyLighting()
  }

  applyQuality(q: QualityConfig): void {
    const scene = this.widget.scene
    if (q.shadowCascades !== this.cascades) {
      // Cascade count is fixed at construction; rebuild the scene's shadow map.
      this.cascades = q.shadowCascades
      const previous = scene.shadowMap
      const Ctor = ShadowMap as unknown as new (options: Record<string, unknown>) => ShadowMap
      scene.shadowMap = new Ctor({
        context: (scene as unknown as { context: unknown }).context,
        lightCamera: (scene as unknown as { _shadowMapCamera: unknown })._shadowMapCamera,
        enabled: previous.enabled,
        numberOfCascades: q.shadowCascades,
        softShadows: q.softShadows,
        size: q.shadowMapSize,
        darkness: previous.darkness,
        maximumDistance: q.shadowDistance
      })
      scene.shadowMap.fadingEnabled = false
      ;(previous as unknown as { destroy(): void }).destroy()
    }
    scene.shadowMap.size = q.shadowMapSize
    scene.shadowMap.softShadows = q.softShadows
    this.detailDistance = q.detailShadowDistance
    this.legacyDistance = q.shadowDistance
    this.shadowMapSize = q.shadowMapSize
    this.cameraNear = this.cameraAgl === null || this.cameraAgl < this.detailDistance * 1.2
    this.applyLighting()
  }

  /** Recomputes the instant, clock, lighting and readouts from the store. */
  update(): void {
    const { sim, target, set } = appState()
    const utc = zonedToUtc(sim.date, sim.minutes, sim.timeZone)
    this.widget.clock.currentTime = JulianDate.fromDate(new Date(utc))
    const lat = target?.latitude ?? 0
    const lon = target?.longitude ?? 0
    const pos = this.body.position(utc, lat, lon)
    this.altitude = pos.altitude
    this.azimuth = pos.azimuth
    // Rise/set times only depend on the date and place; playback changes neither per frame.
    const dayKey = `${sim.date}|${sim.timeZone}|${lat}|${lon}`
    if (dayKey !== this.dayKey || !this.day) {
      this.dayKey = dayKey
      this.day = this.body.day(sim.date, sim.timeZone, lat, lon)
    }
    const day = this.day
    const key = `${sim.date}|${sim.timeZone}|${lat.toFixed(2)}|${lon.toFixed(2)}`
    if (key !== this.profileKey) {
      this.profileKey = key
      this.profile = altitudeProfile(sim.date, sim.timeZone, lat, lon, 96)
    }
    const info: SunInfo = {
      utc,
      azimuth: pos.azimuth,
      altitude: pos.altitude,
      sunrise: day.sunrise,
      sunset: day.sunset,
      solarNoon: day.solarNoon,
      dawn: day.dawn,
      dusk: day.dusk,
      polar: day.polar,
      noonAltitude: day.noonAltitude,
      offsetMinutes: offsetMinutes(utc, sim.timeZone),
      zoneName: zoneAbbreviation(utc, sim.timeZone),
      profile: this.profile
    }
    set({ sun: info })
    this.applyLighting()
    this.updateIndicator()
  }

  private applyLighting(): void {
    const scene = this.widget.scene
    const globe = scene.globe
    const simulated = this.lighting === 'sun'
    scene.light = this.sunLight
    globe.enableLighting = simulated
    globe.dynamicAtmosphereLighting = simulated
    globe.dynamicAtmosphereLightingFromSun = simulated
    scene.atmosphere.dynamicLighting = simulated
      ? DynamicAtmosphereLightingType.SUNLIGHT
      : DynamicAtmosphereLightingType.NONE
    // Night / twilight dimming for the (unlit) photorealistic mesh.
    this.tiles.setDaylight(simulated ? 0.08 + 0.92 * smoothstep(-7, 2, this.altitude) : 1)
    const wanted = simulated && this.shadowsWanted
    const photo = this.mode === 'photorealistic'
    let enabled: boolean
    let distance: number
    if (this.terrainShadows) {
      // Terrain shadows come from the heightmap; the shadow map only adds what the terrain
      // model lacks (buildings, trees, overhangs) close to a low camera.
      enabled = wanted && photo && this.detailWanted && this.detailDistance > 0 && this.altitude > 0.5 && this.cameraNear
      distance = this.detailDistance
    } else {
      // No terrain heights (no ion token, or still loading): shadow maps do everything.
      enabled = wanted && this.altitude > -0.5
      distance = this.legacyDistance
    }
    const shadowMap = scene.shadowMap
    shadowMap.enabled = enabled
    shadowMap.maximumDistance = distance
    this.applyBias(distance)
    globe.shadows = enabled && !photo ? ShadowMode.ENABLED : ShadowMode.DISABLED
    this.tiles.setShadows(enabled && photo)
    scene.requestRender()
  }

  /**
   * Google's tiles have no normals, so Cesium's normal-offset bias only works through the
   * derived-normal patch. Scale it with the world size of a shadow-map texel.
   */
  private applyBias(distance: number): void {
    if (!detailShadowPatchWorking()) return
    const bias = (this.widget.scene.shadowMap as unknown as { _primitiveBias?: { normalOffsetScale: number; depthBias: number } })._primitiveBias
    if (!bias) return
    // One offset serves every cascade; the nearest is ~20× finer than the last, so aim between.
    const far = distance / this.shadowMapSize
    const texel = this.cascades === 4 ? Math.sqrt(far * (far / 20)) : far
    bias.normalOffsetScale = clamp(texel * 2, 0.05, 3)
    bias.depthBias = 0.00004
  }

  // ───────────────────────────── time controls ─────────────────────────────

  setNow(): void {
    const { sim, patchSim } = appState()
    patchSim(utcToZoned(Date.now(), sim.timeZone))
  }

  nudgeMinutes(delta: number): void {
    const { sim, patchSim } = appState()
    patchSim(addMinutes(sim.date, sim.minutes, delta))
  }

  nudgeDays(delta: number): void {
    const { sim, patchSim } = appState()
    patchSim({ date: addDays(sim.date, delta) })
  }

  setInstant(utc: number, timeZone?: string): void {
    const { sim, patchSim } = appState()
    const zone = timeZone && isValidTimeZone(timeZone) ? timeZone : sim.timeZone
    patchSim({ ...utcToZoned(utc, zone), timeZone: zone })
  }

  togglePlay(): void {
    if (appState().sim.playing) this.pause()
    else this.play()
  }

  play(): void {
    appState().patchSim({ playing: true })
    if (this.raf !== null) return
    this.lastFrame = performance.now()
    this.dayAccumulator = 0
    const step = (now: number) => {
      const dt = Math.min(0.25, (now - this.lastFrame) / 1000)
      this.lastFrame = now
      const { sim, patchSim } = appState()
      if (!sim.playing) {
        this.raf = null
        return
      }
      const speed = PLAYBACK_SPEEDS[sim.speed]
      if (speed.kind === 'time') {
        patchSim(addMinutes(sim.date, sim.minutes, speed.rate * dt))
      } else {
        // Step whole days at a fixed time of day.
        this.dayAccumulator += speed.rate * dt
        const days = Math.floor(this.dayAccumulator)
        if (days > 0) {
          this.dayAccumulator -= days
          patchSim({ date: addDays(sim.date, days) })
        }
      }
      this.raf = requestAnimationFrame(step)
    }
    this.raf = requestAnimationFrame(step)
  }

  pause(): void {
    if (this.raf !== null) cancelAnimationFrame(this.raf)
    this.raf = null
    if (appState().sim.playing) appState().patchSim({ playing: false })
  }

  // ───────────────────────────── direction indicator ─────────────────────────────

  private removeIndicator(): void {
    for (const e of this.indicator) this.widget.entities.remove(e)
    this.indicator = []
  }

  private updateIndicator(): void {
    const show = appState().settings.showSunIndicator && this.lighting === 'sun'
    if (!show || !this.targetPosition) {
      if (this.indicator.length) {
        this.removeIndicator()
        this.widget.scene.requestRender()
      }
      return
    }
    if (this.indicator.length === 0) this.createIndicator()
    this.widget.scene.requestRender()
  }

  private indicatorPositions(alongGround: boolean): Cartesian3[] {
    const target = this.targetPosition
    if (!target) return []
    const scene = this.widget.scene
    const length = Math.min(60000, Math.max(40, Cartesian3.distance(scene.camera.positionWC, target) * 0.3))
    const [e, n, u] = sunDirectionENU({ azimuth: this.azimuth, altitude: Math.max(this.altitude, -5) })
    const enu = Transforms.eastNorthUpToFixedFrame(target)
    const local = alongGround
      ? new Cartesian3(e, n, 0)
      : new Cartesian3(e, n, u)
    Cartesian3.normalize(local, local)
    Cartesian3.multiplyByScalar(local, length, local)
    const lift = new Cartesian3(0, 0, Math.max(1, length * 0.004))
    const start = Matrix4.multiplyByPoint(enu, lift, new Cartesian3())
    const end = Matrix4.multiplyByPoint(enu, Cartesian3.add(local, lift, new Cartesian3()), new Cartesian3())
    return [start, end]
  }

  private createIndicator(): void {
    const sunColor = Color.fromCssColorString('#ffc94d')
    const ground = this.widget.entities.add({
      polyline: {
        positions: new CallbackProperty(() => this.indicatorPositions(true), false),
        width: 14,
        material: new PolylineArrowMaterialProperty(sunColor),
        depthFailMaterial: new ColorMaterialProperty(sunColor.withAlpha(0.35)),
        arcType: ArcType.NONE
      }
    })
    const ray = this.widget.entities.add({
      polyline: {
        positions: new CallbackProperty(() => this.indicatorPositions(false), false),
        width: 2,
        material: new PolylineDashMaterialProperty({ color: sunColor, dashLength: 12 }),
        depthFailMaterial: new PolylineDashMaterialProperty({ color: sunColor.withAlpha(0.3), dashLength: 12 }),
        arcType: ArcType.NONE
      }
    })
    this.indicator = [ground, ray]
  }
}
