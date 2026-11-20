import type { PhotoEarthApi } from '../../src/shared/types'

declare global {
  interface Window {
    photoearth: PhotoEarthApi
  }
}

export {}
