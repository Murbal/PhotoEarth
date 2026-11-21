import { useEffect } from 'react'
import { haversine } from '../lib/profile'
import { forecastPoints, twilightAzimuths, type Forecast } from '../lib/weather'
import { appState, useAppStore } from '../store/appStore'

/** A forecast serves the view center within this distance (Open-Meteo's grids are 2–25 km). */
export const FORECAST_REUSE_M = 3000
/** Open-Meteo updates most models hourly. */
const MAX_AGE_MS = 60 * 60 * 1000
/** Wait for the view to settle before asking for a new place. */
const DEBOUNCE_MS = 1200
const CACHE_SIZE = 24

const cache: Forecast[] = []

function cached(at: { latitude: number; longitude: number }, now: number): Forecast | null {
  return cache.find((f) => now - f.fetchedAt < MAX_AGE_MS && haversine(f.location, at) <= FORECAST_REUSE_M) ?? null
}

/**
 * Keeps `weather` holding the forecast for the view center while the time panel is open and
 * the forecast is on. Only coordinates are sent (see README, Weather).
 */
export function useForecastFeed(): void {
  useEffect(() => {
    let timer: number | null = null
    let seq = 0
    const cancel = () => {
      if (timer !== null) window.clearTimeout(timer)
      timer = null
    }

    const load = async () => {
      timer = null
      const s = appState()
      const at = s.target
      if (!at) return
      const id = ++seq
      const location = { latitude: at.latitude, longitude: at.longitude }
      const azimuths = twilightAzimuths(s.sim.date, s.sim.timeZone, location)
      s.set({ weather: { ...s.weather, status: 'loading', error: null } })
      let result
      try {
        result = await window.photoearth.weather.forecast({ points: forecastPoints(location, azimuths) })
      } catch (err) {
        result = { ok: false as const, error: { status: 'error' as const, message: String(err) } }
      }
      if (id !== seq) return
      if (!result.ok) {
        appState().set({ weather: { ...appState().weather, status: 'error', error: result.error.message } })
        return
      }
      const [observer, sunsetSide, sunriseSide] = result.data
      const forecast: Forecast = {
        location,
        fetchedAt: Date.now(),
        observer,
        sunsetSide: sunsetSide ?? null,
        sunriseSide: sunriseSide ?? null,
        sunsetAzimuth: azimuths.sunset,
        sunriseAzimuth: azimuths.sunrise
      }
      cache.unshift(forecast)
      cache.length = Math.min(cache.length, CACHE_SIZE)
      appState().set({ weather: { status: 'ready', forecast, error: null } })
    }

    const check = () => {
      const s = appState()
      if (!s.panels.time || !s.settings.forecast || !s.target) {
        cancel()
        // A request in flight is dropped, not shown later.
        seq++
        if (s.weather.status === 'loading') s.set({ weather: { ...s.weather, status: s.weather.forecast ? 'ready' : 'idle' } })
        return
      }
      const now = Date.now()
      const hit = cached(s.target, now)
      if (hit) {
        cancel()
        seq++
        if (hit !== s.weather.forecast || s.weather.status !== 'ready') s.set({ weather: { status: 'ready', forecast: hit, error: null } })
        return
      }
      cancel()
      timer = window.setTimeout(() => void load(), s.weather.forecast ? DEBOUNCE_MS : DEBOUNCE_MS / 2)
    }

    const unsubscribe = useAppStore.subscribe(
      (s) => [s.panels.time, s.settings.forecast, s.target] as const,
      check,
      { equalityFn: (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] }
    )
    // Forecasts age out while the panel stays open.
    const interval = window.setInterval(check, 5 * 60 * 1000)
    check()
    return () => {
      unsubscribe()
      window.clearInterval(interval)
      cancel()
      seq++
    }
  }, [])
}
