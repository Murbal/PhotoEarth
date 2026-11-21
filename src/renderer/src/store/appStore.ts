import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import { defaultSettings } from '@shared/settings'
import type { ApiKeys, Bookmark, MapMode, SecretsStatus, Settings } from '@shared/types'
import type { ProfileSample, ProfileStats, GeoPoint } from '../lib/profile'

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
  /** Altitudes sampled across the local day (for slider shading). */
  profile: number[]
}

export type Panel = 'time' | 'elevation' | 'bookmarks'

export interface ProfileState {
  active: boolean
  points: GeoPoint[]
  samples: ProfileSample[]
  stats: ProfileStats | null
  hoverIndex: number | null
  loading: boolean
  source: 'terrain' | 'tiles' | null
  error: string | null
}

export interface InspectInfo {
  longitude: number
  latitude: number
  elevation: number | null
  loading: boolean
  screen: { x: number; y: number } | null
}

/** Where the last search (place or coordinates) took the camera. */
export interface Destination {
  name: string
  /** Address or other context, e.g. "Austria" or "from Google Maps link". */
  detail: string
  latitude: number
  longitude: number
}

export interface Toast {
  id: number
  message: string
}

const emptyProfile: ProfileState = {
  active: false,
  points: [],
  samples: [],
  stats: null,
  hoverIndex: null,
  loading: false,
  source: null,
  error: null
}

export interface AppState {
  booted: boolean
  settings: Settings
  keys: ApiKeys
  secrets: SecretsStatus | null
  mode: MapMode
  camera: CameraInfo | null
  target: { longitude: number; latitude: number } | null
  cursor: CursorInfo | null
  scale: { pixels: number; label: string } | null
  sim: SimState
  sun: SunInfo | null
  banners: Banner[]
  panels: Record<Panel, boolean>
  paletteOpen: boolean
  shortcutsOpen: boolean
  settingsOpen: boolean
  onboardingOpen: boolean
  profile: ProfileState
  inspect: InspectInfo | null
  destination: Destination | null
  pendingTiles: number
  fps: number | null
  flyMode: boolean
  eyeLevel: boolean
  /** Viewfinder mode: lens field of view and crop frame (settings.viewfinder). */
  viewfinder: boolean
  bookmarks: Bookmark[]
  autoRange: { min: number; max: number } | null
  terrainReady: boolean
  tilesetReady: boolean
  /** Heightmap terrain shadows (§8.1.1). */
  terrainShadows: 'off' | 'loading' | 'ready' | 'unavailable'
  toast: Toast | null

  set: (partial: Partial<AppState>) => void
  patchSettings: (recipe: (draft: Settings) => void) => void
  postBanner: (banner: Banner) => void
  dismissBanner: (id: string) => void
  togglePanel: (panel: Panel, open?: boolean) => void
  patchSim: (patch: Partial<SimState>) => void
  patchProfile: (patch: Partial<ProfileState>) => void
  resetProfile: () => void
  showToast: (message: string) => void
}

function todayIn(): { date: string; minutes: number } {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    date: `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`,
    minutes: now.getUTCHours() * 60 + now.getUTCMinutes()
  }
}

let toastId = 0

export const useAppStore = create<AppState>()(
  subscribeWithSelector((set, get) => ({
    booted: false,
    settings: defaultSettings(),
    keys: { googleApiKey: null, cesiumIonToken: null },
    secrets: null,
    mode: 'photorealistic',
    camera: null,
    target: null,
    cursor: null,
    scale: null,
    sim: { ...todayIn(), timeZone: 'UTC', playing: false, speed: '10m' },
    sun: null,
    banners: [],
    panels: { time: false, elevation: false, bookmarks: false },
    paletteOpen: false,
    shortcutsOpen: false,
    settingsOpen: false,
    onboardingOpen: false,
    profile: emptyProfile,
    inspect: null,
    destination: null,
    pendingTiles: 0,
    fps: null,
    flyMode: false,
    eyeLevel: false,
    viewfinder: false,
    bookmarks: [],
    autoRange: null,
    terrainReady: false,
    tilesetReady: false,
    terrainShadows: 'off',
    toast: null,

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
    showToast: (message) => {
      const id = ++toastId
      set({ toast: { id, message } })
      setTimeout(() => {
        if (get().toast?.id === id) set({ toast: null })
      }, 2600)
    }
  }))
)

export const appState = (): AppState => useAppStore.getState()
