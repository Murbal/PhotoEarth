import type { Bookmark, NewBookmark } from '@shared/types'
import { getEngine } from '../engine/instance'
import { appState } from '../store/appStore'
import { formatLatLon } from './coords'

export async function saveCurrentView(name?: string): Promise<Bookmark | null> {
  const engine = getEngine()
  if (!engine) return null
  const { settings, target, bookmarks, set, togglePanel, showToast } = appState()
  const label =
    name ??
    (target ? `View ${formatLatLon(target.latitude, target.longitude, 'decimal')}` : `View ${bookmarks.length + 1}`)
  const input: NewBookmark = engine.bookmarkFromView(label, settings.bookmarkIncludeTime)
  const saved = await window.photoearth.bookmarks.create(input)
  set({ bookmarks: [...appState().bookmarks, saved] })
  togglePanel('bookmarks', true)
  showToast('Bookmark saved')
  return saved
}

export async function renameBookmark(id: string, name: string): Promise<void> {
  const updated = await window.photoearth.bookmarks.update(id, { name })
  if (!updated) return
  appState().set({ bookmarks: appState().bookmarks.map((b) => (b.id === id ? updated : b)) })
}

export async function deleteBookmark(id: string): Promise<void> {
  await window.photoearth.bookmarks.remove(id)
  appState().set({ bookmarks: appState().bookmarks.filter((b) => b.id !== id) })
}

export function flyToBookmark(b: Bookmark): void {
  void getEngine()?.flyToBookmark(b)
}
