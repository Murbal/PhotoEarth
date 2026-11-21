import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC } from '@shared/ipc'
import { ALL_NEARBY_KINDS, CITIES_MAX_SPAN_DEG } from '@shared/places'
import { sanitizeSettings } from '@shared/settings'
import type { ApiKeys, AppInfo, AutocompleteRequest, CitiesRequest, NearbyRequest, NewBookmark, Settings } from '@shared/types'
import type { BookmarkStore } from './bookmarks'
import type { JsonFile } from './jsonStore'
import { GOOGLE_REFERER, placeDetails, placesAutocomplete, placesCities, placesNearby, validateKeys } from './network'
import type { SecretStore } from './secrets'
import { openExternalSafely } from './security'

interface Stores {
  settings: JsonFile<Settings>
  secrets: SecretStore
  bookmarks: BookmarkStore
  isTrustedSender: (event: IpcMainInvokeEvent | Electron.IpcMainEvent) => boolean
  /** Called after the stored keys change. */
  onKeysChanged?: (keys: ApiKeys) => void
}

const str = (v: unknown, max = 500): string => (typeof v === 'string' ? v.slice(0, max) : '')

export function registerIpc({ settings, secrets, bookmarks, isTrustedSender, onKeysChanged }: Stores): void {
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => R) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender')
      return fn(...(args as A))
    })
  }

  handle(IPC.info, (): AppInfo => ({ version: app.getVersion(), platform: process.platform, googleReferer: GOOGLE_REFERER }))
  handle(IPC.openExternal, (url: unknown) => openExternalSafely(str(url, 2000)))

  handle(IPC.settingsGet, () => settings.get())
  handle(IPC.settingsSet, (next: unknown) => settings.set(sanitizeSettings(next)))
  ipcMain.on(IPC.settingsFlush, (event, next: unknown) => {
    if (!isTrustedSender(event)) return
    settings.set(sanitizeSettings(next))
    settings.flush()
  })

  handle(IPC.keysGet, () => secrets.get())
  handle(IPC.keysStatus, () => secrets.status())
  handle(IPC.keysSet, (patch: unknown) => {
    const p = (patch ?? {}) as Partial<ApiKeys>
    const clean: Partial<ApiKeys> = {}
    if ('googleApiKey' in p) clean.googleApiKey = str(p.googleApiKey) || null
    if ('cesiumIonToken' in p) clean.cesiumIonToken = str(p.cesiumIonToken, 4000) || null
    return secrets.set(clean).then((status) => {
      onKeysChanged?.(secrets.get())
      return status
    })
  })
  handle(IPC.keysValidate, (keys: unknown) => {
    const k = (keys ?? {}) as Partial<ApiKeys>
    return validateKeys({ googleApiKey: str(k.googleApiKey) || null, cesiumIonToken: str(k.cesiumIonToken, 4000) || null })
  })

  handle(IPC.bookmarksList, () => bookmarks.list())
  handle(IPC.bookmarksCreate, (input: unknown) => bookmarks.create(input as NewBookmark))
  handle(IPC.bookmarksUpdate, (id: unknown, patch: unknown) => bookmarks.update(str(id, 100), (patch ?? {}) as Partial<NewBookmark>))
  handle(IPC.bookmarksRemove, (id: unknown) => bookmarks.remove(str(id, 100)))

  handle(IPC.placesAutocomplete, (req: unknown) => {
    const r = (req ?? {}) as Partial<AutocompleteRequest>
    const bias =
      r.bias && Number.isFinite(r.bias.latitude) && Number.isFinite(r.bias.longitude)
        ? { latitude: r.bias.latitude, longitude: r.bias.longitude }
        : undefined
    return placesAutocomplete(secrets.get().googleApiKey, {
      input: str(r.input, 200),
      sessionToken: str(r.sessionToken, 100),
      bias
    })
  })
  handle(IPC.placesDetails, (placeId: unknown, token: unknown) =>
    placeDetails(secrets.get().googleApiKey, str(placeId, 300), str(token, 100))
  )
  handle(IPC.placesNearby, (req: unknown) => {
    const r = (req ?? {}) as Partial<NearbyRequest>
    const { latitude, longitude } = r.center ?? {}
    if (
      !ALL_NEARBY_KINDS.includes(r.kind as NearbyRequest['kind']) ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      !Number.isFinite(r.radius)
    ) {
      return { ok: false, error: { status: 'error', message: 'Invalid nearby request.' } }
    }
    return placesNearby(secrets.get().googleApiKey, {
      kind: r.kind as NearbyRequest['kind'],
      center: { latitude: Math.max(-90, Math.min(90, latitude as number)), longitude: Math.max(-180, Math.min(180, longitude as number)) },
      radius: r.radius as number
    })
  })
  handle(IPC.placesCities, (req: unknown) => {
    const r = (req ?? {}) as Partial<CitiesRequest>
    const { south, west, north, east } = r
    if (
      ![south, west, north, east].every(Number.isFinite) ||
      (south as number) >= (north as number) ||
      (west as number) >= (east as number) ||
      (north as number) - (south as number) > CITIES_MAX_SPAN_DEG ||
      // Longitude degrees shrink toward the poles, so cells span more of them there.
      (east as number) - (west as number) > 60
    ) {
      return { ok: false, error: { status: 'error', message: 'Invalid cities request.' } }
    }
    const lat = (v: number) => Math.max(-90, Math.min(90, v))
    const lon = (v: number) => Math.max(-180, Math.min(180, v))
    return placesCities(secrets.get().googleApiKey, {
      south: lat(south as number),
      west: lon(west as number),
      north: lat(north as number),
      east: lon(east as number)
    })
  })
}
