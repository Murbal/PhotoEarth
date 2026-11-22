// Moodboard renderer actions: IPC orchestration, photo import, 3D Globe bridge,
// palette extraction & Project Color Story sync.

import { MAX_PHOTO_BYTES, photoUrl } from '@shared/locations'
import { MAX_COLOR_STORY } from '@shared/projects'
import type {
  LocationPhoto,
  MoodboardDocument,
  MoodboardExportFormat,
  MoodboardGlobeSnapshot,
  MoodboardGroupItem,
  MoodboardImageItem,
  MoodboardItem,
  MoodboardLocationItem,
  MoodboardMetaPatch,
  MoodboardNoteItem,
  MoodboardNoteTint,
  MoodboardPaletteItem,
  MoodboardSummary,
  NewMoodboard,
  Project
} from '@shared/types'
import { getEngine } from '../engine/instance'
import { shellState } from '../shell/shellStore'
import { appState } from '../store/appStore'
import { moodboardState } from '../store/moodboardStore'
import { projectsState } from '../store/projectsStore'
import { renderBoardToBytes } from './boardExport'
import { extractPaletteFromImages } from './colorExtract'
import { makeThumbnail } from './photos'
import { updateProject } from './projects'

function topZIndex(items: readonly MoodboardItem[]): number {
  let max = 0
  for (const it of items) {
    if (it.kind !== 'group' && it.zIndex > max) max = it.zIndex
  }
  return max + 1
}

/** Computes a pleasant default card size preserving the photo's aspect ratio. */
export function defaultImageCardSize(width: number, height: number, maxSide = 360): { width: number; height: number } {
  if (!width || !height) return { width: 320, height: 220 }
  const scale = Math.min(maxSide / Math.max(width, height), 1)
  const w = Math.max(120, Math.round(width * scale))
  const h = Math.max(90, Math.round(height * scale))
  return { width: w, height: h }
}

/** Finds an open world position near the center of the current viewport. */
export function defaultSpawnPoint(doc: MoodboardDocument, viewportW = 1100, viewportH = 720, offsetIndex = 0): { x: number; y: number } {
  const cx = (viewportW / 2 - doc.viewport.x) / doc.viewport.zoom
  const cy = (viewportH / 2 - doc.viewport.y) / doc.viewport.zoom
  return {
    x: Math.round(cx - 160 + offsetIndex * 28),
    y: Math.round(cy - 120 + offsetIndex * 28)
  }
}

export async function createMoodboard(
  input?: NewMoodboard,
  opts?: { open?: boolean }
): Promise<{ summary: MoodboardSummary; document: MoodboardDocument }> {
  const res = await window.photoearth.moodboards.create(input)
  moodboardState().replaceSummary(res.summary)
  // Keep projectsStore in sync if the main process auto-linked the board to a project.
  if (res.summary.projectId) {
    const proj = projectsState().projects.find((p) => p.id === res.summary.projectId)
    if (proj && !proj.moodboardIds.includes(res.summary.id)) {
      projectsState().replaceProject({
        ...proj,
        moodboardIds: [...proj.moodboardIds, res.summary.id]
      })
    }
  }
  if (opts?.open !== false) {
    await moodboardState().flushSave()
    moodboardState().setActiveBoard(res.document)
    shellState().set({ activeMoodboardId: res.summary.id })
    shellState().setActiveModule('moodboard')
    appState().patchSettings((d) => {
      d.lastMoodboardId = res.summary.id
    })
  }
  shellState().showToast(`Moodboard “${res.summary.title}” created`)
  return res
}

export async function openMoodboard(id: string): Promise<MoodboardDocument | null> {
  const current = moodboardState().activeBoard
  if (current && current.id === id) {
    shellState().setActiveModule('moodboard')
    return current
  }
  await moodboardState().flushSave()
  const doc = await window.photoearth.moodboards.get(id)
  if (!doc) {
    shellState().showToast('That moodboard could not be opened.')
    return null
  }
  moodboardState().setActiveBoard(doc)
  shellState().set({ activeMoodboardId: doc.id })
  shellState().setActiveModule('moodboard')
  appState().patchSettings((d) => {
    d.lastMoodboardId = doc.id
  })
  return doc
}

export async function closeMoodboard(): Promise<void> {
  await moodboardState().flushSave()
  moodboardState().setActiveBoard(null)
  shellState().set({ activeMoodboardId: null })
}

export async function updateMoodboardMeta(id: string, patch: MoodboardMetaPatch): Promise<MoodboardSummary | null> {
  const updated = await window.photoearth.moodboards.updateMeta(id, patch)
  if (!updated) return null
  moodboardState().replaceSummary(updated)
  const active = moodboardState().activeBoard
  if (active && active.id === id) {
    moodboardState().set({
      activeBoard: { ...active, title: updated.title, projectId: updated.projectId }
    })
  }
  return updated
}

export async function deleteMoodboard(id: string): Promise<boolean> {
  const existing = moodboardState().summaries.find((b) => b.id === id)
  const ok = await window.photoearth.moodboards.remove(id)
  if (!ok) return false
  moodboardState().removeSummary(id)
  // Unlink from any projects in renderer state (main process already unlinked on disk).
  for (const proj of projectsState().projects) {
    if (proj.moodboardIds.includes(id)) {
      projectsState().replaceProject({
        ...proj,
        moodboardIds: proj.moodboardIds.filter((x) => x !== id)
      })
    }
  }
  if (shellState().activeMoodboardId === id) {
    shellState().set({ activeMoodboardId: null })
  }
  if (appState().settings.lastMoodboardId === id) {
    appState().patchSettings((d) => {
      d.lastMoodboardId = null
    })
  }
  shellState().showToast(existing ? `Deleted “${existing.title}”` : 'Moodboard deleted')
  return true
}

export async function linkMoodboardToProject(projectId: string, moodboardId: string): Promise<Project | null> {
  const updated = await window.photoearth.projects.linkMoodboard(projectId, moodboardId)
  if (updated) {
    projectsState().replaceProject(updated)
    // Set primary projectId on the board if it didn't have one yet.
    const summary = moodboardState().summaries.find((b) => b.id === moodboardId)
    if (summary && !summary.projectId) {
      await updateMoodboardMeta(moodboardId, { projectId })
    }
  }
  return updated
}

export async function unlinkMoodboardFromProject(projectId: string, moodboardId: string): Promise<Project | null> {
  const updated = await window.photoearth.projects.unlinkMoodboard(projectId, moodboardId)
  if (updated) {
    projectsState().replaceProject(updated)
    const summary = moodboardState().summaries.find((b) => b.id === moodboardId)
    if (summary && summary.projectId === projectId) {
      await updateMoodboardMeta(moodboardId, { projectId: null })
    }
  }
  return updated
}

/** Appends a stored photo as an Image Card onto the active board. */
export function spawnImageCardOnActiveBoard(
  photo: LocationPhoto,
  opts?: {
    x?: number
    y?: number
    caption?: string
    sourceTitle?: string
    sourceUrl?: string
    globe?: MoodboardGlobeSnapshot
    offsetIndex?: number
  }
): MoodboardImageItem | null {
  const board = moodboardState().activeBoard
  if (!board) return null
  const size = defaultImageCardSize(photo.width, photo.height)
  const fallback = defaultSpawnPoint(board, window.innerWidth - 52, window.innerHeight - 48, opts?.offsetIndex ?? 0)
  const item: MoodboardImageItem = {
    id: crypto.randomUUID(),
    kind: 'image',
    x: opts?.x ?? fallback.x,
    y: opts?.y ?? fallback.y,
    width: size.width,
    height: size.height,
    zIndex: topZIndex(board.items),
    locked: false,
    groupId: null,
    photo,
    caption: opts?.caption ?? '',
    borderless: false,
    sourceTitle: opts?.sourceTitle,
    sourceUrl: opts?.sourceUrl,
    globe: opts?.globe
  }
  moodboardState().commitBoardChange((doc) => ({
    ...doc,
    items: [...doc.items, item]
  }))
  moodboardState().selectOnly(item.id)
  return item
}

async function importBlobToBoard(
  boardId: string,
  name: string,
  size: number,
  load: () => Promise<Blob | string>
): Promise<LocationPhoto | null> {
  const { showToast } = shellState()
  if (size > MAX_PHOTO_BYTES) {
    showToast(`${name} is ${(size / 1048576).toFixed(0)} MB; images can be at most ${MAX_PHOTO_BYTES / 1048576} MB.`)
    return null
  }
  try {
    const blob = await load()
    if (typeof blob === 'string') {
      showToast(blob)
      return null
    }
    const thumb = await makeThumbnail(blob)
    const data = new Uint8Array(await blob.arrayBuffer())
    const res = await window.photoearth.moodboards.addImage(boardId, { name, data, ...thumb })
    if (res.ok) return res.photo
    showToast(res.error)
    return null
  } catch {
    showToast(`${name} can't be read as an image (JPEG, PNG, WebP, GIF or AVIF).`)
    return null
  }
}

export async function addImageFilesToActiveBoard(
  files: Iterable<File>,
  worldPoint?: { x: number; y: number }
): Promise<number> {
  const board = moodboardState().activeBoard
  if (!board) return 0
  let added = 0
  for (const file of files) {
    const photo = await importBlobToBoard(board.id, file.name || 'image.png', file.size, async () => file)
    if (!photo) continue
    spawnImageCardOnActiveBoard(photo, {
      x: worldPoint ? worldPoint.x + added * 32 : undefined,
      y: worldPoint ? worldPoint.y + added * 32 : undefined,
      offsetIndex: added
    })
    added++
  }
  if (added > 0) {
    await moodboardState().flushSave()
    shellState().showToast(added === 1 ? 'Added image to board' : `Added ${added} images to board`)
  }
  return added
}

export async function pickImagesForActiveBoard(worldPoint?: { x: number; y: number }): Promise<number> {
  const board = moodboardState().activeBoard
  if (!board) return 0
  const picked = await window.photoearth.moodboards.pickImages(board.id)
  if (picked.length === 0) return 0
  let added = 0
  for (const entry of picked) {
    const photo = await importBlobToBoard(board.id, entry.name, entry.bytes, async () => {
      const res = await window.photoearth.moodboards.readPickedPhoto(entry.token)
      return res.ok ? new Blob([res.data as Uint8Array<ArrayBuffer>]) : res.error
    })
    if (!photo) continue
    spawnImageCardOnActiveBoard(photo, {
      x: worldPoint ? worldPoint.x + added * 32 : undefined,
      y: worldPoint ? worldPoint.y + added * 32 : undefined,
      offsetIndex: added
    })
    added++
  }
  if (added > 0) {
    await moodboardState().flushSave()
    shellState().showToast(added === 1 ? 'Added image to board' : `Added ${added} images to board`)
  }
  return added
}

export function addNoteCardToActiveBoard(
  worldPoint?: { x: number; y: number },
  opts?: { title?: string; body?: string; tint?: MoodboardNoteTint; isHeading?: boolean }
): MoodboardNoteItem | null {
  const board = moodboardState().activeBoard
  if (!board) return null
  const pos = worldPoint ?? defaultSpawnPoint(board)
  const item: MoodboardNoteItem = {
    id: crypto.randomUUID(),
    kind: 'note',
    x: pos.x,
    y: pos.y,
    width: opts?.isHeading ? 300 : 260,
    height: opts?.isHeading ? 64 : 180,
    zIndex: topZIndex(board.items),
    locked: false,
    groupId: null,
    title: opts?.title ?? '',
    body: opts?.body ?? '',
    tint: opts?.tint ?? (opts?.isHeading ? 'transparent' : 'neutral'),
    isHeading: opts?.isHeading ?? false
  }
  moodboardState().commitBoardChange((doc) => ({
    ...doc,
    items: [...doc.items, item]
  }))
  moodboardState().set({ selectedIds: [item.id], selectedConnectorId: null, editingItemId: item.id })
  return item
}

export function addGroupFrameToActiveBoard(
  worldPoint?: { x: number; y: number },
  opts?: { title?: string; tint?: MoodboardNoteTint; width?: number; height?: number }
): MoodboardGroupItem | null {
  const board = moodboardState().activeBoard
  if (!board) return null
  const pos = worldPoint ?? defaultSpawnPoint(board)
  const item: MoodboardGroupItem = {
    id: crypto.randomUUID(),
    kind: 'group',
    x: pos.x,
    y: pos.y,
    width: opts?.width ?? 440,
    height: opts?.height ?? 340,
    zIndex: 0,
    locked: false,
    groupId: null,
    title: opts?.title ?? 'Section',
    tint: opts?.tint ?? 'neutral',
    collapsed: false
  }
  moodboardState().commitBoardChange((doc) => ({
    ...doc,
    items: [...doc.items, item]
  }))
  moodboardState().set({ selectedIds: [item.id], selectedConnectorId: null, editingItemId: item.id })
  return item
}

export function addPaletteCardToActiveBoard(
  colors: string[],
  opts?: { x?: number; y?: number; title?: string; sourceItemId?: string | null }
): MoodboardPaletteItem | null {
  const board = moodboardState().activeBoard
  if (!board) return null
  const pos = opts?.x !== undefined && opts?.y !== undefined ? { x: opts.x, y: opts.y } : defaultSpawnPoint(board)
  const item: MoodboardPaletteItem = {
    id: crypto.randomUUID(),
    kind: 'palette',
    x: pos.x,
    y: pos.y,
    width: 300,
    height: 144,
    zIndex: topZIndex(board.items),
    locked: false,
    groupId: null,
    title: opts?.title ?? 'Color Palette',
    colors: colors.length > 0 ? colors : ['#1b2a41', '#3b5978', '#d97736', '#f2b866', '#e8dfd1'],
    sourceItemId: opts?.sourceItemId ?? null
  }
  moodboardState().commitBoardChange((doc) => ({
    ...doc,
    items: [...doc.items, item]
  }))
  moodboardState().selectOnly(item.id)
  return item
}

export function addLocationCardToActiveBoard(
  locationId: string,
  worldPoint?: { x: number; y: number }
): MoodboardLocationItem | null {
  const board = moodboardState().activeBoard
  if (!board) return null
  const pos = worldPoint ?? defaultSpawnPoint(board)
  const item: MoodboardLocationItem = {
    id: crypto.randomUUID(),
    kind: 'location',
    x: pos.x,
    y: pos.y,
    width: 264,
    height: 204,
    zIndex: topZIndex(board.items),
    locked: false,
    groupId: null,
    locationId
  }
  moodboardState().commitBoardChange((doc) => ({
    ...doc,
    items: [...doc.items, item]
  }))
  moodboardState().selectOnly(item.id)
  return item
}

/** Extracts a color palette from one or more Image Cards and spawns a linked Palette Card beside them. */
export async function extractPaletteFromImageItems(imageItems: MoodboardImageItem[]): Promise<MoodboardPaletteItem | null> {
  if (imageItems.length === 0) return null
  try {
    const urls = imageItems.map((it) => photoUrl(it.photo.file))
    const colors = await extractPaletteFromImages(urls, imageItems.length > 1 ? 6 : 5)
    const anchor = imageItems[0]
    const palette = addPaletteCardToActiveBoard(colors, {
      x: anchor.x + anchor.width + 24,
      y: anchor.y,
      title: imageItems.length === 1 ? anchor.caption || 'Extracted Palette' : `Palette (${imageItems.length} images)`,
      sourceItemId: imageItems.length === 1 ? anchor.id : null
    })
    shellState().showToast(`Extracted ${colors.length} colors`)
    return palette
  } catch {
    shellState().showToast('Could not extract colors from image.')
    return null
  }
}

/** Pushes palette swatches into a Project's `concept.colorStory` (merges up to MAX_COLOR_STORY). */
export async function sendPaletteToProjectColorStory(
  colors: string[],
  explicitProjectId?: string | null
): Promise<boolean> {
  const board = moodboardState().activeBoard
  const targetProjectId = explicitProjectId ?? board?.projectId ?? shellState().activeProjectId
  if (!targetProjectId) {
    shellState().showToast('Link this moodboard to a project (or set an Active Project) first.')
    return false
  }
  const project = projectsState().projects.find((p) => p.id === targetProjectId)
  if (!project) {
    shellState().showToast('Target project not found.')
    return false
  }
  const merged: string[] = [...colors]
  for (const existing of project.concept.colorStory) {
    if (!merged.includes(existing) && merged.length < MAX_COLOR_STORY) merged.push(existing)
  }
  const next = merged.slice(0, MAX_COLOR_STORY)
  const updated = await updateProject(project.id, { concept: { colorStory: next } })
  if (updated) {
    shellState().showToast(`Synced ${colors.length} colors to “${project.title}”`)
    return true
  }
  return false
}

/**
 * Syncs dominant colors from a Project's linked moodboards into `project.concept.colorStory`.
 * Prefers Palette Cards on linked boards, falling back to extracting colors from their images.
 */
export async function syncProjectColorStoryFromMoodboards(project: Project): Promise<boolean> {
  const boardIds = Array.from(
    new Set([
      ...project.moodboardIds,
      ...moodboardState()
        .summaries.filter((b) => b.projectId === project.id)
        .map((b) => b.id)
    ])
  )
  if (boardIds.length === 0) {
    shellState().showToast('Link a Moodboard to this project first.')
    return false
  }
  const paletteColors: string[] = []
  const imageUrls: string[] = []
  for (const id of boardIds) {
    const active = moodboardState().activeBoard
    const doc = active?.id === id ? active : await window.photoearth.moodboards.get(id)
    if (!doc) continue
    for (const item of doc.items) {
      if (item.kind === 'palette') {
        for (const c of item.colors) {
          if (!paletteColors.includes(c)) paletteColors.push(c)
        }
      } else if (item.kind === 'image') {
        imageUrls.push(photoUrl(item.photo.file))
      }
    }
  }
  let colors = paletteColors.slice(0, MAX_COLOR_STORY)
  if (colors.length === 0 && imageUrls.length > 0) {
    try {
      colors = await extractPaletteFromImages(imageUrls.slice(0, 6), 6)
    } catch {
      /* ignore */
    }
  }
  if (colors.length === 0) {
    shellState().showToast('Add a Palette Card or reference images to a linked Moodboard first.')
    return false
  }
  const updated = await updateProject(project.id, { concept: { colorStory: colors } })
  if (updated) {
    shellState().showToast(`Synced ${colors.length} colors from linked Moodboards`)
    return true
  }
  return false
}

/** Captures the current 3D Globe view (cropped to Viewfinder if open) directly onto a Moodboard. */
export async function captureGlobeToMoodboard(targetBoardId?: string | null): Promise<boolean> {
  const engine = getEngine()
  if (!engine) {
    shellState().showToast('Open the 3D Globe first to capture a view.')
    return false
  }
  if (appState().settings.map.open) {
    shellState().showToast('Switch from 2D Map mode to 3D view to capture a snapshot.')
    return false
  }

  const captured = await engine.captureViewfinderFrame()
  if (!captured) {
    shellState().showToast('Could not capture the 3D viewport frame.')
    return false
  }

  // Pick target board: explicit -> active project's primary board -> currently open board -> create new.
  let boardId = targetBoardId ?? null
  const activeProjectId = shellState().activeProjectId
  if (!boardId && activeProjectId) {
    const proj = projectsState().projects.find((p) => p.id === activeProjectId)
    const projBoardId =
      proj?.moodboardIds.find((id) => moodboardState().summaries.some((s) => s.id === id)) ??
      moodboardState().summaries.find((s) => s.projectId === activeProjectId)?.id ??
      null
    if (projBoardId) boardId = projBoardId
  }
  if (!boardId && moodboardState().activeBoard) {
    boardId = moodboardState().activeBoard!.id
  }
  let targetTitle: string
  if (!boardId) {
    const activeProject = activeProjectId ? projectsState().projects.find((p) => p.id === activeProjectId) : null
    const created = await createMoodboard(
      {
        title: activeProject ? `${activeProject.title} — References` : 'Globe Captures',
        projectId: activeProject?.id ?? null,
        template: 'blank'
      },
      { open: false }
    )
    boardId = created.summary.id
    targetTitle = created.summary.title
  } else {
    targetTitle = moodboardState().summaries.find((s) => s.id === boardId)?.title ?? 'Moodboard'
  }

  try {
    const thumb = await makeThumbnail(captured.blob)
    const data = new Uint8Array(await captured.blob.arrayBuffer())
    const photoRes = await window.photoearth.moodboards.addImage(boardId, {
      name: `${captured.label.replace(/[^a-zA-Z0-9._ -]+/g, '').trim() || 'globe-snapshot'}.png`,
      data,
      ...thumb
    })
    if (!photoRes.ok) {
      shellState().showToast(photoRes.error)
      return false
    }

    const globeMeta: MoodboardGlobeSnapshot = {
      camera: captured.camera,
      time: captured.time,
      viewfinder: captured.viewfinder,
      label: captured.label
    }

    const activeBoard = moodboardState().activeBoard
    if (activeBoard && activeBoard.id === boardId) {
      spawnImageCardOnActiveBoard(photoRes.photo, {
        caption: captured.label,
        globe: globeMeta
      })
      await moodboardState().flushSave()
    } else {
      const doc = await window.photoearth.moodboards.get(boardId)
      if (!doc) return false
      const size = defaultImageCardSize(photoRes.photo.width, photoRes.photo.height)
      // Place neatly to the right of existing content or at origin.
      let maxRight = 0
      let baseY = 0
      for (const it of doc.items) {
        if (it.x + it.width > maxRight) {
          maxRight = it.x + it.width
          baseY = it.y
        }
      }
      const item: MoodboardImageItem = {
        id: crypto.randomUUID(),
        kind: 'image',
        x: doc.items.length === 0 ? 0 : maxRight + 32,
        y: doc.items.length === 0 ? 0 : baseY,
        width: size.width,
        height: size.height,
        zIndex: topZIndex(doc.items),
        locked: false,
        groupId: null,
        photo: photoRes.photo,
        caption: captured.label,
        borderless: false,
        globe: globeMeta
      }
      const saved = await window.photoearth.moodboards.save({
        ...doc,
        items: [...doc.items, item]
      })
      if (saved) moodboardState().replaceSummary(saved.summary)
    }

    shellState().showToast(`Snapped to “${targetTitle}”`)
    return true
  } catch (err) {
    console.error('[photoearth] Globe snapshot failed:', err)
    shellState().showToast('Could not save 3D Globe snapshot.')
    return false
  }
}

/** Moodboard → Globe bridge: switches to 3D Globe and restores a captured snapshot's exact view & time. */
export async function openGlobeSnapshot(snapshot: MoodboardGlobeSnapshot): Promise<void> {
  shellState().setActiveModule('globe')
  await new Promise((r) => setTimeout(r, 0))
  await getEngine()?.restoreGlobeSnapshot(snapshot)
}

/** Exports the active board (or selected items) to a PNG or JPEG file via Electron Save dialog. */
export async function exportActiveBoard(format: MoodboardExportFormat, onlySelection = false): Promise<void> {
  const { activeBoard, selectedIds } = moodboardState()
  if (!activeBoard) return
  const bookmarksById = new Map(appState().bookmarks.map((b) => [b.id, b]))
  const bytes = await renderBoardToBytes(activeBoard, {
    format,
    theme: appState().settings.theme,
    coordFormat: appState().settings.coordFormat,
    bookmarksById,
    selectedIds: onlySelection && selectedIds.length > 0 ? selectedIds : undefined
  })
  if (!bytes) {
    shellState().showToast('Nothing on the canvas to export.')
    return
  }
  const res = await window.photoearth.moodboards.exportImage(activeBoard.title, bytes, format)
  if (res.ok) {
    shellState().showToast(`Exported ${format.toUpperCase()} successfully`)
  } else if (!res.canceled && res.error) {
    shellState().showToast(res.error)
  }
}
