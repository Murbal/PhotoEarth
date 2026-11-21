// Saved scouting locations (formerly view bookmarks): the stored format, its migration, and
// the sanitizers shared by the main process (disk, IPC) and the renderer (filters). Pure.

import { sanitizeCameraView, sanitizeViewfinder } from './settings'
import type {
  Bookmark,
  BookmarkPatch,
  BookmarkTime,
  CameraView,
  GeoPosition,
  LocationPhoto,
  LocationStatus,
  NewProfile,
  ProfilePatch,
  SavedProfile
} from './types'

/** Version 1: `{ version: 1, bookmarks }` with views only. Version 2 adds the location fields and profiles. */
export const BOOKMARKS_FILE_VERSION = 2

export interface BookmarksFile {
  version: typeof BOOKMARKS_FILE_VERSION
  bookmarks: Bookmark[]
  profiles: SavedProfile[]
}

export const LOCATION_STATUSES: readonly LocationStatus[] = ['to-visit', 'visited']
export const MAX_NAME = 200
export const MAX_NOTES = 20_000
export const MAX_BEST_TIME = 500
export const MAX_TAGS = 24
export const MAX_TAG_LENGTH = 40
/** Originals larger than this are refused (a 60 MP JPEG is ~30 MB). */
export const MAX_PHOTO_BYTES = 40 * 1024 * 1024
export const MAX_THUMB_BYTES = 1024 * 1024
export const MAX_PHOTOS_PER_LOCATION = 40
export const MAX_PROFILE_POINTS = 500
/** Thumbnails are this tall (two device pixels per CSS pixel of the largest display). */
export const THUMB_HEIGHT = 240
/** A panorama wider than 4:1 is capped at this width; its thumbnail is shorter instead. */
export const THUMB_MAX_WIDTH = THUMB_HEIGHT * 4

/** Stored photo names: `<uuid>.<ext>` and `<uuid>.thumb.jpg`. Nothing else is ever served. */
export const PHOTO_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.thumb)?\.(jpg|png|webp|gif|avif)$/

export const PHOTO_SCHEME = 'photo'
export const PHOTO_HOST = 'local'

export function photoUrl(file: string): string {
  return `${PHOTO_SCHEME}://${PHOTO_HOST}/${file}`
}

export function thumbFile(photo: Pick<LocationPhoto, 'id'>): string {
  return `${photo.id}.thumb.jpg`
}

type Json = unknown

const isObject = (v: Json): v is Record<string, Json> => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: Json): v is number => typeof v === 'number' && Number.isFinite(v)
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

function text(v: Json, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : ''
}

function isoDate(v: Json, fallback: string): string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : fallback
}

export function sanitizeName(raw: Json, fallback = 'Untitled location'): string {
  const name = typeof raw === 'string' ? raw.trim().slice(0, MAX_NAME) : ''
  return name || fallback
}

function sanitizeTime(raw: Json): BookmarkTime | undefined {
  if (!isObject(raw) || typeof raw.utc !== 'string' || Number.isNaN(Date.parse(raw.utc))) return undefined
  return { utc: new Date(raw.utc).toISOString(), timeZone: typeof raw.timeZone === 'string' ? raw.timeZone.slice(0, 100) : 'UTC' }
}

/** Lowercase, single-spaced, without commas (they separate tags when typing). */
export function normalizeTag(raw: string): string {
  return raw.replace(/[,\s]+/g, ' ').trim().toLowerCase().slice(0, MAX_TAG_LENGTH).trim()
}

export function sanitizeTags(raw: Json): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const t of raw) {
    if (typeof t !== 'string') continue
    const tag = normalizeTag(t)
    if (tag && !out.includes(tag)) out.push(tag)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

export function sanitizePosition(raw: Json): GeoPosition | null {
  if (!isObject(raw) || !finite(raw.longitude) || !finite(raw.latitude)) return null
  return {
    longitude: clamp(raw.longitude, -180, 180),
    latitude: clamp(raw.latitude, -90, 90),
    height: finite(raw.height) ? clamp(raw.height, -1000, 1e5) : null
  }
}

const EARTH_RADIUS = 6371008.8
const DEG = Math.PI / 180

/**
 * Where a camera looks at the ground, without terrain: its view ray meets a sphere at sea
 * level. Looking at or above the horizon (or farther than `maxDistance`), the point below
 * the camera instead. Used for views saved before locations had a position; the height is
 * left unknown and measured on the next visit.
 */
export function estimateTarget(camera: CameraView, maxDistance = 60_000): GeoPosition {
  const below: GeoPosition = { longitude: camera.longitude, latitude: camera.latitude, height: null }
  const h = Math.max(camera.height, 1)
  const pitch = camera.pitch * DEG
  if (pitch > -0.5 * DEG) return below
  // Ray from radius R + h, depression angle -pitch: |p + t·d| = R.
  const r0 = EARTH_RADIUS + h
  const b = -r0 * Math.sin(-pitch)
  const disc = b * b - (r0 * r0 - EARTH_RADIUS * EARTH_RADIUS)
  if (disc < 0) return below
  const t = -b - Math.sqrt(disc)
  if (!(t > 0)) return below
  // Central angle between the camera's nadir and the hit point.
  const angle = Math.asin(clamp((t * Math.cos(pitch)) / EARTH_RADIUS, -1, 1))
  if (angle * EARTH_RADIUS > maxDistance) return below
  const φ1 = camera.latitude * DEG
  const λ1 = camera.longitude * DEG
  const θ = camera.heading * DEG
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(angle) + Math.cos(φ1) * Math.sin(angle) * Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(angle) * Math.cos(φ1), Math.cos(angle) - Math.sin(φ1) * Math.sin(φ2))
  const lon = ((((λ2 / DEG + 180) % 360) + 360) % 360) - 180
  return { longitude: lon, latitude: φ2 / DEG, height: null }
}

export function sanitizePhoto(raw: Json): LocationPhoto | null {
  if (!isObject(raw) || typeof raw.id !== 'string' || typeof raw.file !== 'string') return null
  if (!PHOTO_FILE.test(raw.file) || raw.file.includes('.thumb.') || !raw.file.startsWith(`${raw.id}.`)) return null
  return {
    id: raw.id,
    file: raw.file,
    name: text(raw.name, 260) || raw.file,
    bytes: finite(raw.bytes) ? Math.max(0, Math.round(raw.bytes)) : 0,
    width: finite(raw.width) ? Math.max(0, Math.round(raw.width)) : 0,
    height: finite(raw.height) ? Math.max(0, Math.round(raw.height)) : 0,
    addedAt: isoDate(raw.addedAt, new Date(0).toISOString())
  }
}

/**
 * Coerces a stored or received location. Accepts version-1 bookmarks (views only): they get
 * an estimated position, status "to visit" and empty notes, tags and photos.
 */
export function sanitizeBookmark(raw: Json, now = new Date().toISOString()): Bookmark | null {
  if (!isObject(raw) || typeof raw.id !== 'string' || !raw.id) return null
  const camera = sanitizeCameraView(raw.camera)
  if (!camera) return null
  const createdAt = isoDate(raw.createdAt, now)
  const photos: LocationPhoto[] = []
  if (Array.isArray(raw.photos)) {
    for (const p of raw.photos) {
      const photo = sanitizePhoto(p)
      if (photo && !photos.some((q) => q.id === photo.id)) photos.push(photo)
      if (photos.length >= MAX_PHOTOS_PER_LOCATION) break
    }
  }
  return {
    id: raw.id.slice(0, 100),
    name: sanitizeName(raw.name),
    createdAt,
    updatedAt: isoDate(raw.updatedAt, createdAt),
    camera,
    mode: raw.mode === 'elevation' ? 'elevation' : 'photorealistic',
    time: sanitizeTime(raw.time),
    viewfinder: raw.viewfinder === undefined || raw.viewfinder === null ? undefined : sanitizeViewfinder(raw.viewfinder),
    position: sanitizePosition(raw.position) ?? estimateTarget(camera),
    status: raw.status === 'visited' ? 'visited' : 'to-visit',
    notes: text(raw.notes, MAX_NOTES),
    tags: sanitizeTags(raw.tags),
    bestTime: text(raw.bestTime, MAX_BEST_TIME).trim(),
    photos
  }
}

/** Applies an edit; id, creation date and photos stay as they are. */
export function applyBookmarkPatch(current: Bookmark, patch: Json, now = new Date().toISOString()): Bookmark | null {
  const p: Partial<Record<keyof BookmarkPatch, Json>> = isObject(patch) ? patch : {}
  const next: Record<string, Json> = { ...current, updatedAt: now }
  for (const key of ['name', 'camera', 'mode', 'position', 'status', 'notes', 'tags', 'bestTime'] as const) {
    if (p[key] !== undefined) next[key] = p[key]
  }
  // null clears; undefined leaves alone.
  if (p.time !== undefined) next.time = p.time ?? undefined
  if (p.viewfinder !== undefined) next.viewfinder = p.viewfinder ?? undefined
  const updated = sanitizeBookmark(next, now)
  if (!updated) return null
  return { ...updated, id: current.id, createdAt: current.createdAt, photos: current.photos }
}

export function sanitizeProfile(raw: Json, now = new Date().toISOString()): SavedProfile | null {
  if (!isObject(raw) || typeof raw.id !== 'string' || !raw.id || !Array.isArray(raw.points)) return null
  const points = raw.points
    .slice(0, MAX_PROFILE_POINTS)
    .map(sanitizePosition)
    .filter((p): p is GeoPosition => !!p)
  if (points.length < 2) return null
  return {
    id: raw.id.slice(0, 100),
    name: sanitizeName(raw.name, 'Elevation profile'),
    createdAt: isoDate(raw.createdAt, now),
    points,
    locationId: typeof raw.locationId === 'string' && raw.locationId ? raw.locationId.slice(0, 100) : null
  }
}

export function newProfile(input: NewProfile, id: string, now = new Date().toISOString()): SavedProfile | null {
  return sanitizeProfile({ ...(isObject(input) ? input : {}), id, createdAt: now }, now)
}

export function applyProfilePatch(current: SavedProfile, patch: Json): SavedProfile | null {
  const p: Partial<Record<keyof ProfilePatch, Json>> = isObject(patch) ? patch : {}
  const next: Record<string, Json> = { ...current }
  if (p.name !== undefined) next.name = p.name
  if (p.locationId !== undefined) next.locationId = p.locationId
  const updated = sanitizeProfile(next)
  return updated && { ...updated, id: current.id, createdAt: current.createdAt }
}

/** The version a raw file says it is: 1 for the original `{ version: 1, bookmarks }` (or none). */
export function fileVersion(raw: Json): number {
  return isObject(raw) && finite(raw.version) ? raw.version : 1
}

/**
 * Reads any stored version into the current format. Version 1 held views only (see
 * sanitizeBookmark for what they gain). Records that can't be read are dropped; profiles
 * pointing at a missing location become general profiles.
 */
export function migrateBookmarksFile(raw: Json, now = new Date().toISOString()): BookmarksFile {
  const r = isObject(raw) ? raw : {}
  const bookmarks: Bookmark[] = []
  for (const item of Array.isArray(r.bookmarks) ? r.bookmarks : []) {
    const b = sanitizeBookmark(item, now)
    if (b && !bookmarks.some((x) => x.id === b.id)) bookmarks.push(b)
  }
  const ids = new Set(bookmarks.map((b) => b.id))
  const profiles: SavedProfile[] = []
  for (const item of Array.isArray(r.profiles) ? r.profiles : []) {
    const p = sanitizeProfile(item, now)
    if (!p || profiles.some((x) => x.id === p.id)) continue
    profiles.push(p.locationId && !ids.has(p.locationId) ? { ...p, locationId: null } : p)
  }
  return { version: BOOKMARKS_FILE_VERSION, bookmarks, profiles }
}

// ───────────────────────────── filtering (panel, markers) ─────────────────────────────

export interface LocationFilter {
  status: LocationStatus | 'all'
  /** A location must carry every one of these. */
  tags: string[]
}

export const NO_FILTER: LocationFilter = { status: 'all', tags: [] }

export function matchesFilter(b: Pick<Bookmark, 'status' | 'tags'>, filter: LocationFilter): boolean {
  if (filter.status !== 'all' && b.status !== filter.status) return false
  return filter.tags.every((t) => b.tags.includes(t))
}

/** Every tag in use, most used first, then alphabetical. */
export function tagCounts(bookmarks: ReadonlyArray<Pick<Bookmark, 'tags'>>): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>()
  for (const b of bookmarks) for (const t of b.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}
