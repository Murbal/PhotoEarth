import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sanitizePhoto } from '@shared/locations'
import {
  buildTemplateDocument,
  isValidBoardId,
  migrateMoodboardIndexFile,
  MOODBOARD_DOC_VERSION,
  MOODBOARD_INDEX_VERSION,
  moodboardDocVersion,
  moodboardIndexVersion,
  sanitizeMoodboardDocument,
  sanitizeMoodboardTitle,
  summarizeMoodboardDocument,
  type MoodboardIndexFile
} from '@shared/moodboards'
import type {
  LocationPhoto,
  MoodboardCreateResult,
  MoodboardDocument,
  MoodboardImageResult,
  MoodboardMetaPatch,
  MoodboardSummary,
  MoodboardTemplateId
} from '@shared/types'
import { JsonFile } from './jsonStore'
import { cleanOrphanPhotos, PhotoError, PhotoStore, type PhotoInput, type PhotoOwner } from './photos'

export interface MoodboardStoreOptions {
  /** Shared top-level PhotoStore service; when omitted, MoodboardStore creates its own. */
  photos?: PhotoStore
  /**
   * Whether to run orphan cleanup during construction. Defaults to `true` when MoodboardStore
   * owns its own PhotoStore and `false` when a shared PhotoStore is injected.
   */
  cleanupOrphans?: boolean
  /** Called after a moodboard is removed so ProjectStore can unlink its ID. */
  onRemove?: (boardId: string) => void
  /** Called after a moodboard is created with a primary projectId so ProjectStore can link it. */
  onCreate?: (summary: MoodboardSummary) => void
}

const VALID_TEMPLATES: readonly MoodboardTemplateId[] = ['blank', 'three-column', 'shot-study']

/**
 * Moodboards stored as `<userData>/moodboards/index.json` + lazy per-board `<id>.json` files,
 * referencing shared assets in `<userData>/photos/`.
 */
export class MoodboardStore implements PhotoOwner {
  readonly photos: PhotoStore
  readonly dir: string
  readonly canCleanOrphans: boolean
  private readonly indexFile: JsonFile<MoodboardIndexFile>
  private readonly onRemove?: (boardId: string) => void
  private readonly onCreate?: (summary: MoodboardSummary) => void
  /** Cache of loaded board documents keyed by boardId. */
  private readonly cache = new Map<string, MoodboardDocument>()
  /** Photos removed during live editing (preserved for Undo until flush/close). */
  private readonly pendingPhotoRemovals = new Map<string, LocationPhoto>()
  private readonly startupScanClean: boolean

  constructor(userDataDir: string, options?: MoodboardStoreOptions) {
    this.dir = join(userDataDir, 'moodboards')
    this.onRemove = options?.onRemove
    this.onCreate = options?.onCreate
    const indexPath = join(this.dir, 'index.json')
    const version = readIndexVersion(indexPath)
    if (version !== null && version !== MOODBOARD_INDEX_VERSION) {
      const backup = join(this.dir, `index.v${version}.backup.json`)
      try {
        mkdirSync(this.dir, { recursive: true })
        if (!existsSync(backup)) copyFileSync(indexPath, backup)
      } catch (err) {
        console.error('[photoearth] Could not back up moodboards/index.json before migrating it:', err)
      }
    }
    this.indexFile = new JsonFile<MoodboardIndexFile>(indexPath, (raw) => migrateMoodboardIndexFile(raw))
    if (version !== null && version !== MOODBOARD_INDEX_VERSION) this.indexFile.set(this.indexFile.get())

    const ownsPhotos = !options?.photos
    this.photos = options?.photos ?? new PhotoStore(join(userDataDir, 'photos'))

    // Inspect existing board JSON files on disk so startup orphan cleanup never deletes photos
    // belonging to a corrupt or future-version board document.
    this.startupScanClean = this.checkAllBoardFilesClean()
    this.canCleanOrphans =
      !this.indexFile.recovered &&
      !(version !== null && version > MOODBOARD_INDEX_VERSION) &&
      this.startupScanClean

    if (options?.cleanupOrphans ?? ownsPhotos) {
      cleanOrphanPhotos(this.photos, [this])
    }
  }

  /** Collects every LocationPhoto referenced across all stored moodboard documents. */
  referencedPhotos(): LocationPhoto[] {
    const out: LocationPhoto[] = []
    const seenIds = new Set<string>()
    for (const summary of this.list()) {
      const doc = this.get(summary.id)
      if (!doc) continue
      for (const item of doc.items) {
        if (item.kind === 'image' && !seenIds.has(item.photo.id)) {
          seenIds.add(item.photo.id)
          out.push(item.photo)
        }
      }
    }
    return out
  }

  list(): MoodboardSummary[] {
    return this.indexFile.get().boards
  }

  getSummary(id: string): MoodboardSummary | null {
    return this.list().find((b) => b.id === id) ?? null
  }

  get(id: string): MoodboardDocument | null {
    if (!isValidBoardId(id)) return null
    const cached = this.cache.get(id)
    if (cached) return cached
    const summary = this.getSummary(id)
    if (!summary) return null
    const path = this.boardPath(id)
    if (!existsSync(path)) {
      // Index entry without a board file yet: synthesize an empty board.
      const fallback = buildTemplateDocument(id, summary.title, summary.projectId, 'blank', () => randomUUID())
      this.cache.set(id, fallback)
      return fallback
    }
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'))
      const doc = sanitizeMoodboardDocument(raw, id)
      if (!doc) return null
      // Keep title and projectId aligned with index metadata.
      const synced: MoodboardDocument = { ...doc, id, title: summary.title, projectId: summary.projectId }
      this.cache.set(id, synced)
      return synced
    } catch (err) {
      console.error(`[photoearth] Could not read moodboard ${id}:`, err)
      return null
    }
  }

  create(input?: unknown): MoodboardCreateResult {
    const fields = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
    const id = randomUUID()
    const title = sanitizeMoodboardTitle(fields.title)
    const projectId = typeof fields.projectId === 'string' && fields.projectId.trim() ? fields.projectId.trim().slice(0, 100) : null
    const template: MoodboardTemplateId =
      typeof fields.template === 'string' && (VALID_TEMPLATES as readonly string[]).includes(fields.template)
        ? (fields.template as MoodboardTemplateId)
        : 'blank'

    const now = new Date().toISOString()
    const doc = buildTemplateDocument(id, title, projectId, template, () => randomUUID())
    this.writeBoardFile(doc)
    this.cache.set(id, doc)
    const summary = summarizeMoodboardDocument(doc, { createdAt: now, projectId }, now)
    this.saveIndex([...this.list(), summary])
    this.onCreate?.(summary)
    return { summary, document: doc }
  }

  /**
   * Saves an edited moodboard document atomically and updates index metadata.
   * Removed photos are queued for cleanup on flush so in-session Undo never breaks images.
   */
  save(rawDoc: unknown): MoodboardCreateResult | null {
    if (typeof rawDoc !== 'object' || rawDoc === null) return null
    const rawId = (rawDoc as Record<string, unknown>).id
    if (typeof rawId !== 'string' || !isValidBoardId(rawId)) return null
    const existingSummary = this.getSummary(rawId)
    if (!existingSummary) return null

    const previousDoc = this.get(rawId)
    const doc = sanitizeMoodboardDocument(rawDoc, rawId)
    if (!doc) return null
    const nextDoc: MoodboardDocument = { ...doc, id: rawId }

    // Track photos added back (Undo) vs photos removed from this board.
    const nextPhotoIds = new Set<string>()
    for (const item of nextDoc.items) {
      if (item.kind === 'image') {
        nextPhotoIds.add(item.photo.id)
        this.pendingPhotoRemovals.delete(item.photo.id)
      }
    }
    if (previousDoc) {
      for (const item of previousDoc.items) {
        if (item.kind === 'image' && !nextPhotoIds.has(item.photo.id)) {
          this.pendingPhotoRemovals.set(item.photo.id, item.photo)
        }
      }
    }

    this.writeBoardFile(nextDoc)
    this.cache.set(rawId, nextDoc)
    const now = new Date().toISOString()
    const summary = summarizeMoodboardDocument(nextDoc, existingSummary, now)
    this.saveIndex(this.list().map((b) => (b.id === rawId ? summary : b)))
    return { summary, document: nextDoc }
  }

  updateMeta(id: string, patch: unknown): MoodboardSummary | null {
    if (!isValidBoardId(id)) return null
    const existing = this.getSummary(id)
    if (!existing) return null
    const p = (typeof patch === 'object' && patch !== null ? patch : {}) as Partial<MoodboardMetaPatch>
    const nextTitle = p.title !== undefined ? sanitizeMoodboardTitle(p.title, existing.title) : existing.title
    const nextProjectId =
      p.projectId !== undefined
        ? typeof p.projectId === 'string' && p.projectId.trim()
          ? p.projectId.trim().slice(0, 100)
          : null
        : existing.projectId
    const now = new Date().toISOString()
    const updated: MoodboardSummary = {
      ...existing,
      title: nextTitle,
      projectId: nextProjectId,
      updatedAt: now
    }
    const doc = this.get(id)
    if (doc) {
      const nextDoc: MoodboardDocument = { ...doc, title: nextTitle, projectId: nextProjectId }
      this.writeBoardFile(nextDoc)
      this.cache.set(id, nextDoc)
    }
    this.saveIndex(this.list().map((b) => (b.id === id ? updated : b)))
    return updated
  }

  /** Deletes a moodboard, its JSON file, and all photos exclusively owned by it. */
  remove(id: string): boolean {
    if (!isValidBoardId(id)) return false
    const existing = this.getSummary(id)
    if (!existing) return false
    const doc = this.get(id)
    const boardPhotos: LocationPhoto[] = []
    if (doc) {
      for (const item of doc.items) {
        if (item.kind === 'image') boardPhotos.push(item.photo)
      }
    }
    this.saveIndex(this.list().filter((b) => b.id !== id))
    this.indexFile.flush()
    this.cache.delete(id)
    rmSync(this.boardPath(id), { force: true })
    // Delete photos after removing the board document so a crash never leaves dangling references.
    const stillReferenced = this.allReferencedPhotoIds()
    for (const photo of boardPhotos) {
      this.pendingPhotoRemovals.delete(photo.id)
      if (!stillReferenced.has(photo.id)) this.photos.remove(photo)
    }
    this.onRemove?.(id)
    return true
  }

  /** Saves a new image into the shared PhotoStore for a board. */
  addImage(boardId: string, input: PhotoInput): MoodboardImageResult {
    if (!isValidBoardId(boardId) || !this.getSummary(boardId)) {
      return { ok: false, error: 'The moodboard no longer exists.' }
    }
    try {
      const photo = this.photos.save(input)
      return { ok: true, photo }
    } catch (err) {
      if (err instanceof PhotoError) return { ok: false, error: err.message }
      console.error('[photoearth] Could not store a moodboard image:', err)
      return { ok: false, error: 'The image could not be saved.' }
    }
  }

  /** Clones an already-stored photo under a fresh UUID for independent ownership on a moodboard. */
  clonePhoto(boardId: string, rawSource: unknown): MoodboardImageResult {
    if (!isValidBoardId(boardId) || !this.getSummary(boardId)) {
      return { ok: false, error: 'The moodboard no longer exists.' }
    }
    const source = sanitizePhoto(rawSource)
    if (!source) return { ok: false, error: 'Invalid source photo.' }
    try {
      const photo = this.photos.clone(source)
      return { ok: true, photo }
    } catch (err) {
      if (err instanceof PhotoError) return { ok: false, error: err.message }
      console.error('[photoearth] Could not clone photo to moodboard:', err)
      return { ok: false, error: 'The image could not be copied.' }
    }
  }

  /** Referential integrity hook called when a Project is deleted. */
  unlinkProjectFromAll(projectId: string): number {
    const cleanId = projectId.trim().slice(0, 100)
    if (!cleanId) return 0
    const list = this.list()
    let updatedCount = 0
    const now = new Date().toISOString()
    const next = list.map((b) => {
      if (b.projectId !== cleanId) return b
      updatedCount++
      const doc = this.cache.get(b.id)
      if (doc) {
        const nextDoc = { ...doc, projectId: null }
        this.writeBoardFile(nextDoc)
        this.cache.set(b.id, nextDoc)
      }
      return { ...b, projectId: null, updatedAt: now }
    })
    if (updatedCount > 0) this.saveIndex(next)
    return updatedCount
  }

  /** Flushes index metadata and deletes any photos removed during editing that remain unreferenced. */
  flush(): void {
    this.indexFile.flush()
    if (this.pendingPhotoRemovals.size === 0) return
    const referenced = this.allReferencedPhotoIds()
    for (const [id, photo] of this.pendingPhotoRemovals) {
      if (!referenced.has(id)) this.photos.remove(photo)
    }
    this.pendingPhotoRemovals.clear()
  }

  private boardPath(id: string): string {
    return join(this.dir, `${id}.json`)
  }

  private saveIndex(boards: MoodboardSummary[]): void {
    this.indexFile.set({ version: MOODBOARD_INDEX_VERSION, boards })
  }

  private writeBoardFile(doc: MoodboardDocument): void {
    mkdirSync(this.dir, { recursive: true })
    const target = this.boardPath(doc.id)
    const tmp = `${target}.tmp`
    writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8')
    renameSync(tmp, target)
  }

  private allReferencedPhotoIds(): Set<string> {
    const ids = new Set<string>()
    for (const photo of this.referencedPhotos()) ids.add(photo.id)
    return ids
  }

  private checkAllBoardFilesClean(): boolean {
    if (!existsSync(this.dir)) return true
    try {
      for (const file of readdirSync(this.dir)) {
        if (file === 'index.json' || !file.endsWith('.json')) continue
        const id = file.slice(0, -5)
        if (!isValidBoardId(id)) continue
        try {
          const raw = JSON.parse(readFileSync(join(this.dir, file), 'utf8'))
          if (moodboardDocVersion(raw) > MOODBOARD_DOC_VERSION) return false
        } catch {
          return false
        }
      }
    } catch {
      return false
    }
    return true
  }
}

function readIndexVersion(path: string): number | null {
  if (!existsSync(path)) return null
  try {
    return moodboardIndexVersion(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}
