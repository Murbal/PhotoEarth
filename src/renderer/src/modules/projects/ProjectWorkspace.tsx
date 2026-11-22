import { useEffect, useMemo, useRef, useState } from 'react'
import { normalizeTag, photoUrl, tagCounts, thumbFile } from '@shared/locations'
import {
  formatDateWindow,
  MAX_DATE_LABEL,
  MAX_PROJECT_TITLE,
  PROJECT_STATUS_LABELS,
  PROJECT_STATUSES
} from '@shared/projects'
import type { Bookmark, LocationPhoto, Project, ProjectStatus } from '@shared/types'
import { Icon, type IconName } from '../../components/Icon'
import {
  clearProjectCoverPhoto,
  deleteProject,
  openProjectInGlobe,
  pickProjectCoverPhoto,
  resolveProjectCover,
  setActiveProject,
  setProjectCoverFromLocationPhoto,
  setProjectCoverPhotoFile,
  updateProject
} from '../../lib/projects'
import { useShellStore } from '../../shell/shellStore'
import { useAppStore } from '../../store/appStore'
import { useProjectsStore, type ProjectTab } from '../../store/projectsStore'
import { LinkLocationsDialog, LocationsTab } from './LocationsTab'
import { MoodboardsTab } from './MoodboardsTab'
import { NotesTab } from './NotesTab'
import { OverviewTab } from './OverviewTab'
import { projectCoverGradient, ProjectDraftField } from './projectHelpers'

const TABS: Array<{ id: ProjectTab; label: string; icon: IconName }> = [
  { id: 'overview', label: 'Overview & Brief', icon: 'palette' },
  { id: 'locations', label: 'Locations', icon: 'pin' },
  { id: 'moodboards', label: 'Moodboards', icon: 'moodboard' },
  { id: 'notes', label: 'Notes & Ideas', icon: 'note' }
]

export function ProjectWorkspace({ project }: { project: Project }) {
  const activeTab = useProjectsStore((s) => s.activeTab)
  const setProjectsState = useProjectsStore((s) => s.set)
  const closeProject = useProjectsStore((s) => s.closeProject)
  const activeProjectId = useShellStore((s) => s.activeProjectId)
  const bookmarks = useAppStore((s) => s.bookmarks)
  const [linkDialogOpen, setLinkDialogOpen] = useState(false)
  const [datePopoverOpen, setDatePopoverOpen] = useState(false)
  const [coverMenuOpen, setCoverMenuOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [coverDragging, setCoverDragging] = useState(false)

  const bookmarksById = useMemo(() => new Map(bookmarks.map((b) => [b.id, b])), [bookmarks])
  const linkedLocations = useMemo(
    () => project.locationIds.map((id) => bookmarksById.get(id)).filter((b): b is Bookmark => !!b),
    [bookmarksById, project.locationIds]
  )
  const linkedPhotos = useMemo(
    () => linkedLocations.flatMap((loc) => loc.photos.map((photo) => ({ loc, photo }))),
    [linkedLocations]
  )
  const displayCover = resolveProjectCover(project, bookmarksById)
  const dateChip = formatDateWindow(project.dateWindow)
  const isActive = activeProjectId === project.id

  return (
    <div className="proj-workspace">
      <header className="proj-ws-header">
        {/* Atmospheric backdrop softly tinted from cover photo or color story */}
        <div className="proj-ws-backdrop" aria-hidden="true">
          {displayCover ? (
            <img src={photoUrl(thumbFile(displayCover))} alt="" />
          ) : (
            <div className="proj-ws-backdrop-grad" style={{ background: projectCoverGradient(project) }} />
          )}
          <div className="proj-ws-backdrop-fade" />
        </div>

        <div className="projects-container proj-ws-header-inner">
          <div className="proj-ws-topbar">
            <button
              type="button"
              className="proj-back-btn"
              onClick={() => closeProject()}
              title="Back to Projects (Esc)"
            >
              <Icon name="arrowLeft" size={14} />
              <span>Projects</span>
            </button>

            <span className="spacer" />

            <button
              type="button"
              className={`btn proj-action-btn ${isActive ? 'active-pill' : ''}`}
              aria-pressed={isActive}
              onClick={() => setActiveProject(isActive ? null : project.id)}
              title="Pin this project to the Activity Rail and scope the 3D Globe to it"
            >
              <Icon name="star" size={14} />
              <span>{isActive ? 'Active Project' : 'Set Active'}</span>
            </button>

            <button
              type="button"
              className="btn primary proj-cta"
              onClick={() => void openProjectInGlobe(project)}
              title="Switch to 3D Globe, filter to this project, and fly to its locations"
            >
              <Icon name="globe" size={14} />
              <span>Open in 3D Globe</span>
            </button>

            {confirmDelete ? (
              <div className="proj-delete-confirm">
                <span className="small muted">Delete project? Linked spots stay safe.</span>
                <button
                  type="button"
                  className="btn danger small"
                  onClick={() => void deleteProject(project.id)}
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
                className="icon-btn small proj-ws-trash"
                title="Delete project"
                aria-label="Delete project"
                onClick={() => setConfirmDelete(true)}
              >
                <Icon name="trash" size={15} />
              </button>
            )}
          </div>

          <div className="proj-ws-hero">
            <div
              className={`proj-ws-cover ${coverDragging ? 'dragging' : ''}`}
              style={!displayCover ? { background: projectCoverGradient(project) } : undefined}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes('Files')) return
                e.preventDefault()
                setCoverDragging(true)
              }}
              onDragLeave={() => setCoverDragging(false)}
              onDrop={(e) => {
                e.preventDefault()
                setCoverDragging(false)
                const file = e.dataTransfer.files?.[0]
                if (file) void setProjectCoverPhotoFile(project.id, file)
              }}
            >
              {displayCover ? (
                <img src={photoUrl(thumbFile(displayCover))} alt="" decoding="async" />
              ) : (
                <div className="proj-ws-cover-placeholder">
                  <Icon name="image" size={20} />
                </div>
              )}
              <button
                type="button"
                className="proj-ws-cover-btn"
                onClick={() => setCoverMenuOpen((o) => !o)}
                title="Change cover photo (or drop an image)"
              >
                <Icon name="image" size={12} /> {project.coverPhoto ? 'Change cover' : 'Add cover'}
              </button>
              {coverMenuOpen && (
                <CoverPickerPopover
                  project={project}
                  linkedPhotos={linkedPhotos}
                  onClose={() => setCoverMenuOpen(false)}
                />
              )}
            </div>

            <div className="proj-ws-meta">
              <ProjectDraftField
                key={project.id}
                aria-label="Project title"
                className="proj-ws-title-input"
                maxLength={MAX_PROJECT_TITLE}
                value={project.title}
                onCommit={(title) => void updateProject(project.id, { title })}
              />

              <div className="proj-ws-controls">
                <div className={`proj-status-pill-select ${project.status}`}>
                  <span className={`proj-status-dot ${project.status}`} />
                  <select
                    className="proj-status-select"
                    aria-label="Project status"
                    value={project.status}
                    onChange={(e) => void updateProject(project.id, { status: e.target.value as ProjectStatus })}
                  >
                    {PROJECT_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {PROJECT_STATUS_LABELS[s]}
                      </option>
                    ))}
                  </select>
                  <Icon name="chevronDown" size={12} />
                </div>

                <div className="proj-date-slot">
                  <button
                    type="button"
                    className={`proj-meta-pill ${dateChip ? 'has-value' : ''}`}
                    aria-expanded={datePopoverOpen}
                    onClick={() => setDatePopoverOpen((o) => !o)}
                  >
                    <Icon name="calendar" size={12} />
                    <span>{dateChip ?? 'Target dates'}</span>
                  </button>
                  {datePopoverOpen && (
                    <DateWindowPopover
                      project={project}
                      onClose={() => setDatePopoverOpen(false)}
                    />
                  )}
                </div>

                <span className="proj-meta-divider" aria-hidden="true" />
                <ProjectTagEditor project={project} />
              </div>
            </div>
          </div>

          <nav className="proj-ws-tabs" role="tablist" aria-label="Project sections">
            {TABS.map((tab) => {
              const active = activeTab === tab.id
              const badge =
                tab.id === 'locations'
                  ? linkedLocations.length
                  : tab.id === 'moodboards'
                    ? project.moodboardIds.length
                    : tab.id === 'notes'
                      ? project.notes.length
                      : null
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`proj-ws-tab ${active ? 'active' : ''}`}
                  onClick={() => setProjectsState({ activeTab: tab.id })}
                >
                  <Icon name={tab.icon} size={14} />
                  <span>{tab.label}</span>
                  {badge !== null && badge > 0 && <span className="proj-tab-num">{badge}</span>}
                </button>
              )
            })}
          </nav>
        </div>
      </header>

      <div className="proj-ws-body scroll">
        <div className="projects-container">
          {activeTab === 'overview' && (
            <OverviewTab project={project} onOpenLinkLocations={() => setLinkDialogOpen(true)} />
          )}
          {activeTab === 'locations' && (
            <LocationsTab project={project} onOpenLinkLocations={() => setLinkDialogOpen(true)} />
          )}
          {activeTab === 'moodboards' && <MoodboardsTab project={project} />}
          {activeTab === 'notes' && <NotesTab project={project} />}
        </div>
      </div>

      {linkDialogOpen && (
        <LinkLocationsDialog project={project} onClose={() => setLinkDialogOpen(false)} />
      )}
    </div>
  )
}

function ProjectTagEditor({ project }: { project: Project }) {
  const projects = useProjectsStore((s) => s.projects)
  const bookmarks = useAppStore((s) => s.bookmarks)
  const [draft, setDraft] = useState('')
  const suggestions = useMemo(() => {
    const counts = tagCounts([...projects, ...bookmarks])
    return counts.map((t) => t.tag).filter((t) => !project.tags.includes(t))
  }, [projects, bookmarks, project.tags])

  const add = (raw: string) => {
    const next = raw
      .split(',')
      .map(normalizeTag)
      .filter((t) => t && !project.tags.includes(t))
    if (next.length) void updateProject(project.id, { tags: [...project.tags, ...next] })
    setDraft('')
  }

  return (
    <div className="proj-inline-tags">
      {project.tags.map((t) => (
        <span key={t} className="proj-ws-tag-pill">
          <span>#{t}</span>
          <button
            type="button"
            aria-label={`Remove tag ${t}`}
            onClick={() => void updateProject(project.id, { tags: project.tags.filter((x) => x !== t) })}
          >
            <Icon name="close" size={10} />
          </button>
        </span>
      ))}
      <input
        className="proj-inline-tag-input"
        aria-label="Add project tag"
        placeholder={project.tags.length ? '+ tag' : '+ Add tags…'}
        list={`proj-tags-${project.id}`}
        value={draft}
        onChange={(e) => {
          if (e.target.value.includes(',')) add(e.target.value)
          else setDraft(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            add(draft)
          } else if (e.key === 'Backspace' && !draft && project.tags.length) {
            void updateProject(project.id, { tags: project.tags.slice(0, -1) })
          }
        }}
        onBlur={() => draft.trim() && add(draft)}
      />
      <datalist id={`proj-tags-${project.id}`}>
        {suggestions.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
    </div>
  )
}

function DateWindowPopover({ project, onClose }: { project: Project; onClose: () => void }) {
  const [start, setStart] = useState(project.dateWindow.start ?? '')
  const [end, setEnd] = useState(project.dateWindow.end ?? '')
  const [label, setLabel] = useState(project.dateWindow.label)
  const popRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [onClose])

  const save = () => {
    void updateProject(project.id, {
      dateWindow: {
        start: start || null,
        end: end || null,
        label
      }
    })
    onClose()
  }

  return (
    <div ref={popRef} className="panel proj-popover" role="dialog" aria-label="Target date window">
      <div className="proj-popover-fields">
        <div className="proj-date-inputs">
          <label className="loc-field grow">
            <span className="loc-field-label">Start date</span>
            <input
              type="date"
              className="input"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </label>
          <label className="loc-field grow">
            <span className="loc-field-label">End date</span>
            <input
              type="date"
              className="input"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </label>
        </div>
        <label className="loc-field">
          <span className="loc-field-label">Seasonal or flexible window</span>
          <input
            className="input"
            maxLength={MAX_DATE_LABEL}
            placeholder="e.g. Late October, first snow"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()}
          />
        </label>
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 4 }}>
          <button
            type="button"
            className="btn ghost small"
            onClick={() => {
              void updateProject(project.id, { dateWindow: { start: null, end: null, label: '' } })
              onClose()
            }}
          >
            Clear
          </button>
          <div className="row">
            <button type="button" className="btn ghost small" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn primary small" onClick={save}>
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function CoverPickerPopover({
  project,
  linkedPhotos,
  onClose
}: {
  project: Project
  linkedPhotos: Array<{ loc: Bookmark; photo: LocationPhoto }>
  onClose: () => void
}) {
  const popRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [onClose])

  return (
    <div
      ref={popRef}
      className="panel proj-popover proj-cover-popover"
      role="dialog"
      aria-label="Choose cover photo"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="btn grow"
        style={{ width: '100%' }}
        onClick={() => {
          onClose()
          void pickProjectCoverPhoto(project.id)
        }}
      >
        <Icon name="image" size={14} /> Choose from disk…
      </button>

      {linkedPhotos.length > 0 && (
        <div className="proj-cover-loc-section">
          <div className="loc-field-label">From linked locations</div>
          <div className="proj-cover-loc-grid">
            {linkedPhotos.slice(0, 9).map(({ loc, photo }) => (
              <button
                key={`${loc.id}-${photo.id}`}
                type="button"
                className="proj-cover-loc-thumb"
                title={`${loc.name}: ${photo.name}`}
                onClick={() => {
                  onClose()
                  void setProjectCoverFromLocationPhoto(project.id, photo)
                }}
              >
                <img src={photoUrl(thumbFile(photo))} alt={photo.name} loading="lazy" decoding="async" />
              </button>
            ))}
          </div>
        </div>
      )}

      {project.coverPhoto && (
        <button
          type="button"
          className="btn ghost danger small"
          style={{ width: '100%' }}
          onClick={() => {
            onClose()
            void clearProjectCoverPhoto(project.id)
          }}
        >
          <Icon name="trash" size={13} /> Remove cover photo
        </button>
      )}
    </div>
  )
}
