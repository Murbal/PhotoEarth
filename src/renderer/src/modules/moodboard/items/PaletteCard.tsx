import { useState } from 'react'
import { MAX_PALETTE_COLORS, MAX_PALETTE_TITLE } from '@shared/moodboards'
import { normalizeHexColor } from '@shared/projects'
import type { MoodboardPaletteItem } from '@shared/types'
import { Icon } from '../../../components/Icon'
import { sendPaletteToProjectColorStory } from '../../../lib/moodboards'
import { shellState } from '../../../shell/shellStore'
import { moodboardState } from '../../../store/moodboardStore'

export function PaletteCard({
  item,
  selected,
  editing,
  onStopEdit
}: {
  item: MoodboardPaletteItem
  selected: boolean
  editing: boolean
  onStopEdit: () => void
}) {
  const [titleDraft, setTitleDraft] = useState(item.title)
  const [addingColor, setAddingColor] = useState(false)
  const [newColor, setNewColor] = useState('#4fb3ff')

  const updatePalette = (patch: Partial<Pick<MoodboardPaletteItem, 'title' | 'colors'>>) => {
    moodboardState().commitBoardChange((doc) => ({
      ...doc,
      items: doc.items.map((it) => (it.id === item.id && it.kind === 'palette' ? { ...it, ...patch } : it))
    }))
  }

  const commitTitle = () => {
    const clean = titleDraft.trim().slice(0, MAX_PALETTE_TITLE) || 'Color Palette'
    if (clean !== item.title) updatePalette({ title: clean })
    onStopEdit()
  }

  const copySwatch = (hex: string) => {
    void navigator.clipboard.writeText(hex).then(() => shellState().showToast(`Copied ${hex.toUpperCase()}`))
  }

  const addSwatch = () => {
    const normalized = normalizeHexColor(newColor)
    if (!normalized) return
    if (item.colors.includes(normalized) || item.colors.length >= MAX_PALETTE_COLORS) {
      setAddingColor(false)
      return
    }
    updatePalette({ colors: [...item.colors, normalized] })
    setAddingColor(false)
  }

  const removeSwatch = (hex: string) => {
    if (item.colors.length <= 1) return
    updatePalette({ colors: item.colors.filter((c) => c !== hex) })
  }

  return (
    <div className="mb-palette-card">
      <div className="mb-palette-header">
        <Icon name="palette" size={13} style={{ color: 'var(--accent)', flex: 'none' }} />
        {editing ? (
          <input
            autoFocus
            className="mb-inline-title-input"
            maxLength={MAX_PALETTE_TITLE}
            value={titleDraft}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitTitle()
              } else if (e.key === 'Escape') {
                setTitleDraft(item.title)
                onStopEdit()
              }
            }}
          />
        ) : (
          <span
            className="mb-palette-title truncate"
            onDoubleClick={(e) => {
              e.stopPropagation()
              setTitleDraft(item.title)
              moodboardState().set({ editingItemId: item.id })
            }}
          >
            {item.title}
          </span>
        )}
        <div className="mb-palette-actions" onPointerDown={(e) => e.stopPropagation()}>
          {item.colors.length < MAX_PALETTE_COLORS && (
            <button
              type="button"
              className="mb-mini-btn"
              title="Add swatch"
              aria-label="Add color swatch"
              onClick={() => setAddingColor((v) => !v)}
            >
              <Icon name="plus" size={12} />
            </button>
          )}
          <button
            type="button"
            className="mb-mini-btn accent"
            title="Send to Project Color Story"
            onClick={() => void sendPaletteToProjectColorStory(item.colors)}
          >
            <Icon name="projects" size={12} />
            <span>Sync</span>
          </button>
        </div>
      </div>

      <div className="mb-palette-swatches" onPointerDown={(e) => e.stopPropagation()}>
        {item.colors.map((hex) => (
          <div key={hex} className="mb-swatch-col">
            <button
              type="button"
              className="mb-swatch-chip"
              style={{ background: hex }}
              title={`Click to copy ${hex.toUpperCase()}`}
              onClick={() => copySwatch(hex)}
            />
            <span className="mb-swatch-hex mono">{hex.toUpperCase()}</span>
            {selected && item.colors.length > 1 && (
              <button
                type="button"
                className="mb-swatch-remove"
                aria-label={`Remove ${hex}`}
                onClick={() => removeSwatch(hex)}
              >
                <Icon name="close" size={9} />
              </button>
            )}
          </div>
        ))}
      </div>

      {addingColor && (
        <div className="mb-palette-adder" onPointerDown={(e) => e.stopPropagation()}>
          <input
            type="color"
            value={newColor}
            onChange={(e) => setNewColor(e.target.value)}
            aria-label="Pick color"
          />
          <input
            className="input mono small grow"
            value={newColor}
            maxLength={7}
            onChange={(e) => setNewColor(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addSwatch()}
          />
          <button type="button" className="btn primary small" onClick={addSwatch}>
            Add
          </button>
        </div>
      )}
    </div>
  )
}
