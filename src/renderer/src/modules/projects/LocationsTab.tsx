import { useMemo, useRef, useState } from 'react'
import { formatLatLon } from '@shared/coords'
import { photoUrl, thumbFile } from '@shared/locations'
import type { Bookmark, Project } from '@shared/types'
import { Icon } from '../../components/Icon'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { SENSORS } from '../../lib/lens'
import { updateLocation } from '../../lib/locations'
import {
  flyToProjectLocation,
  linkLocationToProject,
  openProjectInGlobe,
  scoutNewSpotForProject,
  unlinkLocationFromProject
} from '../../lib/projects'
import { useAppStore } from '../../store/appStore'

function viewfinderSummary(b: Bookmark): string | null {
  if (!b.viewfinder) return null
  const sensor = SENSORS.find((s) => s.id === b.viewfinder!.sensor)?.label ?? b.viewfinder.sensor
  const orient = b.viewfinder.portrait ? 'portrait' : 'landscape'
  return `${Math.round(b.viewfinder.focalLength)}mm · ${sensor}${b.viewfinder.aspect !== 'native' ? ` · ${b.viewfinder.aspect}` : ''} (${orient})`
}

export function LocationsTab({
  project,
  onOpenLinkLocations
}: {
  project: Project
  onOpenLinkLocations: () => void
}) {
  const bookmarks = useAppStore((s) => s.bookmarks)
  const coordFormat = useAppStore((s) => s.settings.coordFormat)

  const linked = useMemo(() => {
    const byId = new Map(bookmarks.map((b) => [b.id, b]))
    return project.locationIds.map((id) => byId.get(id)).filter((b): b is Bookmark => !!b)
  }, [bookmarks, project.locationIds])

  return (
    <div className="proj-locations-tab">
      <div className="proj-tab-toolbar">
        <div className="muted small">
          {linked.length === 0
            ? 'Link saved locations from your 3D Globe or scout new spots directly into this project.'
            : `${linked.length} linked ${linked.length === 1 ? 'spot' : 'spots'} · unlinking keeps the saved bookmark intact.`}
        </div>
        <div className="row" style={{ marginLeft: 'auto' }}>
          <button type="button" className="btn" onClick={onOpenLinkLocations}>
            <Icon name="link" size={14} /> Link existing
          </button>
          <button type="button" className="btn primary proj-cta" onClick={() => scoutNewSpotForProject(project)}>
            <Icon name="globe" size={14} /> Scout new spot
          </button>
          {linked.length > 0 && (
            <button type="button" className="btn" onClick={() => void openProjectInGlobe(project)}>
              <Icon name="pin" size={14} /> View all in Globe
            </button>
          )}
        </div>
      </div>

      {linked.length === 0 ? (
        <div className="proj-empty-tab">
          <div className="proj-empty-icon-sm">
            <Icon name="pin" size={20} />
          </div>
          <h3>No locations linked yet</h3>
          <p className="muted">Connect existing bookmarks or jump to the 3D Globe to scout and save spots here.</p>
          <div className="row" style={{ marginTop: 4 }}>
            <button type="button" className="btn" onClick={onOpenLinkLocations}>
              <Icon name="link" size={14} /> Link existing location
            </button>
            <button type="button" className="btn primary proj-cta" onClick={() => scoutNewSpotForProject(project)}>
              <Icon name="globe" size={14} /> Scout in 3D Globe
            </button>
          </div>
        </div>
      ) : (
        <div className="proj-location-grid">
          {linked.map((loc) => {
            const cover = loc.photos[0]
            const lens = viewfinderSummary(loc)
            const visited = loc.status === 'visited'
            return (
              <article key={loc.id} className="proj-location-card">
                <div className="proj-location-media">
                  {cover ? (
                    <img src={photoUrl(thumbFile(cover))} alt="" loading="lazy" decoding="async" />
                  ) : (
                    <div className="proj-location-coords-placeholder">
                      <Icon name="pin" size={20} />
                      <span className="mono small">
                        {formatLatLon(loc.position.latitude, loc.position.longitude, coordFormat)}
                      </span>
                    </div>
                  )}
                  <div className="proj-location-media-overlay">
                    <button
                      type="button"
                      className={`proj-glass-pill visit-toggle ${loc.status}`}
                      title="Click to toggle To Visit / Visited"
                      onClick={() => void updateLocation(loc.id, { status: visited ? 'to-visit' : 'visited' })}
                    >
                      <span className={`status-dot ${loc.status}`} />
                      {visited ? 'Visited' : 'To visit'}
                    </button>
                    <button
                      type="button"
                      className="proj-quick-btn proj-loc-unlink"
                      title="Remove from project (keeps bookmark)"
                      aria-label={`Remove ${loc.name} from project`}
                      onClick={() => void unlinkLocationFromProject(project.id, loc.id)}
                    >
                      <Icon name="unlink" size={13} />
                    </button>
                  </div>
                </div>
                <div className="proj-location-body">
                  <h4>{loc.name}</h4>
                  <div className="mono small faint">
                    {formatLatLon(loc.position.latitude, loc.position.longitude, coordFormat)}
                  </div>
                  {(loc.bestTime || lens) && (
                    <div className="proj-location-pills">
                      {loc.bestTime && (
                        <span className="proj-detail-chip">
                          <Icon name="sun" size={11} /> {loc.bestTime}
                        </span>
                      )}
                      {lens && (
                        <span className="proj-detail-chip">
                          <Icon name="viewfinder" size={11} /> {lens}
                        </span>
                      )}
                    </div>
                  )}
                  {loc.tags.length > 0 && (
                    <div className="project-card-tags">
                      {loc.tags.map((tag) => (
                        <span key={tag} className="proj-tag-chip">
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="proj-location-actions">
                    <button
                      type="button"
                      className="btn grow"
                      onClick={() => void flyToProjectLocation(loc, project.id)}
                    >
                      <Icon name="globe" size={14} /> Fly to in Globe
                    </button>
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function LinkLocationsDialog({
  project,
  onClose
}: {
  project: Project
  onClose: () => void
}) {
  const bookmarks = useAppStore((s) => s.bookmarks)
  const coordFormat = useAppStore((s) => s.settings.coordFormat)
  const [query, setQuery] = useState('')
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef)

  const linkedSet = useMemo(() => new Set(project.locationIds), [project.locationIds])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = [...bookmarks].reverse()
    if (!q) return list
    return list.filter((b) =>
      [b.name, b.tags.join(' '), b.bestTime, b.notes]
        .join(' ')
        .toLowerCase()
        .includes(q)
    )
  }, [bookmarks, query])

  return (
    <div className="scrim center" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="panel dialog proj-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Link existing locations"
      >
        <div className="dialog-header">
          <h2>Link saved locations</h2>
          <button type="button" className="icon-btn small" title="Close" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="dialog-body proj-picker-body">
          <div className="proj-search-wrap" style={{ width: '100%' }}>
            <Icon name="search" size={14} />
            <input
              autoFocus
              className="proj-search-input"
              aria-label="Search saved locations"
              placeholder="Filter saved locations by name, tag, or note…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          <div className="proj-picker-list scroll">
            {bookmarks.length === 0 ? (
              <div className="muted small" style={{ padding: 14 }}>
                No saved locations yet. Scout spots in the 3D Globe and save them with Ctrl+B.
              </div>
            ) : filtered.length === 0 ? (
              <div className="muted small" style={{ padding: 14 }}>
                No saved locations match “{query}”.
              </div>
            ) : (
              filtered.map((b) => {
                const isLinked = linkedSet.has(b.id)
                return (
                  <button
                    key={b.id}
                    type="button"
                    className={`proj-picker-row ${isLinked ? 'linked' : ''}`}
                    onClick={() =>
                      void (isLinked ? unlinkLocationFromProject(project.id, b.id) : linkLocationToProject(project.id, b.id))
                    }
                  >
                    <div className="proj-mini-loc-thumb">
                      {b.photos[0] ? (
                        <img src={photoUrl(thumbFile(b.photos[0]))} alt="" loading="lazy" decoding="async" />
                      ) : (
                        <Icon name="pin" size={14} />
                      )}
                    </div>
                    <div className="proj-picker-info">
                      <div className="proj-picker-name">
                        <span className={`status-dot ${b.status}`} />
                        <span>{b.name}</span>
                      </div>
                      <div className="small faint truncate">
                        {formatLatLon(b.position.latitude, b.position.longitude, coordFormat)}
                        {b.tags.length > 0 ? ` · ${b.tags.join(', ')}` : ''}
                      </div>
                    </div>
                    <span className={`proj-picker-state ${isLinked ? 'linked' : ''}`}>
                      {isLinked ? (
                        <>
                          <Icon name="check" size={13} /> Linked
                        </>
                      ) : (
                        <>
                          <Icon name="plus" size={13} /> Link
                        </>
                      )}
                    </span>
                  </button>
                )
              })
            )}
          </div>

          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn primary proj-cta" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
