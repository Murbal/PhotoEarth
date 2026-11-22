import { useRef } from 'react'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { shortcutLabel } from '../lib/platform'
import { useShellStore } from '../shell/shellStore'
import { Icon } from './Icon'

type ShortcutGroup = [string, Array<[string, string]>]

const GLOBAL_GROUPS: ShortcutGroup[] = [
  [
    'Workspace',
    [
      [shortcutLabel('Mod+1'), 'Switch to Projects Hub'],
      [shortcutLabel('Mod+2'), 'Switch to 3D Globe'],
      [shortcutLabel('Mod+3'), 'Switch to Moodboards'],
      [shortcutLabel('Mod+K'), 'Search & command palette'],
      [shortcutLabel('Mod+,'), 'Settings'],
      ['?', 'This overlay']
    ]
  ]
]

const PROJECTS_GROUPS: ShortcutGroup[] = [
  [
    'Projects Hub',
    [
      ['N', 'New project (on Projects index)'],
      ['/', 'Focus search filter (on Projects index)'],
      ['Esc', 'Back to Projects index / close dialog']
    ]
  ]
]

const MOODBOARD_GROUPS: ShortcutGroup[] = [
  [
    'Canvas navigation',
    [
      ['Space + Left-drag / Middle-drag', 'Pan infinite canvas'],
      ['Scroll wheel / Pinch', 'Zoom toward cursor (10%–400%)'],
      ['F', 'Fit selection (or entire board)'],
      ['0', 'Reset zoom to 100%'],
      ['Tab', 'Presentation Mode (hide all chrome)'],
      ['B', 'Toggle Inspiration Browser panel']
    ]
  ],
  [
    'Tools & editing',
    [
      ['V / T / G / C', 'Select / Note / Group Frame / Connector'],
      ['I', 'Add image from disk'],
      [shortcutLabel('Mod+V'), 'Paste image or text onto canvas'],
      [shortcutLabel('Mod+A'), 'Select all items'],
      [shortcutLabel('Mod+D'), 'Duplicate selection'],
      ['[ / ]', 'Send to back / Bring to front'],
      [shortcutLabel('Mod+Z'), 'Undo'],
      [shortcutLabel('Mod+Shift+Z'), 'Redo'],
      ['Delete / Backspace', 'Delete selected items or connector'],
      ['Shift + Resize', 'Free-stretch image (unlock aspect ratio)']
    ]
  ]
]

const GLOBE_GROUPS: ShortcutGroup[] = [
  [
    'Mouse',
    [
      ['Left-drag', 'Pan (grab the ground)'],
      ['Right-drag / Ctrl+Left-drag', 'Orbit around the point'],
      ['Middle-drag / Shift+Left-drag', 'Rotate heading around the point'],
      ['Scroll wheel', 'Zoom toward the cursor'],
      ['Double-click', 'Fly closer to the point'],
      ['Click', 'Inspect point (coordinates, elevation, sky brightness)']
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
      ['1 / 2', 'Photorealistic 3D / Map mode'],
      ['Arrows / W A S D (Map)', 'Pan the map (Shift: faster)'],
      ['M', 'Place names on / off'],
      ['K', 'Light pollution overlay on / off']
    ]
  ],
  [
    'Tools & time',
    [
      [shortcutLabel('Mod+B'), 'Save location (links to active project when on)'],
      ['T', 'Time & sun panel'],
      ['L', 'Layers: light pollution, viewshed, exaggeration'],
      ['P', 'Elevation profile'],
      ['H', 'Horizon panorama: skyline, sun & moon paths'],
      [shortcutLabel('Shift+V'), 'Viewshed analysis: line-of-sight overlay'],
      ['X', 'Shot alignment: camera → subject & sun/moon finder'],
      ['V', 'Viewfinder: lens, crop frame & guides'],
      [', / .', 'Viewfinder: shorter / longer focal length preset'],
      [shortcutLabel('Shift+, / .'), 'Viewfinder: focal length ∓5 %'],
      ['Space', 'Play / pause sun (time panel open)'],
      ['[ / ]', 'Time ±15 min'],
      [shortcutLabel('Shift+[ / ]'), 'Date ±1 day'],
      ['Esc', 'Close / finish / clear marker']
    ]
  ]
]

export function ShortcutsOverlay() {
  const open = useShellStore((s) => s.shortcutsOpen)
  return open ? <ShortcutsDialog /> : null
}

function ShortcutsDialog() {
  const set = useShellStore((s) => s.set)
  const activeModule = useShellStore((s) => s.activeModule)
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef)
  const close = () => set({ shortcutsOpen: false })
  const moduleGroups =
    activeModule === 'projects' ? PROJECTS_GROUPS : activeModule === 'moodboard' ? MOODBOARD_GROUPS : GLOBE_GROUPS
  const groups = [...GLOBAL_GROUPS, ...moduleGroups]
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
            {groups.map(([title, rows]) => (
              <div key={title} style={{ display: 'contents' }}>
                <h3>{title}</h3>
                {rows.map(([keys, label]) => (
                  <div key={`${title}-${keys}`} className="shortcut-row">
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
