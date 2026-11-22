import { useEffect, useMemo, useRef, useState } from 'react'
import { MIN_QUERY_LENGTH } from '@shared/places'
import type { PlaceSuggestion, ResolvedMapsLink, Result } from '@shared/types'
import { getCommands, type Command } from '../commands'
import { getEngine } from '../engine/instance'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { flyToBookmark, openProfile } from '../lib/locations'
import { coordinateProblem, formatLatLon, isShortMapsLink, parseLocationInput } from '@shared/coords'
import { DEBOUNCE_MS, PlacesSession } from '../lib/places'
import { resolveShortLink } from '../lib/shortLinks'
import { shellState, useShellStore } from '../shell/shellStore'
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
  const open = useShellStore((s) => s.paletteOpen)
  return open ? <PaletteDialog /> : null
}

interface PlacesResult {
  /** The trimmed query these results answer; '' when no search applies. */
  query: string
  places: PlaceSuggestion[]
  error: string | null
}

const NO_SUGGESTIONS: PlaceSuggestion[] = []
const NO_PLACES: PlacesResult = { query: '', places: NO_SUGGESTIONS, error: null }

interface ShortLinkResult {
  /** The trimmed query (a short link) this answers. */
  link: string
  result: Result<ResolvedMapsLink>
}

const MAPS_LINK_DETAIL = 'From Google Maps link'

function PaletteDialog() {
  const setShell = useShellStore((s) => s.set)
  const bookmarks = useAppStore((s) => s.bookmarks)
  const profiles = useAppStore((s) => s.profiles)
  const hasGoogleKey = useAppStore((s) => !!s.keys.googleApiKey)
  const target = useAppStore((s) => s.target)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [result, setResult] = useState<PlacesResult>(NO_PLACES)
  const [shortLink, setShortLink] = useState<ShortLinkResult | null>(null)
  const session = useMemo(() => new PlacesSession(), [])
  const dialogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const close = () => setShell({ paletteOpen: false })
  useDialogFocus(dialogRef)

  const q = query.trim()
  const coords = useMemo(() => (q ? parseLocationInput(q) : null), [q])
  // Text that reads as coordinates but isn't a valid location is explained, never sent to
  // address search ("91, 181" is not a street address).
  const coordError = q && !coords ? coordinateProblem(q) : null
  // Short links carry no coordinates; the main process follows them to the full URL.
  const isShortLink = !coords && isShortMapsLink(q)
  const shortResult = isShortLink && shortLink?.link === q ? shortLink.result : null
  const resolving = isShortLink && !shortResult
  const shortCoords = shortResult?.ok ? shortResult.data.location : null
  const shortError = shortResult && !shortResult.ok ? shortResult.error.message : null
  const placesEligible = hasGoogleKey && q.length >= MIN_QUERY_LENGTH && !coords && !coordError && !isShortLink
  // Pending from the first render after a keystroke, so "No matches" never flashes while a
  // search is still on its way.
  const searching = placesEligible && result.query !== q
  // While a new search runs, keep showing the previous results rather than an empty list.
  const places = placesEligible ? result.places : NO_SUGGESTIONS
  const placesError = placesEligible && !searching ? result.error : null

  // Debounced place autocomplete.
  useEffect(() => {
    if (!placesEligible) {
      setResult(NO_PLACES)
      return
    }
    const timer = window.setTimeout(async () => {
      const bias = target ? { latitude: target.latitude, longitude: target.longitude } : undefined
      const res = await session.autocomplete(q, bias)
      if (!res) return
      setResult(res.ok ? { query: q, places: res.data, error: null } : { query: q, places: [], error: res.error.message })
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [q, placesEligible, session, target])

  // Debounced, so typing a link by hand doesn't request every prefix of it.
  useEffect(() => {
    if (!isShortLink) return
    let current = true
    const timer = window.setTimeout(async () => {
      const res = await resolveShortLink(q)
      if (current) setShortLink({ link: q, result: res })
    }, DEBOUNCE_MS)
    return () => {
      current = false
      window.clearTimeout(timer)
    }
  }, [q, isShortLink])

  const items = useMemo<Item[]>(() => {
    const out: Item[] = []
    if (coords) {
      out.push({
        key: 'coords',
        group: 'Go to coordinates',
        icon: 'pin',
        title: formatLatLon(coords.latitude, coords.longitude, 'decimal'),
        subtitle: coords.source === 'url' ? 'from Google Maps link' : coords.source === 'dms' ? 'DMS' : 'decimal degrees',
        run: () => getEngine()?.goToCoordinates(coords, coords.source === 'url' ? MAPS_LINK_DETAIL : 'Coordinates')
      })
    } else if (shortCoords) {
      out.push({
        key: 'coords',
        group: 'Go to coordinates',
        icon: 'pin',
        title: formatLatLon(shortCoords.latitude, shortCoords.longitude, 'decimal'),
        subtitle: 'from Google Maps short link',
        run: () => getEngine()?.goToCoordinates(shortCoords, MAPS_LINK_DETAIL)
      })
    } else if (resolving) {
      out.push({
        key: 'short',
        group: 'Go to coordinates',
        icon: 'clock',
        title: 'Resolving short link…',
        subtitle: 'Asking Google Maps where it leads',
        // Enter before the answer arrives still goes there once it does.
        run: async () => {
          const res = await resolveShortLink(q)
          if (res.ok) await getEngine()?.goToCoordinates(res.data.location, MAPS_LINK_DETAIL)
          else shellState().showToast(res.error.message)
        }
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
          if (res.ok) await getEngine()?.goToPlace(res.data, { name: p.mainText, detail: p.secondaryText })
          else shellState().showToast(res.error.message)
        }
      })
    }
    // Saved locations, found by name, tags, best time or notes.
    const bm = bookmarks
      .map((b) => ({ b, score: matches(q, b.name, b.tags.join(' '), b.bestTime, b.notes, b.status === 'visited' ? 'visited' : 'to visit') }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, q ? 6 : 5)
    for (const { b } of bm) {
      const subtitle = [b.status === 'visited' ? 'Visited' : 'To visit', b.tags.join(', ')].filter(Boolean).join(' · ')
      out.push({ key: `bm-${b.id}`, group: 'Saved locations', icon: 'bookmark', title: b.name, subtitle, run: () => flyToBookmark(b) })
    }
    if (q) {
      const names = new Map(bookmarks.map((b) => [b.id, b.name]))
      for (const p of profiles.filter((p) => matches(q, p.name, 'profile', names.get(p.locationId ?? '')) > 0).slice(0, 4)) {
        const at = p.locationId ? names.get(p.locationId) : undefined
        out.push({ key: `pr-${p.id}`, group: 'Saved profiles', icon: 'profile', title: p.name, subtitle: at, run: () => openProfile(p) })
      }
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
  }, [q, coords, shortCoords, resolving, places, bookmarks, profiles, session])

  useEffect(() => setSelected(0), [q, places.length])
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const execute = (item: Item | undefined) => {
    if (!item) return
    close()
    void item.run()
  }

  // Grouped for the accessibility tree: options inside labelled groups.
  const groups: Array<{ name: string; items: Array<{ item: Item; index: number }> }> = []
  items.forEach((item, index) => {
    const last = groups[groups.length - 1]
    if (last?.name === item.group) last.items.push({ item, index })
    else groups.push({ name: item.group, items: [{ item, index }] })
  })
  const optionId = (i: number) => `palette-option-${i}`
  const active = items[selected]
  const status = resolving
    ? 'Resolving short link…'
    : searching
      ? 'Searching places…'
      : coordError
        ? `Invalid coordinates. ${coordError}`
        : shortError
          ? `Short link not resolved. ${shortError}`
          : placesError
            ? placesError
            : items.length === 0
              ? 'No matches'
              : `${items.length} result${items.length === 1 ? '' : 's'}`

  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={dialogRef} tabIndex={-1} className="panel palette" role="dialog" aria-modal="true" aria-label="Search and commands">
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
            role="combobox"
            aria-label="Search"
            aria-autocomplete="list"
            aria-expanded={items.length > 0}
            aria-controls="palette-listbox"
            aria-activedescendant={active ? optionId(selected) : undefined}
            aria-describedby="palette-status"
            spellCheck={false}
          />
          {(searching || resolving) && (
            <span className="small faint" aria-hidden="true">
              {resolving ? 'resolving…' : 'searching…'}
            </span>
          )}
        </div>
        <div id="palette-status" className="sr-only" role="status" aria-live="polite">
          {status}
        </div>
        <div className="palette-results" ref={listRef}>
          {coordError && (
            <div className="notice palette-notice">
              <strong>Invalid coordinates.</strong> {coordError}
            </div>
          )}
          {shortError && (
            <div className="notice palette-notice">
              <strong>Short link not resolved.</strong> {shortError}
            </div>
          )}
          {placesError && <div className="notice palette-notice">{placesError}</div>}
          {items.length === 0 && !coordError && !shortError && !placesError && (
            <div className="muted" style={{ padding: 14 }}>
              {searching ? 'Searching places…' : 'No matches.'}
            </div>
          )}
          <div id="palette-listbox" role="listbox" aria-label="Results">
            {groups.map((group, g) => (
              <div key={group.name} role="group" aria-labelledby={`palette-group-${g}`}>
                <div className="palette-group" id={`palette-group-${g}`} role="presentation">
                  {group.name}
                </div>
                {group.items.map(({ item, index }) => (
                  <div
                    key={item.key}
                    id={optionId(index)}
                    role="option"
                    aria-selected={index === selected}
                    className={`palette-item ${index === selected ? 'selected' : ''}`}
                    onMouseMove={() => setSelected(index)}
                    onClick={() => execute(item)}
                  >
                    <Icon name={item.icon} size={16} style={{ opacity: 0.7, flex: 'none' }} />
                    <span className="title">
                      {item.title}
                      {item.subtitle && <span className="sub">{item.subtitle}</span>}
                    </span>
                    {item.hint && <span className="kbd">{item.hint}</span>}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
        <div className="palette-footer" aria-hidden="true">
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
