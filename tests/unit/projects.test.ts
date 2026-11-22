import { describe, expect, it } from 'vitest'
import {
  applyProjectPatch,
  filterAndSortProjects,
  formatDateWindow,
  migrateProjectsFile,
  normalizeHexColor,
  PROJECT_TEMPLATES,
  projectsFileVersion,
  sanitizeColorStory,
  sanitizeDateWindow,
  sanitizeIsoDate,
  sanitizeProject
} from '@shared/projects'
import type { Project } from '@shared/types'
import { toggleMarkdownCheckbox } from '@renderer/modules/projects/markdown'

const NOW = '2026-11-22T12:00:00.000Z'
const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e'

describe('projects sanitization', () => {
  it('validates strict ISO calendar dates and swaps inverted date windows', () => {
    expect(sanitizeIsoDate('2026-10-18')).toBe('2026-10-18')
    expect(sanitizeIsoDate('2026-02-28')).toBe('2026-02-28')
    expect(sanitizeIsoDate('2026-02-29')).toBeNull()
    expect(sanitizeIsoDate('2026-13-01')).toBeNull()
    expect(sanitizeIsoDate('2026-10-18T00:00:00Z')).toBeNull()
    expect(sanitizeIsoDate(null)).toBeNull()

    expect(sanitizeDateWindow({ start: '2026-10-24', end: '2026-10-18', label: '  Autumn  ' })).toEqual({
      start: '2026-10-18',
      end: '2026-10-24',
      label: 'Autumn'
    })
  })

  it('normalizes hex colors and deduplicates color stories', () => {
    expect(normalizeHexColor('#AbC')).toBe('#aabbcc')
    expect(normalizeHexColor(' #4FB3FF ')).toBe('#4fb3ff')
    expect(normalizeHexColor('rgb(0,0,0)')).toBeNull()
    expect(normalizeHexColor('#12345')).toBeNull()

    expect(sanitizeColorStory(['#ABC', '#aabbcc', 'bad', '#112233'])).toEqual(['#aabbcc', '#112233'])
    expect(
      sanitizeColorStory(Array.from({ length: 20 }, (_, i) => `#${String(i).padStart(6, '0')}`))
    ).toHaveLength(12)
  })

  it('sanitizes full project records and rejects missing ids', () => {
    expect(sanitizeProject(null)).toBeNull()
    expect(sanitizeProject({ title: 'No ID' })).toBeNull()

    const cover = { id: UUID, file: `${UUID}.jpg`, name: 'cover.jpg', bytes: 1200, width: 1920, height: 1080, addedAt: NOW }
    const p = sanitizeProject(
      {
        id: 'proj-1',
        title: '   ',
        status: 'unknown-status',
        coverPhoto: cover,
        tags: ['Dolomites', 'dolomites', 'Autumn'],
        dateWindow: { start: '2026-10-18', end: '2026-10-24', label: 'First snow' },
        concept: {
          summary: '  Layered peaks  ',
          lightingMood: '  Low fog  ',
          constraints: '  35mm only  ',
          colorStory: ['#FFF', '#4fb3ff']
        },
        locationIds: ['loc-1', 'loc-1', '', 'loc-2'],
        moodboardIds: ['mb-1', 'mb-1'],
        notes: [
          { id: 'n1', title: '  ', body: 'Hello', pinned: true },
          { id: 'n1', title: 'Duplicate id ignored', body: 'Nope' }
        ]
      },
      NOW
    )!

    expect(p).toEqual({
      id: 'proj-1',
      title: 'Untitled project',
      status: 'brainstorming',
      createdAt: NOW,
      updatedAt: NOW,
      coverPhoto: cover,
      tags: ['dolomites', 'autumn'],
      dateWindow: { start: '2026-10-18', end: '2026-10-24', label: 'First snow' },
      concept: {
        summary: 'Layered peaks',
        lightingMood: 'Low fog',
        constraints: '35mm only',
        colorStory: ['#ffffff', '#4fb3ff']
      },
      locationIds: ['loc-1', 'loc-2'],
      moodboardIds: ['mb-1'],
      notes: [{ id: 'n1', title: 'Untitled note', body: 'Hello', pinned: true, createdAt: NOW, updatedAt: NOW }]
    })
  })

  it('deep-merges partial concept & dateWindow patches and protects id/createdAt/coverPhoto', () => {
    const cover = { id: UUID, file: `${UUID}.png`, name: 'c.png', bytes: 10, width: 100, height: 100, addedAt: NOW }
    const current = sanitizeProject(
      {
        id: 'p1',
        title: 'Dolomites',
        status: 'scouting',
        createdAt: '2026-01-01T00:00:00.000Z',
        coverPhoto: cover,
        dateWindow: { start: '2026-10-18', end: '2026-10-24', label: 'Oct' },
        concept: { summary: 'Peaks', lightingMood: 'Fog', constraints: '50mm', colorStory: ['#112233'] }
      },
      NOW
    )!

    const patched = applyProjectPatch(
      current,
      {
        id: 'hijack',
        createdAt: '2030-01-01T00:00:00.000Z',
        coverPhoto: null,
        concept: { lightingMood: 'Alpenglow' },
        dateWindow: { label: 'Late Oct' },
        notes: [{ title: 'Permits', body: 'Check pass', pinned: true }]
      },
      '2026-11-23T00:00:00.000Z',
      () => 'generated-note-id'
    )!

    expect(patched.id).toBe('p1')
    expect(patched.createdAt).toBe('2026-01-01T00:00:00.000Z')
    expect(patched.updatedAt).toBe('2026-11-23T00:00:00.000Z')
    expect(patched.coverPhoto).toEqual(cover)
    expect(patched.concept).toEqual({
      summary: 'Peaks',
      lightingMood: 'Alpenglow',
      constraints: '50mm',
      colorStory: ['#112233']
    })
    expect(patched.dateWindow).toEqual({ start: '2026-10-18', end: '2026-10-24', label: 'Late Oct' })
    expect(patched.notes[0].id).toBe('generated-note-id')
  })

  it('migrates missing, broken and duplicate entries cleanly', () => {
    expect(migrateProjectsFile(undefined)).toEqual({ version: 1, projects: [] })
    expect(projectsFileVersion({ version: 1 })).toBe(1)
    const raw = {
      version: 1,
      projects: [{ id: 'a', title: 'Alpha' }, { title: 'No id' }, { id: 'a', title: 'Duplicate' }]
    }
    const migrated = migrateProjectsFile(raw, NOW)
    expect(migrated.projects.map((p) => p.title)).toEqual(['Alpha'])
    expect(migrateProjectsFile(JSON.parse(JSON.stringify(migrated)), '2030-01-01T00:00:00.000Z')).toEqual(migrated)
  })
})

describe('projects filtering, sorting & formatting', () => {
  const make = (overrides: Partial<Project>): Project =>
    sanitizeProject(
      {
        id: 'p',
        title: 'Project',
        status: 'scouting',
        createdAt: NOW,
        updatedAt: NOW,
        ...overrides
      },
      NOW
    )!

  const list: Project[] = [
    make({
      id: 'p1',
      title: 'Dolomites Autumn',
      status: 'ready',
      updatedAt: '2026-11-20T10:00:00.000Z',
      dateWindow: { start: '2026-10-18', end: '2026-10-24', label: '' },
      tags: ['italy', 'landscape'],
      locationIds: ['loc-tre-cime']
    }),
    make({
      id: 'p2',
      title: 'Urban Fog Night',
      status: 'brainstorming',
      updatedAt: '2026-11-22T10:00:00.000Z',
      concept: { summary: 'Neon mist in Zurich', lightingMood: 'Blue hour', constraints: '', colorStory: [] }
    }),
    make({
      id: 'p3',
      title: 'Iceland 2024',
      status: 'archived',
      updatedAt: '2026-11-22T12:00:00.000Z',
      dateWindow: { start: '2024-02-01', end: '2024-02-10', label: '' }
    })
  ]

  const locationNames = new Map([['loc-tre-cime', 'Tre Cime di Lavaredo']])

  it('hides archived projects from All by default and shows them when filtered to Archived', () => {
    const all = filterAndSortProjects(list, { status: 'all', query: '', sort: 'updated' }, locationNames)
    expect(all.map((p) => p.id)).toEqual(['p2', 'p1'])

    const archived = filterAndSortProjects(list, { status: 'archived', query: '', sort: 'updated' }, locationNames)
    expect(archived.map((p) => p.id)).toEqual(['p3'])
  })

  it('matches search queries across title, tags, concept summary and linked location names', () => {
    expect(filterAndSortProjects(list, { status: 'all', query: 'lavaredo', sort: 'updated' }, locationNames).map((p) => p.id)).toEqual(['p1'])
    expect(filterAndSortProjects(list, { status: 'all', query: 'neon zurich', sort: 'updated' }, locationNames).map((p) => p.id)).toEqual(['p2'])
    expect(filterAndSortProjects(list, { status: 'all', query: 'italy', sort: 'updated' }, locationNames).map((p) => p.id)).toEqual(['p1'])
  })

  it('sorts by name, target date, status and recently updated', () => {
    expect(filterAndSortProjects(list, { status: 'all', query: '', sort: 'name' }).map((p) => p.id)).toEqual(['p1', 'p2'])
    expect(filterAndSortProjects(list, { status: 'all', query: '', sort: 'date' }).map((p) => p.id)).toEqual(['p1', 'p2'])
    expect(filterAndSortProjects(list, { status: 'all', query: '', sort: 'status' }).map((p) => p.id)).toEqual(['p1', 'p2'])
  })

  it('formats date windows concisely', () => {
    expect(formatDateWindow({ start: '2026-10-18', end: '2026-10-24', label: '' }, 2026)).toBe('Oct 18–24')
    expect(formatDateWindow({ start: '2027-10-18', end: '2027-10-24', label: '' }, 2026)).toBe('Oct 18–24, 2027')
    expect(formatDateWindow({ start: '2026-10-28', end: '2026-11-03', label: '' }, 2026)).toBe('Oct 28 – Nov 3')
    expect(formatDateWindow({ start: '2026-12-29', end: '2027-01-04', label: '' }, 2026)).toBe('Dec 29, 2026 – Jan 4, 2027')
    expect(formatDateWindow({ start: '2026-10-18', end: null, label: '' }, 2026)).toBe('Oct 18')
    expect(formatDateWindow({ start: null, end: null, label: 'Late Autumn' }, 2026)).toBe('Late Autumn')
    expect(formatDateWindow({ start: null, end: null, label: '' }, 2026)).toBeNull()
  })

  it('provides valid starter templates', () => {
    expect(PROJECT_TEMPLATES.length).toBeGreaterThanOrEqual(4)
    for (const tpl of PROJECT_TEMPLATES) {
      const sanitized = sanitizeProject({ ...tpl.input, id: tpl.id }, NOW, () => 'n1')
      expect(sanitized).not.toBeNull()
    }
  })

  it('toggles markdown checklist items cleanly', () => {
    const body = '## Tasks\n- [ ] Check permits\n- [x] Book cabin'
    expect(toggleMarkdownCheckbox(body, 1, true)).toBe('## Tasks\n- [x] Check permits\n- [x] Book cabin')
    expect(toggleMarkdownCheckbox(body, 2, false)).toBe('## Tasks\n- [ ] Check permits\n- [ ] Book cabin')
  })
})
