import type { Cartesian3, CesiumWidget } from 'cesium'
import { MOON, type BodyDay, type CelestialBody } from '../lib/celestial'
import { moonState, nextPhases } from '../lib/moon'
import { zonedToUtc } from '../lib/time'
import { appState, useAppStore, type MoonInfo } from '../store/appStore'
import { driveCesiumMoon } from './cesiumMoon'
import { DirectionIndicator } from './DirectionIndicator'

/**
 * The moon for the simulated instant at the camera target: readouts (position, phase,
 * rise/set), the direction line on the map, and Cesium's rendered moon, which sits behind
 * terrain and buildings so a rising moon appears exactly where it clears a ridge. The time
 * itself belongs to SunController; this only follows it. The moon doesn't light the scene.
 */
export class MoonController {
  private readonly indicator: DirectionIndicator
  private readonly restoreCesium: () => void
  private readonly unsubscribe: Array<() => void> = []
  private dayKey = ''
  private day: BodyDay | null = null
  private phasesKey = ''
  private phases: { newMoon: number | null; fullMoon: number | null } = { newMoon: null, fullMoon: null }

  constructor(
    widget: CesiumWidget,
    private readonly body: CelestialBody = MOON
  ) {
    const moon = widget.scene.moon
    if (moon) {
      moon.show = true
      // Lit by the sun only (Cesium's default), so the rendered disc shows the phase.
      moon.onlySunLighting = true
    }
    this.restoreCesium = driveCesiumMoon()
    this.indicator = new DirectionIndicator(widget, '#b8c8ff')
    this.unsubscribe.push(
      useAppStore.subscribe((s) => s.sim, () => this.update()),
      useAppStore.subscribe((s) => s.target, () => this.update())
    )
  }

  destroy(): void {
    this.unsubscribe.forEach((u) => u())
    this.indicator.destroy()
    this.restoreCesium()
  }

  setTargetPosition(position: Cartesian3): void {
    this.indicator.setTarget(position)
    this.updateIndicator()
  }

  update(): void {
    const { sim, target, set } = appState()
    const utc = zonedToUtc(sim.date, sim.minutes, sim.timeZone)
    const lat = target?.latitude ?? 0
    const lon = target?.longitude ?? 0
    const state = moonState(utc, lat, lon)
    // Rise and set move ~4 minutes per degree of longitude: ~100 m steps don't need a new search
    // while panning, and playback within a day doesn't change them at all.
    const dayKey = `${sim.date}|${sim.timeZone}|${lat.toFixed(3)}|${lon.toFixed(3)}`
    if (dayKey !== this.dayKey || !this.day) {
      this.dayKey = dayKey
      this.day = this.body.day(sim.date, sim.timeZone, lat, lon)
    }
    const phasesKey = `${sim.date}|${sim.timeZone}`
    if (phasesKey !== this.phasesKey) {
      // From the start of the local day, so a full moon later today still reads "today".
      this.phasesKey = phasesKey
      this.phases = nextPhases(zonedToUtc(sim.date, 0, sim.timeZone))
    }
    const info: MoonInfo = {
      utc,
      ...state,
      ...this.day,
      nextNewMoon: this.phases.newMoon,
      nextFullMoon: this.phases.fullMoon
    }
    set({ moon: info })
    this.indicator.setDirection(state)
    this.updateIndicator()
  }

  updateIndicator(): void {
    this.indicator.update(appState().settings.showMoonIndicator)
  }
}
