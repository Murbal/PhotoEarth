import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BookmarkStore } from '../../src/main/bookmarks'
import { cleanOrphanPhotos, PhotoStore, type PhotoOwner } from '../../src/main/photos'
import { shellState, useShellStore } from '@renderer/shell/shellStore'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'photoearth-shell-'))
  dirs.push(dir)
  return dir
}

const camera = { longitude: 7.8, latitude: 46.48, height: 6500, heading: 55, pitch: -15, roll: 0 }
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1])
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52])
const photo = (data: Uint8Array = PNG) => ({ name: 'shot.png', data, thumb: JPEG, width: 1600, height: 1200 })

afterEach(() => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
  useShellStore.setState({
    activeModule: 'globe',
    globeMounted: true,
    activeProjectId: null,
    activeMoodboardId: null,
    paletteOpen: false,
    shortcutsOpen: false,
    settingsOpen: false,
    onboardingOpen: false,
    photoViewer: null,
    toast: null
  })
})

describe('shellStore', () => {
  it('starts on globe with globeMounted and tracks module switches with keep-alive', () => {
    expect(shellState().activeModule).toBe('globe')
    expect(shellState().globeMounted).toBe(true)

    shellState().setActiveModule('projects')
    expect(shellState().activeModule).toBe('projects')
    expect(shellState().globeMounted).toBe(true)

    // Simulating startup on a non-globe module: globe lazily mounts on first visit.
    useShellStore.setState({ activeModule: 'projects', globeMounted: false })
    expect(shellState().globeMounted).toBe(false)
    shellState().setActiveModule('moodboard')
    expect(shellState().globeMounted).toBe(false)
    shellState().setActiveModule('globe')
    expect(shellState().globeMounted).toBe(true)
  })

  it('tracks modal state and toasts cleanly', () => {
    expect(shellState().isModalOpen()).toBe(false)
    shellState().set({ paletteOpen: true })
    expect(shellState().isModalOpen()).toBe(true)
    shellState().set({ paletteOpen: false, photoViewer: { locationId: 'loc-1', photoId: 'p-1' } })
    expect(shellState().isModalOpen()).toBe(true)
    shellState().set({ photoViewer: null })
    expect(shellState().isModalOpen()).toBe(false)

    shellState().showToast('Saved')
    expect(shellState().toast?.message).toBe('Saved')
  })
})

describe('shared PhotoStore service', () => {
  it('does not delete other stores photos when BookmarkStore uses an injected PhotoStore', () => {
    const dir = tempDir()
    const photos = new PhotoStore(join(dir, 'photos'))
    const externalPhoto = photos.save(photo(JPEG))

    const bookmarks = new BookmarkStore(dir, { photos })
    const loc = bookmarks.create({ name: 'Peak', camera })
    const res = bookmarks.addPhoto(loc.id, photo(PNG))
    expect(res.ok).toBe(true)
    const bookmarkPhoto = res.ok ? res.bookmark.photos[0] : null
    bookmarks.flush()

    // Reopening BookmarkStore with the shared PhotoStore must not delete externalPhoto.
    const reopened = new BookmarkStore(dir, { photos })
    const filesBefore = readdirSync(photos.dir).sort()
    expect(filesBefore).toContain(externalPhoto.file)
    expect(filesBefore).toContain(bookmarkPhoto!.file)

    // Add an actual orphan and run shared cleanup across both owners.
    const orphan = '11111111-2222-4333-8444-555555555555.jpg'
    writeFileSync(join(photos.dir, orphan), JPEG)
    const externalOwner: PhotoOwner = {
      canCleanOrphans: true,
      referencedPhotos: () => [externalPhoto]
    }
    const removed = cleanOrphanPhotos(photos, [reopened, externalOwner])
    expect(removed).toBe(1)
    const filesAfter = readdirSync(photos.dir).sort()
    expect(filesAfter).not.toContain(orphan)
    expect(filesAfter).toContain(externalPhoto.file)
    expect(filesAfter).toContain(bookmarkPhoto!.file)
  })

  it('skips orphan cleanup if any photo-owning store failed to load cleanly', () => {
    const dir = tempDir()
    const photos = new PhotoStore(join(dir, 'photos'))
    const orphan = '22222222-2222-4333-8444-555555555555.jpg'
    const kept = photos.save(photo(PNG))
    writeFileSync(join(photos.dir, orphan), JPEG)

    const healthyOwner: PhotoOwner = { canCleanOrphans: true, referencedPhotos: () => [kept] }
    const corruptOwner: PhotoOwner = { canCleanOrphans: false, referencedPhotos: () => [] }
    expect(cleanOrphanPhotos(photos, [healthyOwner, corruptOwner])).toBe(0)
    expect(readdirSync(photos.dir)).toContain(orphan)
  })
})
