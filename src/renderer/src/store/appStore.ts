import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import { NO_FILTER, type LocationFilter } from '@shared/locations'
import { defaultSettings } from '@shared/settings'
import type { ApiKeys, Bookmark, SavedProfile, SecretsStatus, Settings } from '@shared/types'
import type { MapSession } from '../engine/MapTiles'
import type { BodyDay } from '../lib/celestial'
import {
  DEFAULT_EYE_HEIGHT,
  type AlignmentBodyFilter,
  type AlignmentGeometry,
  type AlignmentPin,
  type LineOfSightResult,
  type MoonSkyFilter
} from '../lib/alignment'
import type { SkyEstimate } from '../lib/skyBrightness'
import type { SunlitSpan } from '../lib/horizon'
import type { GalacticCoreState } from '../lib/milkyWay'
import type { MoonState } from '../lib/moon'
import type { Horizon, SkylinePeak } from '../lib/panorama'
import type { ProfileSample, ProfileStats, GeoPoint } from '../lib/profile'
import type { BandSegment } from '../lib/sun'
import { addDays } from '../lib/time'
import type { ViewshedPointCheck, ViewshedStats } from '../lib/viewshed'
import type { Forecast } from '../lib/weather'

export type BannerLevel = 'error' | 'warning' | 'info'

export interface BannerAction {
  label: string
  command: string
}

export interface Banner {
  /** Stable id; re-posting the same id replaces the banner. */
  id: string
  level: BannerLevel
  title: string
  message: string
  actions?: BannerAction[]
}

export interface CameraInfo {
  longitude: number
  latitude: number
  /** Meters above the WGS84 ellipsoid. */
  height: number
  heightMsl: number
  /** Above the rendered surface, when known. */
  heightAgl: number | null
  heading: number
  pitch: number
  /** Horizontal angle of view, degrees (Map mode's camera wedge). */
  fov: number
}

export interface CursorInfo {
  longitude: number
  latitude: number
  /** Meters above sea level, null while unknown. */
  elevation: number | null
}

export type PlaybackSpeedId = '1m' | '10m' | '1h' | '1d' | '7d'

export interface SimState {
  /** Local date (YYYY-MM-DD) in `timeZone`. */
  date: string
  /** Local wall-clock minutes of day. */
  minutes: number
  /** IANA zone of the camera target. */
  timeZone: string
  playing: boolean
  speed: PlaybackSpeedId
}

export interface SunInfo {
  utc: number
  azimuth: number
  altitude: number
  sunrise: number | null
  sunset: number | null
  solarNoon: number
  dawn: number | null
  dusk: number | null
  polar: 'day' | 'night' | null
  noonAltitude: number
  offsetMinutes: number
  zoneName: string
  /** The local day split into sky bands (slider shading, golden/blue hour and twilight times). */
  bands: BandSegment[]
}

/** The moon at the simulated instant and camera target, with its rise and set that local day. */
export interface MoonInfo extends MoonState, BodyDay {
  utc: number
  /** First new and full moon from the start of the local day (UTC instants). */
  nextNewMoon: number | null
  nextFullMoon: number | null
}

/** Galactic Core (Sagittarius A*) and Milky Way arch at the simulated instant and camera target. */
export interface MilkyWayInfo extends GalacticCoreState, BodyDay {
  utc: number
}

export type Panel = 'time' | 'layers' | 'bookmarks'

export interface ProfileState {
  active: boolean
  points: GeoPoint[]
  samples: ProfileSample[]
  stats: ProfileStats | null
  hoverIndex: number | null
  loading: boolean
  source: 'terrain' | 'tiles' | null
  error: string | null
  /** The saved profile this path was reopened from, if any. */
  savedId: string | null
}

export interface HorizonObserver {
  longitude: number
  latitude: number
  /** Eye height above sea level, meters. */
  eyeMsl: number
}

/** A named summit on the skyline, with its height above sea level. */
export interface HorizonPeak extends SkylinePeak {
  heightMsl: number
}

export interface HorizonState {
  open: boolean
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Terrain grids loaded so far, out of `levels`. */
  loaded: number
  levels: number
  observer: HorizonObserver | null
  /** Replaced (never mutated) whenever a finer grid arrives. */
  horizon: Horizon | null
  /** Ellipsoid → sea level offset at the observer (geoid undulation), meters. */
  geoid: number
  peaks: HorizonPeak[]
  peakStatus: 'off' | 'loading' | 'ready' | 'unavailable'
  hoverAzimuth: number | null
  error: string | null
}

export type AlignmentPickMode = 'camera' | 'subject' | null
export type AlignmentRangePreset = '30d' | '90d' | '1y' | '2y' | 'custom'

export interface AlignmentFilters {
  bodies: AlignmentBodyFilter
  rangePreset: AlignmentRangePreset
  /** Inclusive local start date (YYYY-MM-DD). */
  startDate: string
  /** Inclusive local end date (YYYY-MM-DD, used directly in custom mode). */
  endDate: string
  azimuthTolerance: number
  altitudeTolerance: number
  /** Minimum Moon illumination percentage (0–100). */
  minMoonIllumination: number
  moonSkyFilter: MoonSkyFilter
}

export interface AlignmentState {
  open: boolean
  pickMode: AlignmentPickMode
  camera: AlignmentPin | null
  subject: AlignmentPin | null
  /** Camera eye / tripod height above ground, meters. */
  eyeHeight: number
  /** Optional direct target direction (e.g. from Horizon Panorama without a subject pin). */
  manualDirection: { azimuth: number; altitude: number } | null
  geometry: AlignmentGeometry | null
  los: LineOfSightResult | null
  losLoading: boolean
  losSource: 'terrain' | 'tiles' | null
  filters: AlignmentFilters
  selectedMatchId: string | null
  /** Whether clicking an alignment result also frames the shot from the Camera pin. */
  frameOnSelect: boolean
}

export interface ViewshedTarget {
  longitude: number
  latitude: number
  /** Ground/surface footing at the target (ellipsoidal), meters. */
  groundEllipsoidal: number
  /** Ground/surface footing at the target (above sea level), meters. */
  groundMsl: number
  /** Geoid undulation at the target, meters. */
  geoid: number
}

export interface ViewshedState {
  open: boolean
  /** Waiting for a map click to set or move the viewshed target. */
  picking: boolean
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Terrain grids loaded so far, out of `levels`. */
  loaded: number
  levels: number
  target: ViewshedTarget | null
  stats: ViewshedStats | null
  error: string | null
}

export interface InspectInfo {
  longitude: number
  latitude: number
  elevation: number | null
  loading: boolean
  screen: { x: number; y: number } | null
}

/** Sun times at the inspected point: flat-horizon rise/set vs. the terrain's skyline. */
export interface SpotSunInfo {
  /** `no-terrain`: no terrain heights without a Cesium ion token. */
  status: 'loading' | 'ready' | 'unavailable' | 'no-terrain'
  /** Civil date and zone the times are for (the simulation's). */
  date: string
  timeZone: string
  /** Flat-horizon (SunCalc) times at the point. */
  sunrise: number | null
  sunset: number | null
  polar: 'day' | 'night' | null
  /** The sun clears / drops behind the skyline (when `status` is `ready`). */
  firstLight: number | null
  lastLight: number | null
  spans: SunlitSpan[]
  sunlitMs: number
}

/** Open-Meteo forecast for the view center (hooks/useForecastFeed). */
export interface WeatherState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** The latest forecast; it may be for a place the view has since moved away from. */
  forecast: Forecast | null
  error: string | null
}

/** Estimated night sky brightness at the inspected point, while the overlay is on. */
export interface SkyInfo {
  /** `outside`: beyond the data (65° S – 75° N). */
  status: 'loading' | 'ready' | 'outside' | 'unavailable'
  /** Label of the data set the estimate comes from. */
  source: string
  estimate: SkyEstimate | null
}

/** Where the last search (place or coordinates) took the camera. */
export interface Destination {
  name: string
  /** Address or other context, e.g. "Austria" or "from Google Maps link". */
  detail: string
  latitude: number
  longitude: number
}

const emptyHorizon: HorizonState = {
  open: false,
  status: 'idle',
  loaded: 0,
  levels: 0,
  observer: null,
  horizon: null,
  geoid: 0,
  peaks: [],
  peakStatus: 'off',
  hoverAzimuth: null,
  error: null
}

const emptyViewshed: ViewshedState = {
  open: false,
  picking: false,
  status: 'idle',
  loaded: 0,
  levels: 0,
  target: null,
  stats: null,
  error: null
}

const emptyProfile: ProfileState = {
  active: false,
  points: [],
  samples: [],
  stats: null,
  hoverIndex: null,
  loading: false,
  source: null,
  error: null,
  savedId: null
}

function defaultAlignmentFilters(startDate: string): AlignmentFilters {
  return {
    bodies: 'both',
    rangePreset: '1y',
    startDate,
    endDate: addDays(startDate, 365),
    azimuthTolerance: 1.0,
    altitudeTolerance: 1.0,
    minMoonIllumination: 0,
    moonSkyFilter: 'any'
  }
}

function emptyAlignment(startDate: string): AlignmentState {
  return {
    open: false,
    pickMode: null,
    camera: null,
    subject: null,
    eyeHeight: DEFAULT_EYE_HEIGHT,
    manualDirection: null,
    geometry: null,
    los: null,
    losLoading: false,
    losSource: null,
    filters: defaultAlignmentFilters(startDate),
    selectedMatchId: null,
    frameOnSelect: false
  }
}

export interface AppState {
  booted: boolean
  settings: Settings
  keys: ApiKeys
  secrets: SecretsStatus | null
  camera: CameraInfo | null
  target: { longitude: number; latitude: number } | null
  cursor: CursorInfo | null
  scale: { pixels: number; label: string } | null
  sim: SimState
  sun: SunInfo | null
  moon: MoonInfo | null
  milkyWay: MilkyWayInfo | null
  banners: Banner[]
  panels: Record<Panel, boolean>
  profile: ProfileState
  horizon: HorizonState
  alignment: AlignmentState
  viewshed: ViewshedState
  inspect: InspectInfo | null
  /** Line-of-sight status from the inspected point to the active viewshed target. */
  inspectViewshed: ViewshedPointCheck | null
  spotSun: SpotSunInfo | null
  weather: WeatherState
  sky: SkyInfo | null
  destination: Destination | null
  pendingTiles: number
  fps: number | null
  flyMode: boolean
  eyeLevel: boolean
  /** Viewfinder mode: lens field of view and crop frame (settings.viewfinder). */
  viewfinder: boolean
  /** Saved scouting locations. */
  bookmarks: Bookmark[]
  /** Saved elevation profile paths. */
  profiles: SavedProfile[]
  /** What the locations panel and the map markers show. */
  locationFilter: LocationFilter
  /** The location open in the editor, highlighted on the map. */
  activeLocation: string | null
  terrainReady: boolean
  tilesetReady: boolean
  /** Dev-only toggle (PHOTOEARTH_NO_3D_TILES=1): skip loading Photorealistic 3D Tiles. */
  disable3dTiles: boolean
  /** Map mode's Google 2D Tiles session. */
  mapSession: MapSession | null
  /** Heightmap terrain shadows. */
  terrainShadows: 'off' | 'loading' | 'ready' | 'unavailable'

  set: (partial: Partial<AppState>) => void
  patchSettings: (recipe: (draft: Settings) => void) => void
  postBanner: (banner: Banner) => void
  dismissBanner: (id: string) => void
  togglePanel: (panel: Panel, open?: boolean) => void
  patchSim: (patch: Partial<SimState>) => void
  patchProfile: (patch: Partial<ProfileState>) => void
  resetProfile: () => void
  patchHorizon: (patch: Partial<HorizonState>) => void
  resetHorizon: () => void
  patchAlignment: (patch: Partial<AlignmentState>) => void
  patchAlignmentFilters: (patch: Partial<AlignmentFilters>) => void
  resetAlignment: () => void
  patchViewshed: (patch: Partial<ViewshedState>) => void
  resetViewshed: () => void
}

function todayIn(): { date: string; minutes: number } {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    date: `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`,
    minutes: now.getUTCHours() * 60 + now.getUTCMinutes()
  }
}

export const useAppStore = create<AppState>()(
  subscribeWithSelector((set, get) => ({
    booted: false,
    settings: defaultSettings(),
    keys: { googleApiKey: null, cesiumIonToken: null },
    secrets: null,
    camera: null,
    target: null,
    cursor: null,
    scale: null,
    sim: { ...todayIn(), timeZone: 'UTC', playing: false, speed: '10m' },
    sun: null,
    moon: null,
    milkyWay: null,
    banners: [],
    panels: { time: false, layers: false, bookmarks: false },
    profile: emptyProfile,
    horizon: emptyHorizon,
    alignment: emptyAlignment(todayIn().date),
    viewshed: emptyViewshed,
    inspect: null,
    inspectViewshed: null,
    spotSun: null,
    weather: { status: 'idle', forecast: null, error: null },
    sky: null,
    destination: null,
    pendingTiles: 0,
    fps: null,
    flyMode: false,
    eyeLevel: false,
    viewfinder: false,
    bookmarks: [],
    profiles: [],
    locationFilter: NO_FILTER,
    activeLocation: null,
    terrainReady: false,
    tilesetReady: false,
    disable3dTiles: false,
    mapSession: null,
    terrainShadows: 'off',

    set: (partial) => set(partial),
    patchSettings: (recipe) => {
      const draft = structuredClone(get().settings)
      recipe(draft)
      set({ settings: draft })
    },
    postBanner: (banner) =>
      set((s) => ({ banners: [...s.banners.filter((b) => b.id !== banner.id), banner] })),
    dismissBanner: (id) => set((s) => ({ banners: s.banners.filter((b) => b.id !== id) })),
    togglePanel: (panel, open) =>
      set((s) => ({ panels: { ...s.panels, [panel]: open ?? !s.panels[panel] } })),
    patchSim: (patch) => set((s) => ({ sim: { ...s.sim, ...patch } })),
    patchProfile: (patch) => set((s) => ({ profile: { ...s.profile, ...patch } })),
    resetProfile: () => set({ profile: emptyProfile }),
    patchHorizon: (patch) => set((s) => ({ horizon: { ...s.horizon, ...patch } })),
    resetHorizon: () => set({ horizon: emptyHorizon }),
    patchAlignment: (patch) => set((s) => ({ alignment: { ...s.alignment, ...patch } })),
    patchAlignmentFilters: (patch) =>
      set((s) => ({ alignment: { ...s.alignment, filters: { ...s.alignment.filters, ...patch } } })),
    resetAlignment: () =>
      set((s) => ({
        alignment: {
          ...emptyAlignment(s.sim.date),
          filters: { ...s.alignment.filters },
          eyeHeight: s.alignment.eyeHeight,
          frameOnSelect: s.alignment.frameOnSelect
        }
      })),
    patchViewshed: (patch) => set((s) => ({ viewshed: { ...s.viewshed, ...patch } })),
    resetViewshed: () => set({ viewshed: emptyViewshed, inspectViewshed: null })
  }))
)

export const appState = (): AppState => useAppStore.getState()
