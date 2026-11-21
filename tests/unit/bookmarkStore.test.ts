import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BookmarkStore } from '../../src/main/bookmarks'
import { asBytes, PhotoStore, sniffImage } from '../../src/main/photos'
import { MAX_PHOTO_BYTES } from '../../src/shared/locations'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'photoearth-locations-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

const camera = { longitude: 7.8, latitude: 46.48, height: 6500, heading: 55, pitch: -15, roll: 0 }
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1])
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52])
const photo = (data: Uint8Array = PNG) => ({ name: 'IMG_0042.png', data, thumb: JPEG, width: 4000, height: 3000 })

/** Writes pending changes and reopens the store from disk, as a restart would. */
function reopen(store: BookmarkStore, dir: string): BookmarkStore {
  store.flush()
  return new BookmarkStore(dir)
}

describe('BookmarkStore', () => {
  it('persists locations with their fields across a restart', () => {
    const dir = tempDir()
    let store = new BookmarkStore(dir)
    const created = store.create({
      name: 'Oeschinensee',
      camera,
      mode: 'photorealistic',
      position: { longitude: 7.72, latitude: 46.5, height: 1580 },
      tags: ['Lake', 'sunrise'],
      notes: 'Cable car from Kandersteg',
      bestTime: 'Sunrise in early October',
      status: 'visited',
      id: 'chosen-by-renderer',
      photos: [{ id: 'x', file: '../../secret.jpg' }]
    })
    expect(created.id).not.toBe('chosen-by-renderer')
    expect(created.photos).toEqual([])
    store = reopen(store, dir)
    expect(store.list()).toEqual([created])
    const raw = JSON.parse(readFileSync(join(dir, 'bookmarks.json'), 'utf8'))
    expect(raw.version).toBe(2)
    expect(raw.bookmarks[0].tags).toEqual(['lake', 'sunrise'])
  })

  it('updates and removes', () => {
    const dir = tempDir()
    let store = new BookmarkStore(dir)
    const a = store.create({ name: 'A', camera, mode: 'photorealistic' })
    const b = store.create({ name: 'B', camera, mode: 'elevation' })
    expect(store.update(a.id, { status: 'visited', notes: 'ok' })).toMatchObject({ status: 'visited', notes: 'ok' })
    expect(store.update('missing', { name: 'x' })).toBeNull()
    expect(store.remove(b.id)).toBe(true)
    expect(store.remove(b.id)).toBe(false)
    store = reopen(store, dir)
    expect(store.list().map((x) => [x.name, x.status])).toEqual([['A', 'visited']])
  })

  it('migrates a version-1 file, keeps a backup of it, and writes version 2', () => {
    const dir = tempDir()
    const v1 = {
      version: 1,
      bookmarks: [
        { id: 'old', name: 'Old view', createdAt: '2025-01-01T00:00:00.000Z', camera, mode: 'elevation', time: { utc: '2025-01-01T07:00:00.000Z', timeZone: 'Europe/Zurich' } }
      ]
    }
    writeFileSync(join(dir, 'bookmarks.json'), JSON.stringify(v1))
    let store = new BookmarkStore(dir)
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0]).toMatchObject({ id: 'old', name: 'Old view', mode: 'elevation', status: 'to-visit', tags: [], photos: [] })
    expect(store.list()[0].time?.timeZone).toBe('Europe/Zurich')
    expect(JSON.parse(readFileSync(join(dir, 'bookmarks.v1.backup.json'), 'utf8'))).toEqual(v1)
    store = reopen(store, dir)
    expect(JSON.parse(readFileSync(join(dir, 'bookmarks.json'), 'utf8')).version).toBe(2)
    expect(store.list()[0].id).toBe('old')
    // The backup is written once, never overwritten by a later migration.
    writeFileSync(join(dir, 'bookmarks.json'), JSON.stringify({ version: 1, bookmarks: [] }))
    new BookmarkStore(dir)
    expect(JSON.parse(readFileSync(join(dir, 'bookmarks.v1.backup.json'), 'utf8'))).toEqual(v1)
  })

  it('keeps an unreadable file aside instead of overwriting it', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'bookmarks.json'), '{ not json')
    const store = new BookmarkStore(dir)
    expect(store.list()).toEqual([])
    expect(readdirSync(dir).some((f) => f.startsWith('bookmarks.json.corrupt-'))).toBe(true)
  })

  it('copies photos in, serves only their files, and deletes them with the location', () => {
    const dir = tempDir()
    let store = new BookmarkStore(dir)
    const loc = store.create({ name: 'A', camera, mode: 'photorealistic' })
    const res = store.addPhoto(loc.id, photo())
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const [p] = res.bookmark.photos
    expect(p).toMatchObject({ name: 'IMG_0042.png', bytes: PNG.byteLength, width: 4000, height: 3000 })
    expect(p.file).toBe(`${p.id}.png`)
    const photos = join(dir, 'photos')
    expect(readFileSync(join(photos, p.file))).toEqual(Buffer.from(PNG))
    expect(readFileSync(join(photos, `${p.id}.thumb.jpg`))).toEqual(Buffer.from(JPEG))
    expect(store.photos.resolve(p.file)).toBe(join(photos, p.file))
    expect(store.photos.resolve('../bookmarks.json')).toBeNull()
    expect(store.photos.resolve('bookmarks.json')).toBeNull()

    store = reopen(store, dir)
    expect(store.list()[0].photos).toEqual([p])
    expect(store.removePhoto(loc.id, p.id)!.photos).toEqual([])
    expect(readdirSync(photos)).toEqual([])

    const again = store.addPhoto(loc.id, photo(JPEG))
    expect(again.ok && again.bookmark.photos[0].file.endsWith('.jpg')).toBe(true)
    store.remove(loc.id)
    expect(readdirSync(photos)).toEqual([])
  })

  it('refuses huge files, non-images and missing locations', () => {
    const dir = tempDir()
    const store = new BookmarkStore(dir)
    const loc = store.create({ name: 'A', camera, mode: 'photorealistic' })
    const huge = new Uint8Array(MAX_PHOTO_BYTES + 1)
    huge.set(JPEG)
    expect(store.addPhoto(loc.id, photo(huge))).toEqual({ ok: false, error: expect.stringContaining('at most 40 MB') })
    expect(store.addPhoto(loc.id, photo(new TextEncoder().encode('#!/bin/sh\necho hi\n')))).toEqual({ ok: false, error: expect.stringContaining('JPEG, PNG') })
    expect(store.addPhoto(loc.id, { ...photo(), thumb: PNG })).toMatchObject({ ok: false })
    expect(store.addPhoto(loc.id, { ...photo(), data: 'not bytes' })).toMatchObject({ ok: false })
    expect(store.addPhoto('missing', photo())).toMatchObject({ ok: false })
    expect(existsSync(join(dir, 'photos')) ? readdirSync(join(dir, 'photos')) : []).toEqual([])
    expect(store.list()[0].photos).toEqual([])
  })

  it('removes orphaned photo files at start, and nothing else', () => {
    const dir = tempDir()
    const store = new BookmarkStore(dir)
    const loc = store.create({ name: 'A', camera, mode: 'photorealistic' })
    const res = store.addPhoto(loc.id, photo())
    const kept = res.ok ? res.bookmark.photos[0] : null
    const photos = join(dir, 'photos')
    const orphan = '11111111-2222-4333-8444-555555555555.jpg'
    writeFileSync(join(photos, orphan), JPEG)
    writeFileSync(join(photos, 'notes.txt'), 'mine')
    reopen(store, dir)
    expect(readdirSync(photos).sort()).toEqual([kept!.file, `${kept!.id}.thumb.jpg`, 'notes.txt'].sort())
  })

  it('keeps every photo when bookmarks.json is unreadable or from a newer version', () => {
    for (const contents of ['{ "version": 2, "bookmarks": [ ,] }', (v: string) => v.replace('"version": 2', '"version": 99')]) {
      const dir = tempDir()
      const store = new BookmarkStore(dir)
      const loc = store.create({ name: 'A', camera, mode: 'photorealistic' })
      expect(store.addPhoto(loc.id, photo()).ok).toBe(true)
      store.flush()
      const photos = join(dir, 'photos')
      const before = readdirSync(photos).sort()
      const file = join(dir, 'bookmarks.json')
      writeFileSync(file, typeof contents === 'string' ? contents : contents(readFileSync(file, 'utf8')))
      new BookmarkStore(dir)
      expect(readdirSync(photos).sort()).toEqual(before)
    }
  })

  it('saves profiles on their own or with a location, and drops them with it', () => {
    const dir = tempDir()
    let store = new BookmarkStore(dir)
    const loc = store.create({ name: 'A', camera, mode: 'photorealistic' })
    const points = [
      { longitude: 7.9, latitude: 46.5, height: 2100 },
      { longitude: 7.95, latitude: 46.52, height: 2300 }
    ]
    const general = store.createProfile({ name: 'Valley', points })!
    const attached = store.createProfile({ name: 'Ridge', points, locationId: loc.id })!
    const dangling = store.createProfile({ name: 'X', points, locationId: 'missing' })!
    expect([general.locationId, attached.locationId, dangling.locationId]).toEqual([null, loc.id, null])
    expect(store.createProfile({ name: 'one point', points: points.slice(0, 1) })).toBeNull()
    expect(store.updateProfile(general.id, { name: 'Lower valley' })!.name).toBe('Lower valley')
    expect(store.removeProfile(dangling.id)).toBe(true)
    store = reopen(store, dir)
    expect(store.listProfiles().map((p) => [p.name, p.points])).toEqual([
      ['Lower valley', points],
      ['Ridge', points]
    ])
    store.remove(loc.id)
    expect(store.listProfiles().map((p) => p.name)).toEqual(['Lower valley'])
  })
})

describe('photos', () => {
  it('recognizes image types by their bytes', () => {
    const riff = new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')
    const avif = new Uint8Array([0, 0, 0, 0x1c, ...new TextEncoder().encode('ftypavif'), 0, 0])
    expect([JPEG, PNG, new TextEncoder().encode('GIF89a......'), riff, avif].map(sniffImage)).toEqual(['jpg', 'png', 'gif', 'webp', 'avif'])
    expect(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg">'))).toBeNull()
    expect(sniffImage(new Uint8Array(4))).toBeNull()
  })

  it('accepts the byte containers IPC can deliver', () => {
    expect(asBytes(new Uint8Array([1, 2]))).toEqual(new Uint8Array([1, 2]))
    expect(asBytes(new Uint8Array([1, 2]).buffer)).toEqual(new Uint8Array([1, 2]))
    expect([...asBytes(Buffer.from([1, 2]))!]).toEqual([1, 2])
    expect(asBytes('x')).toBeNull()
  })

  it('writes into a directory it creates', () => {
    const dir = join(tempDir(), 'nested', 'photos')
    const store = new PhotoStore(dir)
    expect(existsSync(dir)).toBe(false)
    store.save(photo())
    expect(readdirSync(dir)).toHaveLength(2)
  })
})
