import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC } from '@shared/ipc'
import { sanitizeSettings } from '@shared/settings'
import type { ApiKeys, AppInfo, AutocompleteRequest, NewBookmark, Settings } from '@shared/types'
import type { BookmarkStore } from './bookmarks'
import type { JsonFile } from './jsonStore'
import { GOOGLE_REFERER, placeDetails, placesAutocomplete, validateKeys } from './network'
import type { SecretStore } from './secrets'
import { openExternalSafely } from './security'

interface Stores {
  settings: JsonFile<Settings>
  secrets: SecretStore
  bookmarks: BookmarkStore
  isTrustedSender: (event: IpcMainInvokeEvent | Electron.IpcMainEvent) => boolean
}

const str = (v: unknown, max = 500): string => (typeof v === 'string' ? v.slice(0, max) : '')

export function registerIpc({ settings, secrets, bookmarks, isTrustedSender }: Stores): void {
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
    return secrets.set(clean)
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
}
