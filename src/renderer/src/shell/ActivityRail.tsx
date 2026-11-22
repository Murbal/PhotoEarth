import { Icon } from '../components/Icon'
import { shortcutLabel } from '../lib/platform'
import { WORKSPACE_MODULES } from './modules'
import { useShellStore } from './shellStore'

export function ActivityRail({ inert }: { inert?: boolean }) {
  const activeModule = useShellStore((s) => s.activeModule)
  const setActiveModule = useShellStore((s) => s.setActiveModule)
  const set = useShellStore((s) => s.set)
  const paletteOpen = useShellStore((s) => s.paletteOpen)
  const shortcutsOpen = useShellStore((s) => s.shortcutsOpen)
  const settingsOpen = useShellStore((s) => s.settingsOpen)

  return (
    <nav className="activity-rail" aria-label="Workspace modules" inert={inert}>
      <div className="activity-rail-group">
        {WORKSPACE_MODULES.map((mod, index) => {
          const active = activeModule === mod.id
          const keys = shortcutLabel(`Mod+${index + 1}`)
          return (
            <button
              key={mod.id}
              type="button"
              className={`activity-btn ${active ? 'active' : ''}`}
              title={`${mod.label} (${keys})`}
              aria-label={mod.label}
              aria-current={active ? 'page' : undefined}
              onClick={() => setActiveModule(mod.id)}
            >
              <Icon name={mod.icon} size={18} />
            </button>
          )
        })}
      </div>

      <div className="activity-rail-spacer" />

      <div className="activity-rail-group">
        <button
          type="button"
          className={`activity-btn ${paletteOpen ? 'active' : ''}`}
          title={`Search & commands (${shortcutLabel('Mod+K')})`}
          aria-label="Search & commands"
          onClick={() => set({ paletteOpen: true })}
        >
          <Icon name="command" size={18} />
        </button>
        <button
          type="button"
          className={`activity-btn ${shortcutsOpen ? 'active' : ''}`}
          title="Controls & shortcuts (?)"
          aria-label="Controls & shortcuts"
          onClick={() => set({ shortcutsOpen: true })}
        >
          <Icon name="help" size={18} />
        </button>
        <button
          type="button"
          className={`activity-btn ${settingsOpen ? 'active' : ''}`}
          title={`Settings (${shortcutLabel('Mod+,')})`}
          aria-label="Settings"
          onClick={() => set({ settingsOpen: true })}
        >
          <Icon name="settings" size={18} />
        </button>
      </div>
    </nav>
  )
}
