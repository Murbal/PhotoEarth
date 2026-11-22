// Projects Hub renderer actions (IPC + store orchestration + Globe bridge).

import { MAX_PHOTO_BYTES } from '@shared/locations'
import { MAX_NOTES_PER_PROJECT } from '@shared/projects'
import type { Bookmark, LocationPhoto, NewProject, Project, ProjectNote, ProjectPatch } from '@shared/types'
import { getEngine } from '../engine/instance'
import { shellState } from '../shell/shellStore'
import { appState } from '../store/appStore'
import { projectsState, type ProjectTab } from '../store/projectsStore'
import { makeThumbnail } from './photos'

export function getActiveProject(): Project | null {
  const id = shellState().activeProjectId
  if (!id) return null
  return projectsState().projects.find((p) => p.id === id) ?? null
}

/** Sets or clears the Active Project across the app and persists it in settings. */
export function setActiveProject(id: string | null, opts?: { silent?: boolean }): void {
  const project = id ? projectsState().projects.find((p) => p.id === id) ?? null : null
  const nextId = project ? project.id : null
  const prevId = shellState().activeProjectId
  shellState().set({ activeProjectId: nextId })
  if (!nextId && appState().locationScope === 'project') {
    appState().set({ locationScope: 'all' })
  }
  if (appState().settings.lastProjectId !== nextId) {
    appState().patchSettings((d) => {
      d.lastProjectId = nextId
    })
  }
  if (!opts?.silent && nextId !== prevId) {
    shellState().showToast(project ? `Active project: ${project.title}` : 'Active project cleared')
  }
}

export async function createProject(
  input: NewProject,
  opts?: { open?: boolean; setActive?: boolean }
): Promise<Project> {
  const created = await window.photoearth.projects.create(input)
  projectsState().replaceProject(created)
  if (opts?.open !== false) {
    projectsState().openProject(created.id, 'overview')
    shellState().setActiveModule('projects')
  }
  if (opts?.setActive) setActiveProject(created.id, { silent: true })
  shellState().showToast(`Project “${created.title}” created`)
  return created
}

export async function updateProject(id: string, patch: ProjectPatch): Promise<Project | null> {
  const updated = await window.photoearth.projects.update(id, patch)
  if (updated) projectsState().replaceProject(updated)
  return updated
}

export async function deleteProject(id: string): Promise<boolean> {
  const existing = projectsState().projects.find((p) => p.id === id)
  const ok = await window.photoearth.projects.remove(id)
  if (!ok) return false
  projectsState().removeProjectFromState(id)
  if (shellState().activeProjectId === id) {
    setActiveProject(null, { silent: true })
  }
  if (appState().scoutingProjectId === id) {
    appState().set({ scoutingProjectId: null })
  }
  shellState().showToast(existing ? `Deleted “${existing.title}”` : 'Project deleted')
  return true
}

export function openProjectWorkspace(id: string, tab?: ProjectTab): void {
  projectsState().openProject(id, tab)
  shellState().setActiveModule('projects')
}

async function uploadCoverBlob(projectId: string, name: string, size: number, load: () => Promise<Blob | string>): Promise<void> {
  const { showToast } = shellState()
  if (size > MAX_PHOTO_BYTES) {
    showToast(`${name} is ${(size / 1048576).toFixed(0)} MB; photos can be at most ${MAX_PHOTO_BYTES / 1048576} MB.`)
    return
  }
  try {
    const file = await load()
    if (typeof file === 'string') {
      showToast(file)
      return
    }
    const thumb = await makeThumbnail(file)
    const data = new Uint8Array(await file.arrayBuffer())
    const res = await window.photoearth.projects.setCoverPhoto(projectId, { name, data, ...thumb })
    if (res.ok) {
      projectsState().replaceProject(res.project)
      showToast('Cover photo updated')
    } else {
      showToast(res.error)
    }
  } catch {
    showToast(`${name} can't be read as an image (JPEG, PNG, WebP, GIF or AVIF).`)
  }
}

export async function pickProjectCoverPhoto(projectId: string): Promise<void> {
  const picked = await window.photoearth.projects.pickCoverPhoto(projectId)
  if (!picked) return
  await uploadCoverBlob(projectId, picked.name, picked.bytes, async () => {
    const res = await window.photoearth.projects.readPickedPhoto(picked.token)
    return res.ok ? new Blob([res.data as Uint8Array<ArrayBuffer>]) : res.error
  })
}

export async function setProjectCoverPhotoFile(projectId: string, file: File): Promise<void> {
  await uploadCoverBlob(projectId, file.name, file.size, async () => file)
}

export async function setProjectCoverFromLocationPhoto(projectId: string, photo: LocationPhoto): Promise<void> {
  const res = await window.photoearth.projects.setCoverPhotoFromPhoto(projectId, photo)
  if (res.ok) {
    projectsState().replaceProject(res.project)
    shellState().showToast('Cover photo updated')
  } else {
    shellState().showToast(res.error)
  }
}

export async function clearProjectCoverPhoto(projectId: string): Promise<void> {
  const updated = await window.photoearth.projects.clearCoverPhoto(projectId)
  if (updated) {
    projectsState().replaceProject(updated)
    shellState().showToast('Cover photo removed')
  }
}

export async function linkLocationToProject(projectId: string, locationId: string): Promise<Project | null> {
  const updated = await window.photoearth.projects.linkLocation(projectId, locationId)
  if (updated) projectsState().replaceProject(updated)
  return updated
}

export async function unlinkLocationFromProject(projectId: string, locationId: string): Promise<Project | null> {
  const updated = await window.photoearth.projects.unlinkLocation(projectId, locationId)
  if (updated) projectsState().replaceProject(updated)
  return updated
}

export async function addProjectNote(
  projectId: string,
  note?: { title?: string; body?: string; pinned?: boolean }
): Promise<ProjectNote | null> {
  const project = projectsState().projects.find((p) => p.id === projectId)
  if (!project) return null
  if (project.notes.length >= MAX_NOTES_PER_PROJECT) {
    shellState().showToast(`A project can hold at most ${MAX_NOTES_PER_PROJECT} notes.`)
    return null
  }
  const now = new Date().toISOString()
  const draft: ProjectNote = {
    id: crypto.randomUUID(),
    title: note?.title ?? 'Untitled note',
    body: note?.body ?? '',
    pinned: note?.pinned ?? false,
    createdAt: now,
    updatedAt: now
  }
  const updated = await updateProject(projectId, { notes: [draft, ...project.notes] })
  if (!updated) return null
  const created = updated.notes.find((n) => n.id === draft.id) ?? updated.notes[0] ?? null
  if (created) projectsState().set({ selectedNoteId: created.id })
  return created
}

export async function updateProjectNote(
  projectId: string,
  noteId: string,
  patch: Partial<Pick<ProjectNote, 'title' | 'body' | 'pinned'>>
): Promise<Project | null> {
  const project = projectsState().projects.find((p) => p.id === projectId)
  if (!project) return null
  const now = new Date().toISOString()
  const notes = project.notes.map((n) => (n.id === noteId ? { ...n, ...patch, updatedAt: now } : n))
  return updateProject(projectId, { notes })
}

export async function deleteProjectNote(projectId: string, noteId: string): Promise<Project | null> {
  const project = projectsState().projects.find((p) => p.id === projectId)
  if (!project) return null
  const notes = project.notes.filter((n) => n.id !== noteId)
  const updated = await updateProject(projectId, { notes })
  if (updated && projectsState().selectedNoteId === noteId) {
    projectsState().set({ selectedNoteId: updated.notes[0]?.id ?? null })
  }
  return updated
}

/**
 * Resolves the best preview photo for a project card: explicit cover photo first, then the
 * first linked location's first photo, or null (which renders a color-story / subtle gradient).
 */
export function resolveProjectCover(project: Project, bookmarksById: ReadonlyMap<string, Bookmark>): LocationPhoto | null {
  if (project.coverPhoto) return project.coverPhoto
  for (const id of project.locationIds) {
    const loc = bookmarksById.get(id)
    if (loc?.photos[0]) return loc.photos[0]
  }
  return null
}

/**
 * Switches to the 3D Globe with this project active and scoped, and flies to fit its linked
 * locations (or the first location if there's only one).
 */
export async function openProjectInGlobe(project: Project): Promise<void> {
  setActiveProject(project.id, { silent: true })
  const linked = project.locationIds
    .map((id) => appState().bookmarks.find((b) => b.id === id))
    .filter((b): b is Bookmark => !!b)
  appState().set({ locationScope: 'project' })
  appState().togglePanel('bookmarks', true)
  shellState().setActiveModule('globe')
  if (linked.length === 0) {
    shellState().showToast(`Opened “${project.title}” in Globe — no linked spots yet`)
    return
  }
  // Wait a microtask so GlobeModule resumes from suspension before starting the camera flight.
  await new Promise((r) => setTimeout(r, 0))
  const engine = getEngine()
  if (!engine) return
  if (linked.length === 1) {
    await engine.flyToBookmark(linked[0])
  } else {
    await engine.flyToProjectLocations(linked)
  }
}

/** Switches to the 3D Globe ready to save new spots directly into this project. */
export function scoutNewSpotForProject(project: Project): void {
  setActiveProject(project.id, { silent: true })
  appState().set({ saveToActiveProject: true, locationScope: 'project', scoutingProjectId: project.id })
  shellState().setActiveModule('globe')
}

/** Switches to the 3D Globe and flies straight to one linked location. */
export async function flyToProjectLocation(bookmark: Bookmark, projectId?: string): Promise<void> {
  if (projectId) setActiveProject(projectId, { silent: true })
  shellState().setActiveModule('globe')
  await new Promise((r) => setTimeout(r, 0))
  await getEngine()?.flyToBookmark(bookmark)
}
