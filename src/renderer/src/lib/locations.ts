// Saved scouting locations and profiles: renderer-side actions (IPC + store).

import { MAX_PHOTO_BYTES, MAX_PHOTOS_PER_LOCATION } from '@shared/locations'
import type { Bookmark, BookmarkPatch, SavedProfile } from '@shared/types'
import { getEngine } from '../engine/instance'
import { appState } from '../store/appStore'
import { formatLatLon } from '@shared/coords'
import { makeThumbnail } from './photos'
import { haversine } from './profile'
import { formatDistance } from './units'

function replaceBookmark(updated: Bookmark): void {
  appState().set({ bookmarks: appState().bookmarks.map((b) => (b.id === updated.id ? updated : b)) })
}

/**
 * Saves the current view as a location (Ctrl/Cmd+B). `edit` opens it in the editor, as the
 * panel's button does; the shortcut only opens the list, so the keyboard stays on the map.
 */
export async function saveCurrentView(opts: { name?: string; edit?: boolean } = {}): Promise<Bookmark | null> {
  const engine = getEngine()
  if (!engine) return null
  const { settings, destination, bookmarks, set, togglePanel, showToast } = appState()
  // In Map mode the location is at the map's center (§5.5).
  const target = settings.map.open ? engine.mapView() : appState().target
  const label =
    opts.name ??
    destination?.name ??
    (target ? `View ${formatLatLon(target.latitude, target.longitude, 'decimal')}` : `View ${bookmarks.length + 1}`)
  const saved = await window.photoearth.bookmarks.create(await engine.bookmarkFromView(label, settings.bookmarkIncludeTime))
  // Opens on the new location, or on the list where it now is: never on another location's
  // details left open from before.
  set({ bookmarks: [...appState().bookmarks, saved], activeLocation: opts.edit ? saved.id : null })
  togglePanel('bookmarks', true)
  showToast('Location saved')
  return saved
}

export async function updateLocation(id: string, patch: BookmarkPatch): Promise<Bookmark | null> {
  const updated = await window.photoearth.bookmarks.update(id, patch)
  if (updated) replaceBookmark(updated)
  return updated
}

/** Replaces a location's view, lens, time (when the setting says so) and spot with the current ones. */
export async function setLocationToCurrentView(id: string): Promise<void> {
  const engine = getEngine()
  const b = appState().bookmarks.find((x) => x.id === id)
  if (!engine || !b) return
  const view = await engine.bookmarkFromView(b.name, appState().settings.bookmarkIncludeTime)
  await updateLocation(id, { ...view, time: view.time ?? null, viewfinder: view.viewfinder ?? null })
  appState().showToast('Location updated to the current view')
}

/** Deletes a location with its photos and attached profiles. */
export async function deleteLocation(id: string): Promise<void> {
  await window.photoearth.bookmarks.remove(id)
  const s = appState()
  s.set({
    bookmarks: s.bookmarks.filter((b) => b.id !== id),
    profiles: s.profiles.filter((p) => p.locationId !== id),
    activeLocation: s.activeLocation === id ? null : s.activeLocation,
    photoViewer: s.photoViewer?.locationId === id ? null : s.photoViewer
  })
}

export function flyToBookmark(b: Bookmark): void {
  void getEngine()?.flyToBookmark(b)
}

/** A photo to import: its name and size up front, its bytes only when it's its turn. */
interface PhotoSource {
  name: string
  size: number
  /** The file's contents, or a message saying why it can't be read. */
  load: () => Promise<Blob | string>
}

/**
 * Copies photos into the location, one at a time: each is checked for size before it is read,
 * given a thumbnail here (the browser's decoders, EXIF orientation applied), and stored by the
 * main process, which checks it again.
 */
async function importPhotos(id: string, sources: Iterable<PhotoSource>): Promise<void> {
  const { showToast } = appState()
  let added = 0
  const problems: string[] = []
  for (const source of sources) {
    const current = appState().bookmarks.find((b) => b.id === id)
    if (!current) return
    if (current.photos.length >= MAX_PHOTOS_PER_LOCATION) {
      problems.push(`A location can hold at most ${MAX_PHOTOS_PER_LOCATION} photos.`)
      break
    }
    if (source.size > MAX_PHOTO_BYTES) {
      problems.push(`${source.name} is ${(source.size / 1048576).toFixed(0)} MB; photos can be at most ${MAX_PHOTO_BYTES / 1048576} MB.`)
      continue
    }
    try {
      const file = await source.load()
      if (typeof file === 'string') {
        problems.push(`${source.name}: ${file}`)
        continue
      }
      const thumb = await makeThumbnail(file)
      const data = new Uint8Array(await file.arrayBuffer())
      const res = await window.photoearth.bookmarks.addPhoto(id, { name: source.name, data, ...thumb })
      if (res.ok) {
        replaceBookmark(res.bookmark)
        added++
      } else {
        problems.push(`${source.name}: ${res.error}`)
      }
    } catch {
      problems.push(`${source.name} can't be read as an image here (JPEG, PNG, WebP, GIF or AVIF).`)
    }
  }
  if (problems.length) showToast(problems.length === 1 ? problems[0] : `${problems[0]} (+${problems.length - 1} more)`)
  else if (added) showToast(added === 1 ? 'Photo added' : `${added} photos added`)
}

/** Files dropped on the editor. */
export function addPhotoFiles(id: string, files: Iterable<File>): Promise<void> {
  return importPhotos(
    id,
    Array.from(files, (file) => ({ name: file.name, size: file.size, load: async () => file }))
  )
}

/** "Add photos": the native file picker, then the chosen files one by one. */
export async function pickPhotos(id: string): Promise<void> {
  const picked = await window.photoearth.bookmarks.pickPhotos(id)
  await importPhotos(
    id,
    picked.map((p) => ({
      name: p.name,
      size: p.bytes,
      load: async () => {
        const res = await window.photoearth.bookmarks.readPickedPhoto(p.token)
        return res.ok ? new Blob([res.data as Uint8Array<ArrayBuffer>]) : res.error
      }
    }))
  )
}

export async function removePhoto(id: string, photoId: string): Promise<void> {
  const updated = await window.photoearth.bookmarks.removePhoto(id, photoId)
  if (updated) replaceBookmark(updated)
  const viewer = appState().photoViewer
  if (viewer?.photoId === photoId) appState().set({ photoViewer: null })
}

// ───────────────────────────── profiles ─────────────────────────────

/** "Path 3.2 km", from the drawn path's length (known before, or without, any elevation samples). */
export function defaultProfileName(): string {
  const { profile, settings } = appState()
  let length = 0
  for (let i = 1; i < profile.points.length; i++) length += haversine(profile.points[i - 1], profile.points[i])
  return length > 0 ? `Path ${formatDistance(length, settings.units)}` : 'Elevation profile'
}

/** Saves the drawn profile path, on its own or with a location. */
export async function saveProfile(name: string, locationId: string | null): Promise<SavedProfile | null> {
  const engine = getEngine()
  if (!engine) return null
  const points = engine.profile.vertexPositions()
  const saved = await window.photoearth.profiles.create({ name, points, locationId })
  if (!saved) {
    appState().showToast('A profile needs at least two points')
    return null
  }
  appState().set({ profiles: [...appState().profiles, saved] })
  appState().patchProfile({ savedId: saved.id })
  appState().showToast(saved.locationId ? 'Profile saved with the location' : 'Profile saved')
  return saved
}

export function openProfile(p: SavedProfile): void {
  void getEngine()?.openSavedProfile(p)
}

export async function renameProfile(id: string, name: string): Promise<void> {
  const updated = await window.photoearth.profiles.update(id, { name })
  if (updated) appState().set({ profiles: appState().profiles.map((p) => (p.id === id ? updated : p)) })
}

export async function deleteProfile(id: string): Promise<void> {
  await window.photoearth.profiles.remove(id)
  appState().set({ profiles: appState().profiles.filter((p) => p.id !== id) })
  if (appState().profile.savedId === id) appState().patchProfile({ savedId: null })
}
