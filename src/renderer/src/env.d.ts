/// <reference types="vite/client" />
import type { PhotoEarthApi } from '../../shared/types'

declare global {
  interface Window {
    photoearth: PhotoEarthApi
  }

  interface ImportMetaEnv {
    /** "1" in test builds (`npm run build:test`): exposes Cesium and the engine on window for scripts driving the app. */
    readonly VITE_PHOTOEARTH_TEST?: string
  }
}
