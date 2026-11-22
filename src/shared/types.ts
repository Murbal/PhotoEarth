// Types shared by the main, preload and renderer processes.

import type { ParsedLocation } from './coords'

export type ModuleId = 'globe' | 'projects' | 'moodboard'
export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra'
export type Units = 'metric' | 'imperial'
export type CoordFormat = 'decimal' | 'dms'
export type Theme = 'dark' | 'light'
/** Google 2D map types. Satellite isn't offered: Google doesn't serve it to EEA accounts. */
export type ImageryType = 'roadmap' | 'terrain'
export type LightingMode = 'sun' | 'flat'

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
  /** Range of building/tree detail shadows near a low camera, meters (0 = off). */
  detailShadowDistance: number | null
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

/**
 * Where the light pollution overlay comes from. `atlas-YYYY`: David Lorenz's Light
 * Pollution Atlas for that year (modeled zenith sky brightness from VIIRS); `black-marble`:
 * NASA's VIIRS Black Marble 2016 (light emitted upward, not sky brightness).
 */
export type LightPollutionSourceId =
  | 'atlas-2025'
  | 'atlas-2024'
  | 'atlas-2023'
  | 'atlas-2022'
  | 'atlas-2020'
  | 'atlas-2016'
  | 'black-marble'

export interface LightPollutionSettings {
  enabled: boolean
  opacity: number
  source: LightPollutionSourceId
}

/** Map mode: a full-window 2D map, shown instead of the 3D view while `open`. */
export interface MapModeSettings {
  open: boolean
  /** Center and fractional Web Mercator zoom of the map. */
  longitude: number
  latitude: number
  zoom: number
  type: ImageryType
}

/** Horizon panorama: what the strip chart draws over the skyline. */
export interface HorizonSettings {
  /** The moon's path for the same date. */
  moon: boolean
  /** The Milky Way arch and Galactic Core path for the same date. */
  milkyWay: boolean
  /** Names of the peaks on the skyline (Places API Nearby Search). */
  peakNames: boolean
}

/** Astrophotography dark-window preferences. */
export interface AstroSettings {
  /** Minimum Galactic Core altitude (degrees) for the dark-window calculation. */
  minCoreAltitude: number
  /** Allow a thin crescent moon (≤ 10 % illuminated) in the dark window. */
  allowLowMoon: boolean
}

export type ViewshedColorMode = 'distance' | 'solid'

/** Viewshed analysis overlay: line-of-sight visibility from a selected target point. */
export interface ViewshedSettings {
  /** Analysis radius, meters. */
  radius: number
  /** Target height offset above ground, meters (e.g. 1.7 m eye height, 0 m peak, 50 m tower/drone). */
  targetOffset: number
  /** Surrounding viewer height offset above ground, meters (e.g. 1.7 m standing photographer). */
  viewerOffset: number
  /** Overlay opacity (0–1). */
  opacity: number
  /** Distance-tinted visibility ('distance') or uniform tint ('solid'). */
  colorMode: ViewshedColorMode
  /** Draw concentric distance rings within the analysis radius. */
  showRings: boolean
}

export interface Settings {
  version: 1
  units: Units
  coordFormat: CoordFormat
  theme: Theme
  quality: QualitySettings
  navigation: NavigationSettings
  lastCamera: CameraView | null
  map: MapModeSettings
  imagery: ImageryType
  /** Google place names on the map (a labels-only Map Tiles layer). */
  placeLabels: boolean
  /** Artificial night sky brightness overlay. */
  lightPollution: LightPollutionSettings
  verticalExaggeration: number
  lighting: LightingMode
  shadows: boolean
  /** Shadow-map detail (buildings, trees) on top of heightmap terrain shadows. */
  detailShadows: boolean
  showSunIndicator: boolean
  /** Moon direction line on the map, like the sun's. */
  showMoonIndicator: boolean
  /** Galactic Core direction line on the map, like the sun's and moon's. */
  showMilkyWayIndicator: boolean
  /** Open-Meteo cloud, wind and visibility forecast in the time panel (sends the view center to Open-Meteo). */
  forecast: boolean
  /** Astrophotography / Milky Way dark-window preferences. */
  astro: AstroSettings
  viewfinder: ViewfinderSettings
  horizon: HorizonSettings
  viewshed: ViewshedSettings
  bookmarkIncludeTime: boolean
  /** Markers for the saved locations on the map. */
  showLocationMarkers: boolean
  /** Last active project context (restored on startup if it still exists). */
  lastProjectId: string | null
  onboardingComplete: boolean
}

export interface BookmarkTime {
  /** ISO 8601 UTC instant. */
  utc: string
  /** IANA zone of the bookmarked location at save time. */
  timeZone: string
}

export type LocationStatus = 'to-visit' | 'visited'

/** A point on the ground. Degrees; height in meters above the WGS84 ellipsoid. */
export interface GeoPosition {
  longitude: number
  latitude: number
  /**
   * Null while only estimated from the camera (bookmarks saved before locations had a
   * position); measured on the surface the next time the location is visited.
   */
  height: number | null
}

/** A reference photo, copied into the app's photo directory (never referenced by its original path). */
export interface LocationPhoto {
  id: string
  /** Stored file name, `<id>.<ext>`; the thumbnail is `<id>.thumb.jpg`. */
  file: string
  /** Original file name, for display only. */
  name: string
  bytes: number
  /** Pixel size as displayed (EXIF orientation applied). */
  width: number
  height: number
  addedAt: string
}

/**
 * A saved scouting location. It grew out of the view bookmarks: every bookmark is a location,
 * and a plain bookmark is one with no notes, tags or photos.
 */
export interface Bookmark {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  camera: CameraView
  time?: BookmarkTime
  /** Set when the view was saved in viewfinder mode: reopens framed with the same lens. */
  viewfinder?: ViewfinderSettings
  /** The spot itself (map marker): the pin or view center when saved. */
  position: GeoPosition
  status: LocationStatus
  notes: string
  /** Lowercase, unique. */
  tags: string[]
  /** Free text, e.g. "Sunrise, late October, after fresh snow". */
  bestTime: string
  photos: LocationPhoto[]
}

export interface NewBookmark {
  name: string
  camera: CameraView
  time?: BookmarkTime
  viewfinder?: ViewfinderSettings
  position?: GeoPosition
  status?: LocationStatus
  notes?: string
  tags?: string[]
  bestTime?: string
}

/** Editable fields. `null` clears the saved time or lens. Photos change only through addPhoto/removePhoto. */
export interface BookmarkPatch {
  name?: string
  camera?: CameraView
  time?: BookmarkTime | null
  viewfinder?: ViewfinderSettings | null
  position?: GeoPosition
  status?: LocationStatus
  notes?: string
  tags?: string[]
  bestTime?: string
}

/** A photo to import: the original file's bytes and a JPEG thumbnail made by the renderer. */
export interface PhotoUpload {
  name: string
  data: Uint8Array
  thumb: Uint8Array
  width: number
  height: number
}

export type PhotoResult = { ok: true; bookmark: Bookmark } | { ok: false; error: string }

/** A file chosen in the native photo picker: a one-time token, never its path. */
export interface PickedPhoto {
  token: string
  name: string
  bytes: number
}

export type PickedPhotoData = { ok: true; data: Uint8Array } | { ok: false; error: string }

/** A saved elevation profile path, on its own or attached to a location. */
export interface SavedProfile {
  id: string
  name: string
  createdAt: string
  /** The clicked vertices, with their surface heights (ellipsoidal) when known. */
  points: GeoPosition[]
  /** The location it belongs to, or null for a general profile. */
  locationId: string | null
}

export interface NewProfile {
  name: string
  points: GeoPosition[]
  locationId?: string | null
}

export interface ProfilePatch {
  name?: string
  locationId?: string | null
}

// ───────────────────────────── projects ─────────────────────────────

export type ProjectStatus = 'brainstorming' | 'scouting' | 'ready' | 'shot' | 'archived'

export interface ProjectDateWindow {
  /** ISO calendar date 'YYYY-MM-DD' (date-only, independent of timezone). */
  start: string | null
  end: string | null
  /** Optional free text, e.g. "Late October, first snow" when exact dates aren't fixed yet. */
  label: string
}

export interface ProjectConcept {
  /** Short 1-2 sentence premise or visual goal. */
  summary: string
  /** Lighting / weather mood keywords or prose (e.g. "low-angle fog, blue hour"). */
  lightingMood: string
  /** Optional self-imposed constraints (e.g. "35mm prime only", "square 1:1"). */
  constraints: string
  /** Dominant target hex colors (manually picked or synced from a linked Moodboard). */
  colorStory: string[]
}

export interface ProjectNote {
  id: string
  title: string
  /** Markdown text. */
  body: string
  pinned: boolean
  createdAt: string
  updatedAt: string
}

export interface Project {
  id: string
  title: string
  status: ProjectStatus
  createdAt: string
  updatedAt: string
  /** Optional cover image stored in the shared PhotoStore. */
  coverPhoto: LocationPhoto | null
  /** Lowercase, unique tags (e.g. 'landscape', 'astro', 'italy'). */
  tags: string[]
  dateWindow: ProjectDateWindow
  concept: ProjectConcept
  /** Ordered list of linked Bookmark IDs from bookmarks.json. */
  locationIds: string[]
  /** Ordered list of linked Moodboard IDs from moodboards/index.json. */
  moodboardIds: string[]
  /** Free-form scratchpad / concept cards. */
  notes: ProjectNote[]
}

export interface NewProject {
  title: string
  status?: ProjectStatus
  tags?: string[]
  dateWindow?: Partial<ProjectDateWindow>
  concept?: Partial<ProjectConcept>
  locationIds?: string[]
  moodboardIds?: string[]
  notes?: Array<{ title: string; body: string; pinned?: boolean }>
}

export interface ProjectPatch {
  title?: string
  status?: ProjectStatus
  tags?: string[]
  dateWindow?: Partial<ProjectDateWindow>
  concept?: Partial<ProjectConcept>
  locationIds?: string[]
  moodboardIds?: string[]
  notes?: ProjectNote[]
}

export type ProjectPhotoResult = { ok: true; project: Project } | { ok: false; error: string }

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

/** Where a Google Maps short link leads: the full URL and what it parses to. */
export interface ResolvedMapsLink {
  url: string
  location: ParsedLocation
}

export interface AppInfo {
  version: string
  platform: string
  /** Referer sent with Google requests (for referrer-restricted keys). */
  googleReferer: string
  /** Dev-only toggle (PHOTOEARTH_NO_3D_TILES=1): skip loading Photorealistic 3D Tiles. */
  disable3dTiles?: boolean
}

/** Commands sent from the main-process menu to the renderer. */
export type MenuCommand =
  | 'open-settings'
  | 'open-palette'
  | 'open-shortcuts'
  | 'open-projects'
  | 'mode-photorealistic'
  | 'mode-map'
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
  /** Saved scouting locations (formerly view bookmarks). */
  bookmarks: {
    list(): Promise<Bookmark[]>
    create(bookmark: NewBookmark): Promise<Bookmark>
    update(id: string, patch: BookmarkPatch): Promise<Bookmark | null>
    /** Also deletes the location's photos and its attached profiles. */
    remove(id: string): Promise<boolean>
    addPhoto(id: string, photo: PhotoUpload): Promise<PhotoResult>
    /** Opens the native file picker for photos to add to a location; [] when cancelled. */
    pickPhotos(id: string): Promise<PickedPhoto[]>
    /** Reads a file chosen in the picker (each token works once). */
    readPickedPhoto(token: string): Promise<PickedPhotoData>
    removePhoto(id: string, photoId: string): Promise<Bookmark | null>
  }
  profiles: {
    list(): Promise<SavedProfile[]>
    create(profile: NewProfile): Promise<SavedProfile | null>
    update(id: string, patch: ProfilePatch): Promise<SavedProfile | null>
    remove(id: string): Promise<boolean>
  }
  projects: {
    list(): Promise<Project[]>
    create(input: NewProject): Promise<Project>
    update(id: string, patch: ProjectPatch): Promise<Project | null>
    remove(id: string): Promise<boolean>
    setCoverPhoto(id: string, photo: PhotoUpload): Promise<ProjectPhotoResult>
    setCoverPhotoFromPhoto(id: string, photo: LocationPhoto): Promise<ProjectPhotoResult>
    clearCoverPhoto(id: string): Promise<Project | null>
    pickCoverPhoto(id: string): Promise<PickedPhoto | null>
    readPickedPhoto(token: string): Promise<PickedPhotoData>
    linkLocation(projectId: string, locationId: string): Promise<Project | null>
    unlinkLocation(projectId: string, locationId: string): Promise<Project | null>
    linkMoodboard(projectId: string, moodboardId: string): Promise<Project | null>
    unlinkMoodboard(projectId: string, moodboardId: string): Promise<Project | null>
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
  maps: {
    /** Follows a maps.app.goo.gl / goo.gl/maps link to its google.com/maps URL (online, no key). */
    resolveShortLink(url: string): Promise<Result<ResolvedMapsLink>>
  }
  openExternal(url: string): Promise<void>
  onMenuCommand(listener: (command: MenuCommand) => void): () => void
}
