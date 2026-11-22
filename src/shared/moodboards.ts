// Moodboards: stored format, sanitization, migration, starter templates, filtering/sorting,
// and infinite 2D canvas geometry helpers shared by main and renderer. Pure.

import { MAX_PHOTO_BYTES, PHOTO_FILE, sanitizePhoto } from './locations'
import { normalizeHexColor } from './projects'
import { sanitizeCameraView, sanitizeViewfinder } from './settings'
import type {
  BookmarkTime,
  MoodboardConnector,
  MoodboardDocument,
  MoodboardGlobeSnapshot,
  MoodboardGroupItem,
  MoodboardImageItem,
  MoodboardItem,
  MoodboardLocationItem,
  MoodboardNoteItem,
  MoodboardNoteTint,
  MoodboardPaletteItem,
  MoodboardSummary,
  MoodboardTemplateId,
  MoodboardViewport
} from './types'

export const MOODBOARD_INDEX_VERSION = 1
export const MOODBOARD_DOC_VERSION = 1

export interface MoodboardIndexFile {
  version: typeof MOODBOARD_INDEX_VERSION
  boards: MoodboardSummary[]
}

export const MOODBOARD_NOTE_TINTS: readonly MoodboardNoteTint[] = [
  'neutral',
  'amber',
  'blue',
  'rose',
  'emerald',
  'transparent'
]

export const MAX_BOARD_TITLE = 200
export const MAX_ITEMS_PER_BOARD = 500
export const MAX_CONNECTORS_PER_BOARD = 500
export const MAX_CAPTION = 500
export const MAX_NOTE_TITLE = 200
export const MAX_NOTE_BODY = 20_000
export const MAX_GROUP_TITLE = 120
export const MAX_PALETTE_TITLE = 120
export const MAX_PALETTE_COLORS = 8
export const MAX_CONNECTOR_LABEL = 120
export const MAX_SOURCE_TITLE = 300
export const MAX_SOURCE_URL = 2000
export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 4.0
export const MIN_ITEM_WIDTH = 80
export const MIN_ITEM_HEIGHT = 48
export const MAX_ITEM_DIMENSION = 10_000
export const MAX_COORD = 100_000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Json = unknown

const isObject = (v: Json): v is Record<string, Json> => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: Json): v is number => typeof v === 'number' && Number.isFinite(v)
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

function text(v: Json, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : ''
}

function isoTimestamp(v: Json, fallback: string): string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : fallback
}

function sanitizeSafeHttpUrl(v: Json): string | undefined {
  if (typeof v !== 'string') return undefined
  const trimmed = v.trim().slice(0, MAX_SOURCE_URL)
  if (!trimmed) return undefined
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString()
  } catch {
    /* ignore malformed URLs */
  }
  return undefined
}

function sanitizeBookmarkTime(raw: Json): BookmarkTime | undefined {
  if (!isObject(raw) || typeof raw.utc !== 'string' || Number.isNaN(Date.parse(raw.utc))) return undefined
  return {
    utc: new Date(raw.utc).toISOString(),
    timeZone: typeof raw.timeZone === 'string' ? raw.timeZone.slice(0, 100) : 'UTC'
  }
}

export function isValidBoardId(id: string): boolean {
  return UUID_RE.test(id)
}

export function sanitizeMoodboardTitle(raw: Json, fallback = 'Untitled Moodboard'): string {
  const title = typeof raw === 'string' ? raw.trim().slice(0, MAX_BOARD_TITLE) : ''
  return title || fallback
}

export function sanitizeNoteTint(raw: Json, fallback: MoodboardNoteTint = 'neutral'): MoodboardNoteTint {
  return typeof raw === 'string' && (MOODBOARD_NOTE_TINTS as readonly string[]).includes(raw)
    ? (raw as MoodboardNoteTint)
    : fallback
}

export function sanitizeViewport(raw: Json): MoodboardViewport {
  const r = isObject(raw) ? raw : {}
  return {
    x: finite(r.x) ? clamp(r.x, -MAX_COORD * 4, MAX_COORD * 4) : 0,
    y: finite(r.y) ? clamp(r.y, -MAX_COORD * 4, MAX_COORD * 4) : 0,
    zoom: finite(r.zoom) ? clamp(r.zoom, MIN_ZOOM, MAX_ZOOM) : 1
  }
}

export function sanitizeGlobeSnapshot(raw: Json): MoodboardGlobeSnapshot | undefined {
  if (!isObject(raw)) return undefined
  const camera = sanitizeCameraView(raw.camera)
  if (!camera) return undefined
  return {
    camera,
    time: sanitizeBookmarkTime(raw.time),
    viewfinder: raw.viewfinder === undefined || raw.viewfinder === null ? undefined : sanitizeViewfinder(raw.viewfinder),
    locationId: typeof raw.locationId === 'string' && raw.locationId.trim() ? raw.locationId.trim().slice(0, 100) : null,
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 200) : undefined
  }
}

export function sanitizePaletteColors(raw: Json): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    const c = normalizeHexColor(item)
    if (c && !out.includes(c)) out.push(c)
    if (out.length >= MAX_PALETTE_COLORS) break
  }
  return out
}

export function sanitizeMoodboardItem(raw: Json): MoodboardItem | null {
  if (!isObject(raw) || typeof raw.id !== 'string' || !raw.id.trim()) return null
  const id = raw.id.trim().slice(0, 100)
  const base = {
    id,
    x: finite(raw.x) ? clamp(raw.x, -MAX_COORD, MAX_COORD) : 0,
    y: finite(raw.y) ? clamp(raw.y, -MAX_COORD, MAX_COORD) : 0,
    width: finite(raw.width) ? clamp(raw.width, MIN_ITEM_WIDTH, MAX_ITEM_DIMENSION) : 280,
    height: finite(raw.height) ? clamp(raw.height, MIN_ITEM_HEIGHT, MAX_ITEM_DIMENSION) : 200,
    zIndex: finite(raw.zIndex) ? clamp(Math.round(raw.zIndex), -10_000, 100_000) : 0,
    locked: typeof raw.locked === 'boolean' ? raw.locked : false,
    groupId: typeof raw.groupId === 'string' && raw.groupId.trim() ? raw.groupId.trim().slice(0, 100) : null
  }

  switch (raw.kind) {
    case 'image': {
      const photo = sanitizePhoto(raw.photo)
      if (!photo) return null
      const item: MoodboardImageItem = {
        ...base,
        kind: 'image',
        photo,
        caption: text(raw.caption, MAX_CAPTION).trim(),
        borderless: typeof raw.borderless === 'boolean' ? raw.borderless : false,
        sourceTitle: typeof raw.sourceTitle === 'string' && raw.sourceTitle.trim() ? raw.sourceTitle.trim().slice(0, MAX_SOURCE_TITLE) : undefined,
        sourceUrl: sanitizeSafeHttpUrl(raw.sourceUrl),
        globe: sanitizeGlobeSnapshot(raw.globe)
      }
      return item
    }
    case 'palette': {
      const colors = sanitizePaletteColors(raw.colors)
      const item: MoodboardPaletteItem = {
        ...base,
        kind: 'palette',
        title: text(raw.title, MAX_PALETTE_TITLE).trim() || 'Color Palette',
        colors: colors.length > 0 ? colors : ['#1b2a41', '#3b5978', '#d97736', '#f2b866', '#e8dfd1'],
        sourceItemId: typeof raw.sourceItemId === 'string' && raw.sourceItemId.trim() ? raw.sourceItemId.trim().slice(0, 100) : null
      }
      return item
    }
    case 'note': {
      const item: MoodboardNoteItem = {
        ...base,
        kind: 'note',
        title: text(raw.title, MAX_NOTE_TITLE).trim(),
        body: text(raw.body, MAX_NOTE_BODY),
        tint: sanitizeNoteTint(raw.tint, 'neutral'),
        isHeading: typeof raw.isHeading === 'boolean' ? raw.isHeading : false
      }
      return item
    }
    case 'group': {
      const item: MoodboardGroupItem = {
        ...base,
        kind: 'group',
        title: text(raw.title, MAX_GROUP_TITLE).trim() || 'Section',
        tint: sanitizeNoteTint(raw.tint, 'neutral'),
        collapsed: typeof raw.collapsed === 'boolean' ? raw.collapsed : false
      }
      return item
    }
    case 'location': {
      const locationId = typeof raw.locationId === 'string' ? raw.locationId.trim().slice(0, 100) : ''
      if (!locationId) return null
      const item: MoodboardLocationItem = {
        ...base,
        kind: 'location',
        locationId
      }
      return item
    }
    default:
      return null
  }
}

export function sanitizeMoodboardConnector(raw: Json, validItemIds: ReadonlySet<string>): MoodboardConnector | null {
  if (!isObject(raw) || typeof raw.id !== 'string' || !raw.id.trim()) return null
  const fromId = typeof raw.fromId === 'string' ? raw.fromId.trim().slice(0, 100) : ''
  const toId = typeof raw.toId === 'string' ? raw.toId.trim().slice(0, 100) : ''
  if (!fromId || !toId || fromId === toId) return null
  if (!validItemIds.has(fromId) || !validItemIds.has(toId)) return null
  return {
    id: raw.id.trim().slice(0, 100),
    fromId,
    toId,
    label: text(raw.label, MAX_CONNECTOR_LABEL).trim(),
    directed: typeof raw.directed === 'boolean' ? raw.directed : true
  }
}

export function sanitizeMoodboardDocument(raw: Json, fallbackId?: string): MoodboardDocument | null {
  if (!isObject(raw)) return null
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim().slice(0, 100) : fallbackId
  if (!id) return null
  const items: MoodboardItem[] = []
  const seenItemIds = new Set<string>()
  if (Array.isArray(raw.items)) {
    for (const entry of raw.items) {
      const item = sanitizeMoodboardItem(entry)
      if (item && !seenItemIds.has(item.id)) {
        seenItemIds.add(item.id)
        items.push(item)
      }
      if (items.length >= MAX_ITEMS_PER_BOARD) break
    }
  }
  // Clear dangling groupId pointers
  const groupIds = new Set(items.filter((i) => i.kind === 'group').map((i) => i.id))
  for (const item of items) {
    if (item.groupId && (!groupIds.has(item.groupId) || item.groupId === item.id)) {
      item.groupId = null
    }
  }
  const connectors: MoodboardConnector[] = []
  const seenConnectorIds = new Set<string>()
  if (Array.isArray(raw.connectors)) {
    for (const entry of raw.connectors) {
      const conn = sanitizeMoodboardConnector(entry, seenItemIds)
      if (conn && !seenConnectorIds.has(conn.id)) {
        seenConnectorIds.add(conn.id)
        connectors.push(conn)
      }
      if (connectors.length >= MAX_CONNECTORS_PER_BOARD) break
    }
  }
  return {
    version: MOODBOARD_DOC_VERSION,
    id,
    title: sanitizeMoodboardTitle(raw.title),
    projectId: typeof raw.projectId === 'string' && raw.projectId.trim() ? raw.projectId.trim().slice(0, 100) : null,
    viewport: sanitizeViewport(raw.viewport),
    items,
    connectors
  }
}

export function sanitizeMoodboardSummary(raw: Json, now = new Date().toISOString()): MoodboardSummary | null {
  if (!isObject(raw) || typeof raw.id !== 'string' || !raw.id.trim()) return null
  const createdAt = isoTimestamp(raw.createdAt, now)
  const previewFiles: string[] = []
  if (Array.isArray(raw.previewFiles)) {
    for (const f of raw.previewFiles) {
      if (typeof f === 'string' && PHOTO_FILE.test(f) && !previewFiles.includes(f)) {
        previewFiles.push(f)
      }
      if (previewFiles.length >= 4) break
    }
  }
  return {
    id: raw.id.trim().slice(0, 100),
    title: sanitizeMoodboardTitle(raw.title),
    projectId: typeof raw.projectId === 'string' && raw.projectId.trim() ? raw.projectId.trim().slice(0, 100) : null,
    createdAt,
    updatedAt: isoTimestamp(raw.updatedAt, createdAt),
    itemCount: finite(raw.itemCount) ? Math.max(0, Math.round(raw.itemCount)) : 0,
    previewFiles
  }
}

export function moodboardIndexVersion(raw: Json): number {
  return isObject(raw) && finite(raw.version) ? raw.version : 1
}

export function moodboardDocVersion(raw: Json): number {
  return isObject(raw) && finite(raw.version) ? raw.version : 1
}

export function migrateMoodboardIndexFile(raw: Json, now = new Date().toISOString()): MoodboardIndexFile {
  const r = isObject(raw) ? raw : {}
  const boards: MoodboardSummary[] = []
  for (const entry of Array.isArray(r.boards) ? r.boards : []) {
    const summary = sanitizeMoodboardSummary(entry, now)
    if (summary && !boards.some((b) => b.id === summary.id)) boards.push(summary)
  }
  return { version: MOODBOARD_INDEX_VERSION, boards }
}

/** Derives a MoodboardSummary from a full document (extracting up to 4 thumbnail preview files). */
export function summarizeMoodboardDocument(
  doc: MoodboardDocument,
  existing?: Pick<MoodboardSummary, 'createdAt' | 'projectId'> | null,
  now = new Date().toISOString()
): MoodboardSummary {
  const previewFiles: string[] = []
  for (const item of doc.items) {
    if (item.kind === 'image') {
      const thumb = `${item.photo.id}.thumb.jpg`
      if (PHOTO_FILE.test(thumb) && !previewFiles.includes(thumb)) {
        previewFiles.push(thumb)
      }
      if (previewFiles.length >= 4) break
    }
  }
  return {
    id: doc.id,
    title: doc.title,
    projectId: doc.projectId ?? existing?.projectId ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    itemCount: doc.items.length,
    previewFiles
  }
}

// ───────────────────────────── starter templates ─────────────────────────────

export interface MoodboardTemplate {
  id: MoodboardTemplateId
  name: string
  description: string
  accentColors: string[]
}

export const MOODBOARD_TEMPLATES: readonly MoodboardTemplate[] = [
  {
    id: 'blank',
    name: 'Blank Canvas',
    description: 'An open PureRef-style infinite canvas ready for dragged images, snapshots, and notes.',
    accentColors: ['#1e293b', '#334155', '#4fb3ff']
  },
  {
    id: 'three-column',
    name: 'Lighting / Color / Composition',
    description: 'Three organized section frames to separate light direction, color grading, and framing studies.',
    accentColors: ['#d97736', '#4fb3ff', '#4cd18a']
  },
  {
    id: 'shot-study',
    name: 'Shot Study',
    description: 'Hero reference zone paired with a target color palette, framing notes, and field checklist.',
    accentColors: ['#101828', '#3b5978', '#f2b866', '#e8dfd1']
  }
]

export function buildTemplateDocument(
  id: string,
  title: string,
  projectId: string | null,
  template: MoodboardTemplateId = 'blank',
  makeId: () => string
): MoodboardDocument {
  const cleanTitle = sanitizeMoodboardTitle(title)
  if (template === 'three-column') {
    const g1 = makeId()
    const g2 = makeId()
    const g3 = makeId()
    const n1 = makeId()
    const n2 = makeId()
    const n3 = makeId()
    return {
      version: MOODBOARD_DOC_VERSION,
      id,
      title: cleanTitle,
      projectId,
      viewport: { x: 80, y: 80, zoom: 0.9 },
      items: [
        { id: g1, kind: 'group', x: 0, y: 0, width: 380, height: 520, zIndex: 0, locked: false, title: 'Lighting & Atmosphere', tint: 'amber', collapsed: false },
        { id: g2, kind: 'group', x: 420, y: 0, width: 380, height: 520, zIndex: 0, locked: false, title: 'Color & Tone', tint: 'blue', collapsed: false },
        { id: g3, kind: 'group', x: 840, y: 0, width: 380, height: 520, zIndex: 0, locked: false, title: 'Composition & Framing', tint: 'emerald', collapsed: false },
        {
          id: n1,
          kind: 'note',
          x: 24,
          y: 56,
          width: 332,
          height: 150,
          zIndex: 1,
          locked: false,
          groupId: g1,
          title: 'Light Direction',
          body: '- Low-angle side light / golden hour\n- Atmospheric haze or clearing clouds\n- Drop lighting references below',
          tint: 'amber',
          isHeading: false
        },
        {
          id: n2,
          kind: 'note',
          x: 444,
          y: 56,
          width: 332,
          height: 150,
          zIndex: 2,
          locked: false,
          groupId: g2,
          title: 'Color Grading Notes',
          body: '- Cool shadows vs warm highlights\n- Right-click any image → **Extract Color Palette**',
          tint: 'blue',
          isHeading: false
        },
        {
          id: n3,
          kind: 'note',
          x: 864,
          y: 56,
          width: 332,
          height: 150,
          zIndex: 3,
          locked: false,
          groupId: g3,
          title: 'Framing & Lenses',
          body: '- Foreground anchors & leading lines\n- Snap 3D Globe Viewfinder frames directly here',
          tint: 'emerald',
          isHeading: false
        }
      ],
      connectors: []
    }
  }

  if (template === 'shot-study') {
    const heroGroup = makeId()
    const notesGroup = makeId()
    const palId = makeId()
    const noteId = makeId()
    return {
      version: MOODBOARD_DOC_VERSION,
      id,
      title: cleanTitle,
      projectId,
      viewport: { x: 100, y: 80, zoom: 0.95 },
      items: [
        { id: heroGroup, kind: 'group', x: 0, y: 0, width: 520, height: 480, zIndex: 0, locked: false, title: 'Hero Visual References', tint: 'neutral', collapsed: false },
        { id: notesGroup, kind: 'group', x: 560, y: 0, width: 340, height: 480, zIndex: 0, locked: false, title: 'Technical & Field Notes', tint: 'blue', collapsed: false },
        {
          id: palId,
          kind: 'palette',
          x: 584,
          y: 56,
          width: 292,
          height: 136,
          zIndex: 1,
          locked: false,
          groupId: notesGroup,
          title: 'Target Color Story',
          colors: ['#101828', '#23395d', '#4fb3ff', '#f2b866', '#e8dfd1'],
          sourceItemId: null
        },
        {
          id: noteId,
          kind: 'note',
          x: 584,
          y: 212,
          width: 292,
          height: 236,
          zIndex: 2,
          locked: false,
          groupId: notesGroup,
          title: 'Shot Breakdown',
          body: '## Key Elements\n- [ ] Confirm focal length in 3D Viewfinder\n- [ ] Check sun/moon azimuth alignment\n- [ ] Gather 3–4 foreground texture references',
          tint: 'neutral',
          isHeading: false
        }
      ],
      connectors: []
    }
  }

  return {
    version: MOODBOARD_DOC_VERSION,
    id,
    title: cleanTitle,
    projectId,
    viewport: { x: 0, y: 0, zoom: 1 },
    items: [],
    connectors: []
  }
}

// ───────────────────────────── filtering & sorting ─────────────────────────────

export type MoodboardSort = 'updated' | 'name' | 'items'

export interface MoodboardQuery {
  query: string
  projectId: string | 'all'
  sort: MoodboardSort
}

export function filterAndSortMoodboards(
  boards: readonly MoodboardSummary[],
  { query, projectId, sort }: MoodboardQuery,
  projectNamesById?: ReadonlyMap<string, string>,
  projectMoodboardIds?: ReadonlySet<string>
): MoodboardSummary[] {
  const q = query.trim().toLowerCase()
  const filtered = boards.filter((b) => {
    if (projectId !== 'all') {
      const matchesPrimary = b.projectId === projectId
      const matchesLinked = projectMoodboardIds?.has(b.id) ?? false
      if (!matchesPrimary && !matchesLinked) return false
    }
    if (!q) return true
    const projectName = b.projectId ? projectNamesById?.get(b.projectId) ?? '' : ''
    const hay = `${b.title} ${projectName}`.toLowerCase()
    return q.split(/\s+/).every((tok) => hay.includes(tok))
  })
  return [...filtered].sort((a, b) => {
    switch (sort) {
      case 'name':
        return a.title.localeCompare(b.title)
      case 'items':
        return b.itemCount - a.itemCount || b.updatedAt.localeCompare(a.updatedAt)
      case 'updated':
      default:
        return b.updatedAt.localeCompare(a.updatedAt)
    }
  })
}

// ───────────────────────────── infinite canvas geometry ─────────────────────────────

export interface WorldRect {
  x: number
  y: number
  width: number
  height: number
}

export function worldBoundsOfItems(items: ReadonlyArray<Pick<MoodboardItem, 'x' | 'y' | 'width' | 'height'>>): WorldRect | null {
  if (items.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const it of items) {
    if (it.x < minX) minX = it.x
    if (it.y < minY) minY = it.y
    if (it.x + it.width > maxX) maxX = it.x + it.width
    if (it.y + it.height > maxY) maxY = it.y + it.height
  }
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) }
}

/** Computes a viewport { x, y, zoom } that centers and fits `bounds` within `viewportW × viewportH`. */
export function fitViewportToBounds(
  bounds: WorldRect | null,
  viewportW: number,
  viewportH: number,
  padding = 80
): MoodboardViewport {
  if (!bounds || viewportW <= 0 || viewportH <= 0) {
    return { x: Math.round(viewportW / 2), y: Math.round(viewportH / 2), zoom: 1 }
  }
  const availW = Math.max(100, viewportW - padding * 2)
  const availH = Math.max(100, viewportH - padding * 2)
  const zoom = clamp(Math.min(availW / bounds.width, availH / bounds.height, 1.5), MIN_ZOOM, MAX_ZOOM)
  const cx = bounds.x + bounds.width / 2
  const cy = bounds.y + bounds.height / 2
  return {
    x: viewportW / 2 - cx * zoom,
    y: viewportH / 2 - cy * zoom,
    zoom
  }
}

/** Zooms smoothly toward a screen cursor position (clientX - rect.left, clientY - rect.top). */
export function zoomViewportAtPoint(
  viewport: MoodboardViewport,
  screenX: number,
  screenY: number,
  nextZoomRaw: number
): MoodboardViewport {
  const zoom = clamp(nextZoomRaw, MIN_ZOOM, MAX_ZOOM)
  const worldX = (screenX - viewport.x) / viewport.zoom
  const worldY = (screenY - viewport.y) / viewport.zoom
  return {
    x: screenX - worldX * zoom,
    y: screenY - worldY * zoom,
    zoom
  }
}

/** Visible world-space rectangle for viewport culling (expanded by `marginPx` in screen pixels). */
export function visibleWorldRect(
  viewport: MoodboardViewport,
  viewportW: number,
  viewportH: number,
  marginPx = 300
): WorldRect {
  const m = marginPx / viewport.zoom
  return {
    x: -viewport.x / viewport.zoom - m,
    y: -viewport.y / viewport.zoom - m,
    width: viewportW / viewport.zoom + m * 2,
    height: viewportH / viewport.zoom + m * 2
  }
}

export function rectsIntersect(a: WorldRect, b: WorldRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

export interface SnapGuide {
  axis: 'x' | 'y'
  position: number
  start: number
  end: number
}

export interface SnapResult {
  dx: number
  dy: number
  guides: SnapGuide[]
}

/**
 * Computes edge & center alignment snapping for a moving rect against neighboring rects.
 * Returns delta adjustments (dx, dy) in world units and visual guide line segments.
 */
export function computeSnapGuides(
  moving: WorldRect,
  others: readonly WorldRect[],
  threshold = 8
): SnapResult {
  let bestDx: number | null = null
  let bestDxDist = threshold + 1
  let bestXPos = 0

  let bestDy: number | null = null
  let bestDyDist = threshold + 1
  let bestYPos = 0

  const mXs = [moving.x, moving.x + moving.width / 2, moving.x + moving.width]
  const mYs = [moving.y, moving.y + moving.height / 2, moving.y + moving.height]

  for (const o of others) {
    const oXs = [o.x, o.x + o.width / 2, o.x + o.width]
    const oYs = [o.y, o.y + o.height / 2, o.y + o.height]
    for (const mx of mXs) {
      for (const ox of oXs) {
        const d = Math.abs(ox - mx)
        if (d <= threshold && d < bestDxDist) {
          bestDxDist = d
          bestDx = ox - mx
          bestXPos = ox
        }
      }
    }
    for (const my of mYs) {
      for (const oy of oYs) {
        const d = Math.abs(oy - my)
        if (d <= threshold && d < bestDyDist) {
          bestDyDist = d
          bestDy = oy - my
          bestYPos = oy
        }
      }
    }
  }

  const dx = bestDx ?? 0
  const dy = bestDy ?? 0
  const guides: SnapGuide[] = []
  const snapped: WorldRect = { x: moving.x + dx, y: moving.y + dy, width: moving.width, height: moving.height }

  if (bestDx !== null) {
    let minY = snapped.y
    let maxY = snapped.y + snapped.height
    for (const o of others) {
      if (
        Math.abs(o.x - bestXPos) < 0.5 ||
        Math.abs(o.x + o.width / 2 - bestXPos) < 0.5 ||
        Math.abs(o.x + o.width - bestXPos) < 0.5
      ) {
        minY = Math.min(minY, o.y)
        maxY = Math.max(maxY, o.y + o.height)
      }
    }
    guides.push({ axis: 'x', position: bestXPos, start: minY - 16, end: maxY + 16 })
  }

  if (bestDy !== null) {
    let minX = snapped.x
    let maxX = snapped.x + snapped.width
    for (const o of others) {
      if (
        Math.abs(o.y - bestYPos) < 0.5 ||
        Math.abs(o.y + o.height / 2 - bestYPos) < 0.5 ||
        Math.abs(o.y + o.height - bestYPos) < 0.5
      ) {
        minX = Math.min(minX, o.x)
        maxX = Math.max(maxX, o.x + o.width)
      }
    }
    guides.push({ axis: 'y', position: bestYPos, start: minX - 16, end: maxX + 16 })
  }

  return { dx, dy, guides }
}

export interface ConnectorCurve {
  x1: number
  y1: number
  cx1: number
  cy1: number
  cx2: number
  cy2: number
  x2: number
  y2: number
  midX: number
  midY: number
}

/** Auto-picks the nearest edge anchors between two item rects and returns a smooth cubic bezier. */
export function connectorBezier(from: WorldRect, to: WorldRect): ConnectorCurve {
  const fcX = from.x + from.width / 2
  const fcY = from.y + from.height / 2
  const tcX = to.x + to.width / 2
  const tcY = to.y + to.height / 2
  const dx = tcX - fcX
  const dy = tcY - fcY

  let x1: number
  let y1: number
  let x2: number
  let y2: number
  let cx1: number
  let cy1: number
  let cx2: number
  let cy2: number

  if (Math.abs(dx) >= Math.abs(dy)) {
    const dir = dx >= 0 ? 1 : -1
    x1 = dir > 0 ? from.x + from.width : from.x
    y1 = fcY
    x2 = dir > 0 ? to.x : to.x + to.width
    y2 = tcY
    const bend = clamp(Math.abs(x2 - x1) * 0.45, 40, 220)
    cx1 = x1 + dir * bend
    cy1 = y1
    cx2 = x2 - dir * bend
    cy2 = y2
  } else {
    const dir = dy >= 0 ? 1 : -1
    x1 = fcX
    y1 = dir > 0 ? from.y + from.height : from.y
    x2 = tcX
    y2 = dir > 0 ? to.y : to.y + to.height
    const bend = clamp(Math.abs(y2 - y1) * 0.45, 40, 220)
    cx1 = x1
    cy1 = y1 + dir * bend
    cx2 = x2
    cy2 = y2 - dir * bend
  }

  // Cubic bezier midpoint at t = 0.5
  const midX = 0.125 * x1 + 0.375 * cx1 + 0.375 * cx2 + 0.125 * x2
  const midY = 0.125 * y1 + 0.375 * cy1 + 0.375 * cy2 + 0.125 * y2

  return { x1, y1, cx1, cy1, cx2, cy2, x2, y2, midX, midY }
}

/** Returns IDs of non-group items spatially contained within a group frame (or explicitly linked by groupId). */
export function itemsInsideGroup(group: MoodboardGroupItem, items: readonly MoodboardItem[]): string[] {
  const out: string[] = []
  for (const item of items) {
    if (item.id === group.id || item.kind === 'group') continue
    if (item.groupId === group.id) {
      out.push(item.id)
      continue
    }
    const cx = item.x + item.width / 2
    const cy = item.y + item.height / 2
    if (cx >= group.x && cx <= group.x + group.width && cy >= group.y && cy <= group.y + group.height) {
      out.push(item.id)
    }
  }
  return out
}

// ───────────────────────────── Inspiration Browser helpers ─────────────────────────────

export const DEFAULT_INSPIRATION_URL = 'https://www.google.com/search?udm=2&q=landscape+photography+lighting'
const BARE_DOMAIN_RE = /^([a-z0-9-]+\.)+[a-z]{2,}(\/.*)?$/i

/**
 * Turns user input from the Inspiration Browser address bar into a safe http(s) URL:
 * - Full http(s) URLs pass through.
 * - Bare hostnames (e.g. `pinterest.com`, `are.na/explore`) get `https://`.
 * - Plain search text opens Google Images (`udm=2`).
 */
export function normalizeBrowserInput(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return DEFAULT_INSPIRATION_URL
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const u = new URL(trimmed)
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString()
    } catch {
      /* fall through to search */
    }
  }
  if (!/\s/.test(trimmed) && BARE_DOMAIN_RE.test(trimmed)) {
    try {
      const u = new URL(`https://${trimmed}`)
      if (u.protocol === 'https:') return u.toString()
    } catch {
      /* fall through to search */
    }
  }
  return `https://www.google.com/search?udm=2&q=${encodeURIComponent(trimmed)}`
}

/** Decodes a `data:image/...;base64,...` URI into bytes if valid and within MAX_PHOTO_BYTES. */
export function decodeImageDataUrl(url: string): Uint8Array | null {
  const match = /^data:image\/[a-z0-9.+-]+(?:;[^;,]+)*;base64,([a-z0-9+/=\s]+)$/i.exec(url)
  if (!match) return null
  const compact = match[1].replace(/\s+/g, '')
  if (compact.length * 0.76 > MAX_PHOTO_BYTES) return null
  try {
    const binary = atob(compact)
    if (binary.length > MAX_PHOTO_BYTES) return null
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

/**
 * Computes a Chromium-compliant origin-only `Referer` header under `strict-origin-when-cross-origin`:
 * - Omits `Referer` on HTTPS → HTTP downgrades or invalid/non-http(s) URLs.
 * - Uses origin-only (`https://host/`) so neither cross-origin fetches nor same-origin→cross-origin
 *   redirects are ever cancelled by Chromium with `net::ERR_BLOCKED_BY_CLIENT`.
 */
export function safeImageReferer(srcUrl: string, pageUrl: string): string | null {
  try {
    const src = new URL(srcUrl)
    const page = new URL(pageUrl)
    if ((src.protocol !== 'http:' && src.protocol !== 'https:') || (page.protocol !== 'http:' && page.protocol !== 'https:')) {
      return null
    }
    if (page.protocol === 'https:' && src.protocol === 'http:') return null
    return `${page.origin}/`
  } catch {
    return null
  }
}
