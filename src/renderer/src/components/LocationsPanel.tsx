import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { MAX_BEST_TIME, MAX_NOTES, matchesFilter, normalizeTag, photoUrl, tagCounts, thumbFile } from '@shared/locations'
import type { Bookmark, LocationStatus, SavedProfile } from '@shared/types'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { formatLatLon } from '@shared/coords'
import {
  addPhotoFiles,
  deleteLocation,
  defaultProfileName,
  deleteProfile,
  flyToBookmark,
  openProfile,
  pickPhotos,
  removePhoto,
  renameProfile,
  saveCurrentView,
  saveProfile,
  setLocationToCurrentView,
  updateLocation
} from '../lib/locations'
import { shortcutLabel } from '../lib/platform'
import { formatClock, formatShortDate, utcToZoned } from '../lib/time'
import { useAppStore, appState } from '../store/appStore'
import { Icon } from './Icon'

const STATUS_LABEL: Record<LocationStatus, string> = { 'to-visit': 'To visit', visited: 'Visited' }

function savedTime(b: Bookmark): string | null {
  if (!b.time) return null
  const t = utcToZoned(Date.parse(b.time.utc), b.time.timeZone)
  return `${formatShortDate(t.date)} ${formatClock(t.minutes)}`
}

/** Saved scouting locations: the list with its filters, or one location's editor. */
export function LocationsPanel() {
  const open = useAppStore((s) => s.panels.bookmarks)
  const active = useAppStore((s) => s.bookmarks.find((b) => b.id === s.activeLocation) ?? null)
  const togglePanel = useAppStore((s) => s.togglePanel)
  if (!open) return null
  return (
    <div className="panel side-panel left locations-panel" role="region" aria-label="Saved locations">
      {active ? (
        <LocationEditor key={active.id} location={active} />
      ) : (
        <>
          <div className="panel-header">
            Saved locations <span className="spacer" />
            <button className="icon-btn small" title="Close" aria-label="Close saved locations" onClick={() => togglePanel('bookmarks', false)}>
              <Icon name="close" size={14} />
            </button>
          </div>
          <LocationList />
        </>
      )}
    </div>
  )
}

function LocationList() {
  const bookmarks = useAppStore((s) => s.bookmarks)
  const profiles = useAppStore((s) => s.profiles)
  const filter = useAppStore((s) => s.locationFilter)
  const includeTime = useAppStore((s) => s.settings.bookmarkIncludeTime)
  const patch = useAppStore((s) => s.patchSettings)
  const set = useAppStore((s) => s.set)
  const tags = useMemo(() => tagCounts(bookmarks), [bookmarks])
  const shown = useMemo(() => [...bookmarks].reverse().filter((b) => matchesFilter(b, filter)), [bookmarks, filter])
  const general = profiles.filter((p) => !p.locationId)
  // Selected tags no longer in use (their last location was deleted or retagged) stop filtering.
  useEffect(() => {
    const used = filter.tags.filter((t) => tags.some((x) => x.tag === t))
    if (used.length !== filter.tags.length) set({ locationFilter: { ...filter, tags: used } })
  }, [tags, filter, set])

  const setStatus = (status: LocationStatus | 'all') => set({ locationFilter: { ...filter, status } })
  const toggleTag = (tag: string) =>
    set({ locationFilter: { ...filter, tags: filter.tags.includes(tag) ? filter.tags.filter((t) => t !== tag) : [...filter.tags, tag] } })

  return (
    <>
      <div className="panel-body">
        <div className="row">
          <button className="btn primary grow" onClick={() => void saveCurrentView({ edit: true })}>
            <Icon name="plus" size={14} /> Save current view
          </button>
        </div>
        <label className="switch small muted" style={{ marginTop: 6 }}>
          <input type="checkbox" checked={includeTime} onChange={(e) => patch((d) => void (d.bookmarkIncludeTime = e.target.checked))} />
          Include simulated date & time
        </label>
        {bookmarks.length > 0 && (
          <div className="location-filters">
            <div className="segmented" role="group" aria-label="Filter by status">
              {(['all', 'to-visit', 'visited'] as const).map((s) => (
                <button key={s} className={filter.status === s ? 'active' : ''} aria-pressed={filter.status === s} onClick={() => setStatus(s)}>
                  {s === 'all' ? 'All' : STATUS_LABEL[s]}
                </button>
              ))}
            </div>
            {tags.length > 0 && (
              <div className="tag-row" role="group" aria-label="Filter by tag">
                {tags.map(({ tag, count }) => (
                  <button
                    key={tag}
                    className={`tag ${filter.tags.includes(tag) ? 'active' : ''}`}
                    aria-pressed={filter.tags.includes(tag)}
                    title={`${count} location${count === 1 ? '' : 's'}`}
                    onClick={() => toggleTag(tag)}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="scroll" style={{ padding: '0 6px 8px' }}>
        {bookmarks.length === 0 && (
          <div className="muted" style={{ padding: '6px 8px 10px' }}>
            No saved locations yet. Press <span className="kbd">{shortcutLabel('Mod+B')}</span> to save the current view.
          </div>
        )}
        {bookmarks.length > 0 && shown.length === 0 && (
          <div className="muted" style={{ padding: '6px 8px 10px' }}>
            No location matches the filter.
          </div>
        )}
        {shown.map((b) => (
          <LocationRow key={b.id} location={b} />
        ))}
        {general.length > 0 && (
          <>
            <div className="list-heading">Saved profiles</div>
            {general.map((p) => (
              <ProfileRow key={p.id} profile={p} />
            ))}
          </>
        )}
      </div>
    </>
  )
}

function LocationRow({ location: b }: { location: Bookmark }) {
  const set = useAppStore((s) => s.set)
  const time = savedTime(b)
  const cover = b.photos[0]
  const detail = [b.tags.join(', '), time].filter(Boolean).join(' · ')
  return (
    <div
      className="bookmark location-row"
      role="button"
      tabIndex={0}
      title="Fly there and restore its time"
      onClick={() => flyToBookmark(b)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          flyToBookmark(b)
        }
      }}
    >
      <span className={`status-dot ${b.status}`} title={STATUS_LABEL[b.status]} aria-label={STATUS_LABEL[b.status]} />
      <div className="name">
        {b.name}
        {detail && <div className="small faint">{detail}</div>}
      </div>
      {cover && <img className="location-cover" src={photoUrl(thumbFile(cover))} alt="" loading="lazy" decoding="async" />}
      <div className="actions">
        <button
          className="icon-btn small"
          title="Edit notes, tags, photos"
          aria-label={`Edit ${b.name}`}
          onClick={(e) => {
            e.stopPropagation()
            set({ activeLocation: b.id })
          }}
        >
          <Icon name="edit" size={14} />
        </button>
      </div>
    </div>
  )
}

/** A text field saved when it loses focus (and, for long text, shortly after typing stops). */
function DraftField({
  value,
  onCommit,
  multiline,
  ...rest
}: {
  value: string
  onCommit: (value: string) => void
  multiline?: boolean
  placeholder?: string
  maxLength?: number
  'aria-label': string
  className?: string
}) {
  const [draft, setDraft] = useState(value)
  const timer = useRef<number | null>(null)
  const latest = useRef({ draft, value, onCommit })
  useEffect(() => {
    latest.current = { draft, value, onCommit }
  })
  const commit = useRef(() => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
    const { draft: d, value: v, onCommit: fn } = latest.current
    if (d !== v) fn(d)
  }).current
  // Leaving the editor (or switching location) still saves what was typed.
  useEffect(() => commit, [commit])
  // A change saved elsewhere shows unless an edit is pending here.
  const [shown, setShown] = useState(value)
  if (shown !== value) {
    setShown(value)
    if (timer.current === null) setDraft(value)
  }
  const onChange = (next: string) => {
    setDraft(next)
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(commit, 800)
  }
  return multiline ? (
    <textarea className="input textarea" value={draft} onChange={(e) => onChange(e.target.value)} onBlur={commit} rows={5} {...rest} />
  ) : (
    <input
      className="input"
      value={draft}
      onChange={(e) => onChange(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
      {...rest}
    />
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="loc-field">
      <div className="loc-field-label">{label}</div>
      {children}
    </div>
  )
}

function LocationEditor({ location: b }: { location: Bookmark }) {
  const set = useAppStore((s) => s.set)
  const togglePanel = useAppStore((s) => s.togglePanel)
  const format = useAppStore((s) => s.settings.coordFormat)
  const profiles = useAppStore((s) => s.profiles).filter((p) => p.locationId === b.id)
  const hasPath = useAppStore((s) => !s.profile.active && s.profile.points.length > 1 && !s.profile.savedId)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const time = savedTime(b)

  return (
    <>
      <div className="panel-header">
        <button className="icon-btn small" title="Back to all locations" aria-label="Back to all locations" onClick={() => set({ activeLocation: null })}>
          <Icon name="chevronLeft" size={15} />
        </button>
        Location <span className="spacer" />
        <button className="icon-btn small" title="Close" aria-label="Close saved locations" onClick={() => (set({ activeLocation: null }), togglePanel('bookmarks', false))}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="scroll location-editor">
        <DraftField aria-label="Name" className="input location-name" value={b.name} maxLength={200} onCommit={(name) => void updateLocation(b.id, { name })} />
        <div className="row">
          <div className="segmented" role="group" aria-label="Status">
            {(['to-visit', 'visited'] as const).map((s) => (
              <button key={s} className={b.status === s ? 'active' : ''} aria-pressed={b.status === s} onClick={() => void updateLocation(b.id, { status: s })}>
                <span className={`status-dot ${s}`} /> {STATUS_LABEL[s]}
              </button>
            ))}
          </div>
        </div>
        <div className="row">
          <button className="btn grow" onClick={() => flyToBookmark(b)} title="Fly to the saved view and restore its time">
            <Icon name="pin" size={14} /> Fly there
          </button>
          <button className="btn grow" onClick={() => void setLocationToCurrentView(b.id)} title="Replace the saved view, time and spot with the current ones">
            Use current view
          </button>
        </div>
        <div className="small faint">
          {formatLatLon(b.position.latitude, b.position.longitude, format)}
          {time && ` · opens at ${time} (${b.time!.timeZone})`}
          {b.time && (
            <button className="link-btn" onClick={() => void updateLocation(b.id, { time: null })}>
              forget time
            </button>
          )}
        </div>

        <Field label="Best time">
          <DraftField aria-label="Best time" value={b.bestTime} maxLength={MAX_BEST_TIME} placeholder="e.g. Sunrise, late October, after snow" onCommit={(bestTime) => void updateLocation(b.id, { bestTime })} />
        </Field>
        <Field label="Tags">
          <TagEditor location={b} />
        </Field>
        <Field label="Notes">
          <DraftField aria-label="Notes" multiline value={b.notes} maxLength={MAX_NOTES} placeholder="Access, parking, compositions, hazards…" onCommit={(notes) => void updateLocation(b.id, { notes })} />
        </Field>
        <Field label={`Photos${b.photos.length ? ` (${b.photos.length})` : ''}`}>
          <PhotoGrid location={b} />
        </Field>
        <Field label="Elevation profiles">
          {profiles.map((p) => (
            <ProfileRow key={p.id} profile={p} />
          ))}
          {profiles.length === 0 && !hasPath && <div className="small faint">Draw a path (P), then save it here from the profile panel.</div>}
          {hasPath && (
            <button className="btn" onClick={() => void saveProfile(defaultProfileName(), b.id)} title="Save the path drawn on the map with this location">
              <Icon name="plus" size={14} /> Save drawn path here
            </button>
          )}
        </Field>

        <div className="row" style={{ marginTop: 6 }}>
          {confirmDelete ? (
            <>
              <span className="small grow">
                Delete with {b.photos.length} photo{b.photos.length === 1 ? '' : 's'}
                {profiles.length ? ` and ${profiles.length} profile${profiles.length === 1 ? '' : 's'}` : ''}?
              </span>
              <button className="btn danger" onClick={() => void deleteLocation(b.id)}>
                Delete
              </button>
              <button className="btn ghost" onClick={() => setConfirmDelete(false)}>
                Keep
              </button>
            </>
          ) : (
            <button className="btn ghost danger" onClick={() => setConfirmDelete(true)}>
              <Icon name="trash" size={14} /> Delete location
            </button>
          )}
        </div>
      </div>
    </>
  )
}

function TagEditor({ location: b }: { location: Bookmark }) {
  const all = useAppStore((s) => s.bookmarks)
  const [draft, setDraft] = useState('')
  const suggestions = useMemo(() => tagCounts(all).map((t) => t.tag).filter((t) => !b.tags.includes(t)), [all, b.tags])
  const add = (raw: string) => {
    const next = raw
      .split(',')
      .map(normalizeTag)
      .filter((t) => t && !b.tags.includes(t))
    if (next.length) void updateLocation(b.id, { tags: [...b.tags, ...next] })
    setDraft('')
  }
  return (
    <div className="tag-editor">
      {b.tags.map((t) => (
        <span key={t} className="tag active">
          {t}
          <button aria-label={`Remove tag ${t}`} onClick={() => void updateLocation(b.id, { tags: b.tags.filter((x) => x !== t) })}>
            <Icon name="close" size={11} />
          </button>
        </span>
      ))}
      <input
        className="tag-input"
        aria-label="Add tag"
        placeholder={b.tags.length ? 'Add tag' : 'Add tags: sunrise, lake…'}
        list={`tags-${b.id}`}
        value={draft}
        onChange={(e) => {
          // Typing or pasting a comma completes a tag.
          if (e.target.value.includes(',')) add(e.target.value)
          else setDraft(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') add(draft)
          else if (e.key === 'Backspace' && !draft && b.tags.length) void updateLocation(b.id, { tags: b.tags.slice(0, -1) })
        }}
        onBlur={() => draft.trim() && add(draft)}
      />
      <datalist id={`tags-${b.id}`}>
        {suggestions.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
    </div>
  )
}

function PhotoGrid({ location: b }: { location: Bookmark }) {
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const run = (job: () => Promise<void>) => {
    setBusy(true)
    void job().finally(() => setBusy(false))
  }
  const add = (files: FileList | null) => {
    if (files?.length) run(() => addPhotoFiles(b.id, Array.from(files)))
  }
  return (
    <div
      className={`photo-drop ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        add(e.dataTransfer.files)
      }}
    >
      {b.photos.length > 0 && (
        <div className="photo-grid">
          {b.photos.map((p) => (
            <div key={p.id} className="photo-thumb">
              <button className="photo-open" title={p.name} aria-label={`Show ${p.name}`} onClick={() => appState().set({ photoViewer: { locationId: b.id, photoId: p.id } })}>
                <img src={photoUrl(thumbFile(p))} alt={p.name} loading="lazy" decoding="async" />
              </button>
              <button className="photo-remove" title="Remove photo" aria-label={`Remove ${p.name}`} onClick={() => void removePhoto(b.id, p.id)}>
                <Icon name="close" size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
      <button className="btn" disabled={busy} onClick={() => run(() => pickPhotos(b.id))}>
        <Icon name="plus" size={14} /> {busy ? 'Adding…' : 'Add photos'}
      </button>
      <span className="small faint"> or drop images here</span>
    </div>
  )
}

function ProfileRow({ profile: p }: { profile: SavedProfile }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(p.name)
  const commit = () => {
    if (draft.trim() && draft.trim() !== p.name) void renameProfile(p.id, draft.trim())
    setEditing(false)
  }
  return (
    <div className="bookmark profile-row" role="button" tabIndex={0} title="Reopen this profile" onClick={() => !editing && openProfile(p)} onKeyDown={(e) => !editing && e.key === 'Enter' && openProfile(p)}>
      <Icon name="profile" size={15} style={{ flex: 'none', opacity: 0.7 }} />
      {editing ? (
        <input
          className="input grow"
          autoFocus
          aria-label="Profile name"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') setEditing(false)
            e.stopPropagation()
          }}
        />
      ) : (
        <div className="name">
          {p.name}
          <div className="small faint">{p.points.length} points</div>
        </div>
      )}
      {!editing && (
        <div className="actions">
          <button
            className="icon-btn small"
            title="Rename"
            aria-label={`Rename ${p.name}`}
            onClick={(e) => {
              e.stopPropagation()
              setDraft(p.name)
              setEditing(true)
            }}
          >
            <Icon name="edit" size={14} />
          </button>
          <button
            className="icon-btn small"
            title="Delete"
            aria-label={`Delete ${p.name}`}
            onClick={(e) => {
              e.stopPropagation()
              void deleteProfile(p.id)
            }}
          >
            <Icon name="trash" size={14} />
          </button>
        </div>
      )}
    </div>
  )
}

/** A reference photo at full size, with the location's others a click or arrow key away. */
export function PhotoViewer() {
  const viewer = useAppStore((s) => s.photoViewer)
  const location = useAppStore((s) => (viewer ? s.bookmarks.find((b) => b.id === viewer.locationId) : undefined))
  const index = location?.photos.findIndex((p) => p.id === viewer?.photoId) ?? -1
  if (!location || index < 0) return null
  return <PhotoDialog location={location} index={index} />
}

function PhotoDialog({ location, index }: { location: Bookmark; index: number }) {
  const set = useAppStore((s) => s.set)
  const ref = useRef<HTMLDivElement>(null)
  useDialogFocus(ref)
  const photos = location.photos
  const photo = photos[index]
  const go = (d: number) => set({ photoViewer: { locationId: location.id, photoId: photos[(index + d + photos.length) % photos.length].id } })
  return (
    <div
      className="scrim center photo-viewer"
      onClick={() => set({ photoViewer: null })}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') go(-1)
        else if (e.key === 'ArrowRight') go(1)
        else return
        e.preventDefault()
      }}
    >
      <div ref={ref} className="photo-frame" role="dialog" aria-modal="true" aria-label={`${location.name}: ${photo.name}`} onClick={(e) => e.stopPropagation()}>
        <img src={photoUrl(photo.file)} alt={photo.name} decoding="async" />
        <div className="row photo-caption">
          <span className="grow">
            {photo.name}
            <span className="faint">
              {' '}
              · {photo.width} × {photo.height} · {index + 1} / {photos.length}
            </span>
          </span>
          {photos.length > 1 && (
            <>
              <button className="icon-btn small" aria-label="Previous photo" onClick={() => go(-1)}>
                <Icon name="chevronLeft" size={15} />
              </button>
              <button className="icon-btn small" aria-label="Next photo" onClick={() => go(1)}>
                <Icon name="chevronRight" size={15} />
              </button>
            </>
          )}
          <button className="icon-btn small" aria-label="Close photo" onClick={() => set({ photoViewer: null })}>
            <Icon name="close" size={14} />
          </button>
        </div>
      </div>
    </div>
  )
}
