import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { BookmarksPanel } from './components/BookmarksPanel'
import { Banners } from './components/Banners'
import { CommandPalette } from './components/CommandPalette'
import { ElevationPanel } from './components/ElevationPanel'
import { HorizonPanel } from './components/HorizonPanel'
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
import { runCommand } from './commands'
import { getEngine } from './engine/instance'
import { useForecastFeed } from './hooks/useForecastFeed'
import { useShortcuts } from './hooks/useShortcuts'
import { saveCurrentView } from './lib/bookmarks'
import { appState, useAppStore } from './store/appStore'

async function boot(): Promise<void> {
  const api = window.photoearth
  const [settings, keys, secrets, bookmarks] = await Promise.all([
    api.settings.get(),
    api.keys.get(),
    api.keys.status(),
    api.bookmarks.list()
  ])
  appState().set({
    settings,
    keys,
    secrets,
    bookmarks,
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
const GAP = 12
/** Right side panels sit left of the 60 px tool rail. */
const RIGHT_PANEL_INSET = 60
const MIN_STACK_WIDTH = 600
const STACK_BOTTOM = 40
const STATUS_CLEARANCE = 44

/**
 * Keeps the bottom stack (profile, time & sun) and the side panels (bookmarks, elevation
 * styling) from covering each other. The stack narrows to the space between open side
 * panels; only when that space is too small does it span the width, and the side panels
 * then end above it instead.
 */
function useOverlayLayout(root: RefObject<HTMLDivElement | null>, stack: RefObject<HTMLDivElement | null>): void {
  const left = useAppStore((s) => s.panels.bookmarks)
  const right = useAppStore((s) => s.panels.elevation)
  useLayoutEffect(() => {
    const rootEl = root.current
    const stackEl = stack.current
    if (!rootEl || !stackEl) return
    const apply = () => {
      const width = rootEl.clientWidth
      const leftInset = left ? GAP + SIDE_PANEL + GAP : EDGE
      const rightInset = right ? RIGHT_PANEL_INSET + SIDE_PANEL + GAP : EDGE
      const besidePanels = width - leftInset - rightInset >= MIN_STACK_WIDTH
      const stackHeight = stackEl.offsetHeight
      const style = rootEl.style
      style.setProperty('--stack-left', `${besidePanels ? leftInset : EDGE}px`)
      style.setProperty('--stack-right', `${besidePanels ? rightInset : EDGE}px`)
      style.setProperty('--stack-height', `${stackHeight}px`)
      const clearance = !besidePanels && stackHeight > 0 ? STACK_BOTTOM + stackHeight + GAP : STATUS_CLEARANCE
      style.setProperty('--side-bottom', `${clearance}px`)
    }
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(rootEl)
    observer.observe(stackEl)
    return () => observer.disconnect()
  }, [root, stack, left, right])
}

export function App() {
  const booted = useAppStore((s) => s.booted)
  const theme = useAppStore((s) => s.settings.theme)
  const modalOpen = useAppStore((s) => s.paletteOpen || s.settingsOpen || s.shortcutsOpen || s.onboardingOpen)
  const overlayRef = useRef<HTMLDivElement>(null)
  const stackRef = useRef<HTMLDivElement>(null)
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
  useOverlayLayout(overlayRef, stackRef)

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
      {booted && <MapView creditContainer={creditEl} inert={modalOpen} />}
      {/* While a dialog is open, everything behind it is inert: no focus, no clicks. */}
      <div ref={overlayRef} className="overlay-root" inert={modalOpen}>
        <ViewfinderFrame />
        <LoadingBar />
        <TopBar />
        <div className="top-center">
          <StatusChips />
          <Banners />
        </div>
        <RightRail />
        <BookmarksPanel />
        <ElevationPanel />
        <InspectCard />
        <Crosshair />
        <div ref={stackRef} className="bottom-stack">
          <ProfilePanel />
          <HorizonPanel />
          <ViewfinderPanel />
          <TimePanel />
        </div>
        <FpsIndicator />
        <Toast />
        <StatusBar creditRef={setCreditEl} />
      </div>
      <CommandPalette />
      <SettingsDialog />
      <ShortcutsOverlay />
      <Onboarding />
    </>
  )
}
