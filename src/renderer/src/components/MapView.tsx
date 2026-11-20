import { useEffect, useRef } from 'react'
import { Engine } from '../engine/Engine'
import { setEngine } from '../engine/instance'
import { appState, useAppStore } from '../store/appStore'

/**
 * Teardown is deferred by a tick: React StrictMode (dev) unmounts and immediately remounts,
 * and creating a second WebGL context right after destroying the first is wasteful and can
 * fail on some drivers. A remount within the same tick reuses the engine instead.
 */
let pendingTeardown: { engine: Engine; container: HTMLElement; timer: number } | null = null

/** Hosts the Cesium canvas. The engine is created once and lives for the app's lifetime. */
export function MapView({ creditContainer }: { creditContainer: HTMLElement | null }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = ref.current
    if (!container || !creditContainer) return
    let engine: Engine
    if (pendingTeardown && pendingTeardown.container === container) {
      window.clearTimeout(pendingTeardown.timer)
      engine = pendingTeardown.engine
      pendingTeardown = null
    } else {
      try {
        engine = new Engine(container, creditContainer)
      } catch (err) {
        // Without WebGL there is no map, but the rest of the UI (settings, keys) still works.
        console.error('[photoearth] could not create the 3D view', err)
        appState().postBanner({
          id: 'webgl',
          level: 'error',
          title: '3D view unavailable',
          message: `WebGL could not be initialized (${String((err as Error)?.message ?? err)}). Update your graphics driver or check that hardware acceleration isn’t disabled.`
        })
        return
      }
      engine.start(appState().keys)
    }
    setEngine(engine)
    const unsubscribe = useAppStore.subscribe(
      (s) => s.keys,
      (keys) => void engine.setKeys(keys)
    )
    if (import.meta.env.DEV || import.meta.env.VITE_PHOTOEARTH_TEST === '1') {
      ;(window as unknown as { __photoearth?: Engine }).__photoearth = engine
    }
    return () => {
      unsubscribe()
      pendingTeardown = {
        engine,
        container,
        timer: window.setTimeout(() => {
          pendingTeardown = null
          setEngine(null)
          engine.destroy()
        }, 0)
      }
    }
  }, [creditContainer])

  return <div className="map" ref={ref} />
}
