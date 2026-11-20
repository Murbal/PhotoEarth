import { getEngine } from '../engine/instance'
import { useAppStore } from '../store/appStore'
import { Icon } from './Icon'

export function TopBar() {
  const mode = useAppStore((s) => s.mode)
  const set = useAppStore((s) => s.set)
  const setMode = (m: 'photorealistic' | 'elevation') => getEngine()?.setMode(m)
  return (
    <div className="topbar">
      <button className="panel search-pill" onClick={() => set({ paletteOpen: true })} title="Search (Ctrl+K)">
        <Icon name="search" size={16} />
        <span className="label">Search places, coordinates…</span>
        <span className="kbd">Ctrl K</span>
      </button>
      <div className="panel mode-switch">
        <div className="segmented" role="tablist" aria-label="Map mode">
          <button
            role="tab"
            aria-selected={mode === 'photorealistic'}
            className={mode === 'photorealistic' ? 'active' : ''}
            onClick={() => setMode('photorealistic')}
            title="Photorealistic 3D (1)"
          >
            Photorealistic
          </button>
          <button
            role="tab"
            aria-selected={mode === 'elevation'}
            className={mode === 'elevation' ? 'active' : ''}
            onClick={() => setMode('elevation')}
            title="Elevation (2)"
          >
            Elevation
          </button>
        </div>
      </div>
    </div>
  )
}
