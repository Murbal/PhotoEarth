import { useEffect, useMemo, useRef } from 'react'
import { photoUrl, thumbFile } from '@shared/locations'
import {
  filterAndSortProjects,
  formatDateWindow,
  PROJECT_STATUS_LABELS,
  PROJECT_STATUSES,
  PROJECT_TEMPLATES,
  type ProjectSort,
  type ProjectStatusFilter
} from '@shared/projects'
import type { Bookmark, Project } from '@shared/types'
import { Icon, type IconName } from '../../components/Icon'
import {
  createProject,
  openProjectInGlobe,
  openProjectWorkspace,
  resolveProjectCover,
  setActiveProject,
  updateProject
} from '../../lib/projects'
import { useShellStore } from '../../shell/shellStore'
import { useAppStore } from '../../store/appStore'
import { useMoodboardStore } from '../../store/moodboardStore'
import { useProjectsStore } from '../../store/projectsStore'
import { projectCoverGradient, templatePreviewGradient } from './projectHelpers'

const FILTER_PILLS: Array<{ id: ProjectStatusFilter; label: string }> = [
  { id: 'all', label: 'Active' },
  ...PROJECT_STATUSES.map((s) => ({ id: s as ProjectStatusFilter, label: PROJECT_STATUS_LABELS[s] }))
]

const SORT_OPTIONS: Array<{ id: ProjectSort; label: string }> = [
  { id: 'updated', label: 'Recently updated' },
  { id: 'date', label: 'Target date' },
  { id: 'name', label: 'Name' },
  { id: 'status', label: 'Status' }
]

const TEMPLATE_ICONS: Record<string, IconName> = {
  'landscape-trip': 'panorama',
  'astro-alignment': 'night',
  'creative-series': 'palette',
  blank: 'plus'
}

export function ProjectsIndex() {
  const projects = useProjectsStore((s) => s.projects)
  const statusFilter = useProjectsStore((s) => s.statusFilter)
  const sort = useProjectsStore((s) => s.sort)
  const search = useProjectsStore((s) => s.search)
  const focusSearchNonce = useProjectsStore((s) => s.focusSearchNonce)
  const set = useProjectsStore((s) => s.set)
  const bookmarks = useAppStore((s) => s.bookmarks)
  const activeProjectId = useShellStore((s) => s.activeProjectId)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (focusSearchNonce > 0) {
      searchRef.current?.focus()
      searchRef.current?.select()
    }
  }, [focusSearchNonce])

  const bookmarksById = useMemo(() => new Map(bookmarks.map((b) => [b.id, b])), [bookmarks])
  const locationNamesById = useMemo(() => new Map(bookmarks.map((b) => [b.id, b.name])), [bookmarks])

  const visible = useMemo(
    () => filterAndSortProjects(projects, { status: statusFilter, query: search, sort }, locationNamesById),
    [projects, statusFilter, search, sort, locationNamesById]
  )

  const counts = useMemo(() => {
    const map: Record<ProjectStatusFilter, number> = {
      all: 0,
      brainstorming: 0,
      scouting: 0,
      ready: 0,
      shot: 0,
      archived: 0
    }
    for (const p of projects) {
      map[p.status]++
      if (p.status !== 'archived') map.all++
    }
    return map
  }, [projects])

  const hasFilters = statusFilter !== 'all' || search.trim().length > 0

  return (
    <div className="projects-page">
      <header className="projects-header">
        <div className="projects-container">
          <div className="projects-header-top">
            <div className="projects-title-wrap">
              <div className="projects-eyebrow">Studio Hub</div>
              <div className="projects-title-row">
                <h1 className="projects-title">Projects</h1>
                {projects.length > 0 && (
                  <span className="projects-count-pill">
                    {counts.all}
                  </span>
                )}
              </div>
            </div>

            <div className="projects-header-actions">
              <div className="proj-search-wrap">
                <Icon name="search" size={14} />
                <input
                  ref={searchRef}
                  className="proj-search-input"
                  type="search"
                  aria-label="Filter projects"
                  placeholder="Search projects, tags, spots…"
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

              <div className="proj-select-pill">
                <select
                  className="proj-sort-select"
                  aria-label="Sort projects"
                  value={sort}
                  onChange={(e) => set({ sort: e.target.value as ProjectSort })}
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
                title="New project (N)"
              >
                <Icon name="plus" size={15} />
                <span>New Project</span>
                <span className="proj-cta-kbd" aria-hidden="true">N</span>
              </button>
            </div>
          </div>

          <div className="projects-filter-bar" role="group" aria-label="Filter by status">
            {FILTER_PILLS.map((pill) => {
              const active = statusFilter === pill.id
              const count = counts[pill.id]
              return (
                <button
                  key={pill.id}
                  type="button"
                  className={`proj-filter-tab ${active ? 'active' : ''}`}
                  aria-pressed={active}
                  onClick={() => set({ statusFilter: pill.id })}
                >
                  {pill.id !== 'all' && <span className={`proj-status-dot ${pill.id}`} />}
                  <span>{pill.label}</span>
                  {count > 0 && <span className="proj-tab-num">{count}</span>}
                </button>
              )
            })}
          </div>
        </div>
      </header>

      <div className="projects-content scroll">
        <div className="projects-container">
          {projects.length === 0 ? (
            <ProjectsEmptyState />
          ) : visible.length === 0 ? (
            <div className="proj-empty-filtered">
              <div className="proj-empty-icon-sm">
                <Icon name="search" size={20} />
              </div>
              <h3>No matching projects</h3>
              <p className="muted">Try adjusting your search or status filter.</p>
              {hasFilters && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => set({ statusFilter: 'all', search: '' })}
                >
                  Reset filters
                </button>
              )}
            </div>
          ) : (
            <div className="projects-grid">
              {visible.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  bookmarksById={bookmarksById}
                  isActive={project.id === activeProjectId}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ProjectCard({
  project,
  bookmarksById,
  isActive
}: {
  project: Project
  bookmarksById: ReadonlyMap<string, Bookmark>
  isActive: boolean
}) {
  const cover = resolveProjectCover(project, bookmarksById)
  const moodboards = useMoodboardStore((s) => s.summaries)
  const linkedBoards = useMemo(
    () => moodboards.filter((b) => project.moodboardIds.includes(b.id) || b.projectId === project.id),
    [moodboards, project.id, project.moodboardIds]
  )
  const fallbackBoardPreview = !cover ? linkedBoards.find((b) => b.previewFiles.length > 0)?.previewFiles[0] ?? null : null
  const coverSrc = cover ? photoUrl(thumbFile(cover)) : fallbackBoardPreview ? photoUrl(fallbackBoardPreview) : null
  const dateChip = formatDateWindow(project.dateWindow)
  const spotCount = project.locationIds.filter((id) => bookmarksById.has(id)).length
  const boardCount = linkedBoards.length
  const noteCount = project.notes.length
  const isArchived = project.status === 'archived'

  return (
    <article
      className={`project-card ${isActive ? 'is-active' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`Open project ${project.title}`}
      onClick={() => openProjectWorkspace(project.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          openProjectWorkspace(project.id)
        }
      }}
    >
      <div
        className="project-card-cover"
        style={!coverSrc ? { background: projectCoverGradient(project) } : undefined}
      >
        {coverSrc ? (
          <img
            src={coverSrc}
            alt=""
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div className="project-card-cover-pattern" aria-hidden="true" />
        )}
        <div className="project-card-cover-scrim" />

        <div className="project-card-top">
          <div className="project-card-badges">
            <span className={`proj-glass-pill status ${project.status}`}>
              <span className={`proj-status-dot ${project.status}`} />
              {PROJECT_STATUS_LABELS[project.status]}
            </span>
            {isActive && (
              <span className="proj-glass-pill active-context" title="Active project context">
                <Icon name="star" size={11} /> Active
              </span>
            )}
          </div>

          <div
            className="project-card-quick-actions"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className={`proj-quick-btn ${isActive ? 'active' : ''}`}
              title={isActive ? 'Clear Active Project' : 'Set as Active Project'}
              aria-label={isActive ? `Clear ${project.title} as active project` : `Set ${project.title} as active project`}
              onClick={() => setActiveProject(isActive ? null : project.id)}
            >
              <Icon name="star" size={13} />
            </button>
            <button
              type="button"
              className="proj-quick-btn"
              title="Open in 3D Globe"
              aria-label={`Open ${project.title} in 3D Globe`}
              onClick={() => void openProjectInGlobe(project)}
            >
              <Icon name="globe" size={13} />
            </button>
            <button
              type="button"
              className="proj-quick-btn"
              title={isArchived ? 'Unarchive project' : 'Archive project'}
              aria-label={isArchived ? `Unarchive ${project.title}` : `Archive ${project.title}`}
              onClick={() => void updateProject(project.id, { status: isArchived ? 'scouting' : 'archived' })}
            >
              <Icon name="archive" size={13} />
            </button>
          </div>
        </div>

        <div className="project-card-cover-bottom">
          {dateChip && (
            <span className="proj-glass-pill subtle">
              <Icon name="calendar" size={11} /> {dateChip}
            </span>
          )}
        </div>

        {project.concept.colorStory.length > 0 && (
          <div className="project-card-color-story" aria-label="Color story">
            {project.concept.colorStory.map((hex) => (
              <span key={hex} style={{ background: hex }} title={hex} />
            ))}
          </div>
        )}
      </div>

      <div className="project-card-body">
        <h2 className="project-card-title">{project.title}</h2>
        <p className={`project-card-summary ${project.concept.summary ? 'muted' : 'faint'}`}>
          {project.concept.summary || 'Add a concept brief, lighting mood, or scouting notes…'}
        </p>

        {project.tags.length > 0 && (
          <div className="project-card-tags">
            {project.tags.slice(0, 4).map((tag) => (
              <span key={tag} className="proj-tag-chip">
                {tag}
              </span>
            ))}
            {project.tags.length > 4 && (
              <span className="small faint">+{project.tags.length - 4}</span>
            )}
          </div>
        )}

        <div className="project-card-footer">
          <span className="proj-stat" title="Linked scouting locations">
            <Icon name="pin" size={12} /> {spotCount}
          </span>
          <span className="proj-stat" title="Linked moodboards">
            <Icon name="moodboard" size={12} /> {boardCount}
          </span>
          <span className="proj-stat" title="Project notes">
            <Icon name="note" size={12} /> {noteCount}
          </span>
        </div>
      </div>
    </article>
  )
}

function ProjectsEmptyState() {
  const set = useProjectsStore((s) => s.set)
  return (
    <div className="projects-empty-state">
      <div className="projects-empty-hero">
        <div className="projects-empty-eyebrow">Photography Planning Workspace</div>
        <h2>Turn scattered spots into cohesive shoots</h2>
        <p className="muted">
          Pair 3D Globe scouting locations with creative briefs, color stories, and field notes.
          Start with a curated template or create a blank project.
        </p>
      </div>

      <div className="projects-template-grid">
        {PROJECT_TEMPLATES.map((tpl) => {
          const icon = TEMPLATE_ICONS[tpl.id] ?? 'projects'
          const colors = tpl.input.concept?.colorStory ?? []
          return (
            <button
              key={tpl.id}
              type="button"
              className="projects-template-card"
              onClick={() => void createProject(tpl.input, { open: true, setActive: true })}
            >
              <div
                className="projects-template-banner"
                style={{ background: templatePreviewGradient(tpl.id, colors) }}
              >
                <div className="projects-template-badge">
                  <Icon name={icon} size={16} />
                </div>
                {colors.length > 0 && (
                  <div className="projects-template-swatches">
                    {colors.map((hex) => (
                      <span key={hex} style={{ background: hex }} />
                    ))}
                  </div>
                )}
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
          )
        })}
      </div>

      <div className="projects-empty-footer">
        <button
          type="button"
          className="btn ghost"
          onClick={() => set({ createDialogOpen: true })}
        >
          Or customize title & status first
        </button>
      </div>
    </div>
  )
}
