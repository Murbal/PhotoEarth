import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app } from 'electron'
import { sanitizeCameraView } from '@shared/settings'
import type { Bookmark, BookmarkTime, NewBookmark } from '@shared/types'
import { JsonFile } from './jsonStore'

function sanitizeTime(raw: unknown): BookmarkTime | undefined {
  const t = raw as Partial<BookmarkTime> | undefined
  if (!t || typeof t.utc !== 'string' || Number.isNaN(Date.parse(t.utc))) return undefined
  return { utc: new Date(t.utc).toISOString(), timeZone: typeof t.timeZone === 'string' ? t.timeZone : 'UTC' }
}

function sanitizeName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim().slice(0, 200) : ''
  return name || 'Untitled view'
}

export function sanitizeBookmark(raw: unknown): Bookmark | null {
  const b = raw as Partial<Bookmark> | undefined
  if (!b || typeof b.id !== 'string') return null
  const camera = sanitizeCameraView(b.camera)
  if (!camera) return null
  return {
    id: b.id,
    name: sanitizeName(b.name),
    createdAt: typeof b.createdAt === 'string' ? b.createdAt : new Date().toISOString(),
    camera,
    mode: b.mode === 'elevation' ? 'elevation' : 'photorealistic',
    time: sanitizeTime(b.time)
  }
}

/** The file wraps the list in an object so the format can grow without a migration. */
interface BookmarksFile {
  version: 1
  bookmarks: Bookmark[]
}

function sanitizeFile(raw: unknown): BookmarksFile {
  const list = (raw as { bookmarks?: unknown[] } | undefined)?.bookmarks
  const bookmarks = Array.isArray(list) ? list.map(sanitizeBookmark).filter((b): b is Bookmark => !!b) : []
  return { version: 1, bookmarks }
}

export class BookmarkStore {
  private readonly file = new JsonFile<BookmarksFile>(join(app.getPath('userData'), 'bookmarks.json'), sanitizeFile)

  list(): Bookmark[] {
    return this.file.get().bookmarks
  }

  private save(bookmarks: Bookmark[]): void {
    this.file.set({ version: 1, bookmarks })
  }

  create(input: NewBookmark): Bookmark {
    const bookmark = sanitizeBookmark({ ...input, id: randomUUID(), createdAt: new Date().toISOString() })
    if (!bookmark) throw new Error('Invalid bookmark')
    this.save([...this.list(), bookmark])
    return bookmark
  }

  update(id: string, patch: Partial<NewBookmark>): Bookmark | null {
    const list = this.list()
    const index = list.findIndex((b) => b.id === id)
    if (index < 0) return null
    const updated = sanitizeBookmark({ ...list[index], ...patch, id })
    if (!updated) return null
    const next = [...list]
    next[index] = updated
    this.save(next)
    return updated
  }

  remove(id: string): boolean {
    const list = this.list()
    const next = list.filter((b) => b.id !== id)
    this.save(next)
    return next.length !== list.length
  }

  flush(): void {
    this.file.flush()
  }
}
