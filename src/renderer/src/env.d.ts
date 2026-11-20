/// <reference types="vite/client" />
import type { PhotoEarthApi } from '../../shared/types'

declare global {
  interface Window {
    photoearth: PhotoEarthApi
  }

  interface ImportMetaEnv {
    /** "1" in end-to-end test builds: exposes Cesium and the engine on window. */
    readonly VITE_PHOTOEARTH_TEST?: string
  }
}
