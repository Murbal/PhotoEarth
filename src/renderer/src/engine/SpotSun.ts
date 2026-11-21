import { Cartographic, type Cartesian3, type TerrainProvider } from 'cesium'
import { HORIZON_BINS, horizonProfile, receiverHeight, sunlitDay, type HorizonOptions } from '../lib/horizon'
import { sunDay } from '../lib/sun'
import { heightAt, LEVEL_COUNT, LEVEL_HALF, levelResolutions, type ShadowLevel } from '../lib/terrainShadow'
import { appState, useAppStore, type SpotSunInfo } from '../store/appStore'
import { HeightField, LocalFrame, yieldToMain } from './shadows/HeightField'
import { toDeg } from './util'

/** Grid size for the point's levels: ~20 m cells within 5 km, as the High shadow preset. */
const RESOLUTION = 512
/** Skyline bins traced between yields to the UI. */
const BINS_PER_SLICE = 90

interface Spot {
  longitude: number
  latitude: number
  /** Ellipsoidal height of the clicked surface (a roof or tree top can sit above the terrain). */
  height: number
}

/**
 * Terrain-aware sunrise and sunset at the inspected point ("first light / last light"). The
 * terrain around the point is loaded into its own nested levels centered on it, out to the
 * same ±80 km as the shadow pass, and its skyline traced once; each date then only crosses
 * that skyline with the sun's path.
 */
export class SpotSun {
  private spot: Spot | null = null
  private skyline: Float32Array | null = null
  private status: SpotSunInfo['status'] = 'loading'
  private request = 0
  private readonly unsubscribe: Array<() => void>

  constructor(private readonly getProvider: () => TerrainProvider | null) {
    this.unsubscribe = [
      useAppStore.subscribe(
        (s) => `${s.sim.date}|${s.sim.timeZone}`,
        () => this.publish()
      ),
      useAppStore.subscribe(
        (s) => s.terrainReady,
        () => {
          if (this.spot && this.status !== 'ready') void this.load()
        }
      ),
      useAppStore.subscribe(
        (s) => s.inspect === null,
        (cleared) => {
          if (cleared) this.clear()
        }
      )
    ]
  }

  destroy(): void {
    this.request++
    this.unsubscribe.forEach((u) => u())
  }

  inspect(position: Cartesian3): Promise<void> {
    const c = Cartographic.fromCartesian(position)
    if (!c) return Promise.resolve()
    this.spot = { longitude: c.longitude, latitude: c.latitude, height: c.height }
    return this.load()
  }

  clear(): void {
    this.request++
    this.spot = null
    this.skyline = null
    if (appState().spotSun) appState().set({ spotSun: null })
  }

  private async load(): Promise<void> {
    const spot = this.spot
    if (!spot) return
    const id = ++this.request
    const cancelled = () => id !== this.request
    this.skyline = null
    const provider = this.getProvider()
    if (!provider) {
      this.status = 'no-terrain'
      this.publish()
      return
    }
    this.status = 'loading'
    this.publish()

    const field = HeightField.for(provider)
    const frame = new LocalFrame(spot.longitude, spot.latitude)
    const ns = levelResolutions(RESOLUTION)
    const levels: Array<ShadowLevel | null> = new Array<ShadowLevel | null>(LEVEL_COUNT).fill(null)
    for (let k = LEVEL_COUNT - 1; k >= 0; k--) {
      levels[k] = await field.loadLevel(frame, 0, 0, LEVEL_HALF[k], ns[k], levels[k + 1] ?? null, cancelled).catch(() => null)
      if (cancelled()) return
    }
    const ground = heightAt(levels, 0, 0)
    const loaded = levels.filter((l): l is ShadowLevel => l !== null)
    if (!ground || loaded.length === 0) {
      this.status = 'unavailable'
      this.publish()
      return
    }
    const opts: HorizonOptions = {
      radius: frame.radius,
      farHeight: loaded[loaded.length - 1].minHeight,
      maxHeight: Math.max(...loaded.map((l) => l.maxHeight))
    }
    // The heightmap smooths roofs and trees away; a clicked surface above it sees further.
    const height = receiverHeight(Math.max(ground.height, spot.height), ground.cell)
    const skyline = new Float32Array(HORIZON_BINS)
    for (let from = 0; from < HORIZON_BINS; from += BINS_PER_SLICE) {
      horizonProfile(levels, 0, 0, height, opts, HORIZON_BINS, from, Math.min(HORIZON_BINS, from + BINS_PER_SLICE), skyline)
      await yieldToMain()
      if (cancelled()) return
    }
    this.skyline = skyline
    this.status = 'ready'
    this.publish()
  }

  private publish(): void {
    const spot = this.spot
    if (!spot) return
    const { sim, set } = appState()
    const latitude = toDeg(spot.latitude)
    const longitude = toDeg(spot.longitude)
    const flat = sunDay(sim.date, sim.timeZone, latitude, longitude)
    const lit = this.status === 'ready' && this.skyline ? sunlitDay(this.skyline, sim.date, sim.timeZone, latitude, longitude) : null
    set({
      spotSun: {
        status: this.status,
        date: sim.date,
        timeZone: sim.timeZone,
        sunrise: flat.sunrise,
        sunset: flat.sunset,
        polar: flat.polar,
        firstLight: lit?.firstLight ?? null,
        lastLight: lit?.lastLight ?? null,
        spans: lit?.spans ?? [],
        sunlitMs: lit?.sunlitMs ?? 0
      }
    })
  }
}
