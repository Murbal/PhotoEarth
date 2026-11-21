import type { CSSProperties, ReactElement } from 'react'

const PATHS: Record<string, ReactElement> = {
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  /** Topographic contour rings: elevation styling (tint, contours, slope, hillshade). */
  layers: (
    <>
      <path d="M12 3.5c4.8 0 8.5 2.8 8.5 7.4S17 20.5 11.6 20.5C6.4 20.5 3.5 17 3.5 12.8 3.5 7.4 7.3 3.5 12 3.5z" />
      <path d="M12 7.8c2.5 0 4.2 1.5 4.2 3.8 0 2.5-1.9 4.8-4.6 4.8-2.5 0-3.8-1.8-3.8-3.8 0-2.7 1.8-4.8 4.2-4.8z" />
      <circle cx="12" cy="12.1" r="0.8" fill="currentColor" />
    </>
  ),
  /** A chart of a path between two points: the elevation profile tool. */
  profile: (
    <>
      <path d="M3.5 3.5v17h17" />
      <path d="m7.5 15.5 3.5-5 3 3 4.5-7" />
      <circle cx="7.5" cy="15.5" r="1.6" fill="currentColor" />
      <circle cx="18.5" cy="6.5" r="1.6" fill="currentColor" />
    </>
  ),
  bookmark: <path d="M6 3h12v18l-6-4-6 4z" />,
  labels: (
    <>
      <path d="M3 7h11.5l5.5 5-5.5 5H3z" />
      <path d="M7 12h5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 1-1 1.7v.5M12 17h.01" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  play: <path d="M7 4v16l13-8z" fill="currentColor" />,
  pause: (
    <>
      <path d="M7 4h3v16H7zM14 4h3v16h-3z" fill="currentColor" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  /** A person standing on the ground: eye level. */
  person: (
    <>
      <circle cx="12" cy="4.5" r="2.2" />
      <path d="M12 8v6.5M8 11h8M9.5 20l2.5-5.5 2.5 5.5" />
      <path d="M5 21h14" />
    </>
  ),
  plane: <path d="M2 16.5 22 9l-9 13-2.5-6.5z" />,
  edit: <path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4" />,
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z" />
      <circle cx="12" cy="9.5" r="2.5" />
    </>
  ),
  command: <path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </>
  ),
  check: <path d="m5 12 5 5 9-10" />,
  warning: (
    <>
      <path d="M12 3 2 21h20z" />
      <path d="M12 10v5M12 18h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7h.01" />
    </>
  ),
  /** Viewfinder corner brackets around a lens: viewfinder mode. */
  viewfinder: (
    <>
      <path d="M3.5 8V5.5a2 2 0 0 1 2-2H8M16 3.5h2.5a2 2 0 0 1 2 2V8M20.5 16v2.5a2 2 0 0 1-2 2H16M8 20.5H5.5a2 2 0 0 1-2-2V16" />
      <circle cx="12" cy="12" r="3.5" />
    </>
  ),
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronUp: <path d="m6 15 6-6 6 6" />,
  chevronLeft: <path d="m15 6-6 6 6 6" />,
  chevronRight: <path d="m9 6 6 6-6 6" />,
  undo: <path d="M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3" />,
  /** A skyline with the sun setting behind it: the horizon panorama. */
  panorama: (
    <>
      <path d="M2.5 19.5h19" />
      <path d="m2.5 16 4.5-5.5 3.5 3.5 4-6 7 8" />
      <circle cx="17.5" cy="5.5" r="2" />
    </>
  ),
  /** Sightlines fanning out from a target beacon: viewshed analysis overlay. */
  viewshed: (
    <>
      <path d="M2.5 12s3.8-6.5 9.5-6.5S21.5 12 21.5 12s-3.8 6.5-9.5 6.5S2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
      <path d="M12 2.5v2M4.5 5.5l1.5 1.5M19.5 5.5 18 7" />
    </>
  ),
  /** An attitude indicator with a level horizon: level the horizon (remove roll). */
  horizon: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5v3" />
    </>
  ),
  /** A crescent moon and a star: the light pollution (night sky brightness) overlay. */
  night: (
    <>
      <path d="M19.5 14.8A7.5 7.5 0 0 1 9.2 4.5a7.5 7.5 0 1 0 10.3 10.3z" />
      <path d="M17 3.5v4M15 5.5h4" />
    </>
  ),
  now: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="2" fill="currentColor" />
    </>
  )
}

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 18, style }: { name: IconName; size?: number; style?: CSSProperties }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  )
}
