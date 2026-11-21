import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type { MenuCommand, PhotoEarthApi } from '@shared/types'

// The only surface the sandboxed renderer gets: a typed, minimal API.
const api: PhotoEarthApi = {
  info: () => ipcRenderer.invoke(IPC.info),
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    set: (settings) => ipcRenderer.invoke(IPC.settingsSet, settings),
    flush: (settings) => ipcRenderer.send(IPC.settingsFlush, settings)
  },
  keys: {
    get: () => ipcRenderer.invoke(IPC.keysGet),
    set: (keys) => ipcRenderer.invoke(IPC.keysSet, keys),
    status: () => ipcRenderer.invoke(IPC.keysStatus),
    validate: (keys) => ipcRenderer.invoke(IPC.keysValidate, keys)
  },
  bookmarks: {
    list: () => ipcRenderer.invoke(IPC.bookmarksList),
    create: (bookmark) => ipcRenderer.invoke(IPC.bookmarksCreate, bookmark),
    update: (id, patch) => ipcRenderer.invoke(IPC.bookmarksUpdate, id, patch),
    remove: (id) => ipcRenderer.invoke(IPC.bookmarksRemove, id),
    addPhoto: (id, photo) => ipcRenderer.invoke(IPC.bookmarksAddPhoto, id, photo),
    removePhoto: (id, photoId) => ipcRenderer.invoke(IPC.bookmarksRemovePhoto, id, photoId)
  },
  profiles: {
    list: () => ipcRenderer.invoke(IPC.profilesList),
    create: (profile) => ipcRenderer.invoke(IPC.profilesCreate, profile),
    update: (id, patch) => ipcRenderer.invoke(IPC.profilesUpdate, id, patch),
    remove: (id) => ipcRenderer.invoke(IPC.profilesRemove, id)
  },
  places: {
    autocomplete: (request) => ipcRenderer.invoke(IPC.placesAutocomplete, request),
    details: (placeId, sessionToken) => ipcRenderer.invoke(IPC.placesDetails, placeId, sessionToken),
    nearby: (request) => ipcRenderer.invoke(IPC.placesNearby, request),
    cities: (request) => ipcRenderer.invoke(IPC.placesCities, request)
  },
  weather: {
    forecast: (request) => ipcRenderer.invoke(IPC.weatherForecast, request)
  },
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  onMenuCommand: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, command: MenuCommand) => listener(command)
    ipcRenderer.on(IPC.menuCommand, handler)
    return () => ipcRenderer.removeListener(IPC.menuCommand, handler)
  }
}

contextBridge.exposeInMainWorld('photoearth', api)
