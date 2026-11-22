import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type { ModuleId } from '@shared/types'

export interface Toast {
  id: number
  message: string
}

export interface PhotoViewerState {
  locationId: string
  photoId: string
}

export interface ShellState {
  activeModule: ModuleId
  /** True once the 3D Globe has been mounted; kept alive across module switches. */
  globeMounted: boolean
  activeProjectId: string | null
  activeMoodboardId: string | null
  paletteOpen: boolean
  shortcutsOpen: boolean
  settingsOpen: boolean
  onboardingOpen: boolean
  /** A reference photo shown full size. */
  photoViewer: PhotoViewerState | null
  toast: Toast | null

  set: (partial: Partial<ShellState>) => void
  setActiveModule: (module: ModuleId) => void
  showToast: (message: string) => void
  isModalOpen: () => boolean
}

let toastId = 0

export const useShellStore = create<ShellState>()(
  subscribeWithSelector((set, get) => ({
    activeModule: 'globe',
    globeMounted: true,
    activeProjectId: null,
    activeMoodboardId: null,
    paletteOpen: false,
    shortcutsOpen: false,
    settingsOpen: false,
    onboardingOpen: false,
    photoViewer: null,
    toast: null,

    set: (partial) => set(partial),
    setActiveModule: (module) =>
      set((s) => ({
        activeModule: module,
        globeMounted: s.globeMounted || module === 'globe'
      })),
    showToast: (message) => {
      const id = ++toastId
      set({ toast: { id, message } })
      setTimeout(() => {
        if (get().toast?.id === id) set({ toast: null })
      }, 2600)
    },
    isModalOpen: () => {
      const s = get()
      return s.paletteOpen || s.settingsOpen || s.shortcutsOpen || s.onboardingOpen || !!s.photoViewer
    }
  }))
)

export const shellState = (): ShellState => useShellStore.getState()
