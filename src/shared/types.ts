// Types shared by the main, preload and renderer processes.

export type MapMode = 'photorealistic' | 'elevation'
export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra'
export type Units = 'metric' | 'imperial'
export type CoordFormat = 'decimal' | 'dms'
export type Theme = 'dark' | 'light'
export type ImageryType = 'satellite' | 'terrain' | 'roadmap'
export type LightingMode = 'sun' | 'flat'
export type PaletteId = 'terrain' | 'viridis' | 'spectral' | 'magma' | 'grayscale'

/** Camera pose. Angles in degrees, height in meters above the WGS84 ellipsoid. */
export interface CameraView {
  longitude: number
  latitude: number
  height: number
  heading: number
  pitch: number
  roll: number
}

export interface QualityOverrides {
  maximumScreenSpaceError: number | null
  shadowMapSize: number | null
  shadowCascades: 1 | 4 | null
  softShadows: boolean | null
  /** Cells per side of the terrain shadow grids. */
  terrainShadowResolution: number | null
  msaaSamples: number | null
  fxaa: boolean | null
  resolutionScale: number | null
}

export interface QualitySettings {
  preset: QualityPreset
  overrides: QualityOverrides
  /** Render at the device pixel ratio instead of CSS pixels. */
  devicePixelRatioAware: boolean
  showFps: boolean
}

export interface NavigationSettings {
  /** 0 = off, 1 = maximum glide. */
  inertia: number
  speedMultiplier: number
  invertFlyY: boolean
  /** Minimum camera clearance above the surface, meters. */
  minClearance: number
  /**
   * What scrolling on the map does: 'auto' pans with two fingers on a trackpad (pinch zooms)
   * and zooms with a mouse wheel; 'pan' and 'zoom' force one behavior for every device.
   */
  scrollGesture: ScrollGesture
}

export type ScrollGesture = 'auto' | 'pan' | 'zoom'

export interface ElevationStyleSettings {
  tint: {
    enabled: boolean
    opacity: number
    palette: PaletteId
    autoRange: boolean
    /** Manual range in meters above sea level. */
    min: number
    max: number
  }
  contours: {
    enabled: boolean
    interval: number
    width: number
    color: string
    opacity: number
  }
  slope: { enabled: boolean; opacity: number }
  hillshade: { enabled: boolean; opacity: number; followSun: boolean }
}

export type SensorId = 'ff' | 'apsc' | 'apsc-canon' | 'm43' | '1in' | 'mf44' | 'phone' | 'custom'
export type FrameAspect = 'native' | '3:2' | '4:3' | '1:1' | '4:5' | '5:4' | '16:9' | '65:24'
export type CompositionGuide = 'none' | 'thirds' | 'phi' | 'center' | 'diagonals'

/** Viewfinder mode: the simulated camera and how its frame is drawn. */
export interface ViewfinderSettings {
  sensor: SensorId
  /** Dimensions of the custom sensor, mm (landscape). */
  customSensor: { width: number; height: number }
  /** Focal length on the dial, mm (35 mm-equivalent for sensors that are specified that way). */
  focalLength: number
  aspect: FrameAspect
  portrait: boolean
  guide: CompositionGuide
}

/** Horizon panorama: what the strip chart draws over the skyline. */
export interface HorizonSettings {
  /** The moon's path for the same date. */
  moon: boolean
  /** Names of the peaks on the skyline (Places API Nearby Search). */
  peakNames: boolean
}

export interface Settings {
  version: 1
  units: Units
  coordFormat: CoordFormat
  theme: Theme
  quality: QualitySettings
  navigation: NavigationSettings
  lastCamera: CameraView | null
  lastMode: MapMode
  imagery: ImageryType
  /** Google place names on the map (a labels-only Map Tiles layer). */
  placeLabels: boolean
  elevation: ElevationStyleSettings
  verticalExaggeration: number
  lighting: LightingMode
  shadows: boolean
  /** Shadow-map detail (buildings, trees) on top of heightmap terrain shadows. */
  detailShadows: boolean
  showSunIndicator: boolean
  /** Moon direction line on the map, like the sun's. */
  showMoonIndicator: boolean
  /** Open-Meteo cloud, wind and visibility forecast in the time panel (sends the view center to Open-Meteo). */
  forecast: boolean
  viewfinder: ViewfinderSettings
  horizon: HorizonSettings
  bookmarkIncludeTime: boolean
  onboardingComplete: boolean
}

export interface BookmarkTime {
  /** ISO 8601 UTC instant. */
  utc: string
  /** IANA zone of the bookmarked location at save time. */
  timeZone: string
}

export interface Bookmark {
  id: string
  name: string
  createdAt: string
  camera: CameraView
  mode: MapMode
  time?: BookmarkTime
  /** Set when the view was saved in viewfinder mode: reopens framed with the same lens. */
  viewfinder?: ViewfinderSettings
}

export type NewBookmark = Omit<Bookmark, 'id' | 'createdAt'>

export interface ApiKeys {
  googleApiKey: string | null
  cesiumIonToken: string | null
}

export interface SecretsStatus {
  /** OS-backed encryption (DPAPI / Keychain / libsecret) is available. */
  encryptionAvailable: boolean
  /** Electron safeStorage backend (Linux only, otherwise "os"). */
  backend: string
  /** True when keys can only be held for this session (never written in plaintext). */
  memoryOnly: boolean
  hasGoogleApiKey: boolean
  hasCesiumIonToken: boolean
}

export type CheckStatus =
  | 'ok'
  | 'missing'
  | 'invalid'
  | 'disabled'
  | 'quota'
  | 'offline'
  | 'forbidden'
  | 'error'

export interface ApiCheck {
  status: CheckStatus
  message: string
}

export interface ValidationResult {
  mapTiles: ApiCheck
  places: ApiCheck
  ion: ApiCheck
}

export interface LatLng {
  latitude: number
  longitude: number
}

export interface PlaceSuggestion {
  placeId: string
  mainText: string
  secondaryText: string
}

export interface PlaceDetails {
  id: string
  name: string
  formattedAddress: string
  location: LatLng
  viewport?: { low: LatLng; high: LatLng }
}

/** Place kinds shown as map labels (Places API (New) Nearby Search types). */
export type NearbyKind = 'locality' | 'mountain_peak' | 'administrative_area_level_1' | 'country'

export interface NearbyRequest {
  kind: NearbyKind
  center: LatLng
  /** Meters, at most 50 km. */
  radius: number
}

export interface NearbyPlace {
  id: string
  name: string
  location: LatLng
  /** 2: named like its state or canton, 1: like its county or district, 0: neither. */
  seat: 0 | 1 | 2
  /** Cities only: how many of the region's top stations and attractions are in it. */
  fame?: number
}

/** A region to find the main cities of (degrees). */
export interface CitiesRequest {
  south: number
  west: number
  north: number
  east: number
}

export interface AutocompleteRequest {
  input: string
  sessionToken: string
  bias?: LatLng
}

/** Hourly forecast at one point (Open-Meteo). Columns line up with `time`; null where the model has no value. */
export interface WeatherSeries {
  /** The model grid cell the values are for. */
  latitude: number
  longitude: number
  /** Meters above sea level of that cell. */
  elevation: number | null
  /** UTC instants (ms) on the hour. */
  time: number[]
  /** Cloud cover in percent: below ~2 km, ~2–6 km, above ~6 km. */
  cloudLow: (number | null)[]
  cloudMid: (number | null)[]
  cloudHigh: (number | null)[]
  /** Meters. */
  visibility: (number | null)[]
  /** 10 m above ground, m/s; direction it blows from, degrees. */
  windSpeed: (number | null)[]
  windGusts: (number | null)[]
  windDirection: (number | null)[]
  /** Percent; mm over the preceding hour. */
  precipitationProbability: (number | null)[]
  precipitation: (number | null)[]
  /** 2 m above ground, °C, %. */
  temperature: (number | null)[]
  dewPoint: (number | null)[]
  humidity: (number | null)[]
  /** WMO weather interpretation code (45, 48: fog). */
  weatherCode: (number | null)[]
}

export interface WeatherRequest {
  /** 1–3 points, answered in the same order. */
  points: LatLng[]
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiCheck }

export interface AppInfo {
  version: string
  platform: string
  /** Referer sent with Google requests (for referrer-restricted keys). */
  googleReferer: string
}

/** Commands sent from the main-process menu to the renderer. */
export type MenuCommand =
  | 'open-settings'
  | 'open-palette'
  | 'open-shortcuts'
  | 'mode-photorealistic'
  | 'mode-elevation'
  | 'toggle-fps'
  | 'save-bookmark'
  | 'toggle-bookmarks'
  | 'toggle-time-panel'
  | 'toggle-viewfinder'

export interface PhotoEarthApi {
  info(): Promise<AppInfo>
  settings: {
    get(): Promise<Settings>
    set(settings: Settings): Promise<void>
    /** Best-effort synchronous flush, used while the window unloads. */
    flush(settings: Settings): void
  }
  keys: {
    get(): Promise<ApiKeys>
    set(keys: Partial<ApiKeys>): Promise<SecretsStatus>
    status(): Promise<SecretsStatus>
    validate(keys: ApiKeys): Promise<ValidationResult>
  }
  bookmarks: {
    list(): Promise<Bookmark[]>
    create(bookmark: NewBookmark): Promise<Bookmark>
    update(id: string, patch: Partial<NewBookmark>): Promise<Bookmark | null>
    remove(id: string): Promise<boolean>
  }
  places: {
    autocomplete(request: AutocompleteRequest): Promise<Result<PlaceSuggestion[]>>
    details(placeId: string, sessionToken: string): Promise<Result<PlaceDetails>>
    /** Up to 20 places of one kind in a circle, most popular first (for map labels). */
    nearby(request: NearbyRequest): Promise<Result<NearbyPlace[]>>
    cities(request: CitiesRequest): Promise<Result<NearbyPlace[]>>
  }
  weather: {
    /** Hourly forecast for the next 16 days at each point (Open-Meteo, no key). */
    forecast(request: WeatherRequest): Promise<Result<WeatherSeries[]>>
  }
  openExternal(url: string): Promise<void>
  onMenuCommand(listener: (command: MenuCommand) => void): () => void
}
