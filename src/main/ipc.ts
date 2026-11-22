import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC } from '@shared/ipc'
import { ALL_NEARBY_KINDS, CITIES_MAX_SPAN_DEG } from '@shared/places'
import { sanitizeSettings } from '@shared/settings'
import type { ApiKeys, AppInfo, AutocompleteRequest, CitiesRequest, NearbyRequest, Settings, WeatherRequest } from '@shared/types'
import { MAX_FORECAST_POINTS } from '@shared/weather'
import type { BookmarkStore } from './bookmarks'
import type { JsonFile } from './jsonStore'
import { PhotoPicker } from './photoPicker'
import type { PhotoInput } from './photos'
import {
  GOOGLE_REFERER,
  mapsShortLink,
  placeDetails,
  placesAutocomplete,
  placesCities,
  placesNearby,
  validateKeys,
  weatherForecast
} from './network'
import type { SecretStore } from './secrets'
import { openExternalSafely } from './security'

interface Stores {
  settings: JsonFile<Settings>
  secrets: SecretStore
  bookmarks: BookmarkStore
  disable3dTiles?: boolean
  isTrustedSender: (event: IpcMainInvokeEvent | Electron.IpcMainEvent) => boolean
  /** Called after the stored keys change. */
  onKeysChanged?: (keys: ApiKeys) => void
}

const str = (v: unknown, max = 500): string => (typeof v === 'string' ? v.slice(0, max) : '')

export function registerIpc({ settings, secrets, bookmarks, disable3dTiles, isTrustedSender, onKeysChanged }: Stores): void {
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => R) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender')
      return fn(...(args as A))
    })
  }

  handle(IPC.info, (): AppInfo => ({ version: app.getVersion(), platform: process.platform, googleReferer: GOOGLE_REFERER, disable3dTiles: !!disable3dTiles }))
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

  // Every payload is sanitized by the store (shared/locations.ts); ids are only looked up.
  handle(IPC.bookmarksList, () => bookmarks.list())
  handle(IPC.bookmarksCreate, (input: unknown) => bookmarks.create(input))
  handle(IPC.bookmarksUpdate, (id: unknown, patch: unknown) => bookmarks.update(str(id, 100), patch))
  handle(IPC.bookmarksRemove, (id: unknown) => bookmarks.remove(str(id, 100)))
  handle(IPC.bookmarksAddPhoto, (id: unknown, photo: unknown) => {
    const p = (photo ?? {}) as Partial<PhotoInput>
    return bookmarks.addPhoto(str(id, 100), { name: p.name, data: p.data, thumb: p.thumb, width: p.width, height: p.height })
  })
  // The native picker, attached to the window that asked (dialog is looked up per call).
  let pickerWindow: BrowserWindow | null = null
  const picker = new PhotoPicker((options) =>
    pickerWindow ? dialog.showOpenDialog(pickerWindow, options) : dialog.showOpenDialog(options)
  )
  ipcMain.handle(IPC.bookmarksPickPhotos, (event, id: unknown) => {
    if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender')
    const location = bookmarks.list().find((b) => b.id === str(id, 100))
    if (!location) return []
    pickerWindow = BrowserWindow.fromWebContents(event.sender)
    return picker.pick(`Add photos to “${location.name}”`)
  })
  handle(IPC.bookmarksReadPickedPhoto, (token: unknown) => picker.read(str(token, 100)))
  handle(IPC.bookmarksRemovePhoto, (id: unknown, photoId: unknown) => bookmarks.removePhoto(str(id, 100), str(photoId, 100)))
  handle(IPC.profilesList, () => bookmarks.listProfiles())
  handle(IPC.profilesCreate, (input: unknown) => bookmarks.createProfile(input))
  handle(IPC.profilesUpdate, (id: unknown, patch: unknown) => bookmarks.updateProfile(str(id, 100), patch))
  handle(IPC.profilesRemove, (id: unknown) => bookmarks.removeProfile(str(id, 100)))

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
  handle(IPC.weatherForecast, (req: unknown) => {
    const points = ((req ?? {}) as Partial<WeatherRequest>).points
    if (
      !Array.isArray(points) ||
      points.length === 0 ||
      points.length > MAX_FORECAST_POINTS ||
      !points.every((p: unknown) => {
        const q = (p ?? {}) as Partial<{ latitude: unknown; longitude: unknown }>
        return Number.isFinite(q.latitude) && Number.isFinite(q.longitude)
      })
    ) {
      return { ok: false, error: { status: 'error', message: 'Invalid forecast request.' } }
    }
    return weatherForecast({
      points: points.map((p: { latitude: number; longitude: number }) => ({
        latitude: Math.max(-90, Math.min(90, p.latitude)),
        // Open-Meteo wants −180…180.
        longitude: ((((p.longitude + 180) % 360) + 360) % 360) - 180
      }))
    })
  })
  // Validated again in shortLinks.ts: only exact short-link hosts are requested.
  handle(IPC.mapsResolveShortLink, (url: unknown) => mapsShortLink(str(url, 500)))
}
