import type { ImageryType, QualityPreset } from '@shared/types'
import { getEngine } from './engine/instance'
import { saveCurrentView } from './lib/bookmarks'
import { appState } from './store/appStore'

export type CommandGroup = 'View' | 'Navigation' | 'Time & sun' | 'Elevation' | 'Tools' | 'App'

export interface Command {
  id: string
  title: string
  group: CommandGroup
  /** Display form of the shortcut, if any. */
  keys?: string
  keywords?: string
  run: () => void
}

const engine = () => getEngine()

function toggleSetting(fn: (d: ReturnType<typeof appState>['settings']) => void): () => void {
  return () => appState().patchSettings(fn)
}

function setImagery(type: ImageryType): () => void {
  return () =>
    appState().patchSettings((d) => {
      d.imagery = type
    })
}

function setQuality(preset: QualityPreset): () => void {
  return () =>
    appState().patchSettings((d) => {
      d.quality.preset = preset
    })
}

export function getCommands(): Command[] {
  return [
    { id: 'mode-photorealistic', title: 'Photorealistic mode', group: 'View', keys: '1', keywords: '3d tiles google', run: () => engine()?.setMode('photorealistic') },
    { id: 'mode-elevation', title: 'Elevation mode', group: 'View', keys: '2', keywords: 'terrain contours', run: () => engine()?.setMode('elevation') },
    {
      id: 'toggle-place-labels',
      title: 'Show / hide place names',
      group: 'View',
      keys: 'M',
      keywords: 'labels map names cities towns peaks',
      run: toggleSetting((d) => void (d.placeLabels = !d.placeLabels))
    },
    { id: 'toggle-shadows', title: 'Toggle shadows', group: 'Time & sun', run: toggleSetting((d) => void (d.shadows = !d.shadows)) },
    {
      id: 'toggle-lighting',
      title: 'Switch lighting: simulated sun / flat',
      group: 'Time & sun',
      keywords: 'neutral light',
      run: toggleSetting((d) => void (d.lighting = d.lighting === 'sun' ? 'flat' : 'sun'))
    },
    { id: 'toggle-sun-indicator', title: 'Toggle sun direction indicator', group: 'Time & sun', run: toggleSetting((d) => void (d.showSunIndicator = !d.showSunIndicator)) },
    {
      id: 'toggle-detail-shadows',
      title: 'Toggle building & tree shadows',
      group: 'Time & sun',
      keywords: 'detail shadow map near',
      run: toggleSetting((d) => void (d.detailShadows = !d.detailShadows))
    },
    { id: 'toggle-time-panel', title: 'Show / hide time & sun panel', group: 'Time & sun', keys: 'T', run: () => appState().togglePanel('time') },
    { id: 'play-pause', title: 'Play / pause sun animation', group: 'Time & sun', keys: 'Space', run: () => engine()?.sun.togglePlay() },
    { id: 'time-now', title: 'Set time to now', group: 'Time & sun', run: () => engine()?.sun.setNow() },
    { id: 'time-back', title: 'Time −15 min', group: 'Time & sun', keys: '[', run: () => engine()?.sun.nudgeMinutes(-15) },
    { id: 'time-forward', title: 'Time +15 min', group: 'Time & sun', keys: ']', run: () => engine()?.sun.nudgeMinutes(15) },
    { id: 'day-back', title: 'Date −1 day', group: 'Time & sun', keys: 'Shift+[', run: () => engine()?.sun.nudgeDays(-1) },
    { id: 'day-forward', title: 'Date +1 day', group: 'Time & sun', keys: 'Shift+]', run: () => engine()?.sun.nudgeDays(1) },
    { id: 'reset-north', title: 'Reset heading to north', group: 'Navigation', keys: 'N', run: () => void engine()?.camera.resetNorth() },
    { id: 'reset-tilt', title: 'Top-down view', group: 'Navigation', keys: 'U', run: () => void engine()?.camera.resetTilt() },
    { id: 'level-horizon', title: 'Level horizon', group: 'Navigation', keys: 'R', run: () => void engine()?.camera.levelHorizon() },
    { id: 'eye-level', title: 'Eye level at cursor (1.7 m)', group: 'Navigation', keys: 'G', keywords: 'ground standing walk', run: () => void engine()?.camera.goToEyeLevel() },
    { id: 'fly-mode', title: 'Toggle first-person fly mode', group: 'Navigation', keys: 'F', run: () => engine()?.camera.toggleFlyMode() },
    { id: 'zoom-in', title: 'Zoom in', group: 'Navigation', keys: '+', run: () => void engine()?.camera.zoomBy(0.5) },
    { id: 'zoom-out', title: 'Zoom out', group: 'Navigation', keys: '−', run: () => void engine()?.camera.zoomBy(2) },
    { id: 'save-bookmark', title: 'Save bookmark of current view', group: 'Tools', keys: 'Ctrl+B', run: () => void saveCurrentView() },
    { id: 'toggle-bookmarks', title: 'Show / hide bookmarks', group: 'Tools', run: () => appState().togglePanel('bookmarks') },
    { id: 'profile-start', title: 'Draw elevation profile', group: 'Tools', keys: 'P', keywords: 'path chart distance', run: () => engine()?.startProfile() },
    { id: 'profile-clear', title: 'Clear elevation profile', group: 'Tools', run: () => engine()?.profile.clear() },
    { id: 'clear-marker', title: 'Clear inspection marker', group: 'Tools', keys: 'Esc', run: () => engine()?.inspector.clear() },
    { id: 'toggle-elevation-panel', title: 'Show / hide elevation styling', group: 'Elevation', keys: 'L', run: () => appState().togglePanel('elevation') },
    { id: 'toggle-tint', title: 'Toggle hypsometric tint', group: 'Elevation', run: toggleSetting((d) => void (d.elevation.tint.enabled = !d.elevation.tint.enabled)) },
    { id: 'toggle-contours', title: 'Toggle contour lines', group: 'Elevation', run: toggleSetting((d) => void (d.elevation.contours.enabled = !d.elevation.contours.enabled)) },
    { id: 'toggle-slope', title: 'Toggle slope shading', group: 'Elevation', run: toggleSetting((d) => void (d.elevation.slope.enabled = !d.elevation.slope.enabled)) },
    { id: 'toggle-hillshade', title: 'Toggle hillshade', group: 'Elevation', run: toggleSetting((d) => void (d.elevation.hillshade.enabled = !d.elevation.hillshade.enabled)) },
    {
      id: 'toggle-hillshade-sun',
      title: 'Hillshade light: follow sun / classic NW',
      group: 'Elevation',
      run: toggleSetting((d) => void (d.elevation.hillshade.followSun = !d.elevation.hillshade.followSun))
    },
    { id: 'exaggeration-reset', title: 'Reset vertical exaggeration to 1.0×', group: 'Elevation', run: toggleSetting((d) => void (d.verticalExaggeration = 1)) },
    { id: 'imagery-satellite', title: 'Imagery: satellite', group: 'Elevation', run: setImagery('satellite') },
    { id: 'imagery-terrain', title: 'Imagery: terrain map', group: 'Elevation', run: setImagery('terrain') },
    { id: 'imagery-roadmap', title: 'Imagery: road map', group: 'Elevation', run: setImagery('roadmap') },
    { id: 'quality-low', title: 'Quality: Low', group: 'App', run: setQuality('low') },
    { id: 'quality-medium', title: 'Quality: Medium', group: 'App', run: setQuality('medium') },
    { id: 'quality-high', title: 'Quality: High', group: 'App', run: setQuality('high') },
    { id: 'quality-ultra', title: 'Quality: Ultra', group: 'App', run: setQuality('ultra') },
    { id: 'toggle-fps', title: 'Toggle FPS indicator', group: 'App', run: toggleSetting((d) => void (d.quality.showFps = !d.quality.showFps)) },
    { id: 'toggle-units', title: 'Switch units: metric / imperial', group: 'App', run: toggleSetting((d) => void (d.units = d.units === 'metric' ? 'imperial' : 'metric')) },
    { id: 'toggle-coord-format', title: 'Switch coordinates: decimal / DMS', group: 'App', run: toggleSetting((d) => void (d.coordFormat = d.coordFormat === 'decimal' ? 'dms' : 'decimal')) },
    { id: 'toggle-theme', title: 'Switch theme: dark / light', group: 'App', run: toggleSetting((d) => void (d.theme = d.theme === 'dark' ? 'light' : 'dark')) },
    { id: 'open-settings', title: 'Open settings', group: 'App', keys: 'Ctrl+,', keywords: 'api key preferences', run: () => appState().set({ settingsOpen: true }) },
    { id: 'open-shortcuts', title: 'Keyboard shortcuts', group: 'App', keys: '?', run: () => appState().set({ shortcutsOpen: true }) },
    { id: 'retry-providers', title: 'Retry loading map data', group: 'App', run: () => void engine()?.retryProviders() }
  ]
}

export function runCommand(id: string): void {
  getCommands()
    .find((c) => c.id === id)
    ?.run()
}
