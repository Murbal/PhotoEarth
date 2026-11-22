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
  /** Topographic contour rings: the Layers panel (light pollution, viewshed, exaggeration). */
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
  ),
  /** Two pins connected by a sightline to a target: Camera → Subject shot alignment. */
  alignment: (
    <>
      <circle cx="5.5" cy="18.5" r="2.2" fill="currentColor" />
      <path d="M7.3 16.7 15.8 8.2" strokeDasharray="2 2" />
      <circle cx="18" cy="6" r="3" />
      <path d="M18 1.5v1.3M18 9.2v1.3M13.5 6h1.3M21.2 6h1.3" />
    </>
  ),
  /** Swap two items vertically. */
  swap: (
    <>
      <path d="M7 16V4M7 4 4 7M7 4l3 3" />
      <path d="M17 8v12M17 20l-3-3M17 20l3-3" />
    </>
  ),
  /** Folder / workspace icon for Projects Hub. */
  projects: (
    <>
      <path d="M3 6.5A2 2 0 0 1 5 4.5h4.2l2 2H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M7.5 13h9M7.5 16h5.5" />
    </>
  ),
  /** Collage grid icon for Moodboards. */
  moodboard: (
    <>
      <rect x="3.5" y="3.5" width="7" height="9" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="5.5" rx="1.5" />
      <rect x="13.5" y="12" width="7" height="8.5" rx="1.5" />
      <rect x="3.5" y="15.5" width="7" height="5" rx="1.5" />
    </>
  ),
  /** Document / scratchpad note icon. */
  note: (
    <>
      <path d="M6 3.5h8.5L19 8v12.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1z" />
      <path d="M14 3.5V8.5h5M8.5 12h7M8.5 15.5h5" />
    </>
  ),
  /** Calendar / target date window icon. */
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
      <path d="M8 3v4M16 3v4M3.5 9.5h17" />
    </>
  ),
  /** Swatch / color story icon. */
  palette: (
    <>
      <path d="M12 3a9 9 0 0 0 0 18h1.5a2 2 0 0 0 1.4-3.4 1.8 1.8 0 0 1 1.3-3.1H18a3 3 0 0 0 3-3A8.5 8.5 0 0 0 12 3z" />
      <circle cx="8" cy="10" r="1" fill="currentColor" />
      <circle cx="11.5" cy="7.5" r="1" fill="currentColor" />
      <circle cx="15.5" cy="9.5" r="1" fill="currentColor" />
      <circle cx="7.5" cy="14" r="1" fill="currentColor" />
    </>
  ),
  /** Chain link icon. */
  link: (
    <>
      <path d="M10 14a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7L11 7.3" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 0 0 5.7 5.7L13 16.7" />
    </>
  ),
  /** Broken link / unlink icon. */
  unlink: (
    <>
      <path d="M18.5 11.2a4 4 0 0 0-5.7-5.7L11 7.3M5.5 12.8a4 4 0 0 0 5.7 5.7L13 16.7" />
      <path d="M8 2v3M2 8h3M16 19v3M19 16h3" />
    </>
  ),
  /** Archive box icon. */
  archive: (
    <>
      <rect x="3" y="4" width="18" height="4.5" rx="1" />
      <path d="M5 8.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V8.5M10 12.5h4" />
    </>
  ),
  /** Star / active project badge icon. */
  star: <path d="m12 3.2 2.7 5.5 6 .9-4.3 4.2 1 6-5.4-2.8-5.4 2.8 1-6-4.3-4.2 6-.9z" />,
  /** Image / cover photo icon. */
  image: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <circle cx="9" cy="9.5" r="1.5" />
      <path d="m4.5 17 4.5-4.5 3.5 3.5 2.5-2.5 4.5 4.5" />
    </>
  ),
  /** Pinned note thumbtack icon. */
  thumbtack: (
    <>
      <path d="M15 4.5 19.5 9l-2 2-3-1-3.5 3.5 1 3-1.5 1.5-4.5-4.5L7.5 12l3 1 3.5-3.5-1-3z" />
      <path d="m9 15-4.5 4.5" />
    </>
  ),
  /** Back arrow icon. */
  arrowLeft: <path d="M19 12H5M11 6l-6 6 6 6" />,
  /** Forward arrow icon. */
  arrowRight: <path d="M5 12h14M13 6l6 6-6 6" />,
  /** Selection pointer cursor icon. */
  cursor: <path d="m5 3 6.5 17.5 2.5-6.5L20.5 11.5z" />,
  /** Hand pan icon. */
  hand: (
    <>
      <path d="M18 11V6a2 2 0 0 0-4 0v4M14 10V4a2 2 0 0 0-4 0v6M10 10V6a2 2 0 0 0-4 0v8" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2a8 8 0 0 1-7.2-4.5L3.3 14a2 2 0 0 1 3.3-2.2L8 13" />
    </>
  ),
  /** Section / group frame icon. */
  group: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" strokeDasharray="3.5 2.5" />
      <path d="M7.5 9h5" />
    </>
  ),
  /** Curved connector arrow icon. */
  connector: (
    <>
      <circle cx="5.5" cy="18" r="2" />
      <path d="M7.5 18C12 18 12 6 17.5 6" />
      <path d="m15 3.5 3.5 2.5-3.5 2.5" />
    </>
  ),
  /** Lock icon. */
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9.5" rx="2" />
      <path d="M8 11V7.5a4 4 0 0 1 8 0V11" />
    </>
  ),
  /** Unlock icon. */
  unlock: (
    <>
      <rect x="5" y="11" width="14" height="9.5" rx="2" />
      <path d="M8 11V7.5a4 4 0 0 1 7.7-1.5" />
    </>
  ),
  /** Fit view / maximize frame icon. */
  fit: (
    <>
      <path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15" />
    </>
  ),
  /** Download / export icon. */
  download: (
    <>
      <path d="M12 4v11M8 11l4 4 4-4" />
      <path d="M4 18.5v1A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5v-1" />
    </>
  ),
  /** Embedded browser panel icon. */
  browser: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M15 9v11" />
    </>
  ),
  /** Reload / refresh icon. */
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.3-5.7L20 8.5" />
      <path d="M20 4v4.5h-4.5" />
    </>
  ),
  /** Open in external browser icon. */
  external: (
    <>
      <path d="M14 4h6v6M20 4 10.5 13.5" />
      <path d="M18 14v5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 19V7.5A1.5 1.5 0 0 1 5.5 6h5" />
    </>
  ),
  /** Camera shutter / snapshot icon. */
  camera: (
    <>
      <path d="M4 8.5A2 2 0 0 1 6 6.5h2.2l1.3-2h5l1.3 2H18a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
      <circle cx="12" cy="12.5" r="3.2" />
    </>
  ),
  /** Redo icon. */
  redo: <path d="m15 14 5-5-5-5M20 9H9a5 5 0 0 0 0 10h3" />,
  /** Bring to front icon. */
  bringFront: (
    <>
      <rect x="4" y="4" width="10" height="10" rx="1.5" />
      <path d="M14 10h4.5A1.5 1.5 0 0 1 20 11.5v7A1.5 1.5 0 0 1 18.5 20h-7A1.5 1.5 0 0 1 10 18.5V14" />
    </>
  ),
  /** Send to back icon. */
  sendBack: (
    <>
      <rect x="10" y="10" width="10" height="10" rx="1.5" />
      <path d="M10 14H5.5A1.5 1.5 0 0 1 4 12.5v-7A1.5 1.5 0 0 1 5.5 4h7A1.5 1.5 0 0 1 14 5.5V10" />
    </>
  ),
  /** Presentation mode / clean canvas icon. */
  present: (
    <>
      <rect x="3" y="4.5" width="18" height="13" rx="2" />
      <path d="M8.5 20.5h7M12 17.5v3" />
    </>
  ),
  /** Grid / snap icon. */
  grid: (
    <>
      <circle cx="6" cy="6" r="1.2" fill="currentColor" />
      <circle cx="12" cy="6" r="1.2" fill="currentColor" />
      <circle cx="18" cy="6" r="1.2" fill="currentColor" />
      <circle cx="6" cy="12" r="1.2" fill="currentColor" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
      <circle cx="18" cy="12" r="1.2" fill="currentColor" />
      <circle cx="6" cy="18" r="1.2" fill="currentColor" />
      <circle cx="12" cy="18" r="1.2" fill="currentColor" />
      <circle cx="18" cy="18" r="1.2" fill="currentColor" />
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
