import { useRef } from 'react'
import { runCommand } from '../commands'
import { getEngine } from '../engine/instance'
import { shortcutLabel } from '../lib/platform'
import { haversine } from '../lib/profile'
import { useAppStore } from '../store/appStore'
import { Icon, type IconName } from './Icon'

/** A rail button whose name and shortcut appear beside it at once on hover or focus. */
function RailButton({
  icon,
  label,
  keys,
  active,
  pressed,
  small,
  onClick
}: {
  icon: IconName
  label: string
  keys?: string
  active?: boolean
  /** For toggles: exposes the on/off state. */
  pressed?: boolean
  small?: boolean
  onClick: () => void
}) {
  return (
    <button
      className={`icon-btn rail-btn ${small ? 'small' : ''} ${active ? 'active' : ''}`}
      aria-label={label}
      aria-keyshortcuts={keys}
      aria-pressed={pressed}
      onClick={onClick}
    >
      <Icon name={icon} size={small ? 16 : 18} />
      <Tip label={label} keys={keys} />
    </button>
  )
}

function Tip({ label, keys }: { label: string; keys?: string }) {
  return (
    <span className="rail-tip" aria-hidden="true">
      {label}
      {keys && <span className="kbd">{keys}</span>}
    </span>
  )
}

function Compass() {
  const heading = useAppStore((s) => s.camera?.heading ?? 0)
  const drag = useRef<{ angle: number; moved: boolean } | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  const angleOf = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect()
    return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2))
  }

  return (
    <div
      ref={ref}
      className="panel compass rail-btn"
      role="button"
      tabIndex={0}
      aria-label={`Heading ${Math.round(((heading % 360) + 360) % 360)}°. Face north`}
      aria-keyshortcuts="N"
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          void getEngine()?.camera.resetNorth()
        }
      }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { angle: angleOf(e), moved: false }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        const a = angleOf(e)
        let delta = a - d.angle
        if (delta > Math.PI) delta -= 2 * Math.PI
        if (delta < -Math.PI) delta += 2 * Math.PI
        if (Math.abs(delta) > 0.002) {
          d.moved = true
          d.angle = a
          // Turning the dial clockwise turns the north marker clockwise (heading decreases).
          getEngine()?.camera.rotateHeadingBy(delta)
        }
      }}
      onPointerUp={() => {
        if (drag.current && !drag.current.moved) void getEngine()?.camera.resetNorth()
        drag.current = null
      }}
    >
      <svg viewBox="-30 -30 60 60" aria-hidden="true">
        <circle r="27" fill="none" stroke="currentColor" strokeOpacity="0.15" strokeWidth="2" />
        {Array.from({ length: 12 }, (_, i) => (
          <line
            key={i}
            x1="0"
            y1="-27"
            x2="0"
            y2={i % 3 === 0 ? -22 : -24.5}
            stroke="currentColor"
            strokeOpacity="0.4"
            strokeWidth="1.2"
            transform={`rotate(${i * 30 - heading})`}
          />
        ))}
        <g transform={`rotate(${-heading})`}>
          <path d="M0 -19 L5 0 L0 -3 L-5 0 Z" fill="#ff5d5d" />
          <path d="M0 19 L5 0 L0 3 L-5 0 Z" fill="currentColor" fillOpacity="0.45" />
        </g>
        <text
          x={Math.sin((-heading * Math.PI) / 180) * 21.5}
          y={-Math.cos((-heading * Math.PI) / 180) * 21.5 + 3}
          textAnchor="middle"
          fontSize="8"
          fontWeight="700"
          fill="#ff7a7a"
        >
          N
        </text>
      </svg>
      <Tip label="Face north · drag to rotate" keys="N" />
    </div>
  )
}

function TiltWidget() {
  const pitch = useAppStore((s) => s.camera?.pitch ?? -45)
  const angle = Math.max(-90, Math.min(90, pitch))
  return (
    <button
      className="panel tilt-widget rail-btn"
      aria-label={`Tilt ${Math.round(angle)}°. Toggle top-down / oblique view`}
      aria-keyshortcuts="U"
      onClick={() => void getEngine()?.camera.toggleTilt()}
    >
      <svg width="30" height="30" viewBox="-15 -15 30 30" aria-hidden="true">
        <path d="M-11 9 H11" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1.5" />
        <g transform={`rotate(${-angle})`}>
          <path d="M-2 0 H11" stroke="var(--accent)" strokeWidth="2.2" strokeLinecap="round" />
          <circle r="3" fill="var(--accent)" />
        </g>
      </svg>
      <Tip label={`Tilt ${Math.round(angle)}° · top-down / oblique`} keys="U" />
    </button>
  )
}

export function RightRail() {
  const panels = useAppStore((s) => s.panels)
  const togglePanel = useAppStore((s) => s.togglePanel)
  const set = useAppStore((s) => s.set)
  const profileOn = useAppStore((s) => s.profile.active || s.profile.samples.length > 0)
  const horizonOpen = useAppStore((s) => s.horizon.open)
  const alignmentOpen = useAppStore((s) => s.alignment.open)
  const viewshedOpen = useAppStore((s) => s.viewshed.open)
  const eyeLevel = useAppStore((s) => s.eyeLevel)
  const flyMode = useAppStore((s) => s.flyMode)
  // Where Eye level stands (Engine.eyeLevelSpot): the inspect marker, then the search pin.
  const pin = useAppStore((s) => s.inspect ?? s.destination)
  const camera = useAppStore((s) => s.camera)
  const pinElsewhere = !!pin && (!camera || haversine(pin, camera) > 5)
  const placeLabels = useAppStore((s) => s.settings.placeLabels)
  const lightPollution = useAppStore((s) => s.settings.lightPollution.enabled)
  const viewfinder = useAppStore((s) => s.viewfinder)
  const patchSettings = useAppStore((s) => s.patchSettings)
  const mapOpen = useAppStore((s) => s.settings.map.open)

  // Map mode (§5.5): the 3D tools and camera widgets would act on the hidden 3D view.
  if (mapOpen) {
    return (
      <div className="right-rail">
        <div className="panel toolbar" role="toolbar" aria-label="Tools" aria-orientation="vertical">
          <RailButton icon="bookmark" label="Saved locations" active={panels.bookmarks} pressed={panels.bookmarks} onClick={() => togglePanel('bookmarks')} />
          <div className="divider" />
          <RailButton icon="settings" label="Settings" keys={shortcutLabel('Mod+,')} onClick={() => set({ settingsOpen: true })} />
          <RailButton icon="help" label="Controls & shortcuts" keys="?" onClick={() => set({ shortcutsOpen: true })} />
        </div>
        <div className="nav-widgets" role="toolbar" aria-label="Map" aria-orientation="vertical">
          <div className="panel zoom-widget">
            <RailButton small icon="plus" label="Zoom in" keys="+" onClick={() => runCommand('zoom-in')} />
            <RailButton small icon="minus" label="Zoom out" keys="−" onClick={() => runCommand('zoom-out')} />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="right-rail">
      <div className="panel toolbar" role="toolbar" aria-label="Tools" aria-orientation="vertical">
        <RailButton icon="sun" label="Time & sun" keys="T" active={panels.time} pressed={panels.time} onClick={() => togglePanel('time')} />
        <RailButton
          icon="layers"
          label="Elevation styling & light pollution"
          keys="L"
          active={panels.elevation}
          pressed={panels.elevation}
          onClick={() => togglePanel('elevation')}
        />
        <RailButton
          icon="profile"
          label={profileOn ? 'Elevation profile: clear path' : 'Elevation profile: draw a path'}
          keys="P"
          active={profileOn}
          pressed={profileOn}
          onClick={() => {
            const e = getEngine()
            if (!e) return
            if (profileOn) e.profile.clear()
            else e.startProfile()
          }}
        />
        <RailButton
          icon="panorama"
          label={horizonOpen ? 'Horizon panorama: close' : 'Horizon panorama: skyline, sun & moon paths'}
          keys="H"
          active={horizonOpen}
          pressed={horizonOpen}
          onClick={() => getEngine()?.toggleHorizon()}
        />
        <RailButton
          icon="viewshed"
          label={viewshedOpen ? 'Viewshed analysis: clear overlay' : 'Viewshed analysis: line-of-sight overlay'}
          keys={shortcutLabel('Shift+V')}
          active={viewshedOpen}
          pressed={viewshedOpen}
          onClick={() => getEngine()?.toggleViewshed()}
        />
        <RailButton
          icon="alignment"
          label={alignmentOpen ? 'Shot alignment: close' : 'Shot alignment: camera → subject & sun/moon date finder'}
          keys="X"
          active={alignmentOpen}
          pressed={alignmentOpen}
          onClick={() => getEngine()?.toggleAlignment()}
        />
        <RailButton
          icon="viewfinder"
          label="Viewfinder: lens, crop frame & guides"
          keys="V"
          active={viewfinder}
          pressed={viewfinder}
          onClick={() => set({ viewfinder: !viewfinder })}
        />
        <RailButton
          icon="labels"
          label="Place names"
          keys="M"
          active={placeLabels}
          pressed={placeLabels}
          onClick={() => patchSettings((d) => void (d.placeLabels = !d.placeLabels))}
        />
        <RailButton
          icon="night"
          label={lightPollution ? 'Light pollution: hide' : 'Light pollution: sky brightness & Bortle estimate'}
          keys="K"
          active={lightPollution}
          pressed={lightPollution}
          onClick={() => runCommand('toggle-light-pollution')}
        />
        <RailButton icon="bookmark" label="Saved locations" active={panels.bookmarks} pressed={panels.bookmarks} onClick={() => togglePanel('bookmarks')} />
        <div className="divider" />
        <RailButton icon="settings" label="Settings" keys={shortcutLabel('Mod+,')} onClick={() => set({ settingsOpen: true })} />
        <RailButton icon="help" label="Controls & shortcuts" keys="?" onClick={() => set({ shortcutsOpen: true })} />
      </div>

      <div className="nav-widgets" role="toolbar" aria-label="Camera" aria-orientation="vertical">
        <Compass />
        <TiltWidget />
        <div className="panel zoom-widget">
          <RailButton
            small
            icon="person"
            label={
              eyeLevel && !pinElsewhere ? 'Leave eye level' : pin ? 'Eye level at the pin (1.7 m)' : 'Eye level at cursor (1.7 m)'
            }
            keys="G"
            active={eyeLevel}
            pressed={eyeLevel}
            onClick={() => void getEngine()?.toggleEyeLevel()}
          />
          <RailButton
            small
            icon="plane"
            label="Fly mode (first person)"
            keys="F"
            active={flyMode}
            pressed={flyMode}
            onClick={() => getEngine()?.camera.toggleFlyMode()}
          />
          <RailButton small icon="horizon" label="Level horizon" keys="R" onClick={() => void getEngine()?.camera.levelHorizon()} />
        </div>
        <div className="panel zoom-widget">
          <RailButton small icon="plus" label="Zoom in" keys="+" onClick={() => void getEngine()?.camera.zoomBy(0.5)} />
          <RailButton small icon="minus" label="Zoom out" keys="−" onClick={() => void getEngine()?.camera.zoomBy(2)} />
        </div>
      </div>
    </div>
  )
}
