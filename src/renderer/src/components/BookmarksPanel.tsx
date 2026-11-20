import { useState } from 'react'
import { deleteBookmark, flyToBookmark, renameBookmark, saveCurrentView } from '../lib/bookmarks'
import { formatClock, utcToZoned, formatShortDate } from '../lib/time'
import { useAppStore } from '../store/appStore'
import { Icon } from './Icon'

export function BookmarksPanel() {
  const open = useAppStore((s) => s.panels.bookmarks)
  const bookmarks = useAppStore((s) => s.bookmarks)
  const includeTime = useAppStore((s) => s.settings.bookmarkIncludeTime)
  const patch = useAppStore((s) => s.patchSettings)
  const togglePanel = useAppStore((s) => s.togglePanel)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  if (!open) return null

  const commit = (id: string) => {
    if (draft.trim()) void renameBookmark(id, draft.trim())
    setEditing(null)
  }

  return (
    <div className="panel side-panel left">
      <div className="panel-header">
        Bookmarks <span className="spacer" />
        <button className="icon-btn small" title="Close" onClick={() => togglePanel('bookmarks', false)}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="panel-body">
        <div className="row">
          <button className="btn primary grow" onClick={() => void saveCurrentView().then((b) => b && (setEditing(b.id), setDraft(b.name)))}>
            <Icon name="plus" size={14} /> Save current view
          </button>
        </div>
        <label className="switch small muted" style={{ marginTop: 6 }}>
          <input type="checkbox" checked={includeTime} onChange={(e) => patch((d) => void (d.bookmarkIncludeTime = e.target.checked))} />
          Include simulated date & time
        </label>
      </div>
      <div className="scroll" style={{ padding: '0 6px 8px' }}>
        {bookmarks.length === 0 && (
          <div className="muted" style={{ padding: '6px 8px 10px' }}>
            No bookmarks yet. Press <span className="kbd">Ctrl B</span> to save the current view.
          </div>
        )}
        {[...bookmarks].reverse().map((b) => {
          const t = b.time ? utcToZoned(Date.parse(b.time.utc), b.time.timeZone) : null
          return (
            <div key={b.id} className="bookmark" onClick={() => editing !== b.id && flyToBookmark(b)} title="Fly to this view">
              <Icon name={b.mode === 'elevation' ? 'layers' : 'pin'} size={15} style={{ flex: 'none', opacity: 0.7 }} />
              {editing === b.id ? (
                <input
                  className="input grow"
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={() => commit(b.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commit(b.id)
                    if (e.key === 'Escape') setEditing(null)
                    e.stopPropagation()
                  }}
                />
              ) : (
                <div className="name">
                  {b.name}
                  {t && (
                    <div className="small faint">
                      {formatShortDate(t.date)} {formatClock(t.minutes)}
                    </div>
                  )}
                </div>
              )}
              {editing !== b.id && (
                <div className="actions">
                  <button
                    className="icon-btn small"
                    title="Rename"
                    onClick={(e) => {
                      e.stopPropagation()
                      setEditing(b.id)
                      setDraft(b.name)
                    }}
                  >
                    <Icon name="edit" size={14} />
                  </button>
                  <button
                    className="icon-btn small"
                    title="Delete"
                    onClick={(e) => {
                      e.stopPropagation()
                      void deleteBookmark(b.id)
                    }}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
