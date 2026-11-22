import { describe, expect, it } from 'vitest'
import {
  buildTemplateDocument,
  computeSnapGuides,
  connectorBezier,
  decodeImageDataUrl,
  filterAndSortMoodboards,
  fitViewportToBounds,
  itemsInsideGroup,
  migrateMoodboardIndexFile,
  normalizeBrowserInput,
  rectsIntersect,
  safeImageReferer,
  sanitizeMoodboardDocument,
  sanitizeViewport,
  summarizeMoodboardDocument,
  visibleWorldRect,
  worldBoundsOfItems,
  zoomViewportAtPoint
} from '@shared/moodboards'
import type { MoodboardGroupItem, MoodboardItem, MoodboardSummary } from '@shared/types'
import { extractPaletteFromPixels } from '@renderer/lib/colorExtract'

const PHOTO_ID = '11111111-2222-4333-8444-555555555555'
const BOARD_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

const validPhoto = {
  id: PHOTO_ID,
  file: `${PHOTO_ID}.jpg`,
  name: 'sunset.jpg',
  bytes: 120_000,
  width: 1600,
  height: 1067,
  addedAt: '2026-06-01T10:00:00.000Z'
}

describe('shared/moodboards sanitization & migration', () => {
  it('sanitizes all item kinds, drops invalid items/connectors, and strips unsafe URLs', () => {
    const doc = sanitizeMoodboardDocument({
      version: 1,
      id: BOARD_ID,
      title: '  Dolomites Study  ',
      projectId: 'proj-1',
      viewport: { x: 100, y: -50, zoom: 12 }, // zoom clamped to 4.0
      items: [
        {
          id: 'img-1',
          kind: 'image',
          x: 10,
          y: 20,
          width: 300,
          height: 200,
          zIndex: 2,
          locked: false,
          groupId: 'missing-group',
          photo: validPhoto,
          caption: 'Warm ridge light',
          borderless: true,
          sourceUrl: 'javascript:alert(1)',
          sourceTitle: 'Sketchy'
        },
        {
          id: 'img-2',
          kind: 'image',
          x: 400,
          y: 20,
          width: 300,
          height: 200,
          zIndex: 3,
          locked: false,
          photo: validPhoto,
          sourceUrl: 'https://example.com/photo/1',
          globe: {
            camera: { longitude: 11.8, latitude: 46.5, height: 2200, heading: 120, pitch: -10, roll: 0 },
            label: '50 mm · 120° ESE'
          }
        },
        { id: 'img-bad', kind: 'image', photo: { id: 'x', file: '../../etc/passwd' } },
        { id: 'pal-1', kind: 'palette', x: 0, y: 300, width: 280, height: 140, title: 'Dusk', colors: ['#FFF', '#1a2b3c', 'not-a-color', '#ffffff'] },
        { id: 'note-1', kind: 'note', x: 50, y: 50, width: 240, height: 160, title: 'Light', body: 'Backlit mist', tint: 'amber' },
        { id: 'grp-1', kind: 'group', x: 0, y: 0, width: 400, height: 300, title: 'Refs', tint: 'invalid-tint', collapsed: false },
        { id: 'loc-1', kind: 'location', x: 600, y: 100, width: 250, height: 190, locationId: 'bm-1' },
        { id: 'loc-bad', kind: 'location', locationId: '' }
      ],
      connectors: [
        { id: 'c-1', fromId: 'img-1', toId: 'note-1', label: 'same lighting', directed: true },
        { id: 'c-self', fromId: 'img-1', toId: 'img-1', label: 'bad' },
        { id: 'c-dangling', fromId: 'img-1', toId: 'img-bad', label: 'gone' }
      ]
    })

    expect(doc).not.toBeNull()
    expect(doc!.title).toBe('Dolomites Study')
    expect(doc!.viewport.zoom).toBe(4)
    expect(doc!.items.map((i) => i.id)).toEqual(['img-1', 'img-2', 'pal-1', 'note-1', 'grp-1', 'loc-1'])

    const img1 = doc!.items[0]
    expect(img1.kind === 'image' && img1.sourceUrl).toBeUndefined()
    expect(img1.groupId).toBeNull()

    const img2 = doc!.items[1]
    expect(img2.kind === 'image' && img2.sourceUrl).toBe('https://example.com/photo/1')
    expect(img2.kind === 'image' && img2.globe?.camera.longitude).toBe(11.8)

    const pal = doc!.items[2]
    expect(pal.kind === 'palette' && pal.colors).toEqual(['#ffffff', '#1a2b3c'])

    const grp = doc!.items[4]
    expect(grp.kind === 'group' && grp.tint).toBe('neutral')

    expect(doc!.connectors).toHaveLength(1)
    expect(doc!.connectors[0].label).toBe('same lighting')

    const summary = summarizeMoodboardDocument(doc!, null, '2026-06-02T12:00:00.000Z')
    expect(summary.itemCount).toBe(6)
    expect(summary.previewFiles).toEqual([`${PHOTO_ID}.thumb.jpg`])
  })

  it('builds starter templates cleanly and migrates index files', () => {
    let n = 0
    const nextId = () => `id-${++n}`
    const threeCol = buildTemplateDocument(BOARD_ID, 'Autumn Study', 'proj-1', 'three-column', nextId)
    expect(threeCol.items.filter((i) => i.kind === 'group')).toHaveLength(3)
    expect(threeCol.items.filter((i) => i.kind === 'note')).toHaveLength(3)

    const shotStudy = buildTemplateDocument(BOARD_ID, 'Shot Study', null, 'shot-study', nextId)
    expect(shotStudy.items.some((i) => i.kind === 'palette')).toBe(true)

    const migrated = migrateMoodboardIndexFile({
      version: 1,
      boards: [
        { id: BOARD_ID, title: 'Board A', itemCount: 3, previewFiles: [`${PHOTO_ID}.thumb.jpg`, '../bad.jpg'] },
        { id: BOARD_ID, title: 'Duplicate ignored' },
        { title: 'Missing id ignored' }
      ]
    })
    expect(migrated.boards).toHaveLength(1)
    expect(migrated.boards[0].previewFiles).toEqual([`${PHOTO_ID}.thumb.jpg`])
  })

  it('filters and sorts moodboard summaries by query, project, and sort mode', () => {
    const boards: MoodboardSummary[] = [
      { id: '1', title: 'Beta', projectId: 'p1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', itemCount: 2, previewFiles: [] },
      { id: '2', title: 'Alpha', projectId: 'p2', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-05T00:00:00Z', itemCount: 10, previewFiles: [] },
      { id: '3', title: 'Gamma', projectId: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-04T00:00:00Z', itemCount: 5, previewFiles: [] }
    ]
    const names = new Map([['p1', 'Dolomites'], ['p2', 'Iceland']])
    expect(filterAndSortMoodboards(boards, { query: '', projectId: 'all', sort: 'name' }).map((b) => b.title)).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(filterAndSortMoodboards(boards, { query: '', projectId: 'all', sort: 'items' }).map((b) => b.id)).toEqual(['2', '3', '1'])
    expect(filterAndSortMoodboards(boards, { query: 'dolomites', projectId: 'all', sort: 'updated' }, names).map((b) => b.id)).toEqual(['1'])
    expect(filterAndSortMoodboards(boards, { query: '', projectId: 'p1', sort: 'updated' }, names, new Set(['3'])).map((b) => b.id)).toEqual(['3', '1'])
  })
})

describe('infinite canvas geometry helpers', () => {
  it('computes bounds, fit viewport, cursor-centered zoom, and culling intersection', () => {
    const items = [
      { x: 0, y: 0, width: 200, height: 100 },
      { x: 400, y: 200, width: 200, height: 200 }
    ]
    const bounds = worldBoundsOfItems(items)
    expect(bounds).toEqual({ x: 0, y: 0, width: 600, height: 400 })

    const fitted = fitViewportToBounds(bounds, 1000, 800, 100)
    expect(fitted.zoom).toBeGreaterThan(0.5)
    expect(fitted.zoom).toBeLessThanOrEqual(1.5)

    // Zooming at a fixed screen point keeps the same world coordinate under that cursor.
    const vp = sanitizeViewport({ x: 50, y: 30, zoom: 1 })
    const cursorX = 350
    const cursorY = 230
    const worldBeforeX = (cursorX - vp.x) / vp.zoom
    const worldBeforeY = (cursorY - vp.y) / vp.zoom
    const zoomed = zoomViewportAtPoint(vp, cursorX, cursorY, 2)
    expect((cursorX - zoomed.x) / zoomed.zoom).toBeCloseTo(worldBeforeX, 6)
    expect((cursorY - zoomed.y) / zoomed.zoom).toBeCloseTo(worldBeforeY, 6)

    const vis = visibleWorldRect({ x: 0, y: 0, zoom: 1 }, 800, 600, 100)
    expect(rectsIntersect(vis, { x: 10, y: 10, width: 100, height: 100 })).toBe(true)
    expect(rectsIntersect(vis, { x: 2000, y: 2000, width: 100, height: 100 })).toBe(false)
  })

  it('snaps moving items to neighboring edges/centers and computes connector curves & group containment', () => {
    const snap = computeSnapGuides(
      { x: 104, y: 202, width: 100, height: 100 },
      [{ x: 100, y: 400, width: 100, height: 100 }],
      8
    )
    expect(snap.dx).toBe(-4)
    expect(snap.dy).toBe(0)
    expect(snap.guides).toHaveLength(1)
    expect(snap.guides[0].axis).toBe('x')
    expect(snap.guides[0].position).toBe(100)

    const curve = connectorBezier(
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 300, y: 0, width: 100, height: 100 }
    )
    expect(curve.x1).toBe(100)
    expect(curve.x2).toBe(300)
    expect(curve.midX).toBeCloseTo(200, 4)

    const group: MoodboardGroupItem = {
      id: 'g1',
      kind: 'group',
      x: 0,
      y: 0,
      width: 300,
      height: 300,
      zIndex: 0,
      locked: false,
      title: 'Lighting',
      tint: 'neutral',
      collapsed: false
    }
    const items: MoodboardItem[] = [
      group,
      { id: 'inside', kind: 'note', x: 50, y: 50, width: 100, height: 100, zIndex: 1, locked: false, title: '', body: '', tint: 'neutral' },
      { id: 'outside', kind: 'note', x: 500, y: 500, width: 100, height: 100, zIndex: 2, locked: false, title: '', body: '', tint: 'neutral' }
    ]
    expect(itemsInsideGroup(group, items)).toEqual(['inside'])
  })
})

describe('local color palette extraction', () => {
  it('extracts distinct dominant colors sorted from dark to light', () => {
    // 4 blocks of 25 pixels each: deep navy, crimson, golden yellow, pale cream
    const colors: Array<[number, number, number]> = [
      [16, 24, 40],
      [210, 45, 65],
      [240, 185, 60],
      [240, 238, 225]
    ]
    const rgba = new Uint8ClampedArray(colors.length * 25 * 4)
    let off = 0
    for (const [r, g, b] of colors) {
      for (let i = 0; i < 25; i++) {
        rgba[off++] = r
        rgba[off++] = g
        rgba[off++] = b
        rgba[off++] = 255
      }
    }
    const palette = extractPaletteFromPixels(rgba, 4)
    expect(palette).toHaveLength(4)
    expect(palette[0]).toBe('#101828')
    expect(palette[3]).toBe('#f0eee1')
  })

  it('ignores fully transparent pixels and returns valid hex fallback if empty', () => {
    const empty = new Uint8ClampedArray(40) // alpha = 0
    const palette = extractPaletteFromPixels(empty, 5)
    expect(palette).toHaveLength(5)
    expect(palette.every((c) => /^#[0-9a-f]{6}$/.test(c))).toBe(true)
  })
})

describe('Inspiration Browser helpers', () => {
  it('normalizes URLs, bare domains, and plain Google Images searches', () => {
    expect(normalizeBrowserInput('https://pinterest.com/ideas')).toBe('https://pinterest.com/ideas')
    expect(normalizeBrowserInput('are.na/explore')).toBe('https://are.na/explore')
    expect(normalizeBrowserInput('dolomites alpenglow fog')).toBe(
      'https://www.google.com/search?udm=2&q=dolomites%20alpenglow%20fog'
    )
    // Unsafe schemes fall back to search, never executed
    expect(normalizeBrowserInput('javascript:alert(1)')).toContain('google.com/search?udm=2')
  })

  it('decodes inline base64 image data URLs and rejects invalid ones', () => {
    const raw = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
    const url = `data:image/png;base64,${raw.toString('base64')}`
    const decoded = decodeImageDataUrl(url)
    expect(decoded).not.toBeNull()
    expect(Array.from(decoded!)).toEqual(Array.from(raw))
    expect(decodeImageDataUrl('data:text/html;base64,PGgxPmhpPC9oMT4=')).toBeNull()
  })

  it('computes origin-only Referer headers to avoid ERR_BLOCKED_BY_CLIENT', () => {
    // Cross-origin: origin only (strips path, query, and #fragment)
    expect(
      safeImageReferer(
        'https://encrypted-tbn0.gstatic.com/images?q=tbn:abc',
        'https://www.google.com/search?udm=2&q=fog#vhid=123'
      )
    ).toBe('https://www.google.com/')

    // Same-origin: also origin-only so cross-origin 302 redirects never fail Referer checks
    expect(
      safeImageReferer(
        'https://example.com/img/shot.webp',
        'https://example.com/gallery?page=2#top'
      )
    ).toBe('https://example.com/')

    // HTTPS -> HTTP downgrade: omitted
    expect(safeImageReferer('http://insecure.example.com/a.jpg', 'https://www.google.com/')).toBeNull()

    // Invalid URLs: omitted
    expect(safeImageReferer('not-a-url', 'https://www.google.com/')).toBeNull()
  })
})
