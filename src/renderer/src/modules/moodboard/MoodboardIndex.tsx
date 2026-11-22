import { useEffect, useMemo, useRef, useState } from 'react'
import { photoUrl } from '@shared/locations'
import {
  filterAndSortMoodboards,
  MAX_BOARD_TITLE,
  MOODBOARD_TEMPLATES,
  type MoodboardSort
} from '@shared/moodboards'
import type { MoodboardSummary, MoodboardTemplateId } from '@shared/types'
import { Icon } from '../../components/Icon'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { createMoodboard, deleteMoodboard, openMoodboard } from '../../lib/moodboards'
import { useShellStore } from '../../shell/shellStore'
import { useMoodboardStore } from '../../store/moodboardStore'
import { useProjectsStore } from '../../store/projectsStore'

const SORT_OPTIONS: Array<{ id: MoodboardSort; label: string }> = [
  { id: 'updated', label: 'Recently updated' },
  { id: 'name', label: 'Name' },
  { id: 'items', label: 'Most items' }
]

function formatRelativeDate(iso: string): string {
  const diffMs = Date.now() - Date.parse(iso)
  if (!Number.isFinite(diffMs) || diffMs < 60_000) return 'Just now'
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 14) return `${days}d ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function MoodboardIndex() {
  const summaries = useMoodboardStore((s) => s.summaries)
  const search = useMoodboardStore((s) => s.search)
  const projectFilter = useMoodboardStore((s) => s.projectFilter)
  const sort = useMoodboardStore((s) => s.sort)
  const focusSearchNonce = useMoodboardStore((s) => s.focusSearchNonce)
  const set = useMoodboardStore((s) => s.set)
  const projects = useProjectsStore((s) => s.projects)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (focusSearchNonce > 0) {
      searchRef.current?.focus()
      searchRef.current?.select()
    }
  }, [focusSearchNonce])

  const projectNamesById = useMemo(() => new Map(projects.map((p) => [p.id, p.title])), [projects])
  const selectedProjectBoardIds = useMemo(() => {
    if (projectFilter === 'all') return undefined
    const proj = projects.find((p) => p.id === projectFilter)
    return proj ? new Set(proj.moodboardIds) : undefined
  }, [projects, projectFilter])

  const visible = useMemo(
    () =>
      filterAndSortMoodboards(
        summaries,
        { query: search, projectId: projectFilter, sort },
        projectNamesById,
        selectedProjectBoardIds
      ),
    [summaries, search, projectFilter, sort, projectNamesById, selectedProjectBoardIds]
  )

  const hasFilters = projectFilter !== 'all' || search.trim().length > 0

  return (
    <div className="mb-index-page">
      <header className="projects-header">
        <div className="projects-container">
          <div className="projects-header-top">
            <div className="projects-title-wrap">
              <div className="projects-eyebrow">Visual Canvas</div>
              <div className="projects-title-row">
                <h1 className="projects-title">Moodboards</h1>
                {summaries.length > 0 && <span className="projects-count-pill">{summaries.length}</span>}
              </div>
            </div>

            <div className="projects-header-actions">
              <div className="proj-search-wrap">
                <Icon name="search" size={14} />
                <input
                  ref={searchRef}
                  className="proj-search-input"
                  type="search"
                  aria-label="Filter moodboards"
                  placeholder="Search moodboards or projects…"
                  value={search}
                  onChange={(e) => set({ search: e.target.value })}
                />
                {search ? (
                  <button
                    type="button"
                    className="proj-search-clear"
                    aria-label="Clear search"
                    onClick={() => set({ search: '' })}
                  >
                    <Icon name="close" size={12} />
                  </button>
                ) : (
                  <span className="proj-kbd-hint" aria-hidden="true">/</span>
                )}
              </div>

              {projects.length > 0 && (
                <div className="proj-select-pill">
                  <select
                    className="proj-sort-select"
                    aria-label="Filter by project"
                    value={projectFilter}
                    onChange={(e) => set({ projectFilter: e.target.value })}
                  >
                    <option value="all">All projects</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title}
                      </option>
                    ))}
                  </select>
                  <Icon name="chevronDown" size={13} />
                </div>
              )}

              <div className="proj-select-pill">
                <select
                  className="proj-sort-select"
                  aria-label="Sort moodboards"
                  value={sort}
                  onChange={(e) => set({ sort: e.target.value as MoodboardSort })}
                >
                  {SORT_OPTIONS.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <Icon name="chevronDown" size={13} />
              </div>

              <button
                type="button"
                className="btn primary proj-cta"
                onClick={() => set({ createDialogOpen: true })}
                title="New moodboard (N)"
              >
                <Icon name="plus" size={15} />
                <span>New Moodboard</span>
                <span className="proj-cta-kbd" aria-hidden="true">N</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="projects-content scroll">
        <div className="projects-container">
          {summaries.length === 0 ? (
            <MoodboardEmptyState />
          ) : visible.length === 0 ? (
            <div className="proj-empty-filtered">
              <div className="proj-empty-icon-sm">
                <Icon name="search" size={20} />
              </div>
              <h3>No matching moodboards</h3>
              <p className="muted">Try adjusting your search or project filter.</p>
              {hasFilters && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => set({ projectFilter: 'all', search: '' })}
                >
                  Reset filters
                </button>
              )}
            </div>
          ) : (
            <div className="mb-boards-grid">
              {visible.map((board) => (
                <MoodboardSummaryCard
                  key={board.id}
                  board={board}
                  projectTitle={board.projectId ? projectNamesById.get(board.projectId) ?? null : null}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function MoodboardCollage({ previewFiles }: { previewFiles: string[] }) {
  if (previewFiles.length === 0) {
    return (
      <div className="mb-collage-empty">
        <div className="mb-collage-dots" aria-hidden="true" />
        <Icon name="moodboard" size={24} style={{ opacity: 0.45 }} />
      </div>
    )
  }
  const count = Math.min(4, previewFiles.length)
  return (
    <div className={`mb-collage count-${count}`}>
      {previewFiles.slice(0, 4).map((file) => (
        <img key={file} src={photoUrl(file)} alt="" loading="lazy" decoding="async" />
      ))}
    </div>
  )
}

function MoodboardSummaryCard({
  board,
  projectTitle
}: {
  board: MoodboardSummary
  projectTitle: string | null
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)

  return (
    <article
      className="mb-board-card"
      role="button"
      tabIndex={0}
      aria-label={`Open moodboard ${board.title}`}
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
          {confirmDelete ? (
            <div className="mb-board-confirm">
              <button
                type="button"
                className="btn danger small"
                onClick={() => void deleteMoodboard(board.id)}
              >
                Delete
              </button>
              <button
                type="button"
                className="btn ghost small"
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="proj-quick-btn"
              title="Delete moodboard"
              aria-label={`Delete ${board.title}`}
              onClick={() => setConfirmDelete(true)}
            >
              <Icon name="trash" size={13} />
            </button>
          )}
        </div>
      </div>

      <div className="mb-board-body">
        <h2 className="mb-board-title">{board.title}</h2>
        <div className="mb-board-meta">
          {projectTitle && (
            <span className="proj-tag-chip truncate" style={{ maxWidth: 160 }}>
              <Icon name="projects" size={10} /> {projectTitle}
            </span>
          )}
          <span className="small faint">
            {board.itemCount} {board.itemCount === 1 ? 'item' : 'items'}
          </span>
          <span className="small faint" style={{ marginLeft: 'auto' }}>
            {formatRelativeDate(board.updatedAt)}
          </span>
        </div>
      </div>
    </article>
  )
}

function MoodboardEmptyState() {
  const activeProjectId = useShellStore((s) => s.activeProjectId)
  const set = useMoodboardStore((s) => s.set)

  return (
    <div className="projects-empty-state">
      <div className="projects-empty-hero">
        <div className="projects-empty-eyebrow">Infinite Reference Canvas</div>
        <h2>Gather light, color, and framing in one place</h2>
        <p className="muted">
          Drop local references, snap live 3D Globe Viewfinder views, extract color stories automatically,
          and browse visual inspiration right beside your board.
        </p>
      </div>

      <div className="projects-template-grid">
        {MOODBOARD_TEMPLATES.map((tpl) => (
          <button
            key={tpl.id}
            type="button"
            className="projects-template-card"
            onClick={() =>
              void createMoodboard({
                title: tpl.id === 'blank' ? 'Untitled Moodboard' : tpl.name,
                projectId: activeProjectId,
                template: tpl.id
              })
            }
          >
            <div
              className="projects-template-banner"
              style={{
                background: `linear-gradient(135deg, ${tpl.accentColors[0]} 0%, ${tpl.accentColors[1] ?? tpl.accentColors[0]} 100%)`
              }}
            >
              <div className="projects-template-badge">
                <Icon name={tpl.id === 'blank' ? 'plus' : 'moodboard'} size={16} />
              </div>
              <div className="projects-template-swatches">
                {tpl.accentColors.map((hex) => (
                  <span key={hex} style={{ background: hex }} />
                ))}
              </div>
            </div>
            <div className="projects-template-body">
              <div className="projects-template-head">
                <strong>{tpl.name}</strong>
                <span className="projects-template-arrow">
                  <Icon name="plus" size={14} />
                </span>
              </div>
              <p className="muted small">{tpl.description}</p>
            </div>
          </button>
        ))}
      </div>

      <div className="projects-empty-footer">
        <button type="button" className="btn ghost" onClick={() => set({ createDialogOpen: true })}>
          Or customize board title & linked project
        </button>
      </div>
    </div>
  )
}

export function NewMoodboardDialog() {
  const open = useMoodboardStore((s) => s.createDialogOpen)
  const set = useMoodboardStore((s) => s.set)
  if (!open) return null
  return <NewMoodboardModal onClose={() => set({ createDialogOpen: false })} />
}

function NewMoodboardModal({ onClose }: { onClose: () => void }) {
  const projects = useProjectsStore((s) => s.projects)
  const activeProjectId = useShellStore((s) => s.activeProjectId)
  const [title, setTitle] = useState('')
  const [projectId, setProjectId] = useState<string>(activeProjectId ?? '')
  const [template, setTemplate] = useState<MoodboardTemplateId>('blank')
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    onClose()
    await createMoodboard({
      title: title.trim() || 'Untitled Moodboard',
      projectId: projectId || null,
      template
    })
  }

  return (
    <div className="scrim center" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="panel dialog"
        role="dialog"
        aria-modal="true"
        aria-label="New Moodboard"
        style={{ width: 'min(480px, calc(100% - 32px))' }}
      >
        <div className="dialog-header">
          <h2>New Moodboard</h2>
          <button type="button" className="icon-btn small" title="Close" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </div>
        <form className="dialog-body" onSubmit={(e) => void submit(e)} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <label className="loc-field">
            <span className="loc-field-label">Title</span>
            <input
              autoFocus
              className="input"
              maxLength={MAX_BOARD_TITLE}
              placeholder="e.g. Dolomites Lighting Study"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>

          {projects.length > 0 && (
            <label className="loc-field">
              <span className="loc-field-label">Link to Project (optional)</span>
              <select className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">Standalone board</option>
                {projects
                  .filter((p) => p.status !== 'archived')
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title}
                    </option>
                  ))}
              </select>
            </label>
          )}

          <div className="loc-field">
            <span className="loc-field-label">Starter layout</span>
            <div className="mb-template-picker">
              {MOODBOARD_TEMPLATES.map((tpl) => (
                <button
                  key={tpl.id}
                  type="button"
                  className={`mb-template-option ${template === tpl.id ? 'active' : ''}`}
                  onClick={() => setTemplate(tpl.id)}
                >
                  <strong>{tpl.name}</strong>
                  <span className="small muted">{tpl.description}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
            <button type="button" className="btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn primary">
              Create Moodboard
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
