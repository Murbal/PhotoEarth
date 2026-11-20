import { useRef } from 'react'
import { getEngine } from '../engine/instance'
import { useAppStore } from '../store/appStore'
import { Icon } from './Icon'

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
      className="panel compass"
      title="Heading — click to face north, drag to rotate"
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
      <svg viewBox="-30 -30 60 60">
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
    </div>
  )
}

function TiltWidget() {
  const pitch = useAppStore((s) => s.camera?.pitch ?? -45)
  const angle = Math.max(-90, Math.min(90, pitch))
  return (
    <div
      className="panel tilt-widget"
      title={`Tilt ${Math.round(angle)}° — click to toggle top-down / oblique (U)`}
      onClick={() => void getEngine()?.camera.toggleTilt()}
    >
      <svg width="30" height="30" viewBox="-15 -15 30 30">
        <path d="M-11 9 H11" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1.5" />
        <g transform={`rotate(${-angle})`}>
          <path d="M-2 0 H11" stroke="var(--accent)" strokeWidth="2.2" strokeLinecap="round" />
          <circle r="3" fill="var(--accent)" />
        </g>
      </svg>
    </div>
  )
}

export function RightRail() {
  const panels = useAppStore((s) => s.panels)
  const togglePanel = useAppStore((s) => s.togglePanel)
  const set = useAppStore((s) => s.set)
  const profileOn = useAppStore((s) => s.profile.active || s.profile.samples.length > 0)
  const eyeLevel = useAppStore((s) => s.eyeLevel)
  const flyMode = useAppStore((s) => s.flyMode)

  return (
    <div className="right-rail">
      <div className="panel toolbar">
        <button className={`icon-btn ${panels.time ? 'active' : ''}`} title="Time & sun (T)" onClick={() => togglePanel('time')}>
          <Icon name="sun" />
        </button>
        <button className={`icon-btn ${panels.elevation ? 'active' : ''}`} title="Elevation styling (L)" onClick={() => togglePanel('elevation')}>
          <Icon name="layers" />
        </button>
        <button
          className={`icon-btn ${profileOn ? 'active' : ''}`}
          title="Elevation profile (P)"
          onClick={() => {
            const e = getEngine()
            if (!e) return
            if (profileOn) e.profile.clear()
            else e.startProfile()
          }}
        >
          <Icon name="profile" />
        </button>
        <button className={`icon-btn ${panels.bookmarks ? 'active' : ''}`} title="Bookmarks" onClick={() => togglePanel('bookmarks')}>
          <Icon name="bookmark" />
        </button>
        <div className="divider" />
        <button className="icon-btn" title="Settings (Ctrl+,)" onClick={() => set({ settingsOpen: true })}>
          <Icon name="settings" />
        </button>
        <button className="icon-btn" title="Keyboard shortcuts (?)" onClick={() => set({ shortcutsOpen: true })}>
          <Icon name="help" />
        </button>
      </div>

      <div className="nav-widgets">
        <Compass />
        <TiltWidget />
        <div className="panel zoom-widget">
          <button className={`icon-btn small ${eyeLevel ? 'active' : ''}`} title="Eye level at cursor (G)" onClick={() => void getEngine()?.camera.goToEyeLevel()}>
            <Icon name="person" size={16} />
          </button>
          <button className={`icon-btn small ${flyMode ? 'active' : ''}`} title="Fly mode (F)" onClick={() => getEngine()?.camera.toggleFlyMode()}>
            <Icon name="plane" size={16} />
          </button>
          <button className="icon-btn small" title="Level horizon (R)" onClick={() => void getEngine()?.camera.levelHorizon()}>
            <Icon name="horizon" size={16} />
          </button>
        </div>
        <div className="panel zoom-widget">
          <button className="icon-btn small" title="Zoom in" onClick={() => void getEngine()?.camera.zoomBy(0.5)}>
            <Icon name="plus" size={16} />
          </button>
          <button className="icon-btn small" title="Zoom out" onClick={() => void getEngine()?.camera.zoomBy(2)}>
            <Icon name="minus" size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}
