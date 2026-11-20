import { useEffect, useMemo, useRef, useState } from 'react'
import type { PlaceSuggestion } from '@shared/types'
import { getCommands, type Command } from '../commands'
import { getEngine } from '../engine/instance'
import { flyToBookmark } from '../lib/bookmarks'
import { formatLatLon, isShortMapsLink, parseLocationInput } from '../lib/coords'
import { DEBOUNCE_MS, PlacesSession } from '../lib/places'
import { useAppStore } from '../store/appStore'
import { Icon, type IconName } from './Icon'

interface Item {
  key: string
  group: string
  icon: IconName
  title: string
  subtitle?: string
  hint?: string
  run: () => void | Promise<void>
}

function matches(query: string, ...fields: Array<string | undefined>): number {
  const q = query.trim().toLowerCase()
  if (!q) return 1
  const hay = fields.filter(Boolean).join(' ').toLowerCase()
  const tokens = q.split(/\s+/)
  if (!tokens.every((t) => hay.includes(t))) return 0
  return hay.startsWith(q) ? 3 : (fields[0] ?? '').toLowerCase().includes(q) ? 2 : 1
}

export function CommandPalette() {
  const open = useAppStore((s) => s.paletteOpen)
  return open ? <PaletteDialog /> : null
}

function PaletteDialog() {
  const set = useAppStore((s) => s.set)
  const bookmarks = useAppStore((s) => s.bookmarks)
  const hasGoogleKey = useAppStore((s) => !!s.keys.googleApiKey)
  const target = useAppStore((s) => s.target)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [places, setPlaces] = useState<PlaceSuggestion[]>([])
  const [placesState, setPlacesState] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null })
  const session = useMemo(() => new PlacesSession(), [])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const close = () => set({ paletteOpen: false })

  useEffect(() => inputRef.current?.focus(), [])

  // Debounced place autocomplete.
  useEffect(() => {
    const q = query.trim()
    if (!hasGoogleKey || q.length < 3 || parseLocationInput(q)) {
      setPlaces([])
      setPlacesState({ loading: false, error: null })
      return
    }
    setPlacesState((s) => ({ ...s, loading: true }))
    const timer = window.setTimeout(async () => {
      const bias = target ? { latitude: target.latitude, longitude: target.longitude } : undefined
      const res = await session.autocomplete(q, bias)
      if (!res) return
      if (res.ok) {
        setPlaces(res.data)
        setPlacesState({ loading: false, error: null })
      } else {
        setPlaces([])
        setPlacesState({ loading: false, error: res.error.message })
      }
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [query, hasGoogleKey, session, target])

  const items = useMemo<Item[]>(() => {
    const out: Item[] = []
    const q = query.trim()
    const coords = q ? parseLocationInput(q) : null
    if (coords) {
      out.push({
        key: 'coords',
        group: 'Go to coordinates',
        icon: 'pin',
        title: formatLatLon(coords.latitude, coords.longitude, 'decimal'),
        subtitle: coords.source === 'url' ? 'from Google Maps link' : coords.source === 'dms' ? 'DMS' : 'decimal degrees',
        run: () => getEngine()?.goToCoordinates(coords)
      })
    } else if (q && isShortMapsLink(q)) {
      out.push({
        key: 'short',
        group: 'Go to coordinates',
        icon: 'info',
        title: 'Short links can’t be resolved offline',
        subtitle: 'Open it in a browser and paste the full google.com/maps URL',
        run: () => undefined
      })
    }
    for (const p of places) {
      out.push({
        key: `place-${p.placeId}`,
        group: 'Places',
        icon: 'globe',
        title: p.mainText,
        subtitle: p.secondaryText,
        run: async () => {
          const res = await session.details(p.placeId)
          if (res.ok) await getEngine()?.goToPlace(res.data)
          else useAppStore.getState().showToast(res.error.message)
        }
      })
    }
    const bm = bookmarks
      .map((b) => ({ b, score: matches(q, b.name) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, q ? 6 : 5)
    for (const { b } of bm) {
      out.push({ key: `bm-${b.id}`, group: 'Bookmarks', icon: 'bookmark', title: b.name, run: () => flyToBookmark(b) })
    }
    const cmds = getCommands()
      .map((c: Command) => ({ c, score: matches(q, c.title, c.keywords, c.group) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, q ? 12 : 60)
    for (const { c } of cmds) {
      out.push({ key: `cmd-${c.id}`, group: 'Commands', icon: 'command', title: c.title, hint: c.keys, run: c.run })
    }
    return out
  }, [query, places, bookmarks, session])

  useEffect(() => setSelected(0), [query, places.length])
  useEffect(() => {
    listRef.current?.querySelector('.palette-item.selected')?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const execute = (item: Item | undefined) => {
    if (!item) return
    close()
    void item.run()
  }

  let lastGroup = ''
  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="panel palette" role="dialog" aria-label="Search and commands">
        <div className="palette-input">
          <Icon name="search" />
          <input
            ref={inputRef}
            value={query}
            placeholder={hasGoogleKey ? 'Search a place, paste coordinates or a Google Maps link, or type a command' : 'Coordinates, Google Maps links, bookmarks or commands'}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') setSelected((s) => Math.min(items.length - 1, s + 1))
              else if (e.key === 'ArrowUp') setSelected((s) => Math.max(0, s - 1))
              else if (e.key === 'Enter') execute(items[selected])
              else if (e.key === 'Escape') close()
              else return
              e.preventDefault()
              e.stopPropagation()
            }}
            aria-label="Search"
            spellCheck={false}
          />
          {placesState.loading && <span className="small faint">searching…</span>}
        </div>
        <div className="palette-results" ref={listRef}>
          {placesState.error && <div className="notice" style={{ margin: 6 }}>{placesState.error}</div>}
          {items.length === 0 && <div className="muted" style={{ padding: 14 }}>No matches.</div>}
          {items.map((item, i) => {
            const header = item.group !== lastGroup ? <div className="palette-group">{item.group}</div> : null
            lastGroup = item.group
            return (
              <div key={item.key}>
                {header}
                <div
                  className={`palette-item ${i === selected ? 'selected' : ''}`}
                  onMouseMove={() => setSelected(i)}
                  onClick={() => execute(item)}
                >
                  <Icon name={item.icon} size={16} style={{ opacity: 0.7, flex: 'none' }} />
                  <span className="title">
                    {item.title}
                    {item.subtitle && <span className="sub">{item.subtitle}</span>}
                  </span>
                  {item.hint && <span className="kbd">{item.hint}</span>}
                </div>
              </div>
            )
          })}
        </div>
        <div className="palette-footer">
          <span>
            <span className="kbd">↑</span> <span className="kbd">↓</span> select
          </span>
          <span>
            <span className="kbd">Enter</span> go
          </span>
          <span>
            <span className="kbd">Esc</span> close
          </span>
          <span style={{ marginLeft: 'auto' }}>Decimal, DMS and Google Maps URLs accepted</span>
        </div>
      </div>
    </div>
  )
}
