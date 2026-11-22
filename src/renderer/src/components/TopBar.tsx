import { isMac, shortcutLabel } from '../lib/platform'
import { useAppStore } from '../store/appStore'
import { Icon } from './Icon'

export function TopBar() {
  const set = useAppStore((s) => s.set)
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
    </div>
  )
}
