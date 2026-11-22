import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BookmarkStore } from '../../src/main/bookmarks'
import { MoodboardStore } from '../../src/main/moodboards'
import { cleanOrphanPhotos, PhotoStore } from '../../src/main/photos'
import { ProjectStore } from '../../src/main/projects'
import { moodboardState, useMoodboardStore } from '@renderer/store/moodboardStore'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'photoearth-moodboards-'))
  dirs.push(dir)
  return dir
}

const camera = { longitude: 7.8, latitude: 46.48, height: 6500, heading: 55, pitch: -15, roll: 0 }
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1])
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52])
const photoInput = (data: Uint8Array = PNG, name = 'ref.png') => ({ name, data, thumb: JPEG, width: 1600, height: 1067 })

afterEach(() => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
  useMoodboardStore.setState({
    summaries: [],
    activeBoard: null,
    dirty: false,
    tool: 'select',
    selectedIds: [],
    selectedConnectorId: null,
    editingItemId: null,
    presentationMode: false,
    browserDrawerOpen: false,
    undoStack: [],
    redoStack: []
  })
})

describe('MoodboardStore (main process)', () => {
  it('persists index + per-board JSON files lazily across restarts and rejects invalid IDs', () => {
    const dir = tempDir()
    const store = new MoodboardStore(dir)
    const { summary, document } = store.create({ title: 'Autumn Light', template: 'three-column' })
    expect(summary.itemCount).toBe(6)
    expect(document.items).toHaveLength(6)
    expect(existsSync(join(dir, 'moodboards', `${summary.id}.json`))).toBe(true)

    // Path traversal or unknown IDs are rejected.
    expect(store.get('../settings')).toBeNull()
    expect(store.save({ ...document, id: '../evil' })).toBeNull()
    expect(store.remove('../evil')).toBe(false)

    store.flush()

    const reopened = new MoodboardStore(dir)
    expect(reopened.list()).toHaveLength(1)
    expect(reopened.list()[0].title).toBe('Autumn Light')
    expect(reopened.get(summary.id)?.items).toHaveLength(6)
  })

  it('stores images in shared PhotoStore, preserves removed images for in-session Undo, and cleans up on flush & remove', () => {
    const dir = tempDir()
    const photos = new PhotoStore(join(dir, 'photos'))
    const store = new MoodboardStore(dir, { photos })
    const { summary, document } = store.create({ title: 'Refs' })

    const added = store.addImage(summary.id, photoInput(PNG, 'mist.png'))
    expect(added.ok).toBe(true)
    if (!added.ok) return
    const imgPhoto = added.photo
    expect(readdirSync(photos.dir)).toContain(imgPhoto.file)

    const withImage = store.save({
      ...document,
      items: [
        {
          id: 'item-1',
          kind: 'image',
          x: 0,
          y: 0,
          width: 300,
          height: 200,
          zIndex: 1,
          locked: false,
          photo: imgPhoto,
          caption: 'Morning mist',
          borderless: false
        }
      ]
    })
    expect(withImage?.summary.previewFiles).toEqual([`${imgPhoto.id}.thumb.jpg`])

    // Removing the image card during live editing queues cleanup without deleting immediately (Undo safety).
    store.save({ ...withImage!.document, items: [] })
    expect(readdirSync(photos.dir)).toContain(imgPhoto.file)

    // Re-adding via Undo cancels the queued deletion.
    store.save(withImage!.document)
    store.flush()
    expect(readdirSync(photos.dir)).toContain(imgPhoto.file)

    // Removing again and flushing deletes the unreferenced photo cleanly.
    store.save({ ...withImage!.document, items: [] })
    store.flush()
    expect(readdirSync(photos.dir)).toEqual([])

    // Deleting an entire board removes its JSON file and owned photos immediately.
    const added2 = store.addImage(summary.id, photoInput(JPEG, 'dusk.jpg'))
    expect(added2.ok).toBe(true)
    if (!added2.ok) return
    store.save({
      ...withImage!.document,
      items: [
        {
          id: 'item-2',
          kind: 'image',
          x: 10,
          y: 10,
          width: 280,
          height: 200,
          zIndex: 1,
          locked: false,
          photo: added2.photo,
          caption: '',
          borderless: false
        }
      ]
    })
    expect(store.remove(summary.id)).toBe(true)
    expect(existsSync(join(dir, 'moodboards', `${summary.id}.json`))).toBe(false)
    expect(readdirSync(photos.dir)).toEqual([])
  })

  it('maintains bidirectional referential integrity with ProjectStore and protects shared orphan cleanup', () => {
    const dir = tempDir()
    const photos = new PhotoStore(join(dir, 'photos'))
    const moodboards = new MoodboardStore(dir, {
      photos,
      onCreate: (summary) => {
        if (summary.projectId) projects.linkMoodboard(summary.projectId, summary.id)
      },
      onRemove: (boardId) => projects.unlinkMoodboardFromAll(boardId)
    })
    const projects = new ProjectStore(dir, {
      photos,
      onRemove: (projectId) => moodboards.unlinkProjectFromAll(projectId)
    })
    const bookmarks = new BookmarkStore(dir, { photos })

    const proj = projects.create({ title: 'Dolomites' })
    const b1 = moodboards.create({ title: 'Board 1', projectId: proj.id })
    const b2 = moodboards.create({ title: 'Board 2', projectId: proj.id })
    expect(projects.get(proj.id)?.moodboardIds).toEqual([b1.summary.id, b2.summary.id])

    // Deleting a moodboard unlinks it from the project.
    expect(moodboards.remove(b1.summary.id)).toBe(true)
    expect(projects.get(proj.id)?.moodboardIds).toEqual([b2.summary.id])

    // Add a photo to b2 and a bookmark, plus an orphan file.
    const loc = bookmarks.create({ name: 'Seceda', camera })
    const bmPhoto = bookmarks.addPhoto(loc.id, photoInput(PNG))
    expect(bmPhoto.ok).toBe(true)
    const mbPhoto = moodboards.addImage(b2.summary.id, photoInput(JPEG))
    expect(mbPhoto.ok).toBe(true)
    if (!mbPhoto.ok || !bmPhoto.ok) return
    moodboards.save({
      ...b2.document,
      items: [
        {
          id: 'i1',
          kind: 'image',
          x: 0,
          y: 0,
          width: 300,
          height: 200,
          zIndex: 1,
          locked: false,
          photo: mbPhoto.photo,
          caption: '',
          borderless: false
        }
      ]
    })
    bookmarks.flush()
    projects.flush()
    moodboards.flush()

    const orphan = '11111111-2222-4333-8444-555555555555.jpg'
    writeFileSync(join(photos.dir, orphan), JPEG)
    expect(cleanOrphanPhotos(photos, [bookmarks, projects, moodboards])).toBe(1)
    expect(readdirSync(photos.dir)).not.toContain(orphan)
    expect(readdirSync(photos.dir)).toContain(mbPhoto.photo.file)
    expect(readdirSync(photos.dir)).toContain(bmPhoto.bookmark.photos[0].file)

    // Deleting the project leaves b2 intact but clears its primary projectId.
    expect(projects.remove(proj.id)).toBe(true)
    expect(moodboards.getSummary(b2.summary.id)?.projectId).toBeNull()

    // A corrupt board document prevents orphan cleanup across the shared PhotoStore.
    const orphan2 = '22222222-2222-4333-8444-555555555555.jpg'
    writeFileSync(join(photos.dir, orphan2), JPEG)
    writeFileSync(join(dir, 'moodboards', `${b2.summary.id}.json`), '{ corrupt')
    const brokenMoodboards = new MoodboardStore(dir, { photos })
    expect(brokenMoodboards.canCleanOrphans).toBe(false)
    expect(cleanOrphanPhotos(photos, [bookmarks, projects, brokenMoodboards])).toBe(0)
    expect(readdirSync(photos.dir)).toContain(orphan2)
  })
})

describe('useMoodboardStore (renderer state & undo/redo)', () => {
  it('supports undo/redo, z-order, duplicate, lock protection, and connector deletion', () => {
    moodboardState().setActiveBoard({
      version: 1,
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      title: 'Test',
      projectId: null,
      viewport: { x: 0, y: 0, zoom: 1 },
      items: [
        { id: 'n1', kind: 'note', x: 0, y: 0, width: 200, height: 120, zIndex: 1, locked: false, title: 'A', body: '', tint: 'neutral' },
        { id: 'n2', kind: 'note', x: 300, y: 0, width: 200, height: 120, zIndex: 2, locked: false, title: 'B', body: '', tint: 'blue' }
      ],
      connectors: [{ id: 'c1', fromId: 'n1', toId: 'n2', label: 'link', directed: true }]
    })

    // Bring n1 to front
    moodboardState().selectOnly('n1')
    moodboardState().bringToFront()
    expect(moodboardState().activeBoard!.items.find((i) => i.id === 'n1')!.zIndex).toBe(3)

    // Undo restores previous zIndex; Redo re-applies
    moodboardState().undo()
    expect(moodboardState().activeBoard!.items.find((i) => i.id === 'n1')!.zIndex).toBe(1)
    moodboardState().redo()
    expect(moodboardState().activeBoard!.items.find((i) => i.id === 'n1')!.zIndex).toBe(3)

    // Duplicate creates a new unlocked offset copy
    moodboardState().duplicateSelection()
    expect(moodboardState().activeBoard!.items).toHaveLength(3)

    // Locked items cannot be deleted
    moodboardState().selectOnly('n2')
    moodboardState().toggleLockSelection()
    expect(moodboardState().activeBoard!.items.find((i) => i.id === 'n2')!.locked).toBe(true)
    moodboardState().deleteSelection()
    expect(moodboardState().activeBoard!.items.some((i) => i.id === 'n2')).toBe(true)

    // Deleting selected connector removes only the connector
    moodboardState().set({ selectedConnectorId: 'c1', selectedIds: [] })
    moodboardState().deleteSelection()
    expect(moodboardState().activeBoard!.connectors).toHaveLength(0)
  })
})
