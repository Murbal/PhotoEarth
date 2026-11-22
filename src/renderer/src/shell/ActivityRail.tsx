import { useEffect, useRef, useState } from 'react'
import { PROJECT_STATUS_LABELS } from '@shared/projects'
import { Icon } from '../components/Icon'
import { openProjectInGlobe, openProjectWorkspace, setActiveProject } from '../lib/projects'
import { shortcutLabel } from '../lib/platform'
import { useProjectsStore } from '../store/projectsStore'
import { WORKSPACE_MODULES } from './modules'
import { useShellStore } from './shellStore'

function initials(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return 'P'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

export function ActivityRail({ inert }: { inert?: boolean }) {
  const activeModule = useShellStore((s) => s.activeModule)
  const setActiveModule = useShellStore((s) => s.setActiveModule)
  const set = useShellStore((s) => s.set)
  const paletteOpen = useShellStore((s) => s.paletteOpen)
  const shortcutsOpen = useShellStore((s) => s.shortcutsOpen)
  const settingsOpen = useShellStore((s) => s.settingsOpen)
  const activeProjectId = useShellStore((s) => s.activeProjectId)
  const projects = useProjectsStore((s) => s.projects)
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const switcherRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!switcherOpen) return
    const onPointerDown = (e: PointerEvent) => {
      if (switcherRef.current && !switcherRef.current.contains(e.target as Node)) {
        setSwitcherOpen(false)
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSwitcherOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [switcherOpen])

  const activeProjects = projects.filter((p) => p.status !== 'archived')

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

      <div className="activity-rail-divider" aria-hidden="true" />

      {/* Active Project indicator + quick switcher popover */}
      <div className="activity-project-slot" ref={switcherRef}>
        <button
          type="button"
          className={`activity-project-pill ${activeProject ? 'has-project' : ''} ${switcherOpen ? 'open' : ''}`}
          title={activeProject ? `Active project: ${activeProject.title} — click to switch` : 'Set active project context'}
          aria-label={activeProject ? `Active project: ${activeProject.title}` : 'Set active project context'}
          aria-expanded={switcherOpen}
          aria-haspopup="dialog"
          onClick={() => setSwitcherOpen((o) => !o)}
          style={
            activeProject?.concept.colorStory[0]
              ? { borderColor: activeProject.concept.colorStory[0] }
              : undefined
          }
        >
          {activeProject ? (
            <span className="activity-project-monogram">{initials(activeProject.title)}</span>
          ) : (
            <Icon name="star" size={16} />
          )}
        </button>

        {switcherOpen && (
          <div className="panel activity-project-popover" role="dialog" aria-label="Active project switcher">
            <div className="activity-popover-header">
              <span>Active project</span>
              {activeProject && (
                <button
                  type="button"
                  className="link-btn small"
                  onClick={() => {
                    setActiveProject(null)
                    setSwitcherOpen(false)
                  }}
                >
                  Clear
                </button>
              )}
            </div>

            {activeProject && (
              <div className="activity-popover-current">
                <div className="activity-popover-current-title">{activeProject.title}</div>
                <div className="small faint">
                  {PROJECT_STATUS_LABELS[activeProject.status]} · {activeProject.locationIds.length}{' '}
                  {activeProject.locationIds.length === 1 ? 'spot' : 'spots'}
                </div>
                <div className="row" style={{ marginTop: 6 }}>
                  <button
                    type="button"
                    className="btn grow"
                    onClick={() => {
                      openProjectWorkspace(activeProject.id)
                      setSwitcherOpen(false)
                    }}
                  >
                    Workspace
                  </button>
                  <button
                    type="button"
                    className="btn grow"
                    onClick={() => {
                      void openProjectInGlobe(activeProject)
                      setSwitcherOpen(false)
                    }}
                  >
                    Open in Globe
                  </button>
                </div>
              </div>
            )}

            <div className="activity-popover-list">
              {activeProjects.length === 0 ? (
                <div className="small muted" style={{ padding: '6px 8px' }}>
                  No projects yet.
                </div>
              ) : (
                activeProjects.map((p) => {
                  const isCurrent = p.id === activeProjectId
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={`activity-popover-item ${isCurrent ? 'active' : ''}`}
                      onClick={() => {
                        setActiveProject(p.id)
                        setSwitcherOpen(false)
                      }}
                    >
                      <span
                        className="activity-popover-dot"
                        style={{ background: p.concept.colorStory[0] ?? 'var(--accent)' }}
                      />
                      <span className="activity-popover-name">{p.title}</span>
                      <span className="small faint">{p.locationIds.length}</span>
                    </button>
                  )
                })
              )}
            </div>

            <div className="activity-popover-footer">
              <button
                type="button"
                className="btn ghost grow"
                onClick={() => {
                  useProjectsStore.getState().set({ createDialogOpen: true })
                  setActiveModule('projects')
                  setSwitcherOpen(false)
                }}
              >
                <Icon name="plus" size={14} /> New project
              </button>
            </div>
          </div>
        )}
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
