import { useEffect, useState } from 'react'
import { MAX_GROUP_TITLE } from '@shared/moodboards'
import type { MoodboardGroupItem } from '@shared/types'
import { Icon } from '../../../components/Icon'
import { moodboardState } from '../../../store/moodboardStore'

export function GroupCard({
  item,
  containedCount,
  editing,
  onStopEdit
}: {
  item: MoodboardGroupItem
  containedCount: number
  editing: boolean
  onStopEdit: () => void
}) {
  const [titleDraft, setTitleDraft] = useState(item.title)

  useEffect(() => {
    if (editing) setTitleDraft(item.title)
  }, [editing, item.title])

  const commit = () => {
    const clean = titleDraft.trim().slice(0, MAX_GROUP_TITLE) || 'Section'
    if (clean !== item.title) {
      moodboardState().commitBoardChange((doc) => ({
        ...doc,
        items: doc.items.map((it) => (it.id === item.id && it.kind === 'group' ? { ...it, title: clean } : it))
      }))
    }
    onStopEdit()
  }

  const toggleCollapse = () => {
    moodboardState().commitBoardChange((doc) => ({
      ...doc,
      items: doc.items.map((it) =>
        it.id === item.id && it.kind === 'group' ? { ...it, collapsed: !it.collapsed } : it
      )
    }))
  }

  const toggleLock = () => {
    moodboardState().commitBoardChange((doc) => ({
      ...doc,
      items: doc.items.map((it) => (it.id === item.id ? { ...it, locked: !it.locked } : it))
    }))
  }

  return (
    <div className={`mb-group-card tint-${item.tint} ${item.collapsed ? 'collapsed' : ''}`}>
      <div
        className="mb-group-header"
        onDoubleClick={(e) => {
          e.stopPropagation()
          if (!item.locked) moodboardState().set({ editingItemId: item.id })
        }}
      >
        <button
          type="button"
          className="mb-mini-btn"
          title={item.collapsed ? 'Expand group' : 'Collapse group'}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={toggleCollapse}
        >
          <Icon name={item.collapsed ? 'chevronRight' : 'chevronDown'} size={12} />
        </button>

        {editing ? (
          <input
            autoFocus
            className="mb-inline-title-input"
            maxLength={MAX_GROUP_TITLE}
            value={titleDraft}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commit()
              } else if (e.key === 'Escape') {
                setTitleDraft(item.title)
                onStopEdit()
              }
            }}
          />
        ) : (
          <span className="mb-group-title truncate">{item.title}</span>
        )}

        <span className="mb-group-count">
          {containedCount} {containedCount === 1 ? 'item' : 'items'}
        </span>

        <button
          type="button"
          className={`mb-mini-btn ${item.locked ? 'active' : ''}`}
          title={item.locked ? 'Unlock group' : 'Lock group'}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={toggleLock}
        >
          <Icon name={item.locked ? 'lock' : 'unlock'} size={11} />
        </button>
      </div>
    </div>
  )
}
