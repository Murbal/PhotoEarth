import { useState } from 'react'
import { photoUrl, thumbFile } from '@shared/locations'
import { MAX_CAPTION } from '@shared/moodboards'
import type { MoodboardImageItem } from '@shared/types'
import { Icon } from '../../../components/Icon'
import { extractPaletteFromImageItems, openGlobeSnapshot } from '../../../lib/moodboards'
import { moodboardState } from '../../../store/moodboardStore'

export function ImageCard({
  item,
  zoom,
  selected,
  editing,
  onStopEdit
}: {
  item: MoodboardImageItem
  zoom: number
  selected: boolean
  editing: boolean
  onStopEdit: () => void
}) {
  const [captionDraft, setCaptionDraft] = useState(item.caption)
  // Use fast JPEG thumbnail when zoomed far out; swap to full-resolution original when zoomed in.
  const src = zoom < 0.65 ? photoUrl(thumbFile(item.photo)) : photoUrl(item.photo.file)

  const commitCaption = () => {
    const trimmed = captionDraft.trim().slice(0, MAX_CAPTION)
    if (trimmed !== item.caption) {
      moodboardState().commitBoardChange((doc) => ({
        ...doc,
        items: doc.items.map((it) => (it.id === item.id && it.kind === 'image' ? { ...it, caption: trimmed } : it))
      }))
    }
    onStopEdit()
  }

  return (
    <div className={`mb-image-card ${item.borderless ? 'borderless' : ''}`}>
      <div className="mb-image-media">
        <img
          src={src}
          alt={item.caption || item.photo.name}
          draggable={false}
          decoding="async"
        />

        {/* Top-left badges: 3D Globe snapshot jump & original web source */}
        <div className="mb-image-badges" onPointerDown={(e) => e.stopPropagation()}>
          {item.globe && (
            <button
              type="button"
              className="mb-badge globe"
              title={`Open this exact 3D Globe view${item.globe.label ? ` (${item.globe.label})` : ''}`}
              onClick={() => void openGlobeSnapshot(item.globe!)}
            >
              <Icon name="globe" size={12} />
              <span>{item.globe.label || '3D View'}</span>
            </button>
          )}
          {item.sourceUrl && (
            <button
              type="button"
              className="mb-badge source"
              title={`Open source: ${item.sourceTitle || item.sourceUrl}`}
              onClick={() => void window.photoearth.openExternal(item.sourceUrl!)}
            >
              <Icon name="external" size={11} />
              <span>{item.sourceTitle ? item.sourceTitle.slice(0, 26) : 'Source'}</span>
            </button>
          )}
        </div>

        {/* Hover quick actions */}
        <div className="mb-image-hover-actions" onPointerDown={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="mb-card-action-btn"
            title="Extract Color Palette"
            aria-label="Extract color palette"
            onClick={() => void extractPaletteFromImageItems([item])}
          >
            <Icon name="palette" size={13} />
          </button>
          <button
            type="button"
            className={`mb-card-action-btn ${item.borderless ? 'active' : ''}`}
            title={item.borderless ? 'Show frame & caption' : 'Borderless PureRef mode'}
            aria-label="Toggle borderless mode"
            onClick={() =>
              moodboardState().commitBoardChange((doc) => ({
                ...doc,
                items: doc.items.map((it) =>
                  it.id === item.id && it.kind === 'image' ? { ...it, borderless: !it.borderless } : it
                )
              }))
            }
          >
            <Icon name="fit" size={13} />
          </button>
        </div>
      </div>

      {!item.borderless && (editing || item.caption) && (
        <div
          className="mb-image-caption"
          onPointerDown={(e) => {
            if (editing) e.stopPropagation()
          }}
        >
          {editing ? (
            <input
              autoFocus
              className="mb-caption-input"
              maxLength={MAX_CAPTION}
              placeholder="Add caption…"
              value={captionDraft}
              onChange={(e) => setCaptionDraft(e.target.value)}
              onBlur={commitCaption}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitCaption()
                } else if (e.key === 'Escape') {
                  setCaptionDraft(item.caption)
                  onStopEdit()
                }
              }}
            />
          ) : (
            <span
              className="mb-caption-text"
              title={selected ? 'Double-click to edit caption' : item.caption}
              onDoubleClick={(e) => {
                e.stopPropagation()
                setCaptionDraft(item.caption)
                moodboardState().set({ editingItemId: item.id })
              }}
            >
              {item.caption}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
