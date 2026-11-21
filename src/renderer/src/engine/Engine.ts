import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cartographic,
  CesiumWidget,
  Color,
  ContextLimits,
  EllipsoidTerrainProvider,
  KeyboardEventModifier,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  type Scene
} from 'cesium'
import { estimateTarget, matchesFilter } from '@shared/locations'
import { DEFAULT_VIEW } from '@shared/settings'
import type { ApiCheck, ApiKeys, Bookmark, CameraView, GeoPosition, MapMode, NewBookmark, PlaceDetails, SavedProfile } from '@shared/types'
import { formatLatLon, type ParsedLocation } from '@shared/coords'
import { cameraForView, LOOKING_DOWN, sameView, viewFromCamera, zoomForMetersPerPixel, clampZoom, type MapView } from '../lib/webMercator'
import { loadGeoid } from '../lib/geoid'
import type { GeoPoint } from '../lib/profile'
import { haversine } from '../lib/profile'
import { appState, useAppStore, type AppState } from '../store/appStore'
import { AlignmentTool } from './AlignmentTool'
import { CameraController } from './CameraController'
import { ElevationStyler } from './ElevationStyler'
import { GoogleImagery } from './GoogleImagery'
import { HorizonTool } from './HorizonTool'
import { LightPollution } from './LightPollution'
import { LocationMarkers } from './LocationMarkers'
import { getMapControl } from './mapControl'
import { MapTiles } from './MapTiles'
import { PlaceLabels } from './PlaceLabels'
import { PointInspector } from './PointInspector'
import { ProfileTool } from './ProfileTool'
import { resolveQuality } from './quality'
import { Readouts } from './Readouts'
import { SearchMarker } from './SearchMarker'
import { MilkyWayController } from './MilkyWayController'
import { MoonController } from './MoonController'
import { installDetailShadowPatch } from './shadows/detailShadowPatch'
import { SpotSun } from './SpotSun'
import { SunController } from './SunController'
import { TerrainManager } from './TerrainManager'
import { TerrainShadows } from './TerrainShadows'
import { TilePreloader } from './TilePreloader'
import { TilesetManager } from './TilesetManager'
import { setUploadBudgets } from './uploadBudget'
import { Viewfinder } from './Viewfinder'
import { ViewshedTool } from './ViewshedTool'
import { cameraTarget, cartographicDeg, currentView, pickSurface, surfaceHeight, toDeg } from './util'

type ProviderKey = 'tiles' | 'terrain' | 'imagery' | 'labels' | 'map'

// The engine is created once and kept across React refreshes, so a hot update of engine code
// would leave the old instance running: reload the page instead (dev only).
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload())

function subscribeJson<T>(selector: (s: AppState) => T, listener: (value: T) => void): () => void {
  return useAppStore.subscribe(selector, listener, {
    equalityFn: (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b)
  })
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))])
}

/**
 * Owns the Cesium widget and the managers from the architecture diagram (§4). React never
 * touches Cesium directly: it updates the store, and the engine reacts to store changes.
 */
export class Engine {
  readonly widget: CesiumWidget
  readonly scene: Scene
  readonly tiles: TilesetManager
  readonly terrain: TerrainManager
  readonly imagery: GoogleImagery
  readonly lightPollution: LightPollution
  readonly labels: PlaceLabels
  readonly camera: CameraController
  readonly sun: SunController
  readonly moon: MoonController
  readonly milkyWay: MilkyWayController
  readonly styler: ElevationStyler
  readonly profile: ProfileTool
  readonly horizon: HorizonTool
  readonly alignment: AlignmentTool
  readonly viewshed: ViewshedTool
  readonly inspector: PointInspector
  readonly spotSun: SpotSun
  readonly searchMarker: SearchMarker
  readonly readouts: Readouts
  readonly terrainShadows: TerrainShadows
  readonly preloader: TilePreloader
  readonly viewfinder: Viewfinder
  readonly markers: LocationMarkers
  /** Map mode's own 2D Tiles session (§5.5). */
  readonly mapTiles: MapTiles
  /** The map view Map mode opened at from the 3D view; unmoved, leaving restores that view. */
  private mapEntry: MapView | null = null
  private readonly handler: ScreenSpaceEventHandler
  private readonly subs: Array<() => void> = []
  private clickTimer: number | null = null
  private saveTimer: number | null = null
  private rangeTimer: number | null = null
  private refreshTimer: number | null = null
  private moveRaf: number | null = null
  private pendingMove: Cartesian2 | null = null
  private terrainOnGlobe: unknown = null
  private keys: ApiKeys = { googleApiKey: null, cesiumIonToken: null }
  private failed = { tiles: false, terrain: false, imagery: false, labels: false, map: false }
  private destroyed = false

  constructor(container: HTMLElement, creditContainer: HTMLElement) {
    this.widget = new CesiumWidget(container, {
      baseLayer: false,
      terrainProvider: new EllipsoidTerrainProvider(),
      scene3DOnly: true,
      // Render only when something changes; animation forces continuous frames (§5.3).
      requestRenderMode: true,
      maximumRenderTimeChange: Number.POSITIVE_INFINITY,
      creditContainer,
      msaaSamples: 4,
      shadows: false,
      showRenderLoopErrors: false,
      contextOptions: { webgl: { alpha: false, powerPreference: 'high-performance' } }
    })
    const scene = (this.scene = this.widget.scene)
    scene.rethrowRenderErrors = false
    scene.renderError.addEventListener((_s: Scene, error: unknown) => {
      console.error('[photoearth] render error', error)
      appState().postBanner({
        id: 'render',
        level: 'error',
        title: 'Rendering error',
        message: `The 3D view hit a GPU error (${String((error as Error)?.message ?? error).slice(0, 160)}). Try a lower quality preset.`,
        actions: [{ label: 'Settings', command: 'open-settings' }]
      })
    })
    const globe = scene.globe
    globe.show = false
    globe.baseColor = Color.fromCssColorString('#22344a')
    globe.depthTestAgainstTerrain = true
    globe.showGroundAtmosphere = true
    globe.preloadSiblings = true
    globe.tileCacheSize = 400
    scene.fog.enabled = true
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = true
    scene.postProcessStages.fxaa.enabled = false

    const status = (key: ProviderKey, title: string) => ({
      error: (check: ApiCheck) => this.reportFailure(key, title, check),
      ready: () => this.reportReady(key)
    })
    const tiles = status('tiles', 'Photorealistic 3D Tiles unavailable')
    const terrain = status('terrain', 'Cesium World Terrain unavailable')
    const imagery = status('imagery', 'Google 2D imagery unavailable')
    const labels = status('labels', 'Google place names unavailable')
    const map = status('map', 'Google map unavailable')

    installDetailShadowPatch()
    this.terrainShadows = new TerrainShadows(
      scene,
      () => this.terrain?.provider ?? null,
      (state) => {
        appState().set({ terrainShadows: state })
        this.sun?.setTerrainShadows(state === 'ready')
        this.applyStyle()
      }
    )
    this.viewshed = new ViewshedTool(
      this.widget,
      () => this.terrain?.provider ?? null,
      () => {
        this.applyStyle()
        this.refreshInspectViewshed()
      }
    )
    this.tiles = new TilesetManager(scene, {
      onError: tiles.error,
      onReady: () => {
        tiles.ready()
        appState().set({ tilesetReady: true })
      },
      onProgress: (pending) => {
        appState().set({ pendingTiles: pending })
        if (pending === 0) this.scheduleRefresh()
      }
    }, this.terrainShadows.binding, this.viewshed.binding)
    this.terrain = new TerrainManager(terrain.error, () => {
      terrain.ready()
      appState().set({ terrainReady: true })
    })
    this.imagery = new GoogleImagery(scene, this.widget.creditDisplay, imagery.error, imagery.ready)
    this.mapTiles = new MapTiles((mapSession) => appState().set({ mapSession }), map.error, map.ready)
    this.lightPollution = new LightPollution(scene, (shown) => {
      this.sun?.setUnlitGlobe(shown)
      this.applyStyle()
    })
    this.labels = new PlaceLabels(scene, { onError: labels.error, onReady: labels.ready }, {
      nearby: (req) => window.photoearth.places.nearby(req),
      cities: (req) => window.photoearth.places.cities(req)
    })
    this.camera = new CameraController(scene, {
      onFlyModeChange: (flyMode) => appState().set({ flyMode }),
      onEyeLevelChange: (eyeLevel) => appState().set({ eyeLevel }),
      onUserInput: () => undefined,
      keyboardEnabled: () => {
        const s = appState()
        return !s.paletteOpen && !s.settingsOpen && !s.onboardingOpen && !s.shortcutsOpen && !s.photoViewer && !s.settings.map.open
      },
      sampleGround: (lon, lat) => this.preciseGround(lon, lat)
    })
    this.viewfinder = new Viewfinder(scene, this.camera)
    this.sun = new SunController(this.widget, this.tiles)
    this.moon = new MoonController(this.widget)
    this.milkyWay = new MilkyWayController(this.widget)
    this.styler = new ElevationStyler(scene, this.terrainShadows, this.viewshed)
    this.profile = new ProfileTool(this.widget, (points) => this.sampleProfile(points))
    this.horizon = new HorizonTool(this.widget, {
      provider: () => this.terrain.provider,
      nearby: (req) => window.photoearth.places.nearby(req),
      knownPeaks: () => this.labels.knownPeaks(),
      canNamePeaks: () => !!this.keys.googleApiKey
    })
    this.alignment = new AlignmentTool(this.widget, {
      sampleGround: (lon, lat) => this.preciseGround(lon, lat),
      samplePath: (points) => this.sampleProfile(points)
    })
    this.inspector = new PointInspector(this.widget, (lon, lat) => this.preciseGround(lon, lat))
    this.spotSun = new SpotSun(() => this.terrain?.provider ?? null)
    this.searchMarker = new SearchMarker(this.widget, (lon, lat) => this.preciseGround(lon, lat))
    this.readouts = new Readouts(scene, (target) => this.onTarget(target))
    this.markers = new LocationMarkers(scene, (points) => this.sampleTerrainHeights(points))
    this.preloader = new TilePreloader(scene, () => {
      const cam = appState().camera
      return cam && cam.heightAgl !== null ? cam.height - cam.heightAgl : null
    })

    this.handler = new ScreenSpaceEventHandler(scene.canvas)
    this.wireMouse()
    scene.camera.moveStart.addEventListener(() => this.onMoveStart())
    scene.camera.moveEnd.addEventListener(() => this.onMoveEnd())
    scene.postRender.addEventListener(() => this.inspector.updateScreen())
    globe.tileLoadProgressEvent.addEventListener((queued: number) => {
      if (appState().mode === 'elevation') appState().set({ pendingTiles: queued })
      if (queued === 0) {
        this.scheduleAutoRange()
        this.scheduleRefresh()
      }
    })
    window.addEventListener('online', this.onOnline)
    this.subscribe()
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  start(keys: ApiKeys): void {
    const s = appState()
    this.camera.setView(s.settings.lastCamera ?? DEFAULT_VIEW)
    this.applyQuality()
    this.camera.configure(s.settings.navigation)
    this.viewshed.configure(s.settings.viewshed, s.settings.units)
    this.scene.verticalExaggeration = s.settings.verticalExaggeration
    this.applyMode()
    this.readouts.refresh()
    this.sun.update()
    this.moon.update()
    this.milkyWay.update()
    void this.setKeys(keys)
    // Started in Map mode: the map shows its saved view, and the 3D view waits under it.
    if (s.settings.map.open) this.pauseForMap()
    void loadGeoid().then(() => {
      if (this.destroyed) return
      this.readouts.refresh()
      const t = appState().target
      if (t) this.styler.setGeoidOffset(t.latitude, t.longitude)
    })
  }

  destroy(): void {
    this.destroyed = true
    window.removeEventListener('online', this.onOnline)
    this.subs.forEach((u) => u())
    this.handler.destroy()
    this.viewfinder.destroy()
    this.camera.destroy()
    this.sun.destroy()
    this.spotSun.destroy()
    this.moon.destroy()
    this.milkyWay.destroy()
    this.readouts.destroy()
    this.imagery.destroy()
    this.mapTiles.destroy()
    this.lightPollution.destroy()
    this.labels.destroy()
    this.terrainShadows.destroy()
    this.viewshed.destroy()
    this.preloader.destroy()
    this.markers.destroy()
    this.alignment.destroy()
    this.widget.destroy()
  }

  requestRender(): void {
    this.scene.requestRender()
  }

  private onOnline = (): void => {
    if (Object.values(this.failed).some(Boolean)) void this.retryProviders()
  }

  async setKeys(keys: ApiKeys): Promise<void> {
    const changed = {
      google: keys.googleApiKey !== this.keys.googleApiKey,
      ion: keys.cesiumIonToken !== this.keys.cesiumIonToken
    }
    this.keys = { ...keys }
    const { postBanner, dismissBanner, set } = appState()
    if (!keys.googleApiKey) {
      postBanner({
        id: 'tiles',
        level: 'info',
        title: 'No Google Maps Platform key',
        message: 'Add a key to see Photorealistic 3D Tiles and satellite imagery.',
        actions: [{ label: 'Add key', command: 'open-settings' }]
      })
    }
    const jobs: Array<Promise<void>> = []
    if (changed.google || this.failed.tiles) {
      if (keys.googleApiKey) dismissBanner('tiles')
      set({ tilesetReady: false })
      this.failed.tiles = false
      jobs.push(this.tiles.load(keys.googleApiKey).then(() => this.applyMode()))
    }
    if (changed.google || this.failed.imagery) {
      this.failed.imagery = false
      dismissBanner('imagery')
      jobs.push(this.imagery.configure(keys.googleApiKey, appState().settings.imagery).then(() => this.applyMode()))
    }
    if (changed.google || this.failed.labels) {
      dismissBanner('labels')
      this.labels.configure(keys.googleApiKey, appState().settings.placeLabels, this.failed.labels)
      this.failed.labels = false
    }
    if ((changed.google || this.failed.map) && appState().settings.map.open) {
      this.failed.map = false
      dismissBanner('map')
      jobs.push(this.mapTiles.configure(keys.googleApiKey, appState().settings.map.type))
    }
    if (changed.ion || this.failed.terrain) {
      this.failed.terrain = false
      dismissBanner('terrain')
      set({ terrainReady: false })
      jobs.push(this.terrain.load(keys.cesiumIonToken).then(() => this.applyMode()))
    }
    await Promise.all(jobs)
  }

  retryProviders(): Promise<void> {
    this.failed = { tiles: true, terrain: true, imagery: true, labels: true, map: true }
    return this.setKeys(this.keys)
  }

  private reportFailure(key: ProviderKey, title: string, check: ApiCheck): void {
    this.failed[key] = true
    if (key === 'tiles') appState().set({ tilesetReady: false })
    appState().postBanner({
      id: key,
      level: check.status === 'offline' || check.status === 'quota' ? 'warning' : 'error',
      title,
      message: check.message,
      actions: [
        { label: 'Retry', command: 'retry-providers' },
        { label: 'Settings', command: 'open-settings' }
      ]
    })
    this.applyMode()
  }

  private reportReady(key: ProviderKey): void {
    this.failed[key] = false
    appState().dismissBanner(key)
  }

  // ───────────────────────────── store → scene ─────────────────────────────

  private subscribe(): void {
    const s = this.subs
    s.push(subscribeJson((st) => st.mode, () => this.applyMode()))
    s.push(subscribeJson((st) => st.tilesetReady, () => this.applyMode()))
    s.push(subscribeJson((st) => st.terrainReady, () => this.applyMode()))
    s.push(subscribeJson((st) => st.settings.quality, () => this.applyQuality()))
    s.push(subscribeJson((st) => st.settings.navigation, (n) => this.camera.configure(n)))
    s.push(
      subscribeJson(
        (st) => st.settings.verticalExaggeration,
        (v) => {
          this.scene.verticalExaggeration = v
          this.applyStyle()
          this.scheduleAutoRange()
        }
      )
    )
    s.push(subscribeJson((st) => [st.settings.elevation, st.autoRange], () => this.applyStyle()))
    s.push(subscribeJson((st) => [st.settings.lighting, st.settings.shadows, st.settings.detailShadows], () => this.applyLighting()))
    s.push(subscribeJson((st) => st.settings.showSunIndicator, () => this.sun.update()))
    s.push(subscribeJson((st) => st.settings.showMoonIndicator, () => this.moon.updateIndicator()))
    s.push(subscribeJson((st) => st.settings.showMilkyWayIndicator, () => this.milkyWay.updateIndicator()))
    s.push(
      subscribeJson(
        (st) => st.settings.imagery,
        (type) => void this.imagery.configure(this.keys.googleApiKey, type).then(() => this.applyMode())
      )
    )
    s.push(
      subscribeJson(
        (st) => st.settings.map.type,
        (type) => {
          if (appState().settings.map.open) void this.mapTiles.configure(this.keys.googleApiKey, type)
        }
      )
    )
    s.push(
      subscribeJson(
        (st) => st.settings.lightPollution,
        (lp) => this.lightPollution.configure(lp, this.scene.globe.show)
      )
    )
    s.push(
      subscribeJson(
        (st) => st.settings.placeLabels,
        (on) => this.labels.configure(this.keys.googleApiKey, on)
      )
    )
    s.push(
      subscribeJson(
        (st) => [st.settings.shadows, st.settings.lighting, st.terrainReady],
        () => this.applyTerrainShadows()
      )
    )
    s.push(useAppStore.subscribe((st) => st.sun, () => this.updateTerrainSun()))
    s.push(
      useAppStore.subscribe(
        (st) => st.camera?.heightAgl ?? null,
        (agl) => {
          this.sun.setCameraHeight(agl)
          this.camera.noteHeightAboveGround(agl)
        }
      )
    )
    s.push(useAppStore.subscribe((st) => st.profile.hoverIndex, () => this.requestRender()))
    s.push(useAppStore.subscribe((st) => st.settings.horizon.peakNames, () => void this.horizon.namePeaks()))
    // A token added while the panorama or viewshed shows "needs terrain" retries it.
    s.push(
      useAppStore.subscribe(
        (st) => st.terrainReady,
        (ready) => {
          const h = appState().horizon
          if (ready && h.open && h.status === 'error' && this.horizon.spot) void this.horizon.open(this.horizon.spot)
          const v = appState().viewshed
          if (ready && v.open && v.status === 'error' && this.viewshed.targetSpot) void this.openViewshed(this.viewshed.targetSpot)
        }
      )
    )
    s.push(
      subscribeJson(
        (st) => [st.settings.viewshed, st.settings.units] as const,
        ([vs, units]) => {
          this.viewshed.configure(vs, units)
          this.refreshInspectViewshed()
        }
      )
    )
    s.push(useAppStore.subscribe((st) => st.inspect, () => this.refreshInspectViewshed()))
    s.push(
      subscribeJson(
        (st) => [st.viewfinder, st.settings.viewfinder] as const,
        ([on, lens]) => this.viewfinder.update(on, lens)
      )
    )
    s.push(
      useAppStore.subscribe(
        (st) => [st.bookmarks, st.locationFilter, st.activeLocation, st.panels.bookmarks, st.settings.showLocationMarkers] as const,
        () => this.updateMarkers(),
        { equalityFn: (a, b) => a.every((v, i) => v === b[i]) }
      )
    )
    s.push(useAppStore.subscribe((st) => st.terrainReady, (ready) => ready && this.markers.resample()))
  }

  /** Pins for the locations the panel's filter shows, plus the one being edited. */
  private updateMarkers(): void {
    const { bookmarks, locationFilter, panels, settings } = appState()
    const activeLocation = panels.bookmarks ? appState().activeLocation : null
    this.markers.setVisible(settings.showLocationMarkers)
    this.markers.update(
      bookmarks.filter((b) => b.id === activeLocation || matchesFilter(b, locationFilter)),
      activeLocation
    )
  }

  private applyMode(): void {
    if (this.destroyed) return
    const { mode, tilesetReady, settings } = appState()
    const photo = mode === 'photorealistic'
    const globe = this.scene.globe
    this.tiles.setVisible(photo)
    // In Photorealistic mode the globe is hidden so it never z-fights with the mesh; it only
    // appears as a backdrop when the tileset is unavailable.
    globe.show = !photo || !tilesetReady
    const terrain = this.terrain.provider ?? this.terrain.ellipsoid
    if (this.terrainOnGlobe !== terrain) {
      this.terrainOnGlobe = terrain
      this.scene.terrainProvider = terrain
    }
    this.imagery.setVisible(globe.show)
    this.lightPollution.configure(settings.lightPollution, globe.show)
    this.labels.refresh()
    if (!photo && !this.terrain.available) {
      appState().postBanner({
        id: 'elevation-terrain',
        level: 'info',
        title: 'Elevation mode needs terrain',
        message: 'Add a Cesium ion access token to load Cesium World Terrain for contours, tint, slope and hillshade.',
        actions: [{ label: 'Add token', command: 'open-settings' }]
      })
    } else {
      appState().dismissBanner('elevation-terrain')
    }
    this.sun.configure(mode, settings.lighting, settings.shadows, settings.detailShadows)
    this.applyStyle()
    this.applyTerrainShadows()
    this.scheduleAutoRange()
    this.requestRender()
  }

  private applyStyle(): void {
    // Called from the terrain-shadow status callback, which can fire during construction.
    if (!this.styler || !this.terrain) return
    const { mode, settings, autoRange } = appState()
    this.styler.apply(
      settings.elevation,
      mode === 'elevation' && (this.terrain.available || this.viewshed.ready),
      autoRange,
      this.terrainShadows.ready,
      this.lightPollution.shown,
      this.viewshed.ready
    )
  }

  private applyLighting(): void {
    const { mode, settings } = appState()
    this.sun.configure(mode, settings.lighting, settings.shadows, settings.detailShadows)
    this.sun.update()
  }

  private applyQuality(): void {
    const { quality } = appState().settings
    const q = resolveQuality(quality.preset, quality.overrides, {
      maxTextureSize: ContextLimits.maximumTextureSize || 4096,
      maxSamples: ContextLimits.maximumSamples || 1
    })
    this.tiles.setScreenSpaceError(q.maximumScreenSpaceError)
    this.terrainShadows.setResolution(q.terrainShadowResolution)
    this.viewshed.setResolution(q.terrainShadowResolution)
    this.scene.globe.maximumScreenSpaceError = q.terrainScreenSpaceError
    this.sun.applyQuality(q)
    if (this.scene.msaaSupported) this.scene.msaaSamples = q.msaaSamples
    this.scene.postProcessStages.fxaa.enabled = q.fxaa
    this.widget.useBrowserRecommendedResolution = !quality.devicePixelRatioAware
    this.widget.resolutionScale = q.resolutionScale
    // Contours fade with the terrain's screen-space error.
    this.applyStyle()
    this.requestRender()
  }

  private applyTerrainShadows(): void {
    const { settings, terrainReady } = appState()
    this.terrainShadows.setEnabled(settings.shadows && settings.lighting === 'sun' && terrainReady && this.terrain.available)
    this.updateTerrainSun()
  }

  private updateTerrainSun(): void {
    const { sun, target } = appState()
    if (sun && target) this.terrainShadows.setSun(sun.azimuth, sun.altitude, target.longitude, target.latitude)
  }

  // ───────────────────────────── mouse ─────────────────────────────

  private wireMouse(): void {
    const h = this.handler
    h.setInputAction((e: { position: Cartesian2 }) => this.onClick(e.position), ScreenSpaceEventType.LEFT_CLICK)
    h.setInputAction((e: { position: Cartesian2 }) => this.onDoubleClick(e.position), ScreenSpaceEventType.LEFT_DOUBLE_CLICK)
    const move = (e: { endPosition: Cartesian2 }) => this.onMouseMove(e.endPosition)
    h.setInputAction(move, ScreenSpaceEventType.MOUSE_MOVE)
    for (const m of [KeyboardEventModifier.SHIFT, KeyboardEventModifier.CTRL, KeyboardEventModifier.ALT]) {
      h.setInputAction(move, ScreenSpaceEventType.MOUSE_MOVE, m)
    }
    h.setInputAction(() => {
      if (this.profile.drawing) this.profile.finish()
    }, ScreenSpaceEventType.RIGHT_CLICK)
    this.scene.canvas.addEventListener('mouseleave', () => this.readouts.onMouseLeave())
  }

  private onClick(position: Cartesian2): void {
    if (appState().flyMode) return
    if (this.profile.drawing) {
      const hit = pickSurface(this.scene, position.x, position.y)
      if (hit) this.profile.addPoint(hit)
      return
    }
    if (this.alignment.isOpen && this.alignment.pickMode !== null) {
      const hit = pickSurface(this.scene, position.x, position.y)
      if (!hit) return
      if (this.alignment.pickMode === 'camera') void this.alignment.setCamera(hit)
      else void this.alignment.setSubject(hit)
      return
    }
    // Wait to see whether this is the first half of a double-click.
    if (this.clickTimer !== null) window.clearTimeout(this.clickTimer)
    const p = Cartesian2.clone(position)
    this.clickTimer = window.setTimeout(() => {
      this.clickTimer = null
      // A saved location's pin: open it (CPU hit test against the drawn pins, no GPU pick).
      const location = this.markers.hitTest(p.x, p.y)
      const b = location ? appState().bookmarks.find((x) => x.id === location) : undefined
      if (b) {
        appState().set({ activeLocation: b.id })
        appState().togglePanel('bookmarks', true)
        void this.flyToBookmark(b)
        return
      }
      const hit = pickSurface(this.scene, p.x, p.y)
      if (!hit) return
      // One-shot target picking for viewshed analysis.
      if (this.viewshed.picking) {
        void this.openViewshed(hit)
        return
      }
      // With the horizon panorama open, a click moves its observer.
      if (this.horizon.isOpen) void this.openHorizon(hit)
      else {
        void this.inspector.inspect(hit)
        void this.spotSun.inspect(hit)
      }
    }, 260)
  }

  private onDoubleClick(position: Cartesian2): void {
    if (this.clickTimer !== null) window.clearTimeout(this.clickTimer)
    this.clickTimer = null
    if (appState().flyMode) return
    if (this.profile.drawing) {
      this.profile.finish()
      return
    }
    this.camera.flyToPoint(position)
  }

  private onMouseMove(position: Cartesian2): void {
    this.readouts.onMouseMove(position)
    if (!this.profile.drawing && !this.profile.hasProfile) return
    this.pendingMove = Cartesian2.clone(position)
    if (this.moveRaf !== null) return
    this.moveRaf = requestAnimationFrame(() => {
      this.moveRaf = null
      const p = this.pendingMove
      if (!p) return
      const picked = this.profile.drawing ? pickSurface(this.scene, p.x, p.y) : undefined
      this.profile.onMouseMove(p, picked)
    })
  }

  // ───────────────────────────── camera events ─────────────────────────────

  private onTarget(target: Cartesian3): void {
    this.sun.setTargetPosition(target)
    this.moon.setTargetPosition(target)
    this.milkyWay.setTargetPosition(target)
    this.terrainShadows.setView(this.scene.camera.positionWC, target, appState().camera?.heightAgl ?? null)
    const t = cartographicDeg(target)
    if (t) this.styler.setGeoidOffset(t.latitude, t.longitude)
  }

  /** The camera started moving: trade a little detail for steady frames until it stops. */
  private onMoveStart(): void {
    this.tiles.setMoving(true)
    this.terrainShadows.setMoving(true)
    setUploadBudgets(this.scene, true)
  }

  private onMoveEnd(): void {
    this.tiles.setMoving(false)
    this.terrainShadows.setMoving(false)
    setUploadBudgets(this.scene, false)
    this.readouts.refresh()
    this.imagery.updateAttribution()
    this.labels.onMoveEnd()
    this.scheduleAutoRange()
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => {
      const view = currentView(this.scene)
      appState().patchSettings((d) => {
        d.lastCamera = view
      })
    }, 1200)
  }

  /** Re-reads target and readouts once detail has streamed in after the camera stopped. */
  private scheduleRefresh(): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer)
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null
      if (this.destroyed) return
      this.readouts.refresh()
      this.labels.refresh()
    }, 300)
  }

  private scheduleAutoRange(): void {
    if (this.rangeTimer !== null) window.clearTimeout(this.rangeTimer)
    this.rangeTimer = window.setTimeout(() => {
      const { mode, settings } = appState()
      if (mode !== 'elevation' || !settings.elevation.tint.autoRange || !this.terrain.available) return
      const range = this.styler.sampleVisibleRange()
      if (range) appState().set({ autoRange: range })
    }, 450)
  }

  // ───────────────────────────── sampling ─────────────────────────────

  /** Ellipsoidal ground height from the active surface (3D tiles or terrain). */
  async preciseGround(longitude: number, latitude: number): Promise<number | undefined> {
    const photo = appState().mode === 'photorealistic'
    if (photo && this.tiles.tileset && appState().tilesetReady) {
      try {
        const [c] = await withTimeout(this.scene.sampleHeightMostDetailed([Cartographic.fromDegrees(longitude, latitude)]), 8000, [])
        if (c && Number.isFinite(c.height)) return c.height
      } catch {
        /* fall through */
      }
    }
    if (this.terrain.available) {
      const [h] = await this.terrain.sample([{ longitude, latitude }])
      if (h !== null) return h
    }
    return surfaceHeight(this.scene, longitude, latitude)
  }

  /** Terrain heights (ellipsoidal) for marker placement; null without a terrain source. */
  private async sampleTerrainHeights(points: Array<{ longitude: number; latitude: number }>): Promise<Array<number | null>> {
    if (!this.terrain.available) return points.map(() => null)
    return withTimeout(this.terrain.sample(points), 10_000, points.map(() => null))
  }

  private async sampleProfile(points: GeoPoint[]): Promise<{ heights: Array<number | null>; source: 'terrain' | 'tiles' }> {
    if (this.terrain.available) return { heights: await this.terrain.sample(points), source: 'terrain' }
    if (this.tiles.tileset) {
      const cartos = points.map((p) => Cartographic.fromDegrees(p.longitude, p.latitude))
      const out = await this.scene.sampleHeightMostDetailed(cartos)
      return { heights: out.map((c) => (c && Number.isFinite(c.height) ? c.height : null)), source: 'tiles' }
    }
    throw new Error('no elevation source (add a Cesium ion token or Google key)')
  }

  /** Approximate ground height for flights; never blocks for long. */
  async groundHeight(longitude: number, latitude: number): Promise<number> {
    if (!this.terrain.available) return surfaceHeight(this.scene, longitude, latitude) ?? 0
    const [h] = await withTimeout(this.terrain.sample([{ longitude, latitude }]), 1500, [null])
    return h ?? 0
  }

  // ───────────────────────────── commands ─────────────────────────────

  /** Switches to a 3D mode (leaving Map mode at the map's center) or to Map mode. */
  async setMode(mode: MapMode | 'map'): Promise<void> {
    if (mode === 'map') {
      this.openMap()
      return
    }
    if (appState().settings.map.open) await this.closeMap(true)
    appState().set({ mode })
    appState().patchSettings((d) => {
      d.lastMode = mode
    })
  }

  // ───────────────────────────── Map mode (§5.5) ─────────────────────────────

  /** The map view now: the live one while a gesture runs, else the committed one. */
  mapView(): MapView {
    const live = getMapControl()?.view()
    if (live) return live
    const { longitude, latitude, zoom } = appState().settings.map
    return { longitude, latitude, zoom }
  }

  /** Opens the map over the 3D view, centered where the 3D view looks, at its scale. */
  private openMap(): void {
    const s = appState()
    if (s.settings.map.open || this.destroyed) return
    if (s.flyMode) this.camera.toggleFlyMode()
    // A pick armed on the 3D view (viewshed observer, alignment pins) can't be clicked from the map.
    if (s.viewshed.picking) this.viewshed.setPicking(false)
    if (s.alignment.pickMode !== null) this.alignment.setPickMode(null)
    const cam = s.camera
    // The view center now (the store's may lag a moving camera): a one-off ray cast on the
    // CPU, no depth readback.
    const target = cam && cam.pitch < LOOKING_DOWN ? cartographicDeg(cameraTarget(this.scene, true)) : null
    const view = cam
      ? viewFromCamera({ ...cam, heightAboveGround: cam.heightAgl ?? cam.heightMsl }, target, this.scene.canvas.clientWidth || window.innerWidth)
      : this.mapView()
    this.mapEntry = view
    s.patchSettings((d) => {
      d.map.open = true
      d.map.longitude = view.longitude
      d.map.latitude = view.latitude
      d.map.zoom = view.zoom
    })
    this.pauseForMap()
  }

  /**
   * While the map is open the 3D view is covered: Cesium's render loop stops, so it draws,
   * streams and uploads nothing (§5.3).
   */
  private pauseForMap(): void {
    this.scene.camera.cancelFlight()
    this.widget.useDefaultRenderLoop = false
    void this.mapTiles.configure(this.keys.googleApiKey, appState().settings.map.type)
  }

  /**
   * Leaves the map for the 3D view. `place`: unless the map is where it opened, the 3D view
   * opens looking at the map's center, with the last heading and pitch, at the map's scale.
   */
  private async closeMap(place: boolean): Promise<void> {
    if (!appState().settings.map.open) return
    const view = this.mapView()
    const entry = this.mapEntry
    this.mapEntry = null
    if (place && (!entry || !sameView(view, entry))) {
      // Sampled while the map still shows, so the 3D view never shows a half-placed camera.
      const ground = await this.groundHeight(view.longitude, view.latitude)
      if (this.destroyed) return
      const cam = appState().camera
      const look = { heading: cam?.heading ?? 0, pitch: cam?.pitch ?? -35, fov: cam?.fov ?? 60 }
      this.camera.setView(cameraForView(view, look, this.scene.canvas.clientWidth || window.innerWidth, ground))
    }
    appState().patchSettings((d) => {
      d.map.open = false
      d.map.longitude = view.longitude
      d.map.latitude = view.latitude
      d.map.zoom = view.zoom
    })
    this.widget.useDefaultRenderLoop = true
    this.requestRender()
    // The status bar's readouts (scale bar) are the 3D view's again.
    this.scheduleRefresh()
  }

  /** Centers the map on a place, zoomed so `range` meters fit the window (search in Map mode). */
  private showOnMap(latitude: number, longitude: number, range: number): void {
    const width = this.scene.canvas.clientWidth || window.innerWidth
    const zoom = clampZoom(zoomForMetersPerPixel(latitude, range / (0.8 * width)))
    const view = { longitude, latitude, zoom }
    const control = getMapControl()
    if (control) control.setView(view, true)
    else
      appState().patchSettings((d) => {
        d.map.longitude = longitude
        d.map.latitude = latitude
        d.map.zoom = zoom
      })
  }

  currentView(): CameraView {
    return currentView(this.scene)
  }

  /**
   * The current view as a location: camera, mode, lens, optionally the simulated time, and the
   * spot. In Map mode: the search pin or the map's center, with the 3D view leaving the map
   * there would open.
   */
  async bookmarkFromView(name: string, includeTime: boolean): Promise<NewBookmark> {
    const { mode, sim, viewfinder, settings, destination, camera } = appState()
    let view = this.currentView()
    let position = settings.map.open ? null : this.locationSpot()
    if (settings.map.open) {
      const map = this.mapView()
      const spot = destination ?? map
      const ground = await this.groundHeight(spot.longitude, spot.latitude)
      const look = { heading: camera?.heading ?? 0, pitch: camera?.pitch ?? -35, fov: camera?.fov ?? 60 }
      view = cameraForView({ ...map, longitude: spot.longitude, latitude: spot.latitude }, look, this.scene.canvas.clientWidth || window.innerWidth, ground)
      // Height unknown without terrain: measured from the surface on the first visit.
      position = { longitude: spot.longitude, latitude: spot.latitude, height: this.terrain.available ? ground : null }
    }
    return {
      name,
      camera: view,
      mode,
      time: includeTime ? { utc: new Date(this.sun.utc).toISOString(), timeZone: sim.timeZone } : undefined,
      viewfinder: viewfinder && !settings.map.open ? structuredClone(settings.viewfinder) : undefined,
      position: position ?? this.locationSpot()
    }
  }

  /** Where a new location is: a dropped pin (inspect marker, then search pin), else the view center. */
  locationSpot(): GeoPosition {
    const canvas = this.scene.canvas
    const spot = this.inspector.point ?? this.searchMarker.point ?? pickSurface(this.scene, canvas.clientWidth / 2, canvas.clientHeight / 2)
    const c = spot && cartographicDeg(spot)
    // Nothing loaded under the view center (or looking at the sky): estimate, measure on the next visit.
    return c ? { longitude: c.longitude, latitude: c.latitude, height: c.height } : estimateTarget(this.currentView())
  }

  /** Flies to a saved location and restores its mode, lens and simulated time. */
  async flyToBookmark(b: Bookmark): Promise<void> {
    // From the map: straight to the location's own view, not via the map's center.
    await this.closeMap(false)
    if (b.mode !== appState().mode) await this.setMode(b.mode)
    if (b.time) this.sun.setInstant(Date.parse(b.time.utc), b.time.timeZone)
    // A shot saved in viewfinder mode reopens framed with the same lens.
    if (b.viewfinder) {
      const lens = b.viewfinder
      appState().patchSettings((d) => void (d.viewfinder = structuredClone(lens)))
      appState().set({ viewfinder: true })
    }
    await this.camera.flyToView(b.camera)
    if (b.position.height === null) void this.measureLocation(b)
  }

  /**
   * A location saved before locations had a position only has one estimated from its camera.
   * Standing in its view again, the view center on the loaded surface replaces the estimate.
   */
  private async measureLocation(b: Bookmark): Promise<void> {
    const started = Date.now()
    while (appState().pendingTiles > 0 && Date.now() - started < 8000) await new Promise((r) => setTimeout(r, 250))
    const v = this.currentView()
    const still = Math.abs(v.longitude - b.camera.longitude) < 1e-6 && Math.abs(v.latitude - b.camera.latitude) < 1e-6 && Math.abs(v.height - b.camera.height) < 1
    if (this.destroyed || !still) return
    const canvas = this.scene.canvas
    const hit = pickSurface(this.scene, canvas.clientWidth / 2, canvas.clientHeight / 2)
    const c = hit && cartographicDeg(hit)
    if (!c) return
    const updated = await window.photoearth.bookmarks.update(b.id, { position: { longitude: c.longitude, latitude: c.latitude, height: c.height } })
    if (updated) appState().set({ bookmarks: appState().bookmarks.map((x) => (x.id === updated.id ? updated : x)) })
  }

  /** Reopens a saved elevation profile and frames its path. */
  async openSavedProfile(profile: SavedProfile): Promise<void> {
    this.inspector.clear()
    const vertices = this.profile.load(profile.points, profile.id)
    if (vertices.length < 2) return
    const sphere = BoundingSphere.fromPoints(vertices)
    const c = cartographicDeg(sphere.center)
    if (!c) return
    const ground = profile.points.reduce((sum, p) => sum + (p.height ?? 0), 0) / profile.points.length
    await this.camera.flyToLocation(c.latitude, c.longitude, { range: Math.max(sphere.radius * 2.6, 1500), groundHeight: ground, pitch: -45 })
  }

  /** Flies to a searched place and pins it, labeled with the name the user picked. */
  async goToPlace(place: PlaceDetails, label?: { name: string; detail: string }): Promise<void> {
    const { latitude, longitude } = place.location
    let range = 6000
    if (place.viewport) {
      const diag = haversine(
        { latitude: place.viewport.low.latitude, longitude: place.viewport.low.longitude },
        { latitude: place.viewport.high.latitude, longitude: place.viewport.high.longitude }
      )
      range = Math.min(4.0e6, Math.max(1200, diag * 1.1))
    }
    const onMap = appState().settings.map.open
    if (onMap) this.showOnMap(latitude, longitude, range)
    const groundHeight = await this.groundHeight(longitude, latitude)
    const marker = this.searchMarker.show(
      {
        name: label?.name || place.name || formatLatLon(latitude, longitude, appState().settings.coordFormat),
        detail: label?.detail ?? place.formattedAddress,
        latitude,
        longitude
      },
      groundHeight
    )
    if (onMap) return
    await this.camera.flyToLocation(latitude, longitude, { range, groundHeight })
    await this.searchMarker.refine(marker)
  }

  async goToCoordinates(loc: ParsedLocation, detail = 'Coordinates'): Promise<void> {
    const onMap = appState().settings.map.open
    if (onMap) this.showOnMap(loc.latitude, loc.longitude, loc.range ?? 4000)
    const groundHeight = await this.groundHeight(loc.longitude, loc.latitude)
    const marker = this.searchMarker.show(
      {
        name: formatLatLon(loc.latitude, loc.longitude, appState().settings.coordFormat),
        detail,
        latitude: loc.latitude,
        longitude: loc.longitude
      },
      groundHeight
    )
    if (onMap) return
    await this.camera.flyToLocation(loc.latitude, loc.longitude, {
      range: loc.range ?? 4000,
      altitude: loc.altitude,
      heading: loc.heading,
      pitch: loc.tilt !== undefined ? loc.tilt - 90 : undefined,
      groundHeight
    })
    await this.searchMarker.refine(marker)
  }

  /** Where Eye level stands: a dropped pin (inspect marker, then search pin), if any. */
  get eyeLevelSpot(): Cartesian3 | null {
    return this.inspector.point ?? this.searchMarker.point
  }

  /** Eye level on/off: at the dropped pin if there is one, else under the cursor. */
  toggleEyeLevel(): Promise<void> {
    return this.camera.toggleEyeLevel(this.eyeLevelSpot ?? undefined)
  }

  /**
   * Horizon panorama for an observer at `position`, else at the inspected point, the search
   * pin or the view center.
   */
  async openHorizon(position?: Cartesian3): Promise<void> {
    const spot = position ?? this.inspector.point ?? this.searchMarker.point ?? cameraTarget(this.scene)
    this.inspector.clear()
    // On the 3D tiles a roof or tower counts as the observer's footing (at full detail); on
    // the terrain, or with exaggerated heights, the panorama's own grids give the ground.
    const { mode, tilesetReady } = appState()
    const c = Cartographic.fromCartesian(spot)
    const tiles = mode === 'photorealistic' && tilesetReady && this.scene.verticalExaggeration === 1
    await this.horizon.open(spot, tiles ? this.preciseGround(toDeg(c.longitude), toDeg(c.latitude)) : undefined)
  }

  /** H: opens the panorama, or closes it when it is open. */
  toggleHorizon(): void {
    if (this.horizon.isOpen) this.horizon.close()
    else void this.openHorizon()
  }

  /** Stands at the panorama's observer, looking at an azimuth and altitude (degrees). */
  lookFromHorizon(azimuth: number, altitude: number): Promise<void> {
    const spot = this.horizon.spot
    if (!spot) return Promise.resolve()
    return this.camera.goToEyeLevel(spot, { heading: azimuth, pitch: altitude })
  }

  /** X: opens or closes the Camera → Subject shot alignment planner. */
  toggleAlignment(): void {
    if (this.alignment.isOpen) this.alignment.close()
    else this.alignment.open()
  }

  /** Stands at the alignment Camera pin (at its configured eye height), facing the Subject or manual direction. */
  lookAlongAlignment(opts?: { enableViewfinder?: boolean }): Promise<void> {
    const { camera, geometry, eyeHeight, manualDirection } = appState().alignment
    if (!camera) return Promise.resolve()
    const spot = this.alignment.cameraSpot ?? Cartesian3.fromDegrees(camera.longitude, camera.latitude, camera.groundHeight)
    const heading = geometry ? geometry.bearing : manualDirection?.azimuth
    const pitch = geometry ? geometry.geometricAngle : manualDirection?.altitude
    if (heading === undefined || pitch === undefined) return this.camera.goToEyeLevel(spot, { heading: toDeg(this.scene.camera.heading), pitch: 0, eyeHeight })
    if (opts?.enableViewfinder) appState().set({ viewfinder: true })
    return this.camera.goToEyeLevel(spot, { heading, pitch: Math.max(-85, Math.min(85, pitch)), eyeHeight })
  }

  /** Frames both Camera and Subject alignment pins from an overview vantage. */
  frameAlignment(): Promise<void> {
    const a = this.alignment.cameraSpot
    const b = this.alignment.subjectSpot
    if (!a && !b) return Promise.resolve()
    if (a && !b) {
      const c = cartographicDeg(a)
      return c ? this.camera.flyToLocation(c.latitude, c.longitude, { range: 2000, groundHeight: c.height }) : Promise.resolve()
    }
    if (!a && b) {
      const c = cartographicDeg(b)
      return c ? this.camera.flyToLocation(c.latitude, c.longitude, { range: 2000, groundHeight: c.height }) : Promise.resolve()
    }
    const sphere = BoundingSphere.fromPoints([a!, b!])
    const c = cartographicDeg(sphere.center)
    if (!c) return Promise.resolve()
    const { camera, subject } = appState().alignment
    const ground = ((camera?.groundHeight ?? 0) + (subject?.groundHeight ?? 0)) / 2
    return this.camera.flyToLocation(c.latitude, c.longitude, { range: Math.max(sphere.radius * 2.6, 1200), groundHeight: ground, pitch: -42 })
  }

  /** Uses the current inspect marker or search pin as the alignment Camera or Subject pin. */
  useActivePinForAlignment(role: 'camera' | 'subject'): void {
    const s = appState()
    const spot = this.inspector.point ?? this.searchMarker.point
    if (!spot) {
      s.showToast('No inspected point or search pin on the map.')
      return
    }
    const label = this.inspector.point ? undefined : s.destination?.name
    if (role === 'camera') void this.alignment.setCamera(spot, label)
    else void this.alignment.setSubject(spot, label)
  }

  /** Uses the camera's current ground footprint as the alignment Camera pin. */
  useCurrentCameraForAlignment(): void {
    const cam = this.scene.camera
    const c = Cartographic.fromCartesian(cam.positionWC)
    if (!c) return
    void this.alignment.setCameraFromCoords(toDeg(c.longitude), toDeg(c.latitude), surfaceHeight(this.scene, toDeg(c.longitude), toDeg(c.latitude)) ?? c.height)
  }

  startProfile(): void {
    this.viewshed.setPicking(false)
    this.inspector.clear()
    this.profile.start()
  }

  /**
   * Opens or moves the viewshed analysis to `position`, else to the inspected point, the
   * search pin, or the view center.
   */
  async openViewshed(position?: Cartesian3): Promise<void> {
    const spot = position ?? this.inspector.point ?? this.searchMarker.point ?? cameraTarget(this.scene)
    const { mode, tilesetReady, settings } = appState()
    this.viewshed.configure(settings.viewshed, settings.units)
    const c = Cartographic.fromCartesian(spot)
    const tiles = mode === 'photorealistic' && tilesetReady && this.scene.verticalExaggeration === 1
    await this.viewshed.open(spot, tiles ? this.preciseGround(toDeg(c.longitude), toDeg(c.latitude)) : undefined)
    this.refreshInspectViewshed()
  }

  /** Shift+V: opens viewshed at the pin or view center, or clears it when already open. */
  toggleViewshed(): void {
    if (this.viewshed.isOpen) this.viewshed.clear()
    else void this.openViewshed()
  }

  /** Flies the camera back to frame the active viewshed target. */
  async flyToViewshedTarget(): Promise<void> {
    const target = appState().viewshed.target
    if (!target) return
    const range = Math.max(1500, Math.min(appState().settings.viewshed.radius * 0.45, 12000))
    await this.camera.flyToLocation(target.latitude, target.longitude, {
      range,
      groundHeight: target.groundEllipsoidal
    })
  }

  /**
   * Stands at the inspected point at eye level, looking back toward the viewshed target.
   * Optionally opens the viewfinder to preview focal-length framing of the target.
   */
  async lookAtViewshedTarget(openViewfinder = false): Promise<void> {
    const spot = this.inspector.point
    const check = appState().inspectViewshed
    if (!spot || !check) return
    if (openViewfinder) appState().set({ viewfinder: true })
    await this.camera.goToEyeLevel(spot, {
      heading: check.bearingToTarget,
      pitch: Math.max(-60, Math.min(60, check.pitchToTarget))
    })
  }

  /** Refreshes line-of-sight readout for the inspected point against the active viewshed. */
  refreshInspectViewshed(): void {
    const point = this.inspector?.point
    const next = point && this.viewshed?.isOpen ? this.viewshed.checkPoint(point) : null
    if (next === null && appState().inspectViewshed === null) return
    appState().set({ inspectViewshed: next })
  }
}
