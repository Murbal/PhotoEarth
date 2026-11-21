import type { Cartesian3, CesiumWidget } from 'cesium'
import { GALACTIC_CORE, type BodyDay, type CelestialBody } from '../lib/celestial'
import { galacticCoreState } from '../lib/milkyWay'
import { zonedToUtc } from '../lib/time'
import { appState, useAppStore, type MilkyWayInfo } from '../store/appStore'
import { DirectionIndicator } from './DirectionIndicator'

/**
 * Galactic Core (Sagittarius A*) and Milky Way arch readouts for the simulated instant at the
 * camera target, plus an optional direction arrow/ray on the 3D map. Follows SunController's
 * simulated clock; never triggers per-frame GPU readbacks.
 */
export class MilkyWayController {
  private readonly indicator: DirectionIndicator
  private readonly unsubscribe: Array<() => void> = []
  private dayKey = ''
  private day: BodyDay | null = null

  constructor(
    widget: CesiumWidget,
    private readonly body: CelestialBody = GALACTIC_CORE
  ) {
    this.indicator = new DirectionIndicator(widget, '#c084fc')
    this.unsubscribe.push(
      useAppStore.subscribe((s) => s.sim, () => this.update()),
      useAppStore.subscribe((s) => s.target, () => this.update())
    )
  }

  destroy(): void {
    this.unsubscribe.forEach((u) => u())
    this.indicator.destroy()
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
    const state = galacticCoreState(utc, lat, lon)
    // Rise, transit and set shift ~4 min/deg of longitude; ~100 m pans and within-day playback reuse them.
    const dayKey = `${sim.date}|${sim.timeZone}|${lat.toFixed(3)}|${lon.toFixed(3)}`
    if (dayKey !== this.dayKey || !this.day) {
      this.dayKey = dayKey
      this.day = this.body.day(sim.date, sim.timeZone, lat, lon)
    }
    const info: MilkyWayInfo = {
      utc,
      ...state,
      ...this.day
    }
    set({ milkyWay: info })
    this.indicator.setDirection(state)
    this.updateIndicator()
  }

  updateIndicator(): void {
    this.indicator.update(appState().settings.showMilkyWayIndicator)
  }
}
