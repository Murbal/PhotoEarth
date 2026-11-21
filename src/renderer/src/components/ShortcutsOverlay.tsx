import { useRef } from 'react'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { shortcutLabel } from '../lib/platform'
import { useAppStore } from '../store/appStore'
import { Icon } from './Icon'

const GROUPS: Array<[string, Array<[string, string]>]> = [
  [
    'Mouse',
    [
      ['Left-drag', 'Pan (grab the ground)'],
      ['Right-drag / Ctrl+Left-drag', 'Orbit around the point'],
      ['Middle-drag / Shift+Left-drag', 'Rotate heading around the point'],
      ['Scroll wheel', 'Zoom toward the cursor'],
      ['Double-click', 'Fly closer to the point'],
      ['Click', 'Inspect point (coordinates, elevation)']
    ]
  ],
  [
    'Trackpad',
    [
      ['Two-finger scroll', 'Pan (look around at eye level)'],
      ['Pinch', 'Zoom toward the cursor'],
      ['Alt/⌥ + two-finger scroll', 'Orbit around the point'],
      ['Click-drag', 'Pan (grab the ground)']
    ]
  ],
  [
    'Keyboard',
    [
      ['W A S D', 'Move (ground-relative)'],
      ['Q / E', 'Descend / ascend'],
      ['Arrow keys', 'Look around'],
      ['Shift / Alt (hold)', 'Faster / precise'],
      ['F', 'First-person fly mode (Esc exits)'],
      ['G', 'Eye level at the pin or cursor (again to leave)'],
      ['N', 'Face north'],
      ['U', 'Top-down view'],
      ['R', 'Level the horizon'],
      ['1 / 2', 'Photorealistic / Elevation mode'],
      ['M', 'Place names on / off']
    ]
  ],
  [
    'Tools & time',
    [
      [shortcutLabel('Mod+K'), 'Search & command palette'],
      [shortcutLabel('Mod+B'), 'Save bookmark'],
      [shortcutLabel('Mod+,'), 'Settings'],
      ['T', 'Time & sun panel'],
      ['L', 'Elevation styling panel'],
      ['P', 'Elevation profile'],
      ['Space', 'Play / pause sun (time panel open)'],
      ['[ / ]', 'Time ±15 min'],
      [shortcutLabel('Shift+[ / ]'), 'Date ±1 day'],
      ['Esc', 'Close / finish / clear marker'],
      ['?', 'This overlay']
    ]
  ]
]

export function ShortcutsOverlay() {
  const open = useAppStore((s) => s.shortcutsOpen)
  return open ? <ShortcutsDialog /> : null
}

function ShortcutsDialog() {
  const set = useAppStore((s) => s.set)
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef)
  const close = () => set({ shortcutsOpen: false })
  return (
    <div className="scrim center" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={dialogRef} tabIndex={-1} className="panel dialog" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" style={{ width: 'min(760px, calc(100% - 32px))' }}>
        <div className="dialog-header">
          <h2>Controls & shortcuts</h2>
          <button className="icon-btn small" title="Close" onClick={close}>
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="dialog-body">
          <div className="shortcut-grid">
            {GROUPS.map(([title, rows]) => (
              <div key={title} style={{ display: 'contents' }}>
                <h3>{title}</h3>
                {rows.map(([keys, label]) => (
                  <div key={keys} className="shortcut-row">
                    <span className="muted">{label}</span>
                    <span className="kbd">{keys}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
