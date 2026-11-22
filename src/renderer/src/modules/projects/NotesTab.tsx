import { useMemo, useState } from 'react'
import { MAX_NOTE_BODY, MAX_NOTE_TITLE } from '@shared/projects'
import type { Project, ProjectNote } from '@shared/types'
import { Icon } from '../../components/Icon'
import { addProjectNote, deleteProjectNote, updateProjectNote } from '../../lib/projects'
import { useProjectsStore } from '../../store/projectsStore'
import { MarkdownPreview, toggleMarkdownCheckbox } from './markdown'
import { ProjectDraftField } from './projectHelpers'

function formatUpdated(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function NotesTab({ project }: { project: Project }) {
  const selectedNoteId = useProjectsStore((s) => s.selectedNoteId)
  const setProjectsState = useProjectsStore((s) => s.set)
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const [confirmDelete, setConfirmDelete] = useState(false)

  const sortedNotes = useMemo(
    () =>
      [...project.notes].sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        return b.updatedAt.localeCompare(a.updatedAt)
      }),
    [project.notes]
  )

  const activeNote: ProjectNote | null =
    sortedNotes.find((n) => n.id === selectedNoteId) ?? sortedNotes[0] ?? null

  const createNote = async () => {
    setConfirmDelete(false)
    setMode('edit')
    await addProjectNote(project.id, { title: 'Untitled note', body: '' })
  }

  return (
    <div className="proj-notes-shell">
      <aside className="proj-notes-sidebar">
        <div className="proj-notes-sidebar-head">
          <span className="proj-brief-label">Notes ({project.notes.length})</span>
          <button type="button" className="btn small" onClick={() => void createNote()}>
            <Icon name="plus" size={13} /> New
          </button>
        </div>

        <div className="proj-notes-list scroll">
          {sortedNotes.length === 0 ? (
            <div className="muted small" style={{ padding: '14px 10px', lineHeight: 1.5 }}>
              Capture shot variations, permits, parking notes, or post-shoot reflections.
            </div>
          ) : (
            sortedNotes.map((note) => {
              const selected = activeNote?.id === note.id
              return (
                <button
                  key={note.id}
                  type="button"
                  className={`proj-note-row ${selected ? 'active' : ''}`}
                  onClick={() => {
                    setConfirmDelete(false)
                    setProjectsState({ selectedNoteId: note.id })
                  }}
                >
                  <div className="proj-note-row-top">
                    {note.pinned && <Icon name="thumbtack" size={11} style={{ color: 'var(--accent)', flex: 'none' }} />}
                    <span className="proj-note-row-title">{note.title}</span>
                    <span className="small faint">{formatUpdated(note.updatedAt)}</span>
                  </div>
                  <div className="proj-note-row-excerpt small faint">
                    {note.body.trim().replace(/\s+/g, ' ').slice(0, 90) || 'Empty note'}
                  </div>
                </button>
              )
            })
          )}
        </div>
      </aside>

      <div className="proj-note-editor-pane">
        {!activeNote ? (
          <div className="proj-empty-tab proj-notes-empty">
            <div className="proj-empty-icon-sm">
              <Icon name="note" size={20} />
            </div>
            <h3>Start a scratchpad note</h3>
            <p className="muted">Keep travel logistics, lighting ideas, and Markdown checklists alongside your spots.</p>
            <button type="button" className="btn primary proj-cta" onClick={() => void createNote()}>
              <Icon name="plus" size={14} /> New note
            </button>
          </div>
        ) : (
          <div key={activeNote.id} className="proj-note-editor-inner">
            <div className="proj-note-editor-bar">
              <ProjectDraftField
                aria-label="Note title"
                className="proj-note-title-input"
                maxLength={MAX_NOTE_TITLE}
                placeholder="Note title"
                value={activeNote.title}
                onCommit={(title) => void updateProjectNote(project.id, activeNote.id, { title })}
              />

              <div className="proj-note-toolbar-actions">
                <button
                  type="button"
                  className={`btn ghost small ${activeNote.pinned ? 'active-pill' : ''}`}
                  title={activeNote.pinned ? 'Unpin from Overview' : 'Pin to Overview'}
                  aria-pressed={activeNote.pinned}
                  onClick={() => void updateProjectNote(project.id, activeNote.id, { pinned: !activeNote.pinned })}
                >
                  <Icon name="thumbtack" size={13} /> {activeNote.pinned ? 'Pinned' : 'Pin'}
                </button>

                <div className="segmented" role="group" aria-label="Note view mode">
                  <button
                    type="button"
                    className={mode === 'edit' ? 'active' : ''}
                    aria-pressed={mode === 'edit'}
                    onClick={() => setMode('edit')}
                  >
                    Write
                  </button>
                  <button
                    type="button"
                    className={mode === 'preview' ? 'active' : ''}
                    aria-pressed={mode === 'preview'}
                    onClick={() => setMode('preview')}
                  >
                    Preview
                  </button>
                </div>

                {confirmDelete ? (
                  <div className="row" style={{ gap: 4 }}>
                    <button
                      type="button"
                      className="btn danger small"
                      onClick={() => {
                        setConfirmDelete(false)
                        void deleteProjectNote(project.id, activeNote.id)
                      }}
                    >
                      Delete
                    </button>
                    <button type="button" className="btn ghost small" onClick={() => setConfirmDelete(false)}>
                      Keep
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="icon-btn small"
                    title="Delete note"
                    aria-label="Delete note"
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                )}
              </div>
            </div>

            {mode === 'edit' ? (
              <ProjectDraftField
                aria-label="Note body (Markdown)"
                className="proj-note-body-textarea"
                multiline
                rows={16}
                maxLength={MAX_NOTE_BODY}
                placeholder="Write Markdown notes: # Headings, **bold**, - bullet lists, - [ ] checklists…"
                value={activeNote.body}
                onCommit={(body) => void updateProjectNote(project.id, activeNote.id, { body })}
              />
            ) : (
              <div className="proj-note-preview-scroll scroll">
                <MarkdownPreview
                  body={activeNote.body}
                  onToggleCheckbox={(lineIndex, checked) => {
                    const nextBody = toggleMarkdownCheckbox(activeNote.body, lineIndex, checked)
                    void updateProjectNote(project.id, activeNote.id, { body: nextBody })
                  }}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
