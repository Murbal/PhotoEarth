import type { Project } from '@shared/types'
import { Icon } from '../../components/Icon'
import { updateProject } from '../../lib/projects'

/**
 * Forward-compatible Moodboards tab inside a Project Workspace.
 * The underlying `moodboardIds` schema & IPC are already active; Phase 3 plugs the infinite
 * canvas module directly into this view.
 */
export function MoodboardsTab({ project }: { project: Project }) {
  return (
    <div className="proj-moodboards-tab">
      {project.moodboardIds.length > 0 && (
        <div className="proj-surface" style={{ marginBottom: 16 }}>
          <div className="proj-surface-head">
            <div className="proj-surface-title">
              <Icon name="moodboard" size={14} />
              <h3>Linked Moodboards</h3>
              <span className="proj-tab-num">{project.moodboardIds.length}</span>
            </div>
          </div>
          <div className="proj-linked-board-list">
            {project.moodboardIds.map((boardId) => (
              <div key={boardId} className="proj-linked-board-row">
                <Icon name="moodboard" size={15} />
                <span className="mono small grow">{boardId}</span>
                <button
                  type="button"
                  className="btn ghost small"
                  onClick={() =>
                    void updateProject(project.id, {
                      moodboardIds: project.moodboardIds.filter((id) => id !== boardId)
                    })
                  }
                >
                  Unlink
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="proj-empty-tab">
        <div className="proj-empty-icon-sm">
          <Icon name="moodboard" size={22} />
        </div>
        <h3>Moodboards arrive in Phase 3</h3>
        <p className="muted" style={{ maxWidth: 460 }}>
          Infinite 2D visual reference canvases, one-click 3D Viewfinder snapshots, local color palette extraction, and an embedded Inspiration Browser will attach directly to this project.
        </p>
      </div>
    </div>
  )
}
