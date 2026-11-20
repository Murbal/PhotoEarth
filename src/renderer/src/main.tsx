import 'cesium/Build/Cesium/Widgets/CesiumWidget/CesiumWidget.css'
import './styles/app.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'

// Cesium loads workers and assets from here (copied next to the bundle at build time).
;(window as unknown as { CESIUM_BASE_URL: string }).CESIUM_BASE_URL = '/cesium/'

// Test builds (VITE_PHOTOEARTH_TEST=1) expose Cesium for end-to-end assertions.
if (import.meta.env.VITE_PHOTOEARTH_TEST === '1') {
  void import('./testHooks').then(({ testCesium }) => {
    ;(window as unknown as { Cesium: unknown }).Cesium = testCesium
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
