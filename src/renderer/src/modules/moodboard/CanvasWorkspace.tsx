import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatLatLon } from '@shared/coords'
import { photoUrl, thumbFile } from '@shared/locations'
import {
  computeSnapGuides,
  connectorBezier,
  fitViewportToBounds,
  itemsInsideGroup,
  MAX_BOARD_TITLE,
  MAX_CONNECTOR_LABEL,
  MIN_ITEM_HEIGHT,
  MIN_ITEM_WIDTH,
  MOODBOARD_NOTE_TINTS,
  rectsIntersect,
  visibleWorldRect,
  worldBoundsOfItems,
  zoomViewportAtPoint,
  type SnapGuide,
  type WorldRect
} from '@shared/moodboards'
import type {
  Bookmark,
  MoodboardConnector,
  MoodboardDocument,
  MoodboardGroupItem,
  MoodboardImageItem,
  MoodboardItem,
  MoodboardNoteTint
} from '@shared/types'
import { Icon } from '../../components/Icon'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import {
  addGroupFrameToActiveBoard,
  addImageFilesToActiveBoard,
  addLocationCardToActiveBoard,
  addNoteCardToActiveBoard,
  addPaletteCardToActiveBoard,
  closeMoodboard,
  exportActiveBoard,
  extractPaletteFromImageItems,
  linkMoodboardToProject,
  openGlobeSnapshot,
  pickImagesForActiveBoard,
  sendPaletteToProjectColorStory,
  unlinkMoodboardFromProject,
  updateMoodboardMeta
} from '../../lib/moodboards'
import { flyToProjectLocation } from '../../lib/projects'
import { shellState } from '../../shell/shellStore'
import { useAppStore } from '../../store/appStore'
import { moodboardState, useMoodboardStore } from '../../store/moodboardStore'
import { useProjectsStore } from '../../store/projectsStore'
import { BrowserDrawerSlot } from './BrowserDrawerSlot'
import { GroupCard } from './items/GroupCard'
import { ImageCard } from './items/ImageCard'
import { LocationCard } from './items/LocationCard'
import { NoteCard } from './items/NoteCard'
import { PaletteCard } from './items/PaletteCard'

type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se'

interface DragInteraction {
  kind: 'pan'
  startClientX: number
  startClientY: number
  startVpX: number
  startVpY: number
}

interface MoveInteraction {
  kind: 'move'
  startWorldX: number
  startWorldY: number
  moved: boolean
  initialPos: Map<string, { x: number; y: number }>
  movingIds: Set<string>
}

interface ResizeInteraction {
  kind: 'resize'
  itemId: string
  corner: ResizeCorner
  startWorldX: number
  startWorldY: number
  initial: WorldRect
  aspect: number
  isImage: boolean
  moved: boolean
}

interface MarqueeInteraction {
  kind: 'marquee'
  startScreenX: number
  startScreenY: number
  curScreenX: number
  curScreenY: number
  additive: boolean
}

interface ConnectInteraction {
  kind: 'connect'
  fromId: string
  curWorldX: number
  curWorldY: number
}

type ActiveInteraction =
  | DragInteraction
  | MoveInteraction
  | ResizeInteraction
  | MarqueeInteraction
  | ConnectInteraction

interface ContextMenuState {
  x: number
  y: number
  worldX: number
  worldY: number
  itemId: string | null
}

const TINT_SWATCH_COLORS: Record<MoodboardNoteTint, string> = {
  neutral: '#334155',
  amber: '#d97706',
  blue: '#2f9cf0',
  rose: '#e11d48',
  emerald: '#10b981',
  transparent: 'transparent'
}

export function CanvasWorkspace({
  board,
  modalOpen
}: {
  board: MoodboardDocument
  modalOpen: boolean
}) {
  const tool = useMoodboardStore((s) => s.tool)
  const selectedIds = useMoodboardStore((s) => s.selectedIds)
  const selectedConnectorId = useMoodboardStore((s) => s.selectedConnectorId)
  const editingItemId = useMoodboardStore((s) => s.editingItemId)
  const presentationMode = useMoodboardStore((s) => s.presentationMode)
  const browserDrawerOpen = useMoodboardStore((s) => s.browserDrawerOpen)
  const showGrid = useMoodboardStore((s) => s.showGrid)
  const snapToGuides = useMoodboardStore((s) => s.snapToGuides)
  const undoCount = useMoodboardStore((s) => s.undoStack.length)
  const redoCount = useMoodboardStore((s) => s.redoStack.length)
  const dirty = useMoodboardStore((s) => s.dirty)
  const fitViewNonce = useMoodboardStore((s) => s.fitViewNonce)
  const resetZoomNonce = useMoodboardStore((s) => s.resetZoomNonce)
  const set = useMoodboardStore((s) => s.set)
  const bookmarks = useAppStore((s) => s.bookmarks)
  const projects = useProjectsStore((s) => s.projects)

  const canvasRef = useRef<HTMLDivElement>(null)
  const [canvasSize, setCanvasSize] = useState({ width: 1200, height: 800 })
  const [spaceDown, setSpaceDown] = useState(false)
  const [dragFileOver, setDragFileOver] = useState(false)
  const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([])
  const [marquee, setMarquee] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
  const [connectPreview, setConnectPreview] = useState<{ fromId: string; toX: number; toY: number } | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [locationPickerPos, setLocationPickerPos] = useState<{ x: number; y: number } | null>(null)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const [titleDraft, setTitleDraft] = useState(board.title)
  const [editingTitle, setEditingTitle] = useState(false)
  const [connectorLabelDraft, setConnectorLabelDraft] = useState('')
  const interactionRef = useRef<ActiveInteraction | null>(null)

  const bookmarksById = useMemo(() => new Map(bookmarks.map((b) => [b.id, b])), [bookmarks])
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const itemsById = useMemo(() => new Map(board.items.map((i) => [i.id, i])), [board.items])

  useEffect(() => {
    setTitleDraft(board.title)
  }, [board.id, board.title])

  // Track canvas container dimensions for culling, fit-view, and grid rendering.
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const update = () => setCanvasSize({ width: el.clientWidth, height: el.clientHeight })
    update()
    const obs = new ResizeObserver(update)
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  // Track Spacebar hold for PureRef-style Space+Left-drag panning.
  useEffect(() => {
    const isInput = (t: EventTarget | null) => {
      const el = t as HTMLElement | null
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
    }
    const onDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isInput(e.target)) setSpaceDown(true)
    }
    const onUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceDown(false)
    }
    const onBlur = () => setSpaceDown(false)
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  // Clipboard paste (Ctrl+V): paste images or plain text as Note cards directly onto the board.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (modalOpen) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      const dt = e.clipboardData
      if (!dt) return
      const imageFiles: File[] = []
      for (const item of Array.from(dt.items)) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const f = item.getAsFile()
          if (f) imageFiles.push(f)
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault()
        void addImageFilesToActiveBoard(imageFiles)
        return
      }
      const plain = dt.getData('text/plain')?.trim()
      if (plain) {
        e.preventDefault()
        addNoteCardToActiveBoard(undefined, { body: plain })
        shellState().showToast('Pasted text as a note card')
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [modalOpen])

  // Close floating popovers on outside click.
  useEffect(() => {
    if (!contextMenu && !exportMenuOpen) return
    const close = () => {
      setContextMenu(null)
      setExportMenuOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [contextMenu, exportMenuOpen])

  const fitView = useCallback(() => {
    const st = moodboardState()
    const doc = st.activeBoard
    if (!doc) return
    const subset =
      st.selectedIds.length > 0 ? doc.items.filter((i) => st.selectedIds.includes(i.id)) : doc.items
    const bounds = worldBoundsOfItems(subset)
    const nextVp = fitViewportToBounds(bounds, canvasSize.width, canvasSize.height, 88)
    st.setViewport(nextVp)
  }, [canvasSize.width, canvasSize.height])

  const resetZoom = useCallback(() => {
    const doc = moodboardState().activeBoard
    if (!doc) return
    const nextVp = zoomViewportAtPoint(doc.viewport, canvasSize.width / 2, canvasSize.height / 2, 1)
    moodboardState().setViewport(nextVp)
  }, [canvasSize.width, canvasSize.height])

  useEffect(() => {
    if (fitViewNonce > 0) fitView()
  }, [fitViewNonce, fitView])

  useEffect(() => {
    if (resetZoomNonce > 0) resetZoom()
  }, [resetZoomNonce, resetZoom])

  // Sync selected connector label draft when selection changes.
  const selectedConnector = useMemo(
    () => (selectedConnectorId ? board.connectors.find((c) => c.id === selectedConnectorId) ?? null : null),
    [board.connectors, selectedConnectorId]
  )
  useEffect(() => {
    setConnectorLabelDraft(selectedConnector?.label ?? '')
  }, [selectedConnector?.id, selectedConnector?.label])

  const screenToWorld = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } => {
      const rect = canvasRef.current?.getBoundingClientRect()
      const sx = clientX - (rect?.left ?? 0)
      const sy = clientY - (rect?.top ?? 0)
      const vp = moodboardState().activeBoard?.viewport ?? board.viewport
      return {
        x: (sx - vp.x) / vp.zoom,
        y: (sy - vp.y) / vp.zoom
      }
    },
    [board.viewport]
  )

  // Wheel / trackpad pinch-zoom and two-finger pan.
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const vp = moodboardState().activeBoard?.viewport
    if (!vp) return
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top

    // Trackpad pinch emits ctrlKey=true on wheel; mouse wheel typically has deltaMode!==0 or discrete steps.
    const isZoom = e.ctrlKey || e.metaKey || (!e.shiftKey && Math.abs(e.deltaX) === 0 && (e.deltaMode !== 0 || Math.abs(e.deltaY) >= 40))
    if (isZoom) {
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.008 : 0.0018))
      moodboardState().setViewport(zoomViewportAtPoint(vp, sx, sy, vp.zoom * factor))
    } else {
      moodboardState().setViewport({
        x: vp.x - e.deltaX,
        y: vp.y - e.deltaY,
        zoom: vp.zoom
      })
    }
  }, [])

  // Collapsed groups hide their contained non-group items.
  const hiddenByCollapsedGroup = useMemo(() => {
    const hidden = new Set<string>()
    for (const item of board.items) {
      if (item.kind === 'group' && item.collapsed) {
        for (const id of itemsInsideGroup(item, board.items)) hidden.add(id)
      }
    }
    return hidden
  }, [board.items])

  const groupChildCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of board.items) {
      if (item.kind === 'group') {
        counts.set(item.id, itemsInsideGroup(item, board.items).length)
      }
    }
    return counts
  }, [board.items])

  // Viewport culling: render only items intersecting the visible world bounds (+ margin).
  const visibleItems = useMemo(() => {
    const viewRect = visibleWorldRect(board.viewport, canvasSize.width, canvasSize.height, 320)
    const groups: MoodboardGroupItem[] = []
    const cards: MoodboardItem[] = []
    for (const item of board.items) {
      if (hiddenByCollapsedGroup.has(item.id)) continue
      const effH = item.kind === 'group' && item.collapsed ? 42 : item.height
      if (!selectedSet.has(item.id) && !rectsIntersect(viewRect, { x: item.x, y: item.y, width: item.width, height: effH })) {
        continue
      }
      if (item.kind === 'group') groups.push(item)
      else cards.push(item)
    }
    groups.sort((a, b) => a.zIndex - b.zIndex)
    cards.sort((a, b) => a.zIndex - b.zIndex)
    return { groups, cards }
  }, [board.items, board.viewport, canvasSize.width, canvasSize.height, hiddenByCollapsedGroup, selectedSet])

  const startPan = (e: React.PointerEvent) => {
    const vp = moodboardState().activeBoard?.viewport ?? board.viewport
    interactionRef.current = {
      kind: 'pan',
      startClientX: e.clientX,
      startClientY: e.clientY,
      startVpX: vp.x,
      startVpY: vp.y
    }
    canvasRef.current?.setPointerCapture(e.pointerId)
  }

  const handleCanvasPointerDown = (e: React.PointerEvent) => {
    setContextMenu(null)
    setExportMenuOpen(false)
    if (e.button === 1 || (e.button === 0 && (spaceDown || tool === 'pan'))) {
      e.preventDefault()
      startPan(e)
      return
    }
    if (e.button !== 0) return

    const world = screenToWorld(e.clientX, e.clientY)
    if (tool === 'note') {
      addNoteCardToActiveBoard({ x: Math.round(world.x - 130), y: Math.round(world.y - 40) })
      set({ tool: 'select' })
      return
    }
    if (tool === 'group') {
      addGroupFrameToActiveBoard({ x: Math.round(world.x - 220), y: Math.round(world.y - 160) })
      set({ tool: 'select' })
      return
    }

    // Empty canvas drag starts marquee box select.
    if (!e.shiftKey) moodboardState().clearSelection()
    const rect = canvasRef.current?.getBoundingClientRect()
    const sx = e.clientX - (rect?.left ?? 0)
    const sy = e.clientY - (rect?.top ?? 0)
    interactionRef.current = {
      kind: 'marquee',
      startScreenX: sx,
      startScreenY: sy,
      curScreenX: sx,
      curScreenY: sy,
      additive: e.shiftKey
    }
    canvasRef.current?.setPointerCapture(e.pointerId)
  }

  const handleItemPointerDown = (e: React.PointerEvent, item: MoodboardItem) => {
    e.stopPropagation()
    setContextMenu(null)
    setExportMenuOpen(false)
    if (e.button === 1 || (e.button === 0 && (spaceDown || tool === 'pan'))) {
      startPan(e)
      return
    }
    if (e.button !== 0) return

    if (tool === 'connect') {
      const world = screenToWorld(e.clientX, e.clientY)
      interactionRef.current = {
        kind: 'connect',
        fromId: item.id,
        curWorldX: world.x,
        curWorldY: world.y
      }
      setConnectPreview({ fromId: item.id, toX: world.x, toY: world.y })
      canvasRef.current?.setPointerCapture(e.pointerId)
      return
    }

    const st = moodboardState()
    if (e.shiftKey) {
      st.toggleSelect(item.id)
    } else if (!st.selectedIds.includes(item.id)) {
      st.selectOnly(item.id)
    }
    if (st.editingItemId && st.editingItemId !== item.id) {
      st.set({ editingItemId: null })
    }

    if (item.locked) return

    // Gather all items that move together (selected items + children of any selected group).
    const activeIds = new Set(moodboardState().selectedIds)
    const doc = moodboardState().activeBoard
    if (!doc) return
    const movingIds = new Set<string>()
    for (const id of activeIds) {
      const target = doc.items.find((x) => x.id === id)
      if (!target || target.locked) continue
      movingIds.add(target.id)
      if (target.kind === 'group') {
        for (const childId of itemsInsideGroup(target, doc.items)) {
          const child = doc.items.find((x) => x.id === childId)
          if (child && !child.locked) movingIds.add(childId)
        }
      }
    }
    if (movingIds.size === 0) return

    const initialPos = new Map<string, { x: number; y: number }>()
    for (const id of movingIds) {
      const it = doc.items.find((x) => x.id === id)
      if (it) initialPos.set(id, { x: it.x, y: it.y })
    }
    const world = screenToWorld(e.clientX, e.clientY)
    interactionRef.current = {
      kind: 'move',
      startWorldX: world.x,
      startWorldY: world.y,
      moved: false,
      initialPos,
      movingIds
    }
    canvasRef.current?.setPointerCapture(e.pointerId)
  }

  const handleResizePointerDown = (e: React.PointerEvent, item: MoodboardItem, corner: ResizeCorner) => {
    e.stopPropagation()
    if (e.button !== 0 || item.locked) return
    const world = screenToWorld(e.clientX, e.clientY)
    interactionRef.current = {
      kind: 'resize',
      itemId: item.id,
      corner,
      startWorldX: world.x,
      startWorldY: world.y,
      initial: { x: item.x, y: item.y, width: item.width, height: item.height },
      aspect: item.width / Math.max(1, item.height),
      isImage: item.kind === 'image',
      moved: false
    }
    canvasRef.current?.setPointerCapture(e.pointerId)
  }

  const handleCanvasPointerMove = (e: React.PointerEvent) => {
    const inter = interactionRef.current
    if (!inter) return

    if (inter.kind === 'pan') {
      const vp = moodboardState().activeBoard?.viewport
      if (!vp) return
      moodboardState().setViewport({
        x: inter.startVpX + (e.clientX - inter.startClientX),
        y: inter.startVpY + (e.clientY - inter.startClientY),
        zoom: vp.zoom
      })
      return
    }

    if (inter.kind === 'marquee') {
      const rect = canvasRef.current?.getBoundingClientRect()
      if (!rect) return
      inter.curScreenX = e.clientX - rect.left
      inter.curScreenY = e.clientY - rect.top
      const x = Math.min(inter.startScreenX, inter.curScreenX)
      const y = Math.min(inter.startScreenY, inter.curScreenY)
      const width = Math.abs(inter.curScreenX - inter.startScreenX)
      const height = Math.abs(inter.curScreenY - inter.startScreenY)
      setMarquee({ x, y, width, height })
      return
    }

    if (inter.kind === 'connect') {
      const world = screenToWorld(e.clientX, e.clientY)
      inter.curWorldX = world.x
      inter.curWorldY = world.y
      setConnectPreview({ fromId: inter.fromId, toX: world.x, toY: world.y })
      return
    }

    if (inter.kind === 'move') {
      const doc = moodboardState().activeBoard
      if (!doc) return
      const world = screenToWorld(e.clientX, e.clientY)
      let dx = world.x - inter.startWorldX
      let dy = world.y - inter.startWorldY
      if (!inter.moved && Math.hypot(dx, dy) < 2) return
      if (!inter.moved) {
        inter.moved = true
        moodboardState().pushUndoSnapshot()
      }

      // Snap guides against non-moving items unless Alt is held.
      if (snapToGuides && !e.altKey) {
        const movingRects: WorldRect[] = []
        const otherRects: WorldRect[] = []
        for (const it of doc.items) {
          if (inter.movingIds.has(it.id)) {
            const init = inter.initialPos.get(it.id)
            if (init) movingRects.push({ x: init.x + dx, y: init.y + dy, width: it.width, height: it.height })
          } else if (!hiddenByCollapsedGroup.has(it.id)) {
            otherRects.push({ x: it.x, y: it.y, width: it.width, height: it.height })
          }
        }
        const union = worldBoundsOfItems(movingRects)
        if (union && otherRects.length > 0) {
          const snap = computeSnapGuides(union, otherRects, 8 / doc.viewport.zoom)
          dx += snap.dx
          dy += snap.dy
          setSnapGuides(snap.guides)
        } else {
          setSnapGuides([])
        }
      } else {
        setSnapGuides([])
      }

      moodboardState().commitBoardChange(
        (cur) => ({
          ...cur,
          items: cur.items.map((it) => {
            const init = inter.initialPos.get(it.id)
            if (!init) return it
            return { ...it, x: Math.round(init.x + dx), y: Math.round(init.y + dy) }
          })
        }),
        { recordHistory: false, scheduleSave: false }
      )
      return
    }

    if (inter.kind === 'resize') {
      const world = screenToWorld(e.clientX, e.clientY)
      const dx = world.x - inter.startWorldX
      const dy = world.y - inter.startWorldY
      if (!inter.moved && Math.hypot(dx, dy) < 2) return
      if (!inter.moved) {
        inter.moved = true
        moodboardState().pushUndoSnapshot()
      }

      const init = inter.initial
      let { x, y, width, height } = init
      const lockAspect = inter.isImage ? !e.shiftKey : e.shiftKey

      if (inter.corner === 'se') {
        width = Math.max(MIN_ITEM_WIDTH, init.width + dx)
        height = lockAspect ? Math.max(MIN_ITEM_HEIGHT, width / inter.aspect) : Math.max(MIN_ITEM_HEIGHT, init.height + dy)
      } else if (inter.corner === 'sw') {
        width = Math.max(MIN_ITEM_WIDTH, init.width - dx)
        height = lockAspect ? Math.max(MIN_ITEM_HEIGHT, width / inter.aspect) : Math.max(MIN_ITEM_HEIGHT, init.height + dy)
        x = init.x + (init.width - width)
      } else if (inter.corner === 'ne') {
        width = Math.max(MIN_ITEM_WIDTH, init.width + dx)
        height = lockAspect ? Math.max(MIN_ITEM_HEIGHT, width / inter.aspect) : Math.max(MIN_ITEM_HEIGHT, init.height - dy)
        y = init.y + (init.height - height)
      } else {
        width = Math.max(MIN_ITEM_WIDTH, init.width - dx)
        height = lockAspect ? Math.max(MIN_ITEM_HEIGHT, width / inter.aspect) : Math.max(MIN_ITEM_HEIGHT, init.height - dy)
        x = init.x + (init.width - width)
        y = init.y + (init.height - height)
      }

      moodboardState().commitBoardChange(
        (cur) => ({
          ...cur,
          items: cur.items.map((it) =>
            it.id === inter.itemId
              ? { ...it, x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
              : it
          )
        }),
        { recordHistory: false, scheduleSave: false }
      )
    }
  }

  const handleCanvasPointerUp = (e: React.PointerEvent) => {
    const inter = interactionRef.current
    if (!inter) return
    interactionRef.current = null
    setSnapGuides([])

    if (inter.kind === 'marquee') {
      setMarquee(null)
      const doc = moodboardState().activeBoard
      if (doc) {
        const minSx = Math.min(inter.startScreenX, inter.curScreenX)
        const minSy = Math.min(inter.startScreenY, inter.curScreenY)
        const maxSx = Math.max(inter.startScreenX, inter.curScreenX)
        const maxSy = Math.max(inter.startScreenY, inter.curScreenY)
        if (maxSx - minSx > 4 || maxSy - minSy > 4) {
          const vp = doc.viewport
          const box: WorldRect = {
            x: (minSx - vp.x) / vp.zoom,
            y: (minSy - vp.y) / vp.zoom,
            width: (maxSx - minSx) / vp.zoom,
            height: (maxSy - minSy) / vp.zoom
          }
          const hitIds = doc.items
            .filter((it) => !hiddenByCollapsedGroup.has(it.id) && rectsIntersect(box, it))
            .map((it) => it.id)
          if (inter.additive) {
            const merged = Array.from(new Set([...moodboardState().selectedIds, ...hitIds]))
            moodboardState().selectMany(merged)
          } else {
            moodboardState().selectMany(hitIds)
          }
        }
      }
      return
    }

    if (inter.kind === 'connect') {
      setConnectPreview(null)
      const doc = moodboardState().activeBoard
      if (doc) {
        const world = screenToWorld(e.clientX, e.clientY)
        // Find topmost item under cursor excluding source item.
        const target = [...doc.items]
          .filter((it) => it.id !== inter.fromId && !hiddenByCollapsedGroup.has(it.id))
          .sort((a, b) => b.zIndex - a.zIndex)
          .find(
            (it) =>
              world.x >= it.x && world.x <= it.x + it.width && world.y >= it.y && world.y <= it.y + it.height
          )
        if (target) {
          const exists = doc.connectors.some(
            (c) => (c.fromId === inter.fromId && c.toId === target.id) || (c.fromId === target.id && c.toId === inter.fromId)
          )
          if (!exists) {
            const conn: MoodboardConnector = {
              id: crypto.randomUUID(),
              fromId: inter.fromId,
              toId: target.id,
              label: '',
              directed: true
            }
            moodboardState().commitBoardChange((cur) => ({
              ...cur,
              connectors: [...cur.connectors, conn]
            }))
            set({ selectedConnectorId: conn.id, selectedIds: [], tool: 'select' })
          }
        }
      }
      return
    }

    if ((inter.kind === 'move' || inter.kind === 'resize') && inter.moved) {
      moodboardState().scheduleSave()
    }
  }

  const handleContextMenu = (e: React.MouseEvent, itemId: string | null = null) => {
    e.preventDefault()
    e.stopPropagation()
    const world = screenToWorld(e.clientX, e.clientY)
    if (itemId && !moodboardState().selectedIds.includes(itemId)) {
      moodboardState().selectOnly(itemId)
    }
    setContextMenu({ x: e.clientX, y: e.clientY, worldX: Math.round(world.x), worldY: Math.round(world.y), itemId })
  }

  const selectedItems = useMemo(
    () => board.items.filter((i) => selectedSet.has(i.id)),
    [board.items, selectedSet]
  )
  const selectedImages = useMemo(
    () => selectedItems.filter((i): i is MoodboardImageItem => i.kind === 'image'),
    [selectedItems]
  )

  const setSelectedTint = (tint: MoodboardNoteTint) => {
    moodboardState().commitBoardChange((doc) => ({
      ...doc,
      items: doc.items.map((it) =>
        selectedSet.has(it.id) && (it.kind === 'note' || it.kind === 'group') ? { ...it, tint } : it
      )
    }))
  }

  const commitTitle = () => {
    setEditingTitle(false)
    const clean = titleDraft.trim().slice(0, MAX_BOARD_TITLE) || 'Untitled Moodboard'
    if (clean !== board.title) {
      void updateMoodboardMeta(board.id, { title: clean })
    }
  }

  const handleProjectLinkChange = async (nextProjectId: string) => {
    const prevId = board.projectId
    const nextId = nextProjectId || null
    if (prevId === nextId) return
    if (prevId) await unlinkMoodboardFromProject(prevId, board.id)
    if (nextId) await linkMoodboardToProject(nextId, board.id)
    await updateMoodboardMeta(board.id, { projectId: nextId })
  }

  const gridSize = Math.max(12, 28 * board.viewport.zoom)
  const gridBgStyle = showGrid
    ? {
        backgroundSize: `${gridSize}px ${gridSize}px`,
        backgroundPosition: `${board.viewport.x}px ${board.viewport.y}px`
      }
    : undefined

  const cursorClass =
    spaceDown || tool === 'pan'
      ? 'cursor-grab'
      : tool === 'note' || tool === 'group' || tool === 'connect'
        ? 'cursor-crosshair'
        : ''

  const overlayCoversBrowser = modalOpen || presentationMode || !!locationPickerPos

  return (
    <div className={`mb-workspace ${presentationMode ? 'presentation' : ''}`}>
      {/* Top Canvas Chrome Bar */}
      {!presentationMode && (
        <header className="mb-topbar">
          <button
            type="button"
            className="proj-back-btn"
            title="Back to Moodboards"
            onClick={() => void closeMoodboard()}
          >
            <Icon name="arrowLeft" size={14} />
            <span>Boards</span>
          </button>

          <span className="mb-topbar-sep" />

          {editingTitle ? (
            <input
              autoFocus
              className="mb-topbar-title-input"
              maxLength={MAX_BOARD_TITLE}
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitTitle()
                else if (e.key === 'Escape') {
                  setTitleDraft(board.title)
                  setEditingTitle(false)
                }
              }}
            />
          ) : (
            <button
              type="button"
              className="mb-topbar-title"
              title="Click to rename moodboard"
              onClick={() => setEditingTitle(true)}
            >
              {board.title}
            </button>
          )}

          {projects.length > 0 && (
            <label className="mb-project-link-pill" title="Link moodboard to a Project">
              <Icon name="projects" size={12} />
              <select
                aria-label="Linked project"
                value={board.projectId ?? ''}
                onChange={(e) => void handleProjectLinkChange(e.target.value)}
              >
                <option value="">No project</option>
                {projects
                  .filter((p) => p.status !== 'archived' || p.id === board.projectId)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title}
                    </option>
                  ))}
              </select>
            </label>
          )}

          <span className="small faint" style={{ marginLeft: 4 }}>
            {dirty ? 'Saving…' : 'Saved'}
          </span>

          <span className="spacer" />

          <div className="mb-topbar-group">
            <button
              type="button"
              className="icon-btn small"
              title="Undo (Ctrl+Z)"
              aria-label="Undo"
              disabled={undoCount === 0}
              onClick={() => moodboardState().undo()}
            >
              <Icon name="undo" size={14} />
            </button>
            <button
              type="button"
              className="icon-btn small"
              title="Redo (Ctrl+Shift+Z)"
              aria-label="Redo"
              disabled={redoCount === 0}
              onClick={() => moodboardState().redo()}
            >
              <Icon name="redo" size={14} />
            </button>
          </div>

          <span className="mb-topbar-sep" />

          <div className="mb-topbar-group">
            <button
              type="button"
              className="btn ghost small mono"
              title="Reset zoom to 100% (0)"
              onClick={resetZoom}
            >
              {Math.round(board.viewport.zoom * 100)}%
            </button>
            <button
              type="button"
              className="icon-btn small"
              title="Fit view to selection or board (F)"
              aria-label="Fit view"
              onClick={fitView}
            >
              <Icon name="fit" size={14} />
            </button>
            <button
              type="button"
              className={`icon-btn small ${showGrid ? 'active' : ''}`}
              title="Toggle dot grid"
              aria-label="Toggle dot grid"
              onClick={() => set({ showGrid: !showGrid })}
            >
              <Icon name="grid" size={14} />
            </button>
          </div>

          <span className="mb-topbar-sep" />

          <div className="mb-export-wrap" onPointerDown={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="btn ghost small"
              title="Export board as PNG or JPEG"
              onClick={() => setExportMenuOpen((v) => !v)}
            >
              <Icon name="download" size={13} />
              <span>Export</span>
            </button>
            {exportMenuOpen && (
              <div className="panel mb-dropdown-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setExportMenuOpen(false)
                    void exportActiveBoard('png', false)
                  }}
                >
                  Export entire board as PNG…
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setExportMenuOpen(false)
                    void exportActiveBoard('jpg', false)
                  }}
                >
                  Export entire board as JPEG…
                </button>
                {selectedIds.length > 0 && (
                  <>
                    <div className="mb-menu-sep" />
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setExportMenuOpen(false)
                        void exportActiveBoard('png', true)
                      }}
                    >
                      Export selection ({selectedIds.length}) as PNG…
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          <button
            type="button"
            className="icon-btn small"
            title="Presentation Mode (Tab)"
            aria-label="Presentation mode"
            onClick={() => set({ presentationMode: true })}
          >
            <Icon name="present" size={15} />
          </button>

          <button
            type="button"
            className={`btn small ${browserDrawerOpen ? 'active-pill' : ''}`}
            title="Toggle Inspiration Browser (B)"
            onClick={() => set({ browserDrawerOpen: !browserDrawerOpen })}
          >
            <Icon name="browser" size={14} />
            <span>Inspiration</span>
          </button>
        </header>
      )}

      {/* Split Workspace: Infinite Canvas + Docked Inspiration Browser */}
      <div className="mb-main-split">
        <div
          ref={canvasRef}
          className={`mb-canvas-viewport ${showGrid ? 'with-grid' : ''} ${cursorClass} ${dragFileOver ? 'drop-active' : ''}`}
          style={gridBgStyle}
          onWheel={handleWheel}
          onPointerDown={handleCanvasPointerDown}
          onPointerMove={handleCanvasPointerMove}
          onPointerUp={handleCanvasPointerUp}
          onContextMenu={(e) => handleContextMenu(e, null)}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes('Files')) return
            e.preventDefault()
            setDragFileOver(true)
          }}
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node)) return
            setDragFileOver(false)
          }}
          onDrop={(e) => {
            e.preventDefault()
            setDragFileOver(false)
            const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|avif)$/i.test(f.name))
            if (files.length > 0) {
              const pt = screenToWorld(e.clientX, e.clientY)
              void addImageFilesToActiveBoard(files, pt)
            }
          }}
        >
          {/* GPU-Composited Transform World Layer */}
          <div
            className="mb-world-layer"
            style={{
              transform: `translate3d(${board.viewport.x}px, ${board.viewport.y}px, 0) scale(${board.viewport.zoom})`
            }}
          >
            {/* 1. Group / Section Frames */}
            {visibleItems.groups.map((group) => (
              <CanvasItemFrame
                key={group.id}
                item={group}
                selected={selectedSet.has(group.id)}
                zoom={board.viewport.zoom}
                collapsedHeight={group.collapsed ? 42 : undefined}
                onPointerDown={(e) => handleItemPointerDown(e, group)}
                onContextMenu={(e) => handleContextMenu(e, group.id)}
                onResizeStart={(e, corner) => handleResizePointerDown(e, group, corner)}
              >
                <GroupCard
                  item={group}
                  containedCount={groupChildCounts.get(group.id) ?? 0}
                  editing={editingItemId === group.id}
                  onStopEdit={() => set({ editingItemId: null })}
                />
              </CanvasItemFrame>
            ))}

            {/* 2. SVG World Layer for Connectors & Alignment Snap Guides */}
            <svg className="mb-svg-world" aria-hidden="true">
              <defs>
                <marker id="mb-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="currentColor" />
                </marker>
              </defs>

              {board.connectors.map((conn) => {
                const from = itemsById.get(conn.fromId)
                const to = itemsById.get(conn.toId)
                if (!from || !to) return null
                if (hiddenByCollapsedGroup.has(from.id) || hiddenByCollapsedGroup.has(to.id)) return null
                const c = connectorBezier(from, to)
                const isSel = selectedConnectorId === conn.id
                const d = `M ${c.x1} ${c.y1} C ${c.cx1} ${c.cy1}, ${c.cx2} ${c.cy2}, ${c.x2} ${c.y2}`
                return (
                  <g
                    key={conn.id}
                    className={`mb-connector ${isSel ? 'selected' : ''}`}
                    onPointerDown={(e) => {
                      e.stopPropagation()
                      set({ selectedConnectorId: conn.id, selectedIds: [] })
                    }}
                  >
                    <path className="mb-connector-hit" d={d} />
                    <path
                      className="mb-connector-path"
                      d={d}
                      markerEnd={conn.directed ? 'url(#mb-arrow)' : undefined}
                    />
                  </g>
                )
              })}

              {connectPreview && (() => {
                const from = itemsById.get(connectPreview.fromId)
                if (!from) return null
                const c = connectorBezier(from, { x: connectPreview.toX, y: connectPreview.toY, width: 1, height: 1 })
                const d = `M ${c.x1} ${c.y1} C ${c.cx1} ${c.cy1}, ${c.cx2} ${c.cy2}, ${c.x2} ${c.y2}`
                return <path className="mb-connector-preview" d={d} markerEnd="url(#mb-arrow)" />
              })()}

              {snapGuides.map((g, idx) => (
                <line
                  key={idx}
                  className="mb-snap-guide"
                  x1={g.axis === 'x' ? g.position : g.start}
                  y1={g.axis === 'y' ? g.position : g.start}
                  x2={g.axis === 'x' ? g.position : g.end}
                  y2={g.axis === 'y' ? g.position : g.end}
                  strokeWidth={1 / board.viewport.zoom}
                />
              ))}
            </svg>

            {/* Connector Labels (HTML pills positioned at bezier midpoints) */}
            {board.connectors.map((conn) => {
              if (!conn.label && selectedConnectorId !== conn.id) return null
              const from = itemsById.get(conn.fromId)
              const to = itemsById.get(conn.toId)
              if (!from || !to) return null
              if (hiddenByCollapsedGroup.has(from.id) || hiddenByCollapsedGroup.has(to.id)) return null
              const c = connectorBezier(from, to)
              const isSel = selectedConnectorId === conn.id
              return (
                <div
                  key={`lbl-${conn.id}`}
                  className={`mb-connector-label ${isSel ? 'selected' : ''}`}
                  style={{ left: c.midX, top: c.midY }}
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    set({ selectedConnectorId: conn.id, selectedIds: [] })
                  }}
                >
                  {isSel ? (
                    <input
                      className="mb-connector-label-input"
                      maxLength={MAX_CONNECTOR_LABEL}
                      placeholder="Label…"
                      value={connectorLabelDraft}
                      onChange={(e) => {
                        setConnectorLabelDraft(e.target.value)
                        moodboardState().commitBoardChange((doc) => ({
                          ...doc,
                          connectors: doc.connectors.map((x) =>
                            x.id === conn.id ? { ...x, label: e.target.value.slice(0, MAX_CONNECTOR_LABEL) } : x
                          )
                        }))
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur()
                      }}
                    />
                  ) : (
                    <span>{conn.label}</span>
                  )}
                </div>
              )
            })}

            {/* 3. Foreground Cards (Image, Palette, Note, Location) */}
            {visibleItems.cards.map((item) => (
              <CanvasItemFrame
                key={item.id}
                item={item}
                selected={selectedSet.has(item.id)}
                zoom={board.viewport.zoom}
                onPointerDown={(e) => handleItemPointerDown(e, item)}
                onContextMenu={(e) => handleContextMenu(e, item.id)}
                onResizeStart={(e, corner) => handleResizePointerDown(e, item, corner)}
              >
                {item.kind === 'image' && (
                  <ImageCard
                    item={item}
                    zoom={board.viewport.zoom}
                    selected={selectedSet.has(item.id)}
                    editing={editingItemId === item.id}
                    onStopEdit={() => set({ editingItemId: null })}
                  />
                )}
                {item.kind === 'palette' && (
                  <PaletteCard
                    item={item}
                    selected={selectedSet.has(item.id)}
                    editing={editingItemId === item.id}
                    onStopEdit={() => set({ editingItemId: null })}
                  />
                )}
                {item.kind === 'note' && (
                  <NoteCard
                    item={item}
                    editing={editingItemId === item.id}
                    onStopEdit={() => set({ editingItemId: null })}
                  />
                )}
                {item.kind === 'location' && (
                  <LocationCard bookmark={bookmarksById.get(item.locationId)} />
                )}
              </CanvasItemFrame>
            ))}
          </div>

          {/* Empty Canvas Onboarding Hint */}
          {board.items.length === 0 && !presentationMode && (
            <div className="mb-canvas-empty-hint" aria-hidden="true">
              <div className="mb-canvas-empty-card">
                <Icon name="moodboard" size={24} style={{ color: 'var(--accent)', opacity: 0.8 }} />
                <div>
                  <strong>Drop images anywhere, paste (Ctrl+V), or open Inspiration Browser (B)</strong>
                  <div className="small muted">
                    Space + Drag to pan · Scroll to zoom · T for Note · G for Group · Tab for Presentation Mode
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Marquee Box Select Rectangle */}
          {marquee && (
            <div
              className="mb-marquee"
              style={{
                left: marquee.x,
                top: marquee.y,
                width: marquee.width,
                height: marquee.height
              }}
            />
          )}

          {/* Drop Overlay */}
          {dragFileOver && (
            <div className="mb-drop-overlay">
              <div className="mb-drop-pill">
                <Icon name="image" size={18} />
                <span>Drop images onto canvas</span>
              </div>
            </div>
          )}

          {/* Contextual Selection Inspector Bar */}
          {!presentationMode && (selectedItems.length > 0 || selectedConnector) && (
            <div className="panel mb-selection-bar" onPointerDown={(e) => e.stopPropagation()}>
              {selectedConnector ? (
                <>
                  <span className="small muted">Connector</span>
                  <button
                    type="button"
                    className={`btn ghost small ${selectedConnector.directed ? 'active-pill' : ''}`}
                    onClick={() =>
                      moodboardState().commitBoardChange((doc) => ({
                        ...doc,
                        connectors: doc.connectors.map((c) =>
                          c.id === selectedConnector.id ? { ...c, directed: !c.directed } : c
                        )
                      }))
                    }
                  >
                    {selectedConnector.directed ? 'Directed arrow' : 'Undirected line'}
                  </button>
                  <button
                    type="button"
                    className="icon-btn small danger"
                    title="Delete connector (Del)"
                    onClick={() => moodboardState().deleteSelection()}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </>
              ) : (
                <>
                  <span className="small muted">
                    {selectedItems.length === 1 ? selectedItems[0].kind : `${selectedItems.length} selected`}
                  </span>

                  {selectedImages.length > 0 && (
                    <button
                      type="button"
                      className="btn ghost small"
                      title="Extract dominant color palette locally"
                      onClick={() => void extractPaletteFromImageItems(selectedImages)}
                    >
                      <Icon name="palette" size={13} />
                      <span>Extract Palette</span>
                    </button>
                  )}

                  {selectedItems.some((i) => i.kind === 'note' || i.kind === 'group') && (
                    <div className="mb-tint-row" role="group" aria-label="Card tint">
                      {MOODBOARD_NOTE_TINTS.map((tint) => (
                        <button
                          key={tint}
                          type="button"
                          className={`mb-tint-dot tint-${tint}`}
                          style={{ background: TINT_SWATCH_COLORS[tint] }}
                          title={`Tint: ${tint}`}
                          onClick={() => setSelectedTint(tint)}
                        />
                      ))}
                    </div>
                  )}

                  {selectedItems.length === 1 && selectedItems[0].kind === 'note' && (
                    <button
                      type="button"
                      className={`btn ghost small ${selectedItems[0].isHeading ? 'active-pill' : ''}`}
                      onClick={() => {
                        const target = selectedItems[0]
                        if (target.kind !== 'note') return
                        moodboardState().commitBoardChange((doc) => ({
                          ...doc,
                          items: doc.items.map((it) =>
                            it.id === target.id && it.kind === 'note'
                              ? { ...it, isHeading: !it.isHeading, tint: !it.isHeading ? 'transparent' : 'neutral' }
                              : it
                          )
                        }))
                      }}
                    >
                      Heading
                    </button>
                  )}

                  <span className="mb-topbar-sep" />

                  <button
                    type="button"
                    className="icon-btn small"
                    title="Bring to front (])"
                    onClick={() => moodboardState().bringToFront()}
                  >
                    <Icon name="bringFront" size={13} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn small"
                    title="Send to back ([)"
                    onClick={() => moodboardState().sendToBack()}
                  >
                    <Icon name="sendBack" size={13} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn small"
                    title="Duplicate (Ctrl+D)"
                    onClick={() => moodboardState().duplicateSelection()}
                  >
                    <Icon name="copy" size={13} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn small"
                    title="Lock / Unlock"
                    onClick={() => moodboardState().toggleLockSelection()}
                  >
                    <Icon name={selectedItems.every((i) => i.locked) ? 'lock' : 'unlock'} size={13} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn small danger"
                    title="Delete (Del)"
                    onClick={() => moodboardState().deleteSelection()}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </>
              )}
            </div>
          )}

          {/* Floating Bottom Keyboard-First Toolbar */}
          {!presentationMode && (
            <div className="panel mb-bottom-toolbar" role="toolbar" aria-label="Canvas tools" onPointerDown={(e) => e.stopPropagation()}>
              <ToolBtn icon="cursor" label="Select" kbd="V" active={tool === 'select'} onClick={() => set({ tool: 'select' })} />
              <ToolBtn icon="hand" label="Pan (or Space+Drag)" active={tool === 'pan'} onClick={() => set({ tool: 'pan' })} />
              <span className="mb-toolbar-sep" />
              <ToolBtn icon="image" label="Add Image" kbd="I" onClick={() => void pickImagesForActiveBoard()} />
              <ToolBtn icon="note" label="Note" kbd="T" active={tool === 'note'} onClick={() => set({ tool: tool === 'note' ? 'select' : 'note' })} />
              <ToolBtn icon="group" label="Group Frame" kbd="G" active={tool === 'group'} onClick={() => set({ tool: tool === 'group' ? 'select' : 'group' })} />
              <ToolBtn icon="connector" label="Connector" kbd="C" active={tool === 'connect'} onClick={() => set({ tool: tool === 'connect' ? 'select' : 'connect' })} />
              <ToolBtn
                icon="palette"
                label="Add Color Palette"
                onClick={() => addPaletteCardToActiveBoard(['#101828', '#23395d', '#4fb3ff', '#f2b866', '#e8dfd1'])}
              />
              <ToolBtn
                icon="pin"
                label="Add Saved Location Card"
                onClick={() => {
                  const pt = screenToWorld(canvasSize.width / 2, canvasSize.height / 2)
                  setLocationPickerPos(pt)
                }}
              />
              <span className="mb-toolbar-sep" />
              <ToolBtn icon="fit" label="Fit View" kbd="F" onClick={fitView} />
              <ToolBtn
                icon="browser"
                label="Inspiration Browser"
                kbd="B"
                active={browserDrawerOpen}
                onClick={() => set({ browserDrawerOpen: !browserDrawerOpen })}
              />
            </div>
          )}

          {/* Presentation Mode Exit Pill */}
          {presentationMode && (
            <button
              type="button"
              className="panel mb-present-exit"
              onClick={() => set({ presentationMode: false })}
            >
              Exit Presentation Mode <span className="kbd">Tab</span>
            </button>
          )}
        </div>

        {/* Docked Inspiration Browser Pane */}
        <BrowserDrawerSlot hiddenByOverlay={overlayCoversBrowser} />
      </div>

      {/* Right-Click Context Menu */}
      {contextMenu && (
        <CanvasContextMenu
          menu={contextMenu}
          item={contextMenu.itemId ? itemsById.get(contextMenu.itemId) ?? null : null}
          bookmarksById={bookmarksById}
          onClose={() => setContextMenu(null)}
          onAddLocation={() => {
            setLocationPickerPos({ x: contextMenu.worldX, y: contextMenu.worldY })
            setContextMenu(null)
          }}
          onFitView={() => {
            fitView()
            setContextMenu(null)
          }}
        />
      )}

      {/* Location Reference Card Picker Dialog */}
      {locationPickerPos && (
        <AddLocationCardDialog
          bookmarks={bookmarks}
          onSelect={(locId) => {
            addLocationCardToActiveBoard(locId, locationPickerPos)
            setLocationPickerPos(null)
          }}
          onClose={() => setLocationPickerPos(null)}
        />
      )}
    </div>
  )
}

function ToolBtn({
  icon,
  label,
  kbd,
  active,
  onClick
}: {
  icon: React.ComponentProps<typeof Icon>['name']
  label: string
  kbd?: string
  active?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={`mb-tool-btn ${active ? 'active' : ''}`}
      title={kbd ? `${label} (${kbd})` : label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
    >
      <Icon name={icon} size={16} />
      {kbd && <span className="mb-tool-kbd">{kbd}</span>}
    </button>
  )
}

function CanvasItemFrame({
  item,
  selected,
  zoom,
  collapsedHeight,
  onPointerDown,
  onContextMenu,
  onResizeStart,
  children
}: {
  item: MoodboardItem
  selected: boolean
  zoom: number
  collapsedHeight?: number
  onPointerDown: (e: React.PointerEvent) => void
  onContextMenu: (e: React.MouseEvent) => void
  onResizeStart: (e: React.PointerEvent, corner: ResizeCorner) => void
  children: React.ReactNode
}) {
  const h = collapsedHeight ?? item.height
  const handleScale = Math.max(0.65, Math.min(2.2, 1 / zoom))
  return (
    <div
      className={`mb-item-frame kind-${item.kind} ${selected ? 'selected' : ''} ${item.locked ? 'locked' : ''}`}
      style={{
        left: item.x,
        top: item.y,
        width: item.width,
        height: h,
        zIndex: item.kind === 'group' ? 0 : item.zIndex + 10
      }}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
    >
      {children}
      {item.locked && (
        <span className="mb-lock-indicator" title="Locked">
          <Icon name="lock" size={10} />
        </span>
      )}
      {selected && !item.locked && !collapsedHeight && (
        <>
          {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
            <div
              key={corner}
              className={`mb-resize-handle ${corner}`}
              style={{ transform: `scale(${handleScale})` }}
              onPointerDown={(e) => onResizeStart(e, corner)}
            />
          ))}
        </>
      )}
    </div>
  )
}

function CanvasContextMenu({
  menu,
  item,
  bookmarksById,
  onClose,
  onAddLocation,
  onFitView
}: {
  menu: ContextMenuState
  item: MoodboardItem | null
  bookmarksById: ReadonlyMap<string, Bookmark>
  onClose: () => void
  onAddLocation: () => void
  onFitView: () => void
}) {
  const left = Math.min(menu.x, window.innerWidth - 220)
  const top = Math.min(menu.y, window.innerHeight - 300)

  return (
    <div
      className="panel mb-context-menu"
      style={{ left, top }}
      role="menu"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {item ? (
        <>
          {item.kind === 'image' && (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onClose()
                  void extractPaletteFromImageItems([item])
                }}
              >
                <Icon name="palette" size={13} /> Extract Color Palette
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onClose()
                  moodboardState().commitBoardChange((doc) => ({
                    ...doc,
                    items: doc.items.map((it) =>
                      it.id === item.id && it.kind === 'image' ? { ...it, borderless: !it.borderless } : it
                    )
                  }))
                }}
              >
                <Icon name="fit" size={13} /> {item.borderless ? 'Show Frame & Caption' : 'Borderless Mode'}
              </button>
              {!item.borderless && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onClose()
                    moodboardState().set({ editingItemId: item.id })
                  }}
                >
                  <Icon name="edit" size={13} /> Edit Caption
                </button>
              )}
              {item.globe && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onClose()
                    void openGlobeSnapshot(item.globe!)
                  }}
                >
                  <Icon name="globe" size={13} /> Open in 3D Globe
                </button>
              )}
              {item.sourceUrl && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onClose()
                    void window.photoearth.openExternal(item.sourceUrl!)
                  }}
                >
                  <Icon name="external" size={13} /> Open Original Source
                </button>
              )}
              <div className="mb-menu-sep" />
            </>
          )}
          {item.kind === 'palette' && (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onClose()
                  void sendPaletteToProjectColorStory(item.colors)
                }}
              >
                <Icon name="projects" size={13} /> Send to Project Color Story
              </button>
              <div className="mb-menu-sep" />
            </>
          )}
          {item.kind === 'location' && bookmarksById.has(item.locationId) && (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onClose()
                  const bm = bookmarksById.get(item.locationId)
                  if (bm) void flyToProjectLocation(bm)
                }}
              >
                <Icon name="globe" size={13} /> Open in 3D Globe
              </button>
              <div className="mb-menu-sep" />
            </>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              moodboardState().bringToFront([item.id])
              onClose()
            }}
          >
            <Icon name="bringFront" size={13} /> Bring to Front <span className="kbd">]</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              moodboardState().sendToBack([item.id])
              onClose()
            }}
          >
            <Icon name="sendBack" size={13} /> Send to Back <span className="kbd">[</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              moodboardState().duplicateSelection()
              onClose()
            }}
          >
            <Icon name="copy" size={13} /> Duplicate
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              moodboardState().toggleLockSelection([item.id])
              onClose()
            }}
          >
            <Icon name={item.locked ? 'unlock' : 'lock'} size={13} /> {item.locked ? 'Unlock' : 'Lock'}
          </button>
          <div className="mb-menu-sep" />
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() => {
              moodboardState().deleteSelection()
              onClose()
            }}
          >
            <Icon name="trash" size={13} /> Delete
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onClose()
              void pickImagesForActiveBoard({ x: menu.worldX, y: menu.worldY })
            }}
          >
            <Icon name="image" size={13} /> Add Image…
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              addNoteCardToActiveBoard({ x: menu.worldX, y: menu.worldY })
              onClose()
            }}
          >
            <Icon name="note" size={13} /> Add Note
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              addNoteCardToActiveBoard({ x: menu.worldX, y: menu.worldY }, { isHeading: true })
              onClose()
            }}
          >
            <Icon name="edit" size={13} /> Add Heading
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              addGroupFrameToActiveBoard({ x: menu.worldX, y: menu.worldY })
              onClose()
            }}
          >
            <Icon name="group" size={13} /> Add Group Frame
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              addPaletteCardToActiveBoard(['#101828', '#23395d', '#4fb3ff', '#f2b866', '#e8dfd1'], {
                x: menu.worldX,
                y: menu.worldY
              })
              onClose()
            }}
          >
            <Icon name="palette" size={13} /> Add Color Palette
          </button>
          <button type="button" role="menuitem" onClick={onAddLocation}>
            <Icon name="pin" size={13} /> Add Saved Location…
          </button>
          <div className="mb-menu-sep" />
          <button type="button" role="menuitem" onClick={onFitView}>
            <Icon name="fit" size={13} /> Fit View <span className="kbd">F</span>
          </button>
        </>
      )}
    </div>
  )
}

function AddLocationCardDialog({
  bookmarks,
  onSelect,
  onClose
}: {
  bookmarks: readonly Bookmark[]
  onSelect: (id: string) => void
  onClose: () => void
}) {
  const coordFormat = useAppStore((s) => s.settings.coordFormat)
  const [query, setQuery] = useState('')
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return bookmarks
    return bookmarks.filter((b) => `${b.name} ${b.tags.join(' ')} ${b.bestTime}`.toLowerCase().includes(q))
  }, [bookmarks, query])

  return (
    <div className="scrim center" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="panel dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Add Saved Location Card"
        style={{ width: 'min(480px, calc(100% - 32px))' }}
      >
        <div className="dialog-header">
          <h2>Add Location Reference Card</h2>
          <button type="button" className="icon-btn small" title="Close" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <input
            autoFocus
            className="input"
            placeholder="Search saved locations…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="mb-loc-picker-list scroll">
            {filtered.length === 0 ? (
              <div className="muted small" style={{ padding: 16, textAlign: 'center' }}>
                {bookmarks.length === 0
                  ? 'No saved locations yet. Save spots in the 3D Globe (Ctrl+B) first.'
                  : 'No matching locations.'}
              </div>
            ) : (
              filtered.map((loc) => (
                <button
                  key={loc.id}
                  type="button"
                  className="mb-loc-picker-row"
                  onClick={() => onSelect(loc.id)}
                >
                  <div className="proj-mini-loc-thumb">
                    {loc.photos[0] ? (
                      <img src={photoUrl(thumbFile(loc.photos[0]))} alt="" />
                    ) : (
                      <Icon name="pin" size={14} />
                    )}
                  </div>
                  <div className="mb-loc-picker-info">
                    <div className="truncate" style={{ fontWeight: 500 }}>{loc.name}</div>
                    <div className="small faint mono">
                      {formatLatLon(loc.position.latitude, loc.position.longitude, coordFormat)}
                    </div>
                  </div>
                  <Icon name="plus" size={14} />
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
