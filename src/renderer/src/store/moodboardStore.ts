import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type { MoodboardSort } from '@shared/moodboards'
import type {
  BrowserDrawerState,
  MoodboardConnector,
  MoodboardDocument,
  MoodboardItem,
  MoodboardSummary,
  MoodboardViewport
} from '@shared/types'

export type MoodboardTool = 'select' | 'pan' | 'note' | 'group' | 'connect'

interface HistorySnapshot {
  items: MoodboardItem[]
  connectors: MoodboardConnector[]
}

const MAX_UNDO_STEPS = 100
const SAVE_DEBOUNCE_MS = 500

let saveTimer: ReturnType<typeof setTimeout> | null = null

function clearSaveTimer(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
}

export const INITIAL_BROWSER_STATE: BrowserDrawerState = {
  url: '',
  title: '',
  canGoBack: false,
  canGoForward: false,
  loading: false
}

export interface MoodboardState {
  summaries: MoodboardSummary[]
  activeBoard: MoodboardDocument | null
  dirty: boolean
  tool: MoodboardTool
  selectedIds: string[]
  selectedConnectorId: string | null
  editingItemId: string | null
  presentationMode: boolean
  browserDrawerOpen: boolean
  browserDrawerWidth: number
  browserState: BrowserDrawerState
  snapToGuides: boolean
  showGrid: boolean
  search: string
  projectFilter: string | 'all'
  sort: MoodboardSort
  createDialogOpen: boolean
  /** Incremented by `/` shortcut on index so MoodboardIndex focuses its search input. */
  focusSearchNonce: number
  /** Incremented by `F` shortcut or Fit button so CanvasWorkspace fits view to selection/all. */
  fitViewNonce: number
  /** Incremented by `0` shortcut so CanvasWorkspace resets zoom to 100%. */
  resetZoomNonce: number
  undoStack: HistorySnapshot[]
  redoStack: HistorySnapshot[]

  set: (partial: Partial<MoodboardState>) => void
  replaceSummary: (summary: MoodboardSummary) => void
  removeSummary: (id: string) => void
  setActiveBoard: (doc: MoodboardDocument | null) => void
  /** Pushes a history snapshot manually before a transient drag/resize sequence. */
  pushUndoSnapshot: () => void
  /** Applies a board mutation, records undo history by default, and schedules debounced save. */
  commitBoardChange: (
    mutator: (doc: MoodboardDocument) => MoodboardDocument,
    opts?: { recordHistory?: boolean; scheduleSave?: boolean }
  ) => void
  /** Updates viewport (pan/zoom) smoothly and schedules debounced save without polluting undo stack. */
  setViewport: (viewport: MoodboardViewport) => void
  undo: () => void
  redo: () => void
  selectOnly: (id: string | null) => void
  toggleSelect: (id: string) => void
  selectMany: (ids: string[]) => void
  selectAll: () => void
  clearSelection: () => void
  bringToFront: (ids?: string[]) => void
  sendToBack: (ids?: string[]) => void
  toggleLockSelection: (ids?: string[]) => void
  deleteSelection: () => void
  duplicateSelection: () => void
  scheduleSave: () => void
  flushSave: () => Promise<void>
  flushSaveSync: () => void
  requestFocusSearch: () => void
  requestFitView: () => void
  requestResetZoom: () => void
}

function nextZIndex(items: readonly MoodboardItem[]): number {
  let max = 0
  for (const it of items) {
    if (it.kind !== 'group' && it.zIndex > max) max = it.zIndex
  }
  return max + 1
}

function minZIndex(items: readonly MoodboardItem[]): number {
  let min = 1
  for (const it of items) {
    if (it.kind !== 'group' && it.zIndex < min) min = it.zIndex
  }
  return min - 1
}

export const useMoodboardStore = create<MoodboardState>()(
  subscribeWithSelector((set, get) => ({
    summaries: [],
    activeBoard: null,
    dirty: false,
    tool: 'select',
    selectedIds: [],
    selectedConnectorId: null,
    editingItemId: null,
    presentationMode: false,
    browserDrawerOpen: false,
    browserDrawerWidth: 440,
    browserState: INITIAL_BROWSER_STATE,
    snapToGuides: true,
    showGrid: true,
    search: '',
    projectFilter: 'all',
    sort: 'updated',
    createDialogOpen: false,
    focusSearchNonce: 0,
    fitViewNonce: 0,
    resetZoomNonce: 0,
    undoStack: [],
    redoStack: [],

    set: (partial) => set(partial),

    replaceSummary: (summary) =>
      set((s) => ({
        summaries: s.summaries.some((b) => b.id === summary.id)
          ? s.summaries.map((b) => (b.id === summary.id ? summary : b))
          : [...s.summaries, summary]
      })),

    removeSummary: (id) =>
      set((s) => ({
        summaries: s.summaries.filter((b) => b.id !== id),
        activeBoard: s.activeBoard?.id === id ? null : s.activeBoard,
        dirty: s.activeBoard?.id === id ? false : s.dirty,
        selectedIds: s.activeBoard?.id === id ? [] : s.selectedIds,
        selectedConnectorId: s.activeBoard?.id === id ? null : s.selectedConnectorId,
        editingItemId: s.activeBoard?.id === id ? null : s.editingItemId,
        presentationMode: s.activeBoard?.id === id ? false : s.presentationMode,
        undoStack: s.activeBoard?.id === id ? [] : s.undoStack,
        redoStack: s.activeBoard?.id === id ? [] : s.redoStack
      })),

    setActiveBoard: (doc) => {
      clearSaveTimer()
      set({
        activeBoard: doc,
        dirty: false,
        selectedIds: [],
        selectedConnectorId: null,
        editingItemId: null,
        tool: 'select',
        presentationMode: false,
        undoStack: [],
        redoStack: []
      })
    },

    pushUndoSnapshot: () => {
      const board = get().activeBoard
      if (!board) return
      const snap: HistorySnapshot = {
        items: structuredClone(board.items),
        connectors: structuredClone(board.connectors)
      }
      set((s) => ({
        undoStack: [...s.undoStack.slice(-(MAX_UNDO_STEPS - 1)), snap],
        redoStack: []
      }))
    },

    commitBoardChange: (mutator, opts) => {
      const board = get().activeBoard
      if (!board) return
      const recordHistory = opts?.recordHistory !== false
      const shouldSave = opts?.scheduleSave !== false
      const prevSnap: HistorySnapshot | null = recordHistory
        ? { items: structuredClone(board.items), connectors: structuredClone(board.connectors) }
        : null
      const next = mutator(board)
      if (next === board) return
      set((s) => ({
        activeBoard: next,
        dirty: true,
        undoStack: prevSnap ? [...s.undoStack.slice(-(MAX_UNDO_STEPS - 1)), prevSnap] : s.undoStack,
        redoStack: prevSnap ? [] : s.redoStack
      }))
      if (shouldSave) get().scheduleSave()
    },

    setViewport: (viewport) => {
      const board = get().activeBoard
      if (!board) return
      set({ activeBoard: { ...board, viewport }, dirty: true })
      get().scheduleSave()
    },

    undo: () => {
      const { activeBoard, undoStack, redoStack } = get()
      if (!activeBoard || undoStack.length === 0) return
      const prev = undoStack[undoStack.length - 1]
      const currentSnap: HistorySnapshot = {
        items: structuredClone(activeBoard.items),
        connectors: structuredClone(activeBoard.connectors)
      }
      const nextBoard: MoodboardDocument = {
        ...activeBoard,
        items: prev.items,
        connectors: prev.connectors
      }
      const validIds = new Set(prev.items.map((i) => i.id))
      set({
        activeBoard: nextBoard,
        dirty: true,
        selectedIds: get().selectedIds.filter((id) => validIds.has(id)),
        selectedConnectorId: null,
        editingItemId: null,
        undoStack: undoStack.slice(0, -1),
        redoStack: [...redoStack.slice(-(MAX_UNDO_STEPS - 1)), currentSnap]
      })
      get().scheduleSave()
    },

    redo: () => {
      const { activeBoard, undoStack, redoStack } = get()
      if (!activeBoard || redoStack.length === 0) return
      const nextSnap = redoStack[redoStack.length - 1]
      const currentSnap: HistorySnapshot = {
        items: structuredClone(activeBoard.items),
        connectors: structuredClone(activeBoard.connectors)
      }
      const nextBoard: MoodboardDocument = {
        ...activeBoard,
        items: nextSnap.items,
        connectors: nextSnap.connectors
      }
      const validIds = new Set(nextSnap.items.map((i) => i.id))
      set({
        activeBoard: nextBoard,
        dirty: true,
        selectedIds: get().selectedIds.filter((id) => validIds.has(id)),
        selectedConnectorId: null,
        editingItemId: null,
        undoStack: [...undoStack.slice(-(MAX_UNDO_STEPS - 1)), currentSnap],
        redoStack: redoStack.slice(0, -1)
      })
      get().scheduleSave()
    },

    selectOnly: (id) =>
      set({
        selectedIds: id ? [id] : [],
        selectedConnectorId: null
      }),

    toggleSelect: (id) =>
      set((s) => ({
        selectedIds: s.selectedIds.includes(id) ? s.selectedIds.filter((x) => x !== id) : [...s.selectedIds, id],
        selectedConnectorId: null
      })),

    selectMany: (ids) => set({ selectedIds: ids, selectedConnectorId: null }),

    selectAll: () => {
      const board = get().activeBoard
      if (!board) return
      set({ selectedIds: board.items.map((i) => i.id), selectedConnectorId: null })
    },

    clearSelection: () => set({ selectedIds: [], selectedConnectorId: null, editingItemId: null }),

    bringToFront: (ids) => {
      const targetIds = new Set(ids ?? get().selectedIds)
      if (targetIds.size === 0) return
      get().commitBoardChange((doc) => {
        let z = nextZIndex(doc.items)
        return {
          ...doc,
          items: doc.items.map((it) => (targetIds.has(it.id) && it.kind !== 'group' ? { ...it, zIndex: z++ } : it))
        }
      })
    },

    sendToBack: (ids) => {
      const targetIds = new Set(ids ?? get().selectedIds)
      if (targetIds.size === 0) return
      get().commitBoardChange((doc) => {
        let z = minZIndex(doc.items)
        return {
          ...doc,
          items: doc.items.map((it) => (targetIds.has(it.id) && it.kind !== 'group' ? { ...it, zIndex: z-- } : it))
        }
      })
    },

    toggleLockSelection: (ids) => {
      const targetIds = new Set(ids ?? get().selectedIds)
      if (targetIds.size === 0) return
      const board = get().activeBoard
      if (!board) return
      const allLocked = board.items.filter((i) => targetIds.has(i.id)).every((i) => i.locked)
      get().commitBoardChange((doc) => ({
        ...doc,
        items: doc.items.map((it) => (targetIds.has(it.id) ? { ...it, locked: !allLocked } : it))
      }))
    },

    deleteSelection: () => {
      const { activeBoard, selectedIds, selectedConnectorId } = get()
      if (!activeBoard) return
      if (selectedConnectorId) {
        get().commitBoardChange((doc) => ({
          ...doc,
          connectors: doc.connectors.filter((c) => c.id !== selectedConnectorId)
        }))
        set({ selectedConnectorId: null })
        return
      }
      if (selectedIds.length === 0) return
      const del = new Set(selectedIds)
      get().commitBoardChange((doc) => ({
        ...doc,
        items: doc.items
          .filter((it) => !del.has(it.id) || it.locked)
          .map((it) => (it.groupId && del.has(it.groupId) ? { ...it, groupId: null } : it)),
        connectors: doc.connectors.filter((c) => !del.has(c.fromId) && !del.has(c.toId))
      }))
      const remaining = new Set(get().activeBoard?.items.map((i) => i.id) ?? [])
      set({
        selectedIds: selectedIds.filter((id) => remaining.has(id)),
        editingItemId: null
      })
    },

    duplicateSelection: () => {
      const { activeBoard, selectedIds } = get()
      if (!activeBoard || selectedIds.length === 0) return
      const sel = new Set(selectedIds)
      const copies: MoodboardItem[] = []
      let z = nextZIndex(activeBoard.items)
      for (const it of activeBoard.items) {
        if (!sel.has(it.id)) continue
        copies.push({
          ...structuredClone(it),
          id: crypto.randomUUID(),
          x: it.x + 28,
          y: it.y + 28,
          zIndex: it.kind === 'group' ? it.zIndex : z++,
          locked: false
        })
      }
      if (copies.length === 0) return
      get().commitBoardChange((doc) => ({
        ...doc,
        items: [...doc.items, ...copies]
      }))
      set({ selectedIds: copies.map((c) => c.id), selectedConnectorId: null })
    },

    scheduleSave: () => {
      clearSaveTimer()
      saveTimer = setTimeout(() => {
        saveTimer = null
        void get().flushSave()
      }, SAVE_DEBOUNCE_MS)
    },

    flushSave: async () => {
      clearSaveTimer()
      const { activeBoard, dirty } = get()
      if (!activeBoard || !dirty) return
      const snapshot = activeBoard
      const res = await window.photoearth?.moodboards?.save(snapshot)
      if (res) {
        get().replaceSummary(res.summary)
        // Only clear dirty if no newer edits happened while IPC was in flight.
        if (get().activeBoard === snapshot) {
          set({ dirty: false })
        }
      }
    },

    flushSaveSync: () => {
      clearSaveTimer()
      const { activeBoard, dirty } = get()
      if (!activeBoard || !dirty) return
      window.photoearth?.moodboards?.flush(activeBoard)
      set({ dirty: false })
    },

    requestFocusSearch: () => set((s) => ({ focusSearchNonce: s.focusSearchNonce + 1 })),
    requestFitView: () => set((s) => ({ fitViewNonce: s.fitViewNonce + 1 })),
    requestResetZoom: () => set((s) => ({ resetZoomNonce: s.resetZoomNonce + 1 }))
  }))
)

export const moodboardState = (): MoodboardState => useMoodboardStore.getState()
