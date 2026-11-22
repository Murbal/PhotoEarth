// Photography projects: stored format, migration, sanitizers, filtering, sorting and starter
// templates shared by the main process (disk, IPC) and the renderer. Pure.

import { sanitizePhoto, sanitizeTags } from './locations'
import type { NewProject, Project, ProjectConcept, ProjectDateWindow, ProjectNote, ProjectPatch, ProjectStatus } from './types'

export const PROJECTS_FILE_VERSION = 1

export interface ProjectsFile {
  version: typeof PROJECTS_FILE_VERSION
  projects: Project[]
}

export const PROJECT_STATUSES: readonly ProjectStatus[] = ['brainstorming', 'scouting', 'ready', 'shot', 'archived']

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  brainstorming: 'Brainstorming',
  scouting: 'Scouting',
  ready: 'Ready',
  shot: 'Shot',
  archived: 'Archived'
}

/** Workflow sort order: actionable projects first, completed and archived last. */
export const PROJECT_STATUS_ORDER: Record<ProjectStatus, number> = {
  ready: 0,
  scouting: 1,
  brainstorming: 2,
  shot: 3,
  archived: 4
}

export const MAX_PROJECT_TITLE = 200
export const MAX_DATE_LABEL = 120
export const MAX_CONCEPT_SUMMARY = 2000
export const MAX_CONCEPT_MOOD = 1000
export const MAX_CONCEPT_CONSTRAINTS = 1000
export const MAX_COLOR_STORY = 12
export const MAX_NOTES_PER_PROJECT = 100
export const MAX_NOTE_TITLE = 200
export const MAX_NOTE_BODY = 20_000
export const MAX_LINKED_IDS = 500

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const HEX_SHORT_RE = /^#([0-9a-fA-F]{3})$/
const HEX_FULL_RE = /^#([0-9a-fA-F]{6})$/

type Json = unknown

const isObject = (v: Json): v is Record<string, Json> => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: Json): v is number => typeof v === 'number' && Number.isFinite(v)

function text(v: Json, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : ''
}

function isoTimestamp(v: Json, fallback: string): string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : fallback
}

export function sanitizeProjectTitle(raw: Json, fallback = 'Untitled project'): string {
  const title = typeof raw === 'string' ? raw.trim().slice(0, MAX_PROJECT_TITLE) : ''
  return title || fallback
}

export function sanitizeProjectStatus(raw: Json, fallback: ProjectStatus = 'brainstorming'): ProjectStatus {
  return typeof raw === 'string' && (PROJECT_STATUSES as readonly string[]).includes(raw) ? (raw as ProjectStatus) : fallback
}

/** Strict calendar date 'YYYY-MM-DD', rejecting impossible dates like 2026-02-31. */
export function sanitizeIsoDate(raw: Json): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  const m = ISO_DATE_RE.exec(trimmed)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const d = new Date(Date.UTC(year, month - 1, day))
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null
  return trimmed
}

export function sanitizeDateWindow(raw: Json): ProjectDateWindow {
  const r = isObject(raw) ? raw : {}
  let start = sanitizeIsoDate(r.start)
  let end = sanitizeIsoDate(r.end)
  if (start && end && start > end) {
    ;[start, end] = [end, start]
  }
  return {
    start,
    end,
    label: text(r.label, MAX_DATE_LABEL).trim()
  }
}

/** Normalizes `#RGB` or `#RRGGBB` to lowercase `#rrggbb`, or null when invalid. */
export function normalizeHexColor(raw: Json): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  const full = HEX_FULL_RE.exec(trimmed)
  if (full) return `#${full[1].toLowerCase()}`
  const short = HEX_SHORT_RE.exec(trimmed)
  if (short) {
    const [r, g, b] = short[1].toLowerCase()
    return `#${r}${r}${g}${g}${b}${b}`
  }
  return null
}

export function sanitizeColorStory(raw: Json): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    const color = normalizeHexColor(item)
    if (color && !out.includes(color)) out.push(color)
    if (out.length >= MAX_COLOR_STORY) break
  }
  return out
}

export function sanitizeConcept(raw: Json): ProjectConcept {
  const r = isObject(raw) ? raw : {}
  return {
    summary: text(r.summary, MAX_CONCEPT_SUMMARY).trim(),
    lightingMood: text(r.lightingMood, MAX_CONCEPT_MOOD).trim(),
    constraints: text(r.constraints, MAX_CONCEPT_CONSTRAINTS).trim(),
    colorStory: sanitizeColorStory(r.colorStory)
  }
}

export function sanitizeProjectNote(raw: Json, now = new Date().toISOString(), fallbackId?: string): ProjectNote | null {
  if (!isObject(raw)) return null
  const rawId = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim().slice(0, 100) : fallbackId
  if (!rawId) return null
  const createdAt = isoTimestamp(raw.createdAt, now)
  return {
    id: rawId,
    title: text(raw.title, MAX_NOTE_TITLE).trim() || 'Untitled note',
    body: text(raw.body, MAX_NOTE_BODY),
    pinned: typeof raw.pinned === 'boolean' ? raw.pinned : false,
    createdAt,
    updatedAt: isoTimestamp(raw.updatedAt, createdAt)
  }
}

export function sanitizeIdList(raw: Json): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const id = item.trim().slice(0, 100)
    if (id && !out.includes(id)) out.push(id)
    if (out.length >= MAX_LINKED_IDS) break
  }
  return out
}

export function sanitizeProject(raw: Json, now = new Date().toISOString(), makeNoteId?: () => string): Project | null {
  if (!isObject(raw) || typeof raw.id !== 'string' || !raw.id.trim()) return null
  const createdAt = isoTimestamp(raw.createdAt, now)
  const notes: ProjectNote[] = []
  if (Array.isArray(raw.notes)) {
    for (const item of raw.notes) {
      const note = sanitizeProjectNote(item, now, makeNoteId?.())
      if (note && !notes.some((n) => n.id === note.id)) notes.push(note)
      if (notes.length >= MAX_NOTES_PER_PROJECT) break
    }
  }
  return {
    id: raw.id.trim().slice(0, 100),
    title: sanitizeProjectTitle(raw.title),
    status: sanitizeProjectStatus(raw.status),
    createdAt,
    updatedAt: isoTimestamp(raw.updatedAt, createdAt),
    coverPhoto: raw.coverPhoto === null || raw.coverPhoto === undefined ? null : sanitizePhoto(raw.coverPhoto),
    tags: sanitizeTags(raw.tags),
    dateWindow: sanitizeDateWindow(raw.dateWindow),
    concept: sanitizeConcept(raw.concept),
    locationIds: sanitizeIdList(raw.locationIds),
    moodboardIds: sanitizeIdList(raw.moodboardIds),
    notes
  }
}

/**
 * Applies a partial edit to an existing project. Preserves `id`, `createdAt` and `coverPhoto`
 * (cover photos change only through dedicated cover-photo methods). Partial `dateWindow` and
 * `concept` objects merge onto the current values so editing one field keeps the others.
 */
export function applyProjectPatch(
  current: Project,
  patch: Json,
  now = new Date().toISOString(),
  makeNoteId?: () => string
): Project | null {
  const p: Partial<Record<keyof ProjectPatch, Json>> = isObject(patch) ? patch : {}
  const next: Record<string, Json> = { ...current, updatedAt: now }
  if (p.title !== undefined) next.title = p.title
  if (p.status !== undefined) next.status = p.status
  if (p.tags !== undefined) next.tags = p.tags
  if (p.locationIds !== undefined) next.locationIds = p.locationIds
  if (p.moodboardIds !== undefined) next.moodboardIds = p.moodboardIds
  if (isObject(p.dateWindow)) next.dateWindow = { ...current.dateWindow, ...p.dateWindow }
  if (isObject(p.concept)) next.concept = { ...current.concept, ...p.concept }
  if (p.notes !== undefined) next.notes = p.notes
  const updated = sanitizeProject(next, now, makeNoteId)
  if (!updated) return null
  return { ...updated, id: current.id, createdAt: current.createdAt, coverPhoto: current.coverPhoto }
}

export function projectsFileVersion(raw: Json): number {
  return isObject(raw) && finite(raw.version) ? raw.version : 1
}

export function migrateProjectsFile(raw: Json, now = new Date().toISOString()): ProjectsFile {
  const r = isObject(raw) ? raw : {}
  const projects: Project[] = []
  for (const item of Array.isArray(r.projects) ? r.projects : []) {
    const project = sanitizeProject(item, now)
    if (project && !projects.some((p) => p.id === project.id)) projects.push(project)
  }
  return { version: PROJECTS_FILE_VERSION, projects }
}

// ───────────────────────────── filtering, sorting & formatting ─────────────────────────────

export type ProjectStatusFilter = ProjectStatus | 'all'
export type ProjectSort = 'updated' | 'date' | 'name' | 'status'

export interface ProjectQuery {
  status: ProjectStatusFilter
  query: string
  sort: ProjectSort
}

export function matchesProjectSearch(
  project: Project,
  query: string,
  locationNamesById?: ReadonlyMap<string, string>
): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const locationNames = locationNamesById
    ? project.locationIds.map((id) => locationNamesById.get(id)).filter(Boolean).join(' ')
    : ''
  const hay = [
    project.title,
    project.tags.join(' '),
    project.concept.summary,
    project.concept.lightingMood,
    project.concept.constraints,
    project.dateWindow.label,
    locationNames
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return q.split(/\s+/).every((token) => hay.includes(token))
}

export function filterAndSortProjects(
  projects: readonly Project[],
  { status, query, sort }: ProjectQuery,
  locationNamesById?: ReadonlyMap<string, string>
): Project[] {
  const filtered = projects.filter((p) => {
    if (status === 'all') {
      if (p.status === 'archived') return false
    } else if (p.status !== status) {
      return false
    }
    return matchesProjectSearch(p, query, locationNamesById)
  })
  return [...filtered].sort((a, b) => {
    switch (sort) {
      case 'name':
        return a.title.localeCompare(b.title)
      case 'status':
        return PROJECT_STATUS_ORDER[a.status] - PROJECT_STATUS_ORDER[b.status] || b.updatedAt.localeCompare(a.updatedAt)
      case 'date': {
        const ad = a.dateWindow.start ?? a.dateWindow.end
        const bd = b.dateWindow.start ?? b.dateWindow.end
        if (ad && bd) return ad.localeCompare(bd) || b.updatedAt.localeCompare(a.updatedAt)
        if (ad) return -1
        if (bd) return 1
        return b.updatedAt.localeCompare(a.updatedAt)
      }
      case 'updated':
      default:
        return b.updatedAt.localeCompare(a.updatedAt)
    }
  })
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function parseIsoParts(iso: string): { year: number; month: number; day: number } | null {
  const m = ISO_DATE_RE.exec(iso)
  if (!m) return null
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }
}

/** Concise human-readable date window chip, e.g. "Oct 18–24" or "Late October, first snow". */
export function formatDateWindow(dw: ProjectDateWindow, referenceYear = new Date().getUTCFullYear()): string | null {
  const start = dw.start ? parseIsoParts(dw.start) : null
  const end = dw.end ? parseIsoParts(dw.end) : null
  if (start && end) {
    const sm = SHORT_MONTHS[start.month - 1]
    const em = SHORT_MONTHS[end.month - 1]
    if (start.year === end.year && start.month === end.month && start.day === end.day) {
      return start.year === referenceYear ? `${sm} ${start.day}` : `${sm} ${start.day}, ${start.year}`
    }
    if (start.year === end.year && start.month === end.month) {
      return start.year === referenceYear ? `${sm} ${start.day}–${end.day}` : `${sm} ${start.day}–${end.day}, ${start.year}`
    }
    if (start.year === end.year) {
      return start.year === referenceYear ? `${sm} ${start.day} – ${em} ${end.day}` : `${sm} ${start.day} – ${em} ${end.day}, ${start.year}`
    }
    return `${sm} ${start.day}, ${start.year} – ${em} ${end.day}, ${end.year}`
  }
  const single = start ?? end
  if (single) {
    const m = SHORT_MONTHS[single.month - 1]
    return single.year === referenceYear ? `${m} ${single.day}` : `${m} ${single.day}, ${single.year}`
  }
  return dw.label || null
}

// ───────────────────────────── starter templates ─────────────────────────────

export interface ProjectTemplate {
  id: string
  name: string
  description: string
  input: NewProject
}

export const PROJECT_TEMPLATES: readonly ProjectTemplate[] = [
  {
    id: 'landscape-trip',
    name: 'Landscape Trip',
    description: 'Multi-day mountain or coastal scouting trip with golden-hour windows and logistics notes.',
    input: {
      title: 'Autumn Mountain Trip',
      status: 'scouting',
      tags: ['landscape', 'golden hour', 'trip'],
      dateWindow: { label: 'Late autumn, crisp mornings' },
      concept: {
        summary: 'Capture layered ridges and valley mist across sunrise and blue hour vantages.',
        lightingMood: 'Low-angle warm side light, clearing storms, valley fog',
        constraints: '24–70mm + 70–200mm; prioritize clean foreground geometry',
        colorStory: ['#1b2a41', '#3b5978', '#d97736', '#f2b866', '#e8dfd1']
      },
      notes: [
        {
          title: 'Logistics & Access',
          body: '## Travel & Permits\n- [ ] Check trailhead parking and winter road closures\n- [ ] Verify sunrise hike duration + headlamp buffer\n- [ ] Download offline maps before departure',
          pinned: true
        }
      ]
    }
  },
  {
    id: 'astro-alignment',
    name: 'Astro Alignment',
    description: 'Plan a Milky Way arch or full-moon alignment behind a specific landmark or peak.',
    input: {
      title: 'Milky Way & Moon Alignment',
      status: 'brainstorming',
      tags: ['astro', 'night', 'alignment'],
      dateWindow: { label: 'New moon window' },
      concept: {
        summary: 'Align the Galactic Core or rising full moon cleanly over a dramatic skyline silhouette.',
        lightingMood: 'Astronomical dark sky (Bortle 1–3) with faint blue-hour foreground blend',
        constraints: 'Fast wide prime (14–24mm f/1.8) or telephoto compression for moonrise',
        colorStory: ['#090d1a', '#1b264f', '#3d4c7a', '#c084fc', '#f5c26b']
      },
      notes: [
        {
          title: 'Alignment Checklist',
          body: '## Scouting Steps\n- [ ] Verify line-of-sight with Horizon Panorama (H) & Shot Alignment (X)\n- [ ] Check light pollution domes along target azimuth\n- [ ] Confirm cloud-cover forecast 48h out',
          pinned: true
        }
      ]
    }
  },
  {
    id: 'creative-series',
    name: 'Creative Series',
    description: 'Cohesive visual theme with deliberate framing constraints, mood notes and color story.',
    input: {
      title: 'Blue Hour Urban Geometry',
      status: 'brainstorming',
      tags: ['series', 'blue hour', 'minimal'],
      dateWindow: { label: 'Ongoing seasonal series' },
      concept: {
        summary: 'A quiet sequence exploring warm artificial light against deep twilight facades.',
        lightingMood: 'Civil to nautical twilight, wet pavement reflections, overcast mist',
        constraints: 'Single 35mm prime · 4:5 vertical framing across all frames',
        colorStory: ['#101828', '#23395d', '#4fb3ff', '#f59e0b', '#fef3c7']
      },
      notes: [
        {
          title: 'Visual Thread',
          body: 'Keep horizons consistent and leave generous negative space so frames sequence cleanly as a diptych or zine.',
          pinned: true
        }
      ]
    }
  },
  {
    id: 'blank',
    name: 'Blank Project',
    description: 'Start fresh with an empty brief and add spots, colors, and notes as ideas form.',
    input: {
      title: 'Untitled Project',
      status: 'brainstorming'
    }
  }
]
