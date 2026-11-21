import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  applyBookmarkPatch,
  applyProfilePatch,
  BOOKMARKS_FILE_VERSION,
  fileVersion,
  MAX_PHOTOS_PER_LOCATION,
  migrateBookmarksFile,
  newProfile,
  sanitizeBookmark,
  type BookmarksFile
} from '@shared/locations'
import type { Bookmark, PhotoResult, SavedProfile } from '@shared/types'
import { JsonFile } from './jsonStore'
import { PhotoError, PhotoStore, type PhotoInput } from './photos'

/**
 * Saved scouting locations and elevation profiles, in `bookmarks.json` (the file kept its name
 * from when locations were view bookmarks), with their photos in `photos/` next to it.
 *
 * A file from an older version is migrated when it is read (see migrateBookmarksFile) and
 * written back in the current format; the original is kept once as `bookmarks.v<n>.backup.json`.
 */
export class BookmarkStore {
  readonly photos: PhotoStore
  private readonly file: JsonFile<BookmarksFile>

  constructor(dir: string) {
    const path = join(dir, 'bookmarks.json')
    const version = readVersion(path)
    if (version !== null && version !== BOOKMARKS_FILE_VERSION) {
      const backup = join(dir, `bookmarks.v${version}.backup.json`)
      try {
        if (!existsSync(backup)) copyFileSync(path, backup)
      } catch (err) {
        console.error('[photoearth] Could not back up bookmarks.json before migrating it:', err)
      }
    }
    this.file = new JsonFile<BookmarksFile>(path, (raw) => migrateBookmarksFile(raw))
    if (version !== null && version !== BOOKMARKS_FILE_VERSION) this.file.set(this.file.get())
    this.photos = new PhotoStore(join(dir, 'photos'))
    try {
      this.photos.removeOrphans(this.list().flatMap((b) => b.photos))
    } catch (err) {
      console.error('[photoearth] Could not clean up the photo directory:', err)
    }
  }

  list(): Bookmark[] {
    return this.file.get().bookmarks
  }

  listProfiles(): SavedProfile[] {
    return this.file.get().profiles
  }

  private save(patch: Partial<Omit<BookmarksFile, 'version'>>): void {
    this.file.set({ ...this.file.get(), ...patch, version: BOOKMARKS_FILE_VERSION })
  }

  create(input: unknown): Bookmark {
    const now = new Date().toISOString()
    const fields = typeof input === 'object' && input !== null ? input : {}
    // Never trust ids, dates or photos from the renderer.
    const bookmark = sanitizeBookmark({ ...fields, id: randomUUID(), createdAt: now, updatedAt: now, photos: [] }, now)
    if (!bookmark) throw new Error('Invalid location')
    this.save({ bookmarks: [...this.list(), bookmark] })
    return bookmark
  }

  update(id: string, patch: unknown): Bookmark | null {
    return this.replace(id, (b) => applyBookmarkPatch(b, patch))
  }

  remove(id: string): boolean {
    const list = this.list()
    const gone = list.find((b) => b.id === id)
    if (!gone) return false
    this.save({
      bookmarks: list.filter((b) => b.id !== id),
      profiles: this.listProfiles().filter((p) => p.locationId !== id)
    })
    // The record goes first: a crash now leaves orphan files (removed at the next start),
    // never a location pointing at missing photos.
    this.file.flush()
    for (const photo of gone.photos) this.photos.remove(photo)
    return true
  }

  addPhoto(id: string, input: PhotoInput): PhotoResult {
    const bookmark = this.list().find((b) => b.id === id)
    if (!bookmark) return { ok: false, error: 'The location no longer exists.' }
    if (bookmark.photos.length >= MAX_PHOTOS_PER_LOCATION) {
      return { ok: false, error: `A location can hold at most ${MAX_PHOTOS_PER_LOCATION} photos.` }
    }
    let photo
    try {
      photo = this.photos.save(input)
    } catch (err) {
      if (err instanceof PhotoError) return { ok: false, error: err.message }
      console.error('[photoearth] Could not store a photo:', err)
      return { ok: false, error: 'The photo could not be saved.' }
    }
    const updated = this.replace(id, (b) => ({ ...b, photos: [...b.photos, photo], updatedAt: photo.addedAt }))
    if (!updated) {
      this.photos.remove(photo)
      return { ok: false, error: 'The location no longer exists.' }
    }
    return { ok: true, bookmark: updated }
  }

  removePhoto(id: string, photoId: string): Bookmark | null {
    const photo = this.list()
      .find((b) => b.id === id)
      ?.photos.find((p) => p.id === photoId)
    if (!photo) return null
    const updated = this.replace(id, (b) => ({ ...b, photos: b.photos.filter((p) => p.id !== photoId), updatedAt: new Date().toISOString() }))
    this.file.flush()
    this.photos.remove(photo)
    return updated
  }

  createProfile(input: unknown): SavedProfile | null {
    const profile = newProfile(input as never, randomUUID())
    if (!profile) return null
    const attached = profile.locationId && this.list().some((b) => b.id === profile.locationId) ? profile : { ...profile, locationId: null }
    this.save({ profiles: [...this.listProfiles(), attached] })
    return attached
  }

  updateProfile(id: string, patch: unknown): SavedProfile | null {
    const list = this.listProfiles()
    const index = list.findIndex((p) => p.id === id)
    if (index < 0) return null
    const updated = applyProfilePatch(list[index], patch)
    if (!updated) return null
    if (updated.locationId && !this.list().some((b) => b.id === updated.locationId)) updated.locationId = null
    const next = [...list]
    next[index] = updated
    this.save({ profiles: next })
    return updated
  }

  removeProfile(id: string): boolean {
    const list = this.listProfiles()
    const next = list.filter((p) => p.id !== id)
    if (next.length === list.length) return false
    this.save({ profiles: next })
    return true
  }

  flush(): void {
    this.file.flush()
  }

  private replace(id: string, fn: (b: Bookmark) => Bookmark | null): Bookmark | null {
    const list = this.list()
    const index = list.findIndex((b) => b.id === id)
    if (index < 0) return null
    const updated = fn(list[index])
    if (!updated) return null
    const next = [...list]
    next[index] = updated
    this.save({ bookmarks: next })
    return updated
  }
}

/** The stored file's format version, or null when there is no readable file. */
function readVersion(path: string): number | null {
  if (!existsSync(path)) return null
  try {
    return fileVersion(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}
