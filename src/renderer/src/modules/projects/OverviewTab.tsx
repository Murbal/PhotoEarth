import { useEffect, useMemo, useRef, useState } from 'react'
import { photoUrl, thumbFile } from '@shared/locations'
import {
  MAX_COLOR_STORY,
  MAX_CONCEPT_CONSTRAINTS,
  MAX_CONCEPT_MOOD,
  MAX_CONCEPT_SUMMARY,
  normalizeHexColor
} from '@shared/projects'
import type { Bookmark, Project } from '@shared/types'
import { Icon } from '../../components/Icon'
import {
  createMoodboard,
  openMoodboard,
  syncProjectColorStoryFromMoodboards
} from '../../lib/moodboards'
import {
  addProjectNote,
  flyToProjectLocation,
  scoutNewSpotForProject,
  updateProject
} from '../../lib/projects'
import { shellState } from '../../shell/shellStore'
import { useAppStore } from '../../store/appStore'
import { useMoodboardStore } from '../../store/moodboardStore'
import { useProjectsStore } from '../../store/projectsStore'
import { ProjectDraftField } from './projectHelpers'

export function OverviewTab({
  project,
  onOpenLinkLocations
}: {
  project: Project
  onOpenLinkLocations: () => void
}) {
  const bookmarks = useAppStore((s) => s.bookmarks)
  const moodboards = useMoodboardStore((s) => s.summaries)
  const setProjectsState = useProjectsStore((s) => s.set)
  const linkedLocations = useMemo(() => {
    const byId = new Map(bookmarks.map((b) => [b.id, b]))
    return project.locationIds.map((id) => byId.get(id)).filter((b): b is Bookmark => !!b)
  }, [bookmarks, project.locationIds])
  const linkedMoodboards = useMemo(() => {
    const byId = new Map(moodboards.map((b) => [b.id, b]))
    const out = project.moodboardIds.map((id) => byId.get(id)).filter((b): b is NonNullable<typeof b> => !!b)
    for (const b of moodboards) {
      if (b.projectId === project.id && !out.some((x) => x.id === b.id)) out.push(b)
    }
    return out
  }, [moodboards, project.id, project.moodboardIds])
  const pinnedNotes = useMemo(() => project.notes.filter((n) => n.pinned), [project.notes])

  return (
    <div className="proj-overview-grid">
      {/* Left column: Editorial Concept Brief + Color Story + Pinned Notes */}
      <div className="proj-overview-main">
        <section className="proj-surface">
          <div className="proj-surface-head">
            <div className="proj-surface-title">
              <Icon name="palette" size={14} />
              <h3>Creative Brief</h3>
            </div>
          </div>

          <div className="proj-brief-grid">
            <div className="proj-brief-block full">
              <label className="proj-brief-label">Premise & story</label>
              <ProjectDraftField
                aria-label="Concept summary"
                className="proj-doc-textarea"
                multiline
                rows={3}
                maxLength={MAX_CONCEPT_SUMMARY}
                placeholder="What's the visual story, mood, or moment you're planning to capture?"
                value={project.concept.summary}
                onCommit={(summary) => void updateProject(project.id, { concept: { summary } })}
              />
            </div>

            <div className="proj-brief-block">
              <label className="proj-brief-label">Lighting & atmosphere</label>
              <ProjectDraftField
                aria-label="Lighting and atmosphere"
                className="proj-doc-textarea"
                multiline
                rows={3}
                maxLength={MAX_CONCEPT_MOOD}
                placeholder="Low-angle side light, valley fog, nautical twilight, clearing storms…"
                value={project.concept.lightingMood}
                onCommit={(lightingMood) => void updateProject(project.id, { concept: { lightingMood } })}
              />
            </div>

            <div className="proj-brief-block">
              <label className="proj-brief-label">Creative constraints</label>
              <ProjectDraftField
                aria-label="Creative constraints"
                className="proj-doc-textarea"
                multiline
                rows={3}
                maxLength={MAX_CONCEPT_CONSTRAINTS}
                placeholder="35mm prime only, 4:5 vertical framing, monochrome, intentional blur…"
                value={project.concept.constraints}
                onCommit={(constraints) => void updateProject(project.id, { concept: { constraints } })}
              />
            </div>
          </div>

          <ColorStoryPalette project={project} />
        </section>

        <section className="proj-surface">
          <div className="proj-surface-head">
            <div className="proj-surface-title">
              <Icon name="thumbtack" size={14} />
              <h3>Pinned Notes</h3>
            </div>
            <span className="spacer" />
            <button
              type="button"
              className="btn ghost small"
              onClick={() => {
                void addProjectNote(project.id, { title: 'Pinned note', pinned: true }).then(() => {
                  setProjectsState({ activeTab: 'notes' })
                })
              }}
            >
              <Icon name="plus" size={13} /> Add note
            </button>
            <button
              type="button"
              className="proj-subtle-link"
              onClick={() => setProjectsState({ activeTab: 'notes' })}
            >
              All notes ({project.notes.length})
            </button>
          </div>
          {pinnedNotes.length === 0 ? (
            <p className="muted small" style={{ margin: 0, lineHeight: 1.5 }}>
              Pin logistics checklists, permits, or creative prompts from the Notes tab to surface them right here.
            </p>
          ) : (
            <div className="proj-pinned-notes">
              {pinnedNotes.map((note) => (
                <button
                  key={note.id}
                  type="button"
                  className="proj-pinned-note-card"
                  onClick={() => setProjectsState({ activeTab: 'notes', selectedNoteId: note.id })}
                >
                  <div className="proj-pinned-note-title">
                    <span>{note.title}</span>
                  </div>
                  <p className="small muted">{note.body.trim() || 'Empty note'}</p>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Right column: Linked Scouting Spots & Moodboards */}
      <aside className="proj-overview-aside">
        <section className="proj-surface">
          <div className="proj-surface-head">
            <div className="proj-surface-title">
              <Icon name="pin" size={14} />
              <h3>Scouting Spots</h3>
              <span className="proj-tab-num">{linkedLocations.length}</span>
            </div>
            <span className="spacer" />
            <button
              type="button"
              className="proj-subtle-link"
              onClick={() => setProjectsState({ activeTab: 'locations' })}
            >
              Manage
            </button>
          </div>

          {linkedLocations.length === 0 ? (
            <div className="proj-aside-empty">
              <p className="muted small">
                Attach saved spots from your 3D Globe or jump in to scout new vantages.
              </p>
            </div>
          ) : (
            <div className="proj-mini-locations">
              {linkedLocations.slice(0, 5).map((loc) => (
                <div key={loc.id} className="proj-mini-loc">
                  <div className="proj-mini-loc-thumb">
                    {loc.photos[0] ? (
                      <img src={photoUrl(thumbFile(loc.photos[0]))} alt="" loading="lazy" decoding="async" />
                    ) : (
                      <Icon name="pin" size={14} />
                    )}
                  </div>
                  <div className="proj-mini-loc-info">
                    <div className="proj-mini-loc-name">
                      <span className={`status-dot ${loc.status}`} />
                      <span className="truncate">{loc.name}</span>
                    </div>
                    {loc.bestTime && <div className="small faint truncate">{loc.bestTime}</div>}
                  </div>
                  <button
                    type="button"
                    className="proj-mini-fly"
                    title={`Fly to ${loc.name} in 3D Globe`}
                    aria-label={`Fly to ${loc.name} in 3D Globe`}
                    onClick={() => void flyToProjectLocation(loc, project.id)}
                  >
                    <Icon name="globe" size={14} />
                  </button>
                </div>
              ))}
              {linkedLocations.length > 5 && (
                <button
                  type="button"
                  className="btn ghost small"
                  onClick={() => setProjectsState({ activeTab: 'locations' })}
                >
                  View all {linkedLocations.length} locations
                </button>
              )}
            </div>
          )}

          <div className="proj-aside-actions">
            <button type="button" className="btn grow" onClick={onOpenLinkLocations}>
              <Icon name="link" size={13} /> Link spot
            </button>
            <button type="button" className="btn grow" onClick={() => scoutNewSpotForProject(project)}>
              <Icon name="globe" size={13} /> Scout new
            </button>
          </div>
        </section>

        <section className="proj-surface">
          <div className="proj-surface-head">
            <div className="proj-surface-title">
              <Icon name="moodboard" size={14} />
              <h3>Moodboards</h3>
              <span className="proj-tab-num">{linkedMoodboards.length}</span>
            </div>
            <span className="spacer" />
            <button
              type="button"
              className="proj-subtle-link"
              onClick={() => setProjectsState({ activeTab: 'moodboards' })}
            >
              Manage
            </button>
          </div>
          {linkedMoodboards.length === 0 ? (
            <div className="proj-aside-empty">
              <p className="muted small">
                Create a visual canvas for references, 3D Viewfinder snapshots, and extracted color stories.
              </p>
            </div>
          ) : (
            <div className="proj-mini-locations">
              {linkedMoodboards.slice(0, 4).map((board) => (
                <div key={board.id} className="proj-mini-loc">
                  <div className="proj-mini-loc-thumb">
                    {board.previewFiles[0] ? (
                      <img src={photoUrl(board.previewFiles[0])} alt="" loading="lazy" decoding="async" />
                    ) : (
                      <Icon name="moodboard" size={14} />
                    )}
                  </div>
                  <div className="proj-mini-loc-info">
                    <div className="proj-mini-loc-name">
                      <span className="truncate">{board.title}</span>
                    </div>
                    <div className="small faint">
                      {board.itemCount} {board.itemCount === 1 ? 'item' : 'items'}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="proj-mini-fly"
                    title={`Open ${board.title}`}
                    aria-label={`Open ${board.title}`}
                    onClick={() => void openMoodboard(board.id)}
                  >
                    <Icon name="moodboard" size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="proj-aside-actions">
            <button
              type="button"
              className="btn grow"
              onClick={() =>
                void createMoodboard({
                  title: `${project.title} — Moodboard`,
                  projectId: project.id,
                  template: 'blank'
                })
              }
            >
              <Icon name="plus" size={13} /> New board
            </button>
            <button
              type="button"
              className="btn grow"
              onClick={() => setProjectsState({ activeTab: 'moodboards' })}
            >
              <Icon name="link" size={13} /> Link board
            </button>
          </div>
        </section>
      </aside>
    </div>
  )
}

function ColorStoryPalette({ project }: { project: Project }) {
  const [adding, setAdding] = useState(false)
  const [pickerColor, setPickerColor] = useState('#4fb3ff')
  const [hexDraft, setHexDraft] = useState('')
  const popRef = useRef<HTMLDivElement>(null)
  const colors = project.concept.colorStory

  useEffect(() => {
    if (!adding) return
    const onPointerDown = (e: PointerEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setAdding(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [adding])

  const addColor = (raw: string) => {
    const normalized = normalizeHexColor(raw)
    if (!normalized) {
      shellState().showToast('Enter a valid hex color such as #4fb3ff')
      return
    }
    if (colors.includes(normalized)) {
      setAdding(false)
      return
    }
    if (colors.length >= MAX_COLOR_STORY) {
      shellState().showToast(`Color story can hold at most ${MAX_COLOR_STORY} swatches.`)
      return
    }
    void updateProject(project.id, { concept: { colorStory: [...colors, normalized] } })
    setHexDraft('')
    setAdding(false)
  }

  const removeColor = (hex: string) => {
    void updateProject(project.id, { concept: { colorStory: colors.filter((c) => c !== hex) } })
  }

  const copyColor = (hex: string) => {
    void navigator.clipboard.writeText(hex).then(() => shellState().showToast(`Copied ${hex}`))
  }

  return (
    <div className="proj-palette-section">
      <div className="proj-palette-head">
        <span className="proj-brief-label">Color story</span>
        <span className="spacer" />
        <button
          type="button"
          className="proj-subtle-link"
          title="Pull dominant tones from this project's linked Moodboards"
          onClick={() => void syncProjectColorStoryFromMoodboards(project)}
        >
          Sync from Moodboard
        </button>
      </div>

      <div className="proj-swatch-strip">
        {colors.map((hex) => (
          <div key={hex} className="proj-swatch-tile" style={{ background: hex }}>
            <button
              type="button"
              className="proj-swatch-tile-hit"
              title={`Copy ${hex}`}
              onClick={() => copyColor(hex)}
            >
              <span className="proj-swatch-hex mono">{hex}</span>
            </button>
            <button
              type="button"
              className="proj-swatch-tile-del"
              aria-label={`Remove color ${hex}`}
              onClick={() => removeColor(hex)}
            >
              <Icon name="close" size={11} />
            </button>
          </div>
        ))}

        {colors.length < MAX_COLOR_STORY && (
          <div className="proj-swatch-add-slot" ref={popRef}>
            <button
              type="button"
              className="proj-swatch-add-tile"
              aria-label="Add swatch to color story"
              aria-expanded={adding}
              onClick={() => setAdding((v) => !v)}
            >
              <Icon name="plus" size={15} />
              <span>{colors.length === 0 ? 'Add swatch' : 'Add'}</span>
            </button>

            {adding && (
              <div className="panel proj-popover proj-color-popover" role="dialog" aria-label="Add color swatch">
                <div className="row">
                  <input
                    type="color"
                    className="proj-color-native"
                    aria-label="Pick swatch color"
                    value={pickerColor}
                    onChange={(e) => {
                      setPickerColor(e.target.value)
                      setHexDraft(e.target.value)
                    }}
                  />
                  <input
                    autoFocus
                    className="input mono grow"
                    aria-label="Hex color code"
                    placeholder={pickerColor}
                    maxLength={7}
                    value={hexDraft}
                    onChange={(e) => setHexDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        addColor(hexDraft.trim() || pickerColor)
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="btn primary small"
                    onClick={() => addColor(hexDraft.trim() || pickerColor)}
                  >
                    Add
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
