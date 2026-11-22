import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import { useMoodboardStore } from '../../store/moodboardStore'

const PRESETS: ReadonlyArray<{ label: string; url: string }> = [
  { label: 'Google Images', url: 'https://www.google.com/search?udm=2&q=landscape+photography+lighting' },
  { label: 'Pinterest', url: 'https://www.pinterest.com/' },
  { label: 'Flickr', url: 'https://www.flickr.com/explore' },
  { label: '500px', url: 'https://500px.com/popular' },
  { label: 'Behance', url: 'https://www.behance.net/galleries/photography' },
  { label: 'Are.na', url: 'https://www.are.na/explore' },
  { label: 'ShotDeck', url: 'https://shotdeck.com/' }
]

const MIN_WIDTH = 340
const MAX_WIDTH = 680

/**
 * Docked right-side Inspiration Browser panel.
 * Renders a compact React navigation chrome bar above a placeholder slot whose exact CSS DIP
 * bounds are synced via ResizeObserver to Electron's main-process `WebContentsView`.
 */
export function BrowserDrawerSlot({ hiddenByOverlay }: { hiddenByOverlay: boolean }) {
  const open = useMoodboardStore((s) => s.browserDrawerOpen)
  const width = useMoodboardStore((s) => s.browserDrawerWidth)
  const browserState = useMoodboardStore((s) => s.browserState)
  const set = useMoodboardStore((s) => s.set)
  const [urlInput, setUrlInput] = useState('')
  const [editingUrl, setEditingUrl] = useState(false)
  const slotRef = useRef<HTMLDivElement>(null)
  const resizingRef = useRef<{ startX: number; startW: number } | null>(null)

  const shouldShowView = open && !hiddenByOverlay

  // Sync WebContentsView visibility cleanly whenever open/overlay/unmount state changes.
  useEffect(() => {
    void window.photoearth?.browserDrawer?.setVisible(shouldShowView)
    return () => {
      void window.photoearth?.browserDrawer?.setVisible(false)
    }
  }, [shouldShowView])

  // Track exact slot bounds and forward to main-process WebContentsView.
  useEffect(() => {
    if (!shouldShowView) return
    const el = slotRef.current
    if (!el) return
    const sync = () => {
      const r = el.getBoundingClientRect()
      void window.photoearth?.browserDrawer?.setBounds({
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.max(0, Math.round(r.width)),
        height: Math.max(0, Math.round(r.height))
      })
    }
    sync()
    const obs = new ResizeObserver(sync)
    obs.observe(el)
    window.addEventListener('resize', sync)
    return () => {
      obs.disconnect()
      window.removeEventListener('resize', sync)
    }
  }, [shouldShowView, width])

  useEffect(() => {
    if (!editingUrl) setUrlInput(browserState.url)
  }, [browserState.url, editingUrl])

  if (!open) return null

  const submitUrl = (e: React.FormEvent) => {
    e.preventDefault()
    const q = urlInput.trim()
    if (!q) return
    setEditingUrl(false)
    void window.photoearth.browserDrawer.navigate(q)
  }

  return (
    <aside className="mb-browser-drawer" style={{ width }} aria-label="Inspiration Browser">
      {/* Left drag resizer */}
      <div
        className="mb-browser-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize inspiration browser"
        onPointerDown={(e) => {
          e.preventDefault()
          e.currentTarget.setPointerCapture(e.pointerId)
          resizingRef.current = { startX: e.clientX, startW: width }
        }}
        onPointerMove={(e) => {
          const r = resizingRef.current
          if (!r) return
          const next = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, r.startW + (r.startX - e.clientX)))
          set({ browserDrawerWidth: Math.round(next) })
        }}
        onPointerUp={() => {
          resizingRef.current = null
        }}
      />

      <div className="mb-browser-chrome">
        <div className="mb-browser-nav-row">
          <button
            type="button"
            className="icon-btn small"
            title="Back"
            aria-label="Back"
            disabled={!browserState.canGoBack}
            onClick={() => void window.photoearth.browserDrawer.goBack()}
          >
            <Icon name="arrowLeft" size={14} />
          </button>
          <button
            type="button"
            className="icon-btn small"
            title="Forward"
            aria-label="Forward"
            disabled={!browserState.canGoForward}
            onClick={() => void window.photoearth.browserDrawer.goForward()}
          >
            <Icon name="arrowRight" size={14} />
          </button>
          <button
            type="button"
            className="icon-btn small"
            title="Reload"
            aria-label="Reload"
            onClick={() => void window.photoearth.browserDrawer.reload()}
          >
            <Icon name="refresh" size={13} />
          </button>

          <form className="mb-browser-url-form" onSubmit={submitUrl}>
            <input
              className="mb-browser-url-input"
              aria-label="Search images or enter URL"
              placeholder="Search Google Images or enter URL…"
              value={urlInput}
              onFocus={(e) => {
                setEditingUrl(true)
                e.currentTarget.select()
              }}
              onBlur={() => setEditingUrl(false)}
              onChange={(e) => setUrlInput(e.target.value)}
            />
          </form>

          {browserState.url && (
            <button
              type="button"
              className="icon-btn small"
              title="Open current page in external browser"
              aria-label="Open in external browser"
              onClick={() => void window.photoearth.openExternal(browserState.url)}
            >
              <Icon name="external" size={13} />
            </button>
          )}
          <button
            type="button"
            className="icon-btn small"
            title="Close Inspiration Browser (B)"
            aria-label="Close Inspiration Browser"
            onClick={() => set({ browserDrawerOpen: false })}
          >
            <Icon name="close" size={14} />
          </button>
        </div>

        <div className="mb-browser-presets">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              className="mb-preset-chip"
              onClick={() => void window.photoearth.browserDrawer.navigate(p.url)}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="mb-browser-hint">
          <span>
            Right-click any image → <strong>Add image to Moodboard</strong> (or Copy + Paste)
          </span>
          {browserState.loading && <span className="mb-browser-loading">Loading…</span>}
        </div>
      </div>

      {/* Native WebContentsView renders over this exact slot rectangle */}
      <div ref={slotRef} className="mb-browser-slot">
        {hiddenByOverlay && (
          <div className="mb-browser-paused small muted">
            Inspiration Browser paused while overlay is open
          </div>
        )}
      </div>
    </aside>
  )
}
