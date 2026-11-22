import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { AlignmentPanel } from './components/AlignmentPanel'
import { Banners } from './components/Banners'
import { CommandPalette } from './components/CommandPalette'
import { ElevationPanel } from './components/ElevationPanel'
import { PartBoundary } from './components/ErrorBoundary'
import { HorizonPanel } from './components/HorizonPanel'
import { LocationsPanel, PhotoViewer } from './components/LocationsPanel'
import { MapMode } from './components/MapMode'
import { MapView } from './components/MapView'
import { Onboarding } from './components/Onboarding'
import { Crosshair, FpsIndicator, InspectCard, LoadingBar, StatusChips, Toast } from './components/Overlays'
import { ProfilePanel } from './components/ProfilePanel'
import { RightRail } from './components/RightRail'
import { SettingsDialog } from './components/SettingsDialog'
import { ShortcutsOverlay } from './components/ShortcutsOverlay'
import { StatusBar } from './components/StatusBar'
import { TimePanel } from './components/TimePanel'
import { TopBar } from './components/TopBar'
import { ViewfinderFrame, ViewfinderPanel } from './components/Viewfinder'
import { ViewshedPanel } from './components/ViewshedPanel'
import { runCommand } from './commands'
import { getEngine } from './engine/instance'
import { useForecastFeed } from './hooks/useForecastFeed'
import { useShortcuts } from './hooks/useShortcuts'
import { saveCurrentView } from './lib/locations'
import { appState, useAppStore } from './store/appStore'

async function boot(): Promise<void> {
  const api = window.photoearth
  const [info, settings, keys, secrets, bookmarks, profiles] = await Promise.all([
    api.info(),
    api.settings.get(),
    api.keys.get(),
    api.keys.status(),
    api.bookmarks.list(),
    api.profiles.list()
  ])
  appState().set({
    settings,
    keys,
    secrets,
    bookmarks,
    profiles,
    disable3dTiles: !!info.disable3dTiles,
    mode: settings.lastMode,
    onboardingOpen: !settings.onboardingComplete,
    booted: true
  })
}

function usePersistence(): void {
  useEffect(() => {
    let timer: number | null = null
    const unsubscribe = useAppStore.subscribe(
      (s) => s.settings,
      (settings) => {
        if (timer !== null) window.clearTimeout(timer)
        timer = window.setTimeout(() => void window.photoearth.settings.set(settings), 400)
      }
    )
    const flush = () => {
      const engine = getEngine()
      const settings = structuredClone(appState().settings)
      if (engine) settings.lastCamera = engine.currentView()
      window.photoearth.settings.flush(settings)
    }
    window.addEventListener('beforeunload', flush)
    return () => {
      unsubscribe()
      window.removeEventListener('beforeunload', flush)
    }
  }, [])
}

function useMenuCommands(): void {
  useEffect(
    () =>
      window.photoearth.onMenuCommand((command) => {
        const s = appState()
        switch (command) {
          case 'open-settings':
            return s.set({ settingsOpen: true })
          case 'open-palette':
            return s.set({ paletteOpen: true })
          case 'open-shortcuts':
            return s.set({ shortcutsOpen: true })
          case 'mode-photorealistic':
            return runCommand('mode-photorealistic')
          case 'mode-elevation':
            return runCommand('mode-elevation')
          case 'mode-map':
            return runCommand('mode-map')
          case 'toggle-fps':
            return runCommand('toggle-fps')
          case 'save-bookmark':
            return void saveCurrentView()
          case 'toggle-bookmarks':
            return s.togglePanel('bookmarks')
          case 'toggle-time-panel':
            return s.togglePanel('time')
          case 'toggle-viewfinder':
            return runCommand('toggle-viewfinder')
        }
      }),
    []
  )
}

const EDGE = 70
const SIDE_PANEL = 300
const ALIGN_PANEL = 340
const GAP = 12
/** Right side panels sit left of the 60 px tool rail. */
const RIGHT_PANEL_INSET = 60
const MIN_STACK_WIDTH = 600
const STACK_BOTTOM = 40
const STATUS_CLEARANCE = 44

/**
 * Keeps the bottom stack (profile, time & sun) and the side panels (bookmarks, elevation
 * styling, shot alignment) from covering each other. The stack narrows to the space between
 * open side panels; only when that space is too small does it span the width, and the side
 * panels then end above it instead.
 */
function useOverlayLayout(
  root: RefObject<HTMLDivElement | null>,
  stack: RefObject<HTMLDivElement | null>,
  top: RefObject<HTMLDivElement | null>
): void {
  const left = useAppStore((s) => s.panels.bookmarks)
  const rightElevation = useAppStore((s) => s.panels.elevation)
  const rightAlignment = useAppStore((s) => s.alignment.open)
  useLayoutEffect(() => {
    const rootEl = root.current
    const stackEl = stack.current
    const topEl = top.current
    if (!rootEl || !stackEl) return
    const apply = () => {
      const width = rootEl.clientWidth
      const leftInset = left ? GAP + SIDE_PANEL + GAP : EDGE
      let rightInset = EDGE
      if (rightElevation && rightAlignment) rightInset = RIGHT_PANEL_INSET + SIDE_PANEL + GAP + ALIGN_PANEL + GAP
      else if (rightAlignment) rightInset = RIGHT_PANEL_INSET + ALIGN_PANEL + GAP
      else if (rightElevation) rightInset = RIGHT_PANEL_INSET + SIDE_PANEL + GAP
      const besidePanels = width - leftInset - rightInset >= MIN_STACK_WIDTH
      const style = rootEl.style
      style.setProperty('--stack-left', `${besidePanels ? leftInset : EDGE}px`)
      style.setProperty('--stack-right', `${besidePanels ? rightInset : EDGE}px`)
      // Keep the bottom stack clear of top-center chips and banners (and side panels when they
      // sit above it). Banners grow with their text, so measure them rather than assume a height.
      const sideAbove = !besidePanels && (left || rightElevation || rightAlignment)
      const topBottom = topEl && topEl.offsetHeight > 0 ? topEl.offsetTop + topEl.offsetHeight + GAP : 0
      const topClearance = Math.max(sideAbove ? 60 + 160 + GAP : 112, topBottom)
      style.setProperty('--stack-max-height', `calc(100% - ${topClearance + STACK_BOTTOM}px)`)
      const stackHeight = stackEl.offsetHeight
      style.setProperty('--stack-height', `${stackHeight}px`)
      const clearance = !besidePanels && stackHeight > 0 ? STACK_BOTTOM + stackHeight + GAP : STATUS_CLEARANCE
      style.setProperty('--side-bottom', `${clearance}px`)
    }
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(rootEl)
    observer.observe(stackEl)
    if (topEl) observer.observe(topEl)
    return () => observer.disconnect()
  }, [root, stack, top, left, rightElevation, rightAlignment])
}

export function App() {
  const booted = useAppStore((s) => s.booted)
  const theme = useAppStore((s) => s.settings.theme)
  const modalOpen = useAppStore((s) => s.paletteOpen || s.settingsOpen || s.shortcutsOpen || s.onboardingOpen || !!s.photoViewer)
  const mapOpen = useAppStore((s) => s.settings.map.open)
  const overlayRef = useRef<HTMLDivElement>(null)
  const stackRef = useRef<HTMLDivElement>(null)
  const topRef = useRef<HTMLDivElement>(null)
  const [creditEl, setCreditEl] = useState<HTMLDivElement | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)

  useEffect(() => {
    boot().catch((err) => setBootError(String(err)))
  }, [])
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  usePersistence()
  useMenuCommands()
  useShortcuts()
  useForecastFeed()
  useOverlayLayout(overlayRef, stackRef, topRef)

  if (bootError) {
    return (
      <div className="scrim center">
        <div className="panel onboarding">
          <h1>PhotoEarth couldn’t start</h1>
          <p className="mono">{bootError}</p>
        </div>
      </div>
    )
  }

  return (
    <>
      {booted && <MapView creditContainer={creditEl} inert={modalOpen || mapOpen} />}
      {booted && <PartBoundary name="Map mode"><MapMode /></PartBoundary>}
      {/* While a dialog is open, everything behind it is inert: no focus, no clicks. 3D-only
          overlays are hidden in Map mode (styles: .overlay-root[data-map]). */}
      <div ref={overlayRef} className="overlay-root" inert={modalOpen} data-map={mapOpen ? '' : undefined}>
        <PartBoundary name="Viewfinder frame"><ViewfinderFrame /></PartBoundary>
        <PartBoundary name="Loading bar"><LoadingBar /></PartBoundary>
        <PartBoundary name="Top bar"><TopBar /></PartBoundary>
        <div ref={topRef} className="top-center">
          <PartBoundary name="Status chips"><StatusChips /></PartBoundary>
          <PartBoundary name="Banners"><Banners /></PartBoundary>
        </div>
        <PartBoundary name="Tool rail"><RightRail /></PartBoundary>
        <PartBoundary name="Saved locations"><LocationsPanel /></PartBoundary>
        <PartBoundary name="Elevation panel"><ElevationPanel /></PartBoundary>
        <PartBoundary name="Shot alignment"><AlignmentPanel /></PartBoundary>
        <PartBoundary name="Inspect card"><InspectCard /></PartBoundary>
        <PartBoundary name="Crosshair"><Crosshair /></PartBoundary>
        <div ref={stackRef} className="bottom-stack">
          <PartBoundary name="Elevation profile"><ProfilePanel /></PartBoundary>
          <PartBoundary name="Horizon panorama"><HorizonPanel /></PartBoundary>
          <PartBoundary name="Viewshed analysis"><ViewshedPanel /></PartBoundary>
          <PartBoundary name="Viewfinder"><ViewfinderPanel /></PartBoundary>
          <PartBoundary name="Time panel"><TimePanel /></PartBoundary>
        </div>
        <PartBoundary name="Frame rate"><FpsIndicator /></PartBoundary>
        <PartBoundary name="Toast"><Toast /></PartBoundary>
        <PartBoundary name="Status bar"><StatusBar creditRef={setCreditEl} /></PartBoundary>
      </div>
      <PartBoundary name="Command palette" onCrash={() => appState().set({ paletteOpen: false })}>
        <CommandPalette />
      </PartBoundary>
      <PartBoundary name="Settings" onCrash={() => appState().set({ settingsOpen: false })}>
        <SettingsDialog />
      </PartBoundary>
      <PartBoundary name="Shortcuts" onCrash={() => appState().set({ shortcutsOpen: false })}>
        <ShortcutsOverlay />
      </PartBoundary>
      <PartBoundary name="Onboarding" onCrash={() => appState().set({ onboardingOpen: false })}>
        <Onboarding />
      </PartBoundary>
      <PartBoundary name="Photo viewer" onCrash={() => appState().set({ photoViewer: null })}>
        <PhotoViewer />
      </PartBoundary>
    </>
  )
}
