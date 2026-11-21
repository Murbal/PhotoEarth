import { describe, expect, it } from 'vitest'
import {
  applyBookmarkPatch,
  applyProfilePatch,
  estimateTarget,
  fileVersion,
  matchesFilter,
  migrateBookmarksFile,
  normalizeTag,
  PHOTO_FILE,
  sanitizeBookmark,
  sanitizePhoto,
  sanitizeProfile,
  sanitizeTags,
  tagCounts
} from '../../src/shared/locations'
import { haversine } from '../../src/renderer/src/lib/profile'
import type { Bookmark } from '../../src/shared/types'

const NOW = '2026-11-21T12:00:00.000Z'
const camera = { longitude: 7.8, latitude: 46.48, height: 6500, heading: 55, pitch: -15, roll: 0 }

/** A bookmark as version 1 of the app wrote it. */
const v1Bookmark = {
  id: 'b1',
  name: 'Lauterbrunnen',
  createdAt: '2025-06-01T08:00:00.000Z',
  camera,
  mode: 'photorealistic',
  time: { utc: '2025-06-21T04:30:00.000Z', timeZone: 'Europe/Zurich' }
}

const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e'

describe('estimateTarget', () => {
  it('follows the view ray down to sea level', () => {
    // Looking straight down: the point below the camera.
    const down = estimateTarget({ ...camera, pitch: -90 })
    expect(down.longitude).toBeCloseTo(camera.longitude, 6)
    expect(down.latitude).toBeCloseTo(camera.latitude, 6)
    expect(down.height).toBeNull()
    // 45° down from 1 km: ~1 km away along the heading (north here).
    const north = estimateTarget({ ...camera, height: 1000, pitch: -45, heading: 0 })
    expect(haversine(north, camera)).toBeGreaterThan(990)
    expect(haversine(north, camera)).toBeLessThan(1010)
    expect(north.latitude).toBeGreaterThan(camera.latitude)
    expect(north.longitude).toBeCloseTo(camera.longitude, 6)
    // Heading east moves east.
    const east = estimateTarget({ ...camera, height: 1000, pitch: -45, heading: 90 })
    expect(east.longitude).toBeGreaterThan(camera.longitude)
    expect(east.latitude).toBeCloseTo(camera.latitude, 3)
    // 15° down from 6.5 km, as the default view: ~24 km along a flat earth, a bit more with curvature.
    const d = haversine(estimateTarget(camera), camera)
    expect(d).toBeGreaterThan(24_000)
    expect(d).toBeLessThan(25_000)
  })

  it('uses the point below the camera when the ray never meets the ground nearby', () => {
    for (const pitch of [0, 10, -0.1]) {
      const p = estimateTarget({ ...camera, pitch })
      expect([p.longitude, p.latitude]).toEqual([camera.longitude, camera.latitude])
    }
    // 2° down from 6.5 km is ~150 km away: too far to be what the view shows.
    expect(estimateTarget({ ...camera, pitch: -2 }).latitude).toBe(camera.latitude)
  })

  it('wraps across the antimeridian', () => {
    const p = estimateTarget({ ...camera, longitude: 179.999, latitude: 0, heading: 90, pitch: -45, height: 2000 })
    expect(p.longitude).toBeLessThan(-179.9)
  })
})

describe('tags', () => {
  it('normalizes case, spaces and commas, and drops duplicates', () => {
    expect(normalizeTag('  Golden   Hour, ')).toBe('golden hour')
    expect(sanitizeTags(['Sunrise', 'sunrise', ' ', 3, 'Lake ', 'x'.repeat(100)])).toEqual(['sunrise', 'lake', 'x'.repeat(40)])
    expect(sanitizeTags('sunrise')).toEqual([])
    expect(sanitizeTags(Array.from({ length: 50 }, (_, i) => `t${i}`))).toHaveLength(24)
  })

  it('counts tags, most used first', () => {
    expect(tagCounts([{ tags: ['lake', 'sunrise'] }, { tags: ['sunrise'] }, { tags: ['alpine'] }])).toEqual([
      { tag: 'sunrise', count: 2 },
      { tag: 'alpine', count: 1 },
      { tag: 'lake', count: 1 }
    ])
  })
})

describe('filter', () => {
  const b = { status: 'visited' as const, tags: ['lake', 'sunrise'] }
  it('matches status and every selected tag', () => {
    expect(matchesFilter(b, { status: 'all', tags: [] })).toBe(true)
    expect(matchesFilter(b, { status: 'visited', tags: ['lake'] })).toBe(true)
    expect(matchesFilter(b, { status: 'to-visit', tags: [] })).toBe(false)
    expect(matchesFilter(b, { status: 'all', tags: ['lake', 'sunrise'] })).toBe(true)
    expect(matchesFilter(b, { status: 'all', tags: ['lake', 'forest'] })).toBe(false)
  })
})

describe('sanitizeBookmark', () => {
  it('reads a version-1 bookmark as a location to visit', () => {
    const b = sanitizeBookmark(v1Bookmark, NOW)!
    expect(b).toMatchObject({
      id: 'b1',
      name: 'Lauterbrunnen',
      createdAt: '2025-06-01T08:00:00.000Z',
      updatedAt: '2025-06-01T08:00:00.000Z',
      camera,
      mode: 'photorealistic',
      time: v1Bookmark.time,
      status: 'to-visit',
      notes: '',
      tags: [],
      bestTime: '',
      photos: []
    })
    expect(b.viewfinder).toBeUndefined()
    expect(b.position).toEqual(estimateTarget(camera))
  })

  it('rejects records without an id or a valid camera', () => {
    expect(sanitizeBookmark({ ...v1Bookmark, id: undefined })).toBeNull()
    expect(sanitizeBookmark({ ...v1Bookmark, camera: { ...camera, pitch: 'x' } })).toBeNull()
    expect(sanitizeBookmark(null)).toBeNull()
  })

  it('keeps location fields and clamps or drops bad ones', () => {
    const b = sanitizeBookmark(
      {
        ...v1Bookmark,
        name: '   ',
        status: 'visited',
        notes: 'n'.repeat(30_000),
        tags: ['Sunrise'],
        bestTime: '  late October  ',
        position: { longitude: 200, latitude: 46.5, height: 1200 },
        time: { utc: 'not a date' },
        mode: 'satellite'
      },
      NOW
    )!
    expect(b.name).toBe('Untitled location')
    expect(b.status).toBe('visited')
    expect(b.notes).toHaveLength(20_000)
    expect(b.tags).toEqual(['sunrise'])
    expect(b.bestTime).toBe('late October')
    expect(b.position).toEqual({ longitude: 180, latitude: 46.5, height: 1200 })
    expect(b.time).toBeUndefined()
    expect(b.mode).toBe('photorealistic')
  })

  it('only accepts photos with names the photo store writes', () => {
    const good = { id: uuid, file: `${uuid}.jpg`, name: 'IMG_1.JPG', bytes: 10, width: 4, height: 3, addedAt: NOW }
    expect(sanitizePhoto(good)).toEqual(good)
    for (const file of ['../../etc/passwd', `${uuid}.exe`, `${uuid}.thumb.jpg`, `/tmp/${uuid}.jpg`, `0f8fad5b-0000-0000-0000-000000000000.jpg`]) {
      expect(sanitizePhoto({ ...good, file }), file).toBeNull()
    }
    expect(PHOTO_FILE.test(`${uuid}.thumb.jpg`)).toBe(true)
    const b = sanitizeBookmark({ ...v1Bookmark, photos: [good, good, { ...good, id: 'x', file: 'x.jpg' }] })!
    expect(b.photos).toEqual([good])
  })
})

describe('applyBookmarkPatch', () => {
  const current = sanitizeBookmark({ ...v1Bookmark, tags: ['lake'], photos: [{ id: uuid, file: `${uuid}.png`, name: 'a.png' }] }, NOW) as Bookmark

  it('edits fields and keeps id, creation date and photos', () => {
    const next = applyBookmarkPatch(current, { name: 'Mürren', status: 'visited', tags: ['Sunset', 'lake'], notes: 'Park at the station', id: 'evil', createdAt: 'x', photos: [] }, NOW)!
    expect(next).toMatchObject({ id: 'b1', createdAt: current.createdAt, updatedAt: NOW, name: 'Mürren', status: 'visited', tags: ['sunset', 'lake'], notes: 'Park at the station' })
    expect(next.photos).toEqual(current.photos)
    expect(next.time).toEqual(current.time)
  })

  it('clears the saved time and lens with null, and leaves them alone when absent', () => {
    const withLens = applyBookmarkPatch(current, { viewfinder: { focalLength: 85 } }, NOW)!
    expect(withLens.viewfinder?.focalLength).toBe(85)
    expect(applyBookmarkPatch(withLens, { name: 'x' }, NOW)!.viewfinder?.focalLength).toBe(85)
    const cleared = applyBookmarkPatch(withLens, { time: null, viewfinder: null }, NOW)!
    expect(cleared.time).toBeUndefined()
    expect(cleared.viewfinder).toBeUndefined()
  })

  it('refuses an invalid camera', () => {
    expect(applyBookmarkPatch(current, { camera: { longitude: 1 } }, NOW)).toBeNull()
  })
})

describe('profiles', () => {
  const raw = { id: 'p1', name: 'Ridge', createdAt: NOW, points: [{ longitude: 7.9, latitude: 46.5, height: 2000 }, { longitude: 7.95, latitude: 46.52 }], locationId: 'b1' }

  it('needs two valid points', () => {
    expect(sanitizeProfile(raw)).toEqual({ ...raw, points: [raw.points[0], { ...raw.points[1], height: null }] })
    expect(sanitizeProfile({ ...raw, points: [raw.points[0], { longitude: 'x' }] })).toBeNull()
    expect(sanitizeProfile({ ...raw, locationId: '' })!.locationId).toBeNull()
  })

  it('renames and detaches', () => {
    const p = sanitizeProfile(raw)!
    expect(applyProfilePatch(p, { name: 'North ridge', locationId: null, id: 'evil' })).toMatchObject({ id: 'p1', name: 'North ridge', locationId: null })
  })
})

describe('migrateBookmarksFile', () => {
  it('migrates version 1 to version 2', () => {
    const v1 = { version: 1, bookmarks: [v1Bookmark, { ...v1Bookmark, id: 'b2', name: 'Eiger', mode: 'elevation', time: undefined }] }
    expect(fileVersion(v1)).toBe(1)
    const v2 = migrateBookmarksFile(v1, NOW)
    expect(v2.version).toBe(2)
    expect(v2.profiles).toEqual([])
    expect(v2.bookmarks.map((b) => [b.id, b.name, b.mode, b.status])).toEqual([
      ['b1', 'Lauterbrunnen', 'photorealistic', 'to-visit'],
      ['b2', 'Eiger', 'elevation', 'to-visit']
    ])
    expect(v2.bookmarks[1].time).toBeUndefined()
    // Migrating again changes nothing.
    expect(migrateBookmarksFile(JSON.parse(JSON.stringify(v2)), '2030-01-01T00:00:00.000Z')).toEqual(v2)
  })

  it('reads a missing or broken file as empty, and drops unreadable and duplicate records', () => {
    expect(migrateBookmarksFile(undefined)).toEqual({ version: 2, bookmarks: [], profiles: [] })
    expect(migrateBookmarksFile({ bookmarks: 'x' })).toEqual({ version: 2, bookmarks: [], profiles: [] })
    expect(fileVersion({ bookmarks: [] })).toBe(1)
    const m = migrateBookmarksFile({ bookmarks: [v1Bookmark, { id: 'bad' }, v1Bookmark] })
    expect(m.bookmarks.map((b) => b.id)).toEqual(['b1'])
  })

  it('turns profiles of a missing location into general profiles', () => {
    const points = [{ longitude: 7.9, latitude: 46.5 }, { longitude: 7.95, latitude: 46.52 }]
    const m = migrateBookmarksFile({
      version: 2,
      bookmarks: [v1Bookmark],
      profiles: [
        { id: 'p1', name: 'a', points, locationId: 'b1' },
        { id: 'p2', name: 'b', points, locationId: 'gone' }
      ]
    })
    expect(m.profiles.map((p) => p.locationId)).toEqual(['b1', null])
  })
})
