import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BookmarkStore } from '../../src/main/bookmarks'
import { PhotoPicker, type OpenDialog } from '../../src/main/photoPicker'
import { cleanOrphanPhotos, PhotoStore } from '../../src/main/photos'
import { ProjectStore } from '../../src/main/projects'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'photoearth-projects-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

const camera = { longitude: 7.8, latitude: 46.48, height: 6500, heading: 55, pitch: -15, roll: 0 }
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1])
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52])
const photo = (data: Uint8Array = PNG, name = 'cover.png') => ({ name, data, thumb: JPEG, width: 1600, height: 900 })

describe('ProjectStore', () => {
  it('persists projects across restarts and ignores untrusted ids and cover photos', () => {
    const dir = tempDir()
    const store = new ProjectStore(dir)
    const created = store.create({
      id: 'evil-id',
      title: 'Dolomites Autumn 2026',
      status: 'scouting',
      tags: ['Italy', 'landscape'],
      dateWindow: { start: '2026-10-18', end: '2026-10-24', label: 'First snow' },
      concept: { summary: 'Peaks in mist', lightingMood: 'Golden hour', colorStory: ['#4FB3FF'] },
      notes: [{ title: 'Permits', body: 'Check rifugio', pinned: true }],
      coverPhoto: { id: 'x', file: '../../secret.jpg' }
    })
    expect(created.id).not.toBe('evil-id')
    expect(created.coverPhoto).toBeNull()
    expect(created.notes).toHaveLength(1)
    expect(created.notes[0].id).toBeTruthy()
    store.flush()

    const reopened = new ProjectStore(dir)
    expect(reopened.list()).toEqual([created])
    const raw = JSON.parse(readFileSync(join(dir, 'projects.json'), 'utf8'))
    expect(raw.version).toBe(1)
  })

  it('manages cover photos, clones from location photos independently, and cleans up on clear/delete', () => {
    const dir = tempDir()
    const photos = new PhotoStore(join(dir, 'photos'))
    const projects = new ProjectStore(dir, { photos })
    const bookmarks = new BookmarkStore(dir, { photos })

    const loc = bookmarks.create({ name: 'Seceda', camera })
    const added = bookmarks.addPhoto(loc.id, photo(PNG, 'seceda.png'))
    expect(added.ok).toBe(true)
    if (!added.ok) return
    const locPhoto = added.bookmark.photos[0]

    const proj = projects.create({ title: 'Dolomites' })
    const uploaded = projects.setCoverPhoto(proj.id, photo(JPEG, 'first.jpg'))
    expect(uploaded.ok).toBe(true)
    if (!uploaded.ok) return
    const firstCover = uploaded.project.coverPhoto!
    expect(readdirSync(photos.dir)).toContain(firstCover.file)

    // Cloning from a location photo creates an independent copy and removes the old project cover.
    const cloned = projects.setCoverPhotoFromPhoto(proj.id, locPhoto)
    expect(cloned.ok).toBe(true)
    if (!cloned.ok) return
    const clonedCover = cloned.project.coverPhoto!
    expect(clonedCover.id).not.toBe(locPhoto.id)
    expect(readdirSync(photos.dir)).not.toContain(firstCover.file)
    expect(readdirSync(photos.dir)).toContain(clonedCover.file)
    expect(readdirSync(photos.dir)).toContain(locPhoto.file)

    // Deleting the location's photo must not affect the project's cloned cover photo.
    bookmarks.removePhoto(loc.id, locPhoto.id)
    expect(readdirSync(photos.dir)).not.toContain(locPhoto.file)
    expect(readdirSync(photos.dir)).toContain(clonedCover.file)

    // Clearing cover removes the cover file; deleting project removes a new cover file too.
    expect(projects.clearCoverPhoto(proj.id)?.coverPhoto).toBeNull()
    expect(readdirSync(photos.dir)).toEqual([])

    const second = projects.setCoverPhoto(proj.id, photo(PNG, 'second.png'))
    expect(second.ok).toBe(true)
    expect(projects.remove(proj.id)).toBe(true)
    expect(readdirSync(photos.dir)).toEqual([])
  })

  it('maintains referential integrity when locations are removed without deleting bookmarks when a project is removed', () => {
    const dir = tempDir()
    const photos = new PhotoStore(join(dir, 'photos'))
    const projects = new ProjectStore(dir, { photos })
    const bookmarks = new BookmarkStore(dir, {
      photos,
      onRemove: (locationId) => {
        projects.unlinkLocationFromAll(locationId)
      }
    })

    const locA = bookmarks.create({ name: 'Spot A', camera })
    const locB = bookmarks.create({ name: 'Spot B', camera })
    const p1 = projects.create({ title: 'Trip 1' })
    const p2 = projects.create({ title: 'Trip 2' })

    projects.linkLocation(p1.id, locA.id)
    projects.linkLocation(p1.id, locB.id)
    projects.linkLocation(p1.id, locA.id) // duplicate ignored
    projects.linkLocation(p2.id, locA.id)
    expect(projects.get(p1.id)?.locationIds).toEqual([locA.id, locB.id])

    // Deleting a bookmark unlinks it cleanly from every referencing project.
    expect(bookmarks.remove(locA.id)).toBe(true)
    expect(projects.get(p1.id)?.locationIds).toEqual([locB.id])
    expect(projects.get(p2.id)?.locationIds).toEqual([])

    // Deleting a project leaves linked bookmarks intact.
    expect(projects.remove(p1.id)).toBe(true)
    expect(bookmarks.list().map((b) => b.id)).toEqual([locB.id])

    // Moodboard link/unlink hooks work symmetrically.
    projects.linkMoodboard(p2.id, 'mb-1')
    expect(projects.get(p2.id)?.moodboardIds).toEqual(['mb-1'])
    expect(projects.unlinkMoodboardFromAll('mb-1')).toBe(1)
    expect(projects.get(p2.id)?.moodboardIds).toEqual([])
  })

  it('participates in shared orphan cleanup and protects photos if projects.json is corrupt or newer', () => {
    const dir = tempDir()
    const photos = new PhotoStore(join(dir, 'photos'))
    const projects = new ProjectStore(dir, { photos })
    const bookmarks = new BookmarkStore(dir, { photos })

    const loc = bookmarks.create({ name: 'Peak', camera })
    const bRes = bookmarks.addPhoto(loc.id, photo(PNG))
    expect(bRes.ok).toBe(true)
    const proj = projects.create({ title: 'Series' })
    const pRes = projects.setCoverPhoto(proj.id, photo(JPEG))
    expect(pRes.ok).toBe(true)
    bookmarks.flush()
    projects.flush()

    const orphan = '11111111-2222-4333-8444-555555555555.jpg'
    writeFileSync(join(photos.dir, orphan), JPEG)
    expect(cleanOrphanPhotos(photos, [bookmarks, projects])).toBe(1)
    expect(readdirSync(photos.dir)).not.toContain(orphan)
    expect(readdirSync(photos.dir)).toContain(bRes.ok ? bRes.bookmark.photos[0].file : '')
    expect(readdirSync(photos.dir)).toContain(pRes.ok ? pRes.project.coverPhoto!.file : '')

    // Corrupt projects.json prevents orphan deletion across the shared PhotoStore.
    const orphan2 = '22222222-2222-4333-8444-555555555555.jpg'
    writeFileSync(join(photos.dir, orphan2), JPEG)
    writeFileSync(join(dir, 'projects.json'), '{ broken json')
    const brokenProjects = new ProjectStore(dir, { photos })
    expect(brokenProjects.canCleanOrphans).toBe(false)
    expect(cleanOrphanPhotos(photos, [bookmarks, brokenProjects])).toBe(0)
    expect(readdirSync(photos.dir)).toContain(orphan2)
  })

  it('supports single-file selection in PhotoPicker for project cover photos', async () => {
    const dir = tempDir()
    const file = join(dir, 'cover.jpg')
    writeFileSync(file, JPEG)
    const calls: Array<Parameters<OpenDialog>[0]> = []
    const picker = new PhotoPicker(async (options) => {
      calls.push(options)
      return { canceled: false, filePaths: [file] }
    })
    const picked = await picker.pick('Choose cover', { multi: false })
    expect(calls[0].properties).toEqual(['openFile'])
    expect(calls[0].buttonLabel).toBe('Choose')
    expect(picked).toHaveLength(1)
  })
})
