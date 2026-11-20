// EGM96 geoid. Cesium terrain and Google 3D Tiles report heights above the WGS84
// ellipsoid; photographers expect heights above mean sea level. The geoid grid
// (~2.7 MB) is loaded lazily so it doesn't delay startup.

type Egm96 = typeof import('egm96-universal')

let mod: Egm96 | null = null
let pending: Promise<void> | null = null

export function loadGeoid(): Promise<void> {
  pending ??= import('egm96-universal').then((m) => {
    mod = m
  })
  return pending
}

export function isGeoidReady(): boolean {
  return mod !== null
}

/** Geoid height N (MSL above the ellipsoid) in meters; 0 until the grid is loaded. */
export function geoidUndulation(latitude: number, longitude: number): number {
  if (!mod) return 0
  try {
    return mod.meanSeaLevel(latitude, ((((longitude + 180) % 360) + 360) % 360) - 180)
  } catch {
    return 0
  }
}

export function toMsl(latitude: number, longitude: number, ellipsoidHeight: number): number {
  return ellipsoidHeight - geoidUndulation(latitude, longitude)
}

export function toEllipsoid(latitude: number, longitude: number, mslHeight: number): number {
  return mslHeight + geoidUndulation(latitude, longitude)
}
