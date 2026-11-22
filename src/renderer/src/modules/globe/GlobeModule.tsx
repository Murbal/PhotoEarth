import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { AlignmentPanel } from '../../components/AlignmentPanel'
import { Banners } from '../../components/Banners'
import { LayersPanel } from '../../components/LayersPanel'
import { PartBoundary } from '../../components/ErrorBoundary'
import { HorizonPanel } from '../../components/HorizonPanel'
import { LocationsPanel } from '../../components/LocationsPanel'
import { MapMode } from '../../components/MapMode'
import { MapView } from '../../components/MapView'
import { Crosshair, FpsIndicator, InspectCard, LoadingBar, StatusChips } from '../../components/Overlays'
import { ProfilePanel } from '../../components/ProfilePanel'
import { RightRail } from '../../components/RightRail'
import { StatusBar } from '../../components/StatusBar'
import { TimePanel } from '../../components/TimePanel'
import { TopBar } from '../../components/TopBar'
import { ViewfinderFrame, ViewfinderPanel } from '../../components/Viewfinder'
import { ViewshedPanel } from '../../components/ViewshedPanel'
import { getEngine } from '../../engine/instance'
import { useForecastFeed } from '../../hooks/useForecastFeed'
import { useAppStore } from '../../store/appStore'

const EDGE = 70
const SIDE_PANEL = 300
const ALIGN_PANEL = 340
const GAP = 12
/** Right side panels sit left of the 60 px tool rail. */
const RIGHT_PANEL_INSET = 60
const MIN_STACK_WIDTH = 600
const STACK_BOTTOM = 40
const STATUS_CLEARANCE = 44

/**
 * Keeps the bottom stack (profile, time & sun) and the side panels (bookmarks, elevation
 * styling, shot alignment) from covering each other. The stack narrows to the space between
 * open side panels; only when that space is too small does it span the width, and the side
 * panels then end above it instead.
 */
function useOverlayLayout(
  root: RefObject<HTMLDivElement | null>,
  stack: RefObject<HTMLDivElement | null>,
  top: RefObject<HTMLDivElement | null>,
  active: boolean
): void {
  const left = useAppStore((s) => s.panels.bookmarks)
  const rightLayers = useAppStore((s) => s.panels.layers)
  const rightAlignment = useAppStore((s) => s.alignment.open)
  useLayoutEffect(() => {
    const rootEl = root.current
    const stackEl = stack.current
    const topEl = top.current
    if (!rootEl || !stackEl) return
    const viewportEl = rootEl.closest('.module-viewport') as HTMLElement | null
    if (!active) {
      viewportEl?.style.setProperty('--stack-height', '0px')
      return
    }
    const apply = () => {
      const width = rootEl.clientWidth
      const leftInset = left ? GAP + SIDE_PANEL + GAP : EDGE
      let rightInset = EDGE
      if (rightLayers && rightAlignment) rightInset = RIGHT_PANEL_INSET + SIDE_PANEL + GAP + ALIGN_PANEL + GAP
      else if (rightAlignment) rightInset = RIGHT_PANEL_INSET + ALIGN_PANEL + GAP
      else if (rightLayers) rightInset = RIGHT_PANEL_INSET + SIDE_PANEL + GAP
      const besidePanels = width - leftInset - rightInset >= MIN_STACK_WIDTH
      const style = rootEl.style
      style.setProperty('--stack-left', `${besidePanels ? leftInset : EDGE}px`)
      style.setProperty('--stack-right', `${besidePanels ? rightInset : EDGE}px`)
      // Keep the bottom stack clear of top-center chips and banners (and side panels when they
      // sit above it). Banners grow with their text, so measure them rather than assume a height.
      const sideAbove = !besidePanels && (left || rightLayers || rightAlignment)
      const topBottom = topEl && topEl.offsetHeight > 0 ? topEl.offsetTop + topEl.offsetHeight + GAP : 0
      const topClearance = Math.max(sideAbove ? 60 + 160 + GAP : 112, topBottom)
      style.setProperty('--stack-max-height', `calc(100% - ${topClearance + STACK_BOTTOM}px)`)
      const stackHeight = stackEl.offsetHeight
      style.setProperty('--stack-height', `${stackHeight}px`)
      viewportEl?.style.setProperty('--stack-height', `${stackHeight}px`)
      const clearance = !besidePanels && stackHeight > 0 ? STACK_BOTTOM + stackHeight + GAP : STATUS_CLEARANCE
      style.setProperty('--side-bottom', `${clearance}px`)
    }
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(rootEl)
    observer.observe(stackEl)
    if (topEl) observer.observe(topEl)
    return () => observer.disconnect()
  }, [root, stack, top, left, rightLayers, rightAlignment, active])
}

export function GlobeModule({ active, modalOpen }: { active: boolean; modalOpen: boolean }) {
  const mapOpen = useAppStore((s) => s.settings.map.open)
  const overlayRef = useRef<HTMLDivElement>(null)
  const stackRef = useRef<HTMLDivElement>(null)
  const topRef = useRef<HTMLDivElement>(null)
  const [creditEl, setCreditEl] = useState<HTMLDivElement | null>(null)

  useForecastFeed()
  useOverlayLayout(overlayRef, stackRef, topRef, active)

  useEffect(() => {
    getEngine()?.setSuspended(!active)
  }, [active])

  return (
    <>
      <MapView creditContainer={creditEl} inert={modalOpen || mapOpen || !active} />
      <PartBoundary name="Map mode"><MapMode /></PartBoundary>
      {/* While a dialog is open or the module is hidden, everything behind it is inert: no focus,
          no clicks. 3D-only overlays are hidden in Map mode (styles: .overlay-root[data-map]). */}
      <div ref={overlayRef} className="overlay-root" inert={modalOpen || !active} data-map={mapOpen ? '' : undefined}>
        <PartBoundary name="Viewfinder frame"><ViewfinderFrame /></PartBoundary>
        <PartBoundary name="Loading bar"><LoadingBar /></PartBoundary>
        <PartBoundary name="Top bar"><TopBar /></PartBoundary>
        <div ref={topRef} className="top-center">
          <PartBoundary name="Status chips"><StatusChips /></PartBoundary>
          <PartBoundary name="Banners"><Banners /></PartBoundary>
        </div>
        <PartBoundary name="Tool rail"><RightRail /></PartBoundary>
        <PartBoundary name="Saved locations"><LocationsPanel /></PartBoundary>
        <PartBoundary name="Layers panel"><LayersPanel /></PartBoundary>
        <PartBoundary name="Shot alignment"><AlignmentPanel /></PartBoundary>
        <PartBoundary name="Inspect card"><InspectCard /></PartBoundary>
        <PartBoundary name="Crosshair"><Crosshair /></PartBoundary>
        <div ref={stackRef} className="bottom-stack">
          <PartBoundary name="Elevation profile"><ProfilePanel /></PartBoundary>
          <PartBoundary name="Horizon panorama"><HorizonPanel /></PartBoundary>
          <PartBoundary name="Viewshed analysis"><ViewshedPanel /></PartBoundary>
          <PartBoundary name="Viewfinder"><ViewfinderPanel /></PartBoundary>
          <PartBoundary name="Time panel"><TimePanel /></PartBoundary>
        </div>
        <PartBoundary name="Frame rate"><FpsIndicator /></PartBoundary>
        <PartBoundary name="Status bar"><StatusBar creditRef={setCreditEl} /></PartBoundary>
      </div>
    </>
  )
}
