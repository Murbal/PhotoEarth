import type { ImageryType, MapMode } from '@shared/types'
import { getEngine } from '../engine/instance'
import { isMac, shortcutLabel } from '../lib/platform'
import { useAppStore } from '../store/appStore'
import { Icon } from './Icon'

const MODES: Array<{ id: MapMode | 'map'; label: string; title: string }> = [
  { id: 'photorealistic', label: 'Photorealistic', title: 'Photorealistic 3D (1)' },
  { id: 'elevation', label: 'Elevation', title: 'Elevation (2)' },
  { id: 'map', label: 'Map', title: '2D map for getting around (3)' }
]

const MAP_TYPES: Array<{ id: ImageryType; label: string }> = [
  { id: 'roadmap', label: 'Road' },
  { id: 'satellite', label: 'Satellite' },
  { id: 'terrain', label: 'Terrain' }
]

export function TopBar() {
  const mode = useAppStore((s) => (s.settings.map.open ? 'map' : s.mode))
  const mapType = useAppStore((s) => s.settings.map.type)
  const set = useAppStore((s) => s.set)
  const patchSettings = useAppStore((s) => s.patchSettings)
  return (
    <div className="topbar">
      <button
        className="panel search-pill"
        onClick={() => set({ paletteOpen: true })}
        title={`Search (${shortcutLabel('Mod+K')})`}
        aria-keyshortcuts={isMac ? 'Meta+K' : 'Control+K'}
      >
        <Icon name="search" size={16} />
        <span className="label">Search places, coordinates…</span>
        <span className="kbd">{shortcutLabel('Mod+K')}</span>
      </button>
      <div className="panel mode-switch">
        <div className="segmented" role="tablist" aria-label="Map mode">
          {MODES.map((m) => (
            <button
              key={m.id}
              role="tab"
              aria-selected={mode === m.id}
              className={mode === m.id ? 'active' : ''}
              onClick={() => void getEngine()?.setMode(m.id)}
              title={m.title}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>
      {mode === 'map' && (
        <div className="panel mode-switch">
          <div className="segmented" role="radiogroup" aria-label="Map type">
            {MAP_TYPES.map((t) => (
              <button
                key={t.id}
                role="radio"
                aria-checked={mapType === t.id}
                className={mapType === t.id ? 'active' : ''}
                onClick={() => patchSettings((d) => void (d.map.type = t.id))}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
