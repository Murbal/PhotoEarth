import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type { ProjectSort, ProjectStatusFilter } from '@shared/projects'
import type { Project } from '@shared/types'

export type ProjectTab = 'overview' | 'locations' | 'moodboards' | 'notes'

export interface ProjectsState {
  projects: Project[]
  /** Project open in the workspace detail view, or null for the Projects Index. */
  openProjectId: string | null
  activeTab: ProjectTab
  statusFilter: ProjectStatusFilter
  sort: ProjectSort
  search: string
  /** Selected note in the Notes & Ideas tab. */
  selectedNoteId: string | null
  /** Opens the quick "New Project" dialog in Projects Hub (e.g. from shortcut `N` or Command Palette). */
  createDialogOpen: boolean
  /** Incremented by `/` shortcut so ProjectsIndex focuses its search input. */
  focusSearchNonce: number

  set: (partial: Partial<ProjectsState>) => void
  openProject: (id: string, tab?: ProjectTab) => void
  closeProject: () => void
  replaceProject: (project: Project) => void
  removeProjectFromState: (id: string) => void
  unlinkLocationFromState: (locationId: string) => void
  requestFocusSearch: () => void
}

export const useProjectsStore = create<ProjectsState>()(
  subscribeWithSelector((set) => ({
    projects: [],
    openProjectId: null,
    activeTab: 'overview',
    statusFilter: 'all',
    sort: 'updated',
    search: '',
    selectedNoteId: null,
    createDialogOpen: false,
    focusSearchNonce: 0,

    set: (partial) => set(partial),
    openProject: (id, tab) =>
      set((s) => ({
        openProjectId: id,
        activeTab: tab ?? (s.openProjectId === id ? s.activeTab : 'overview'),
        selectedNoteId: s.openProjectId === id ? s.selectedNoteId : null
      })),
    closeProject: () => set({ openProjectId: null, selectedNoteId: null }),
    replaceProject: (project) =>
      set((s) => ({
        projects: s.projects.some((p) => p.id === project.id)
          ? s.projects.map((p) => (p.id === project.id ? project : p))
          : [...s.projects, project]
      })),
    removeProjectFromState: (id) =>
      set((s) => ({
        projects: s.projects.filter((p) => p.id !== id),
        openProjectId: s.openProjectId === id ? null : s.openProjectId,
        selectedNoteId: s.openProjectId === id ? null : s.selectedNoteId
      })),
    unlinkLocationFromState: (locationId) =>
      set((s) => ({
        projects: s.projects.map((p) =>
          p.locationIds.includes(locationId) ? { ...p, locationIds: p.locationIds.filter((x) => x !== locationId) } : p
        )
      })),
    requestFocusSearch: () => set((s) => ({ focusSearchNonce: s.focusSearchNonce + 1 }))
  }))
)

export const projectsState = (): ProjectsState => useProjectsStore.getState()
