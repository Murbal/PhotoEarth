import { useEffect, useState } from 'react'
import { MAX_NOTE_BODY, MAX_NOTE_TITLE } from '@shared/moodboards'
import type { MoodboardNoteItem } from '@shared/types'
import { MarkdownPreview, toggleMarkdownCheckbox } from '../../projects/markdown'
import { moodboardState } from '../../../store/moodboardStore'

export function NoteCard({
  item,
  editing,
  onStopEdit
}: {
  item: MoodboardNoteItem
  editing: boolean
  onStopEdit: () => void
}) {
  const [titleDraft, setTitleDraft] = useState(item.title)
  const [bodyDraft, setBodyDraft] = useState(item.body)

  useEffect(() => {
    if (editing) {
      setTitleDraft(item.title)
      setBodyDraft(item.body)
    }
  }, [editing, item.title, item.body])

  const commit = () => {
    const nextTitle = titleDraft.trim().slice(0, MAX_NOTE_TITLE)
    const nextBody = bodyDraft.slice(0, MAX_NOTE_BODY)
    if (nextTitle !== item.title || nextBody !== item.body) {
      moodboardState().commitBoardChange((doc) => ({
        ...doc,
        items: doc.items.map((it) =>
          it.id === item.id && it.kind === 'note' ? { ...it, title: nextTitle, body: nextBody } : it
        )
      }))
    }
    onStopEdit()
  }

  const handleToggleCheckbox = (lineIndex: number, checked: boolean) => {
    const nextBody = toggleMarkdownCheckbox(item.body, lineIndex, checked)
    moodboardState().commitBoardChange((doc) => ({
      ...doc,
      items: doc.items.map((it) => (it.id === item.id && it.kind === 'note' ? { ...it, body: nextBody } : it))
    }))
  }

  return (
    <div
      className={`mb-note-card tint-${item.tint} ${item.isHeading ? 'is-heading' : ''}`}
      onDoubleClick={(e) => {
        e.stopPropagation()
        if (!item.locked) moodboardState().set({ editingItemId: item.id })
      }}
    >
      {editing ? (
        <div
          className="mb-note-editor"
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              commit()
            }
          }}
        >
          <input
            autoFocus={item.isHeading || !item.title}
            className={`mb-note-title-input ${item.isHeading ? 'heading' : ''}`}
            maxLength={MAX_NOTE_TITLE}
            placeholder={item.isHeading ? 'Section heading…' : 'Title (optional)'}
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && item.isHeading) {
                e.preventDefault()
                commit()
              }
            }}
          />
          {!item.isHeading && (
            <textarea
              autoFocus={!!item.title}
              className="mb-note-body-input scroll"
              maxLength={MAX_NOTE_BODY}
              placeholder="Write notes… Supports **bold**, *italic*, # headings, - lists, and - [ ] checklists"
              value={bodyDraft}
              onChange={(e) => setBodyDraft(e.target.value)}
            />
          )}
          <div className="mb-note-editor-footer">
            <span className="small faint">Markdown supported · Esc to finish</span>
            <button type="button" className="btn primary small" onClick={commit}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <div className="mb-note-view scroll">
          {item.title && <div className={`mb-note-title ${item.isHeading ? 'heading' : ''}`}>{item.title}</div>}
          {!item.isHeading && (
            <div className="mb-note-body" onPointerDown={(e) => {
              if ((e.target as HTMLElement).tagName === 'INPUT') e.stopPropagation()
            }}>
              {item.body.trim() ? (
                <MarkdownPreview body={item.body} onToggleCheckbox={handleToggleCheckbox} />
              ) : !item.title ? (
                <span className="faint small">Double-click to write a note…</span>
              ) : null}
            </div>
          )}
          {item.isHeading && !item.title && <span className="faint">Double-click to type heading…</span>}
        </div>
      )}
    </div>
  )
}
