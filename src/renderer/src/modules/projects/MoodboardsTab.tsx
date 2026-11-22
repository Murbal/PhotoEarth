import { useMemo, useRef, useState } from 'react'
import type { MoodboardSummary, Project } from '@shared/types'
import { Icon } from '../../components/Icon'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import {
  createMoodboard,
  linkMoodboardToProject,
  openMoodboard,
  unlinkMoodboardFromProject
} from '../../lib/moodboards'
import { useMoodboardStore } from '../../store/moodboardStore'
import { MoodboardCollage } from '../moodboard/MoodboardIndex'

/**
 * Moodboards tab inside a Project Workspace.
 * Displays all linked moodboards with 2×2 preview collages, item counts, quick open,
 * and actions to create a new linked board or attach an existing one.
 */
export function MoodboardsTab({ project }: { project: Project }) {
  const summaries = useMoodboardStore((s) => s.summaries)
  const [linkDialogOpen, setLinkDialogOpen] = useState(false)

  const summaryById = useMemo(() => new Map(summaries.map((b) => [b.id, b])), [summaries])
  const linkedBoards = useMemo(() => {
    const out: MoodboardSummary[] = []
    const seen = new Set<string>()
    for (const id of project.moodboardIds) {
      const b = summaryById.get(id)
      if (b && !seen.has(b.id)) {
        seen.add(b.id)
        out.push(b)
      }
    }
    for (const b of summaries) {
      if (b.projectId === project.id && !seen.has(b.id)) {
        seen.add(b.id)
        out.push(b)
      }
    }
    return out
  }, [project.id, project.moodboardIds, summaries, summaryById])

  const linkedIds = useMemo(() => new Set(linkedBoards.map((b) => b.id)), [linkedBoards])
  const unlinkedBoards = useMemo(() => summaries.filter((b) => !linkedIds.has(b.id)), [summaries, linkedIds])

  const handleNewBoard = () => {
    void createMoodboard({
      title: `${project.title} — Moodboard`,
      projectId: project.id,
      template: 'blank'
    })
  }

  return (
    <div className="proj-moodboards-tab">
      <div className="proj-tab-toolbar" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <div className="small muted">
          {linkedBoards.length} linked {linkedBoards.length === 1 ? 'moodboard' : 'moodboards'}
        </div>
        <span className="spacer" />
        <button
          type="button"
          className="btn"
          disabled={unlinkedBoards.length === 0}
          onClick={() => setLinkDialogOpen(true)}
        >
          <Icon name="link" size={14} /> Link Existing Board
        </button>
        <button type="button" className="btn primary" onClick={handleNewBoard}>
          <Icon name="plus" size={14} /> New Moodboard
        </button>
      </div>

      {linkedBoards.length === 0 ? (
        <div className="proj-empty-tab">
          <div className="proj-empty-icon-sm">
            <Icon name="moodboard" size={22} />
          </div>
          <h3>No moodboards linked yet</h3>
          <p className="muted" style={{ maxWidth: 460 }}>
            Create an infinite 2D canvas for lighting references, 3D Viewfinder snapshots, and color palettes —
            automatically linked to this project.
          </p>
          <div className="row" style={{ marginTop: 10 }}>
            <button type="button" className="btn primary" onClick={handleNewBoard}>
              <Icon name="plus" size={14} /> New Moodboard
            </button>
            {unlinkedBoards.length > 0 && (
              <button type="button" className="btn" onClick={() => setLinkDialogOpen(true)}>
                <Icon name="link" size={14} /> Link Existing
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="mb-boards-grid">
          {linkedBoards.map((board) => (
            <article
              key={board.id}
              className="mb-board-card"
              role="button"
              tabIndex={0}
              onClick={() => void openMoodboard(board.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  void openMoodboard(board.id)
                }
              }}
            >
              <div className="mb-board-cover">
                <MoodboardCollage previewFiles={board.previewFiles} />
                <div className="mb-board-quick" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="proj-quick-btn"
                    title="Unlink from project"
                    aria-label={`Unlink ${board.title}`}
                    onClick={() => void unlinkMoodboardFromProject(project.id, board.id)}
                  >
                    <Icon name="unlink" size={13} />
                  </button>
                </div>
              </div>
              <div className="mb-board-body">
                <h2 className="mb-board-title">{board.title}</h2>
                <div className="mb-board-meta">
                  <span className="small faint">
                    {board.itemCount} {board.itemCount === 1 ? 'item' : 'items'}
                  </span>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {linkDialogOpen && (
        <LinkMoodboardsDialog
          project={project}
          candidates={unlinkedBoards}
          onClose={() => setLinkDialogOpen(false)}
        />
      )}
    </div>
  )
}

function LinkMoodboardsDialog({
  project,
  candidates,
  onClose
}: {
  project: Project
  candidates: MoodboardSummary[]
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return candidates
    return candidates.filter((b) => b.title.toLowerCase().includes(q))
  }, [candidates, query])

  return (
    <div className="scrim center" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="panel dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Link Existing Moodboard"
        style={{ width: 'min(460px, calc(100% - 32px))' }}
      >
        <div className="dialog-header">
          <h2>Link Existing Moodboard</h2>
          <button type="button" className="icon-btn small" title="Close" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <input
            autoFocus
            className="input"
            placeholder="Search moodboards…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="mb-loc-picker-list scroll">
            {filtered.length === 0 ? (
              <div className="muted small" style={{ padding: 14, textAlign: 'center' }}>
                No available moodboards to link.
              </div>
            ) : (
              filtered.map((board) => (
                <button
                  key={board.id}
                  type="button"
                  className="mb-loc-picker-row"
                  onClick={() => {
                    void linkMoodboardToProject(project.id, board.id)
                    onClose()
                  }}
                >
                  <Icon name="moodboard" size={15} />
                  <div className="mb-loc-picker-info">
                    <div className="truncate" style={{ fontWeight: 500 }}>{board.title}</div>
                    <div className="small faint">
                      {board.itemCount} {board.itemCount === 1 ? 'item' : 'items'}
                    </div>
                  </div>
                  <Icon name="plus" size={14} />
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
