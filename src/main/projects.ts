import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  applyProjectPatch,
  MAX_LINKED_IDS,
  migrateProjectsFile,
  PROJECTS_FILE_VERSION,
  projectsFileVersion,
  sanitizeProject,
  type ProjectsFile
} from '@shared/projects'
import { sanitizePhoto } from '@shared/locations'
import type { LocationPhoto, Project, ProjectPhotoResult } from '@shared/types'
import { JsonFile } from './jsonStore'
import { cleanOrphanPhotos, PhotoError, PhotoStore, type PhotoInput, type PhotoOwner } from './photos'

export interface ProjectStoreOptions {
  /** Shared top-level PhotoStore service; when omitted, ProjectStore creates its own. */
  photos?: PhotoStore
  /**
   * Whether to run orphan cleanup during construction. Defaults to `true` when ProjectStore
   * owns its own PhotoStore and `false` when a shared PhotoStore is injected.
   */
  cleanupOrphans?: boolean
}

/**
 * Photography projects stored in `projects.json`, referencing shared assets in `photos/`.
 * Projects link to bookmarks and moodboards by ID (non-destructive many-to-many).
 */
export class ProjectStore implements PhotoOwner {
  readonly photos: PhotoStore
  readonly canCleanOrphans: boolean
  private readonly file: JsonFile<ProjectsFile>

  constructor(dir: string, options?: ProjectStoreOptions) {
    const path = join(dir, 'projects.json')
    const version = readVersion(path)
    if (version !== null && version !== PROJECTS_FILE_VERSION) {
      const backup = join(dir, `projects.v${version}.backup.json`)
      try {
        if (!existsSync(backup)) copyFileSync(path, backup)
      } catch (err) {
        console.error('[photoearth] Could not back up projects.json before migrating it:', err)
      }
    }
    this.file = new JsonFile<ProjectsFile>(path, (raw) => migrateProjectsFile(raw))
    if (version !== null && version !== PROJECTS_FILE_VERSION) this.file.set(this.file.get())
    const ownsPhotos = !options?.photos
    this.photos = options?.photos ?? new PhotoStore(join(dir, 'photos'))
    this.canCleanOrphans = !this.file.recovered && !(version !== null && version > PROJECTS_FILE_VERSION)
    if (options?.cleanupOrphans ?? ownsPhotos) {
      cleanOrphanPhotos(this.photos, [this])
    }
  }

  referencedPhotos(): LocationPhoto[] {
    const out: LocationPhoto[] = []
    for (const project of this.list()) {
      if (project.coverPhoto) out.push(project.coverPhoto)
    }
    return out
  }

  list(): Project[] {
    return this.file.get().projects
  }

  get(id: string): Project | null {
    return this.list().find((p) => p.id === id) ?? null
  }

  private save(projects: Project[]): void {
    this.file.set({ version: PROJECTS_FILE_VERSION, projects })
  }

  create(input: unknown): Project {
    const now = new Date().toISOString()
    const fields = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
    // Never trust ids, timestamps or coverPhoto from the renderer; assign fresh UUIDs to notes.
    const rawNotes = Array.isArray(fields.notes)
      ? fields.notes.map((n) => (typeof n === 'object' && n !== null ? { ...n, id: randomUUID(), createdAt: now, updatedAt: now } : n))
      : []
    const project = sanitizeProject(
      {
        ...fields,
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
        coverPhoto: null,
        notes: rawNotes
      },
      now,
      () => randomUUID()
    )
    if (!project) throw new Error('Invalid project')
    this.save([...this.list(), project])
    return project
  }

  update(id: string, patch: unknown): Project | null {
    return this.replace(id, (p) => applyProjectPatch(p, patch, new Date().toISOString(), () => randomUUID()))
  }

  /**
   * Deletes the project record and removes its cover photo from PhotoStore.
   * Linked locations and moodboards are left intact.
   */
  remove(id: string): boolean {
    const list = this.list()
    const gone = list.find((p) => p.id === id)
    if (!gone) return false
    this.save(list.filter((p) => p.id !== id))
    // Flush record removal before deleting files so a crash never leaves a dangling photo pointer.
    this.file.flush()
    if (gone.coverPhoto) this.photos.remove(gone.coverPhoto)
    return true
  }

  setCoverPhoto(id: string, input: PhotoInput): ProjectPhotoResult {
    const current = this.get(id)
    if (!current) return { ok: false, error: 'The project no longer exists.' }
    let photo: LocationPhoto
    try {
      photo = this.photos.save(input)
    } catch (err) {
      if (err instanceof PhotoError) return { ok: false, error: err.message }
      console.error('[photoearth] Could not store a project cover photo:', err)
      return { ok: false, error: 'The cover photo could not be saved.' }
    }
    return this.commitCoverPhoto(id, current.coverPhoto, photo)
  }

  setCoverPhotoFromPhoto(id: string, rawSource: unknown): ProjectPhotoResult {
    const current = this.get(id)
    if (!current) return { ok: false, error: 'The project no longer exists.' }
    const source = sanitizePhoto(rawSource)
    if (!source) return { ok: false, error: 'Invalid source photo.' }
    let photo: LocationPhoto
    try {
      photo = this.photos.clone(source)
    } catch (err) {
      if (err instanceof PhotoError) return { ok: false, error: err.message }
      console.error('[photoearth] Could not clone a cover photo:', err)
      return { ok: false, error: 'The cover photo could not be copied.' }
    }
    return this.commitCoverPhoto(id, current.coverPhoto, photo)
  }

  clearCoverPhoto(id: string): Project | null {
    const current = this.get(id)
    if (!current) return null
    const previous = current.coverPhoto
    const updated = this.replace(id, (p) => ({ ...p, coverPhoto: null, updatedAt: new Date().toISOString() }))
    if (updated && previous) {
      this.file.flush()
      this.photos.remove(previous)
    }
    return updated
  }

  linkLocation(projectId: string, locationId: string): Project | null {
    const cleanId = locationId.trim().slice(0, 100)
    if (!cleanId) return null
    return this.replace(projectId, (p) => {
      if (p.locationIds.includes(cleanId)) return p
      if (p.locationIds.length >= MAX_LINKED_IDS) return p
      return { ...p, locationIds: [...p.locationIds, cleanId], updatedAt: new Date().toISOString() }
    })
  }

  unlinkLocation(projectId: string, locationId: string): Project | null {
    const cleanId = locationId.trim().slice(0, 100)
    if (!cleanId) return null
    return this.replace(projectId, (p) => {
      if (!p.locationIds.includes(cleanId)) return p
      return { ...p, locationIds: p.locationIds.filter((x) => x !== cleanId), updatedAt: new Date().toISOString() }
    })
  }

  /** Referential integrity hook called when a Bookmark is deleted. */
  unlinkLocationFromAll(locationId: string): number {
    const cleanId = locationId.trim().slice(0, 100)
    if (!cleanId) return 0
    const list = this.list()
    let updatedCount = 0
    const now = new Date().toISOString()
    const next = list.map((p) => {
      if (!p.locationIds.includes(cleanId)) return p
      updatedCount++
      return { ...p, locationIds: p.locationIds.filter((x) => x !== cleanId), updatedAt: now }
    })
    if (updatedCount > 0) this.save(next)
    return updatedCount
  }

  linkMoodboard(projectId: string, moodboardId: string): Project | null {
    const cleanId = moodboardId.trim().slice(0, 100)
    if (!cleanId) return null
    return this.replace(projectId, (p) => {
      if (p.moodboardIds.includes(cleanId)) return p
      if (p.moodboardIds.length >= MAX_LINKED_IDS) return p
      return { ...p, moodboardIds: [...p.moodboardIds, cleanId], updatedAt: new Date().toISOString() }
    })
  }

  unlinkMoodboard(projectId: string, moodboardId: string): Project | null {
    const cleanId = moodboardId.trim().slice(0, 100)
    if (!cleanId) return null
    return this.replace(projectId, (p) => {
      if (!p.moodboardIds.includes(cleanId)) return p
      return { ...p, moodboardIds: p.moodboardIds.filter((x) => x !== cleanId), updatedAt: new Date().toISOString() }
    })
  }

  /** Referential integrity hook ready for when a Moodboard is deleted. */
  unlinkMoodboardFromAll(moodboardId: string): number {
    const cleanId = moodboardId.trim().slice(0, 100)
    if (!cleanId) return 0
    const list = this.list()
    let updatedCount = 0
    const now = new Date().toISOString()
    const next = list.map((p) => {
      if (!p.moodboardIds.includes(cleanId)) return p
      updatedCount++
      return { ...p, moodboardIds: p.moodboardIds.filter((x) => x !== cleanId), updatedAt: now }
    })
    if (updatedCount > 0) this.save(next)
    return updatedCount
  }

  flush(): void {
    this.file.flush()
  }

  private commitCoverPhoto(id: string, previous: LocationPhoto | null, photo: LocationPhoto): ProjectPhotoResult {
    const updated = this.replace(id, (p) => ({ ...p, coverPhoto: photo, updatedAt: photo.addedAt }))
    if (!updated) {
      this.photos.remove(photo)
      return { ok: false, error: 'The project no longer exists.' }
    }
    if (previous) {
      this.file.flush()
      this.photos.remove(previous)
    }
    return { ok: true, project: updated }
  }

  private replace(id: string, fn: (p: Project) => Project | null): Project | null {
    const list = this.list()
    const index = list.findIndex((p) => p.id === id)
    if (index < 0) return null
    const updated = fn(list[index])
    if (!updated) return null
    const next = [...list]
    next[index] = updated
    this.save(next)
    return updated
  }
}

function readVersion(path: string): number | null {
  if (!existsSync(path)) return null
  try {
    return projectsFileVersion(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}
