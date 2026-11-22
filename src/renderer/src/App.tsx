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
import { moodboardState, useMoodboardStore } from './store/moodboardStore'
import { projectsState } from './store/projectsStore'

async function boot(): Promise<void> {
  const api = window.photoearth
  const [info, settings, keys, secrets, bookmarks, profiles, projects, moodboards] = await Promise.all([
    api.info(),
    api.settings.get(),
    api.keys.get(),
    api.keys.status(),
    api.bookmarks.list(),
    api.profiles.list(),
    api.projects.list(),
    api.moodboards.list()
  ])
  projectsState().set({ projects })
  moodboardState().set({ summaries: moodboards })
  const restoredProjectId =
    settings.lastProjectId && projects.some((p) => p.id === settings.lastProjectId) ? settings.lastProjectId : null
  const restoredMoodboardId =
    settings.lastMoodboardId && moodboards.some((b) => b.id === settings.lastMoodboardId) ? settings.lastMoodboardId : null
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
    activeProjectId: restoredProjectId,
    activeMoodboardId: restoredMoodboardId,
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
      moodboardState().flushSaveSync()
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
          case 'open-projects':
            return sh.setActiveModule('projects')
          case 'open-moodboards':
            return sh.setActiveModule('moodboard')
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
  const activeModule = useShellStore((s) => s.activeModule)
  const modalOpen = useShellStore((s) => s.paletteOpen || s.settingsOpen || s.shortcutsOpen || s.onboardingOpen || !!s.photoViewer)
  const presentationMode = useMoodboardStore((s) => s.presentationMode && !!s.activeBoard)
  const hideRail = activeModule === 'moodboard' && presentationMode
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
        {!hideRail && <ActivityRail inert={modalOpen} />}
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
