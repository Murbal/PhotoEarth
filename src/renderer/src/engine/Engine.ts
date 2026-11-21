import {
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
import { DEFAULT_VIEW } from '@shared/settings'
import type { ApiCheck, ApiKeys, Bookmark, CameraView, MapMode, NewBookmark, PlaceDetails } from '@shared/types'
import { formatLatLon, type ParsedLocation } from '../lib/coords'
import { loadGeoid } from '../lib/geoid'
import type { GeoPoint } from '../lib/profile'
import { haversine } from '../lib/profile'
import { appState, useAppStore, type AppState } from '../store/appStore'
import { CameraController } from './CameraController'
import { ElevationStyler } from './ElevationStyler'
import { GoogleImagery } from './GoogleImagery'
import { PlaceLabels } from './PlaceLabels'
import { PointInspector } from './PointInspector'
import { ProfileTool } from './ProfileTool'
import { resolveQuality } from './quality'
import { Readouts } from './Readouts'
import { SearchMarker } from './SearchMarker'
import { installDetailShadowPatch } from './shadows/detailShadowPatch'
import { SunController } from './SunController'
import { TerrainManager } from './TerrainManager'
import { TerrainShadows } from './TerrainShadows'
import { TilePreloader } from './TilePreloader'
import { TilesetManager } from './TilesetManager'
import { cartographicDeg, currentView, pickSurface, surfaceHeight } from './util'

type ProviderKey = 'tiles' | 'terrain' | 'imagery' | 'labels'

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
  readonly labels: PlaceLabels
  readonly camera: CameraController
  readonly sun: SunController
  readonly styler: ElevationStyler
  readonly profile: ProfileTool
  readonly inspector: PointInspector
  readonly searchMarker: SearchMarker
  readonly readouts: Readouts
  readonly terrainShadows: TerrainShadows
  readonly preloader: TilePreloader
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
  private failed = { tiles: false, terrain: false, imagery: false, labels: false }
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
    }, this.terrainShadows.binding)
    this.terrain = new TerrainManager(terrain.error, () => {
      terrain.ready()
      appState().set({ terrainReady: true })
    })
    this.imagery = new GoogleImagery(scene, this.widget.creditDisplay, imagery.error, imagery.ready)
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
        return !s.paletteOpen && !s.settingsOpen && !s.onboardingOpen && !s.shortcutsOpen
      },
      sampleGround: (lon, lat) => this.preciseGround(lon, lat)
    })
    this.sun = new SunController(this.widget, this.tiles)
    this.styler = new ElevationStyler(scene, this.terrainShadows)
    this.profile = new ProfileTool(this.widget, (points) => this.sampleProfile(points))
    this.inspector = new PointInspector(this.widget, (lon, lat) => this.preciseGround(lon, lat))
    this.searchMarker = new SearchMarker(this.widget, (lon, lat) => this.preciseGround(lon, lat))
    this.readouts = new Readouts(scene, (target) => this.onTarget(target))
    this.preloader = new TilePreloader(scene, () => {
      const cam = appState().camera
      return cam && cam.heightAgl !== null ? cam.height - cam.heightAgl : null
    })

    this.handler = new ScreenSpaceEventHandler(scene.canvas)
    this.wireMouse()
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
    this.scene.verticalExaggeration = s.settings.verticalExaggeration
    this.applyMode()
    this.readouts.refresh()
    this.sun.update()
    void this.setKeys(keys)
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
    this.camera.destroy()
    this.sun.destroy()
    this.readouts.destroy()
    this.imagery.destroy()
    this.labels.destroy()
    this.terrainShadows.destroy()
    this.preloader.destroy()
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
    if (changed.ion || this.failed.terrain) {
      this.failed.terrain = false
      dismissBanner('terrain')
      set({ terrainReady: false })
      jobs.push(this.terrain.load(keys.cesiumIonToken).then(() => this.applyMode()))
    }
    await Promise.all(jobs)
  }

  retryProviders(): Promise<void> {
    this.failed = { tiles: true, terrain: true, imagery: true, labels: true }
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
    s.push(
      subscribeJson(
        (st) => st.settings.imagery,
        (type) => void this.imagery.configure(this.keys.googleApiKey, type).then(() => this.applyMode())
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
    this.styler.apply(settings.elevation, mode === 'elevation' && this.terrain.available, autoRange, this.terrainShadows.ready)
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
    this.scene.globe.maximumScreenSpaceError = q.terrainScreenSpaceError
    this.sun.applyQuality(q)
    if (this.scene.msaaSupported) this.scene.msaaSamples = q.msaaSamples
    this.scene.postProcessStages.fxaa.enabled = q.fxaa
    this.widget.useBrowserRecommendedResolution = !quality.devicePixelRatioAware
    this.widget.resolutionScale = q.resolutionScale
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
    // Wait to see whether this is the first half of a double-click.
    if (this.clickTimer !== null) window.clearTimeout(this.clickTimer)
    const p = Cartesian2.clone(position)
    this.clickTimer = window.setTimeout(() => {
      this.clickTimer = null
      const hit = pickSurface(this.scene, p.x, p.y)
      if (hit) void this.inspector.inspect(hit)
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
    this.terrainShadows.setView(this.scene.camera.positionWC, target, appState().camera?.heightAgl ?? null)
    const t = cartographicDeg(target)
    if (t) this.styler.setGeoidOffset(t.latitude, t.longitude)
  }

  private onMoveEnd(): void {
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

  setMode(mode: MapMode): void {
    appState().set({ mode })
    appState().patchSettings((d) => {
      d.lastMode = mode
    })
  }

  currentView(): CameraView {
    return currentView(this.scene)
  }

  bookmarkFromView(name: string, includeTime: boolean): NewBookmark {
    const { mode, sim } = appState()
    return {
      name,
      camera: this.currentView(),
      mode,
      time: includeTime ? { utc: new Date(this.sun.utc).toISOString(), timeZone: sim.timeZone } : undefined
    }
  }

  async flyToBookmark(b: Bookmark): Promise<void> {
    if (b.mode !== appState().mode) this.setMode(b.mode)
    if (b.time) this.sun.setInstant(Date.parse(b.time.utc), b.time.timeZone)
    await this.camera.flyToView(b.camera)
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
    await this.camera.flyToLocation(latitude, longitude, { range, groundHeight })
    await this.searchMarker.refine(marker)
  }

  async goToCoordinates(loc: ParsedLocation, detail = 'Coordinates'): Promise<void> {
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

  startProfile(): void {
    this.inspector.clear()
    this.profile.start()
  }
}
