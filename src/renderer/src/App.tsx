import { useEffect, useState } from 'react'
import { CommandPalette } from './components/CommandPalette'
import { PartBoundary } from './components/ErrorBoundary'
import { PhotoViewer } from './components/LocationsPanel'
import { Onboarding } from './components/Onboarding'
import { SettingsDialog } from './components/SettingsDialog'
import { ShortcutsOverlay } from './components/ShortcutsOverlay'
import { runCommand } from './commands'
import { getEngine } from './engine/instance'
import { useShortcuts } from './hooks/useShortcuts'
import { saveCurrentView } from './lib/locations'
import { ActivityRail } from './shell/ActivityRail'
import { ModuleViewport } from './shell/ModuleViewport'
import { shellState, useShellStore } from './shell/shellStore'
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
    booted: true
  })
  shellState().set({
    onboardingOpen: !settings.onboardingComplete
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
        const sh = shellState()
        switch (command) {
          case 'open-settings':
            return sh.set({ settingsOpen: true })
          case 'open-palette':
            return sh.set({ paletteOpen: true })
          case 'open-shortcuts':
            return sh.set({ shortcutsOpen: true })
          case 'mode-photorealistic':
            sh.setActiveModule('globe')
            return runCommand('mode-photorealistic')
          case 'mode-map':
            sh.setActiveModule('globe')
            return runCommand('mode-map')
          case 'toggle-fps':
            return runCommand('toggle-fps')
          case 'save-bookmark':
            sh.setActiveModule('globe')
            return void saveCurrentView()
          case 'toggle-bookmarks':
            sh.setActiveModule('globe')
            return s.togglePanel('bookmarks')
          case 'toggle-time-panel':
            sh.setActiveModule('globe')
            return s.togglePanel('time')
          case 'toggle-viewfinder':
            sh.setActiveModule('globe')
            return runCommand('toggle-viewfinder')
        }
      }),
    []
  )
}

export function App() {
  const booted = useAppStore((s) => s.booted)
  const theme = useAppStore((s) => s.settings.theme)
  const modalOpen = useShellStore((s) => s.paletteOpen || s.settingsOpen || s.shortcutsOpen || s.onboardingOpen || !!s.photoViewer)
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
      <div className="workspace-shell">
        <ActivityRail inert={modalOpen} />
        <ModuleViewport booted={booted} modalOpen={modalOpen} />
      </div>
      <PartBoundary name="Command palette" onCrash={() => shellState().set({ paletteOpen: false })}>
        <CommandPalette />
      </PartBoundary>
      <PartBoundary name="Settings" onCrash={() => shellState().set({ settingsOpen: false })}>
        <SettingsDialog />
      </PartBoundary>
      <PartBoundary name="Shortcuts" onCrash={() => shellState().set({ shortcutsOpen: false })}>
        <ShortcutsOverlay />
      </PartBoundary>
      <PartBoundary name="Onboarding" onCrash={() => shellState().set({ onboardingOpen: false })}>
        <Onboarding />
      </PartBoundary>
      <PartBoundary name="Photo viewer" onCrash={() => shellState().set({ photoViewer: null })}>
        <PhotoViewer />
      </PartBoundary>
    </>
  )
}
