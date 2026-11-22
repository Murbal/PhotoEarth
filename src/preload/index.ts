import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type { BrowserDrawerImageAdded, BrowserDrawerState, MenuCommand, PhotoEarthApi } from '@shared/types'

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
    removePhoto: (id, photoId) => ipcRenderer.invoke(IPC.bookmarksRemovePhoto, id, photoId),
    pickPhotos: (id) => ipcRenderer.invoke(IPC.bookmarksPickPhotos, id),
    readPickedPhoto: (token) => ipcRenderer.invoke(IPC.bookmarksReadPickedPhoto, token)
  },
  profiles: {
    list: () => ipcRenderer.invoke(IPC.profilesList),
    create: (profile) => ipcRenderer.invoke(IPC.profilesCreate, profile),
    update: (id, patch) => ipcRenderer.invoke(IPC.profilesUpdate, id, patch),
    remove: (id) => ipcRenderer.invoke(IPC.profilesRemove, id)
  },
  projects: {
    list: () => ipcRenderer.invoke(IPC.projectsList),
    create: (input) => ipcRenderer.invoke(IPC.projectsCreate, input),
    update: (id, patch) => ipcRenderer.invoke(IPC.projectsUpdate, id, patch),
    remove: (id) => ipcRenderer.invoke(IPC.projectsRemove, id),
    setCoverPhoto: (id, photo) => ipcRenderer.invoke(IPC.projectsSetCoverPhoto, id, photo),
    setCoverPhotoFromPhoto: (id, photo) => ipcRenderer.invoke(IPC.projectsSetCoverPhotoFromPhoto, id, photo),
    clearCoverPhoto: (id) => ipcRenderer.invoke(IPC.projectsClearCoverPhoto, id),
    pickCoverPhoto: (id) => ipcRenderer.invoke(IPC.projectsPickCoverPhoto, id),
    readPickedPhoto: (token) => ipcRenderer.invoke(IPC.projectsReadPickedPhoto, token),
    linkLocation: (projectId, locationId) => ipcRenderer.invoke(IPC.projectsLinkLocation, projectId, locationId),
    unlinkLocation: (projectId, locationId) => ipcRenderer.invoke(IPC.projectsUnlinkLocation, projectId, locationId),
    linkMoodboard: (projectId, moodboardId) => ipcRenderer.invoke(IPC.projectsLinkMoodboard, projectId, moodboardId),
    unlinkMoodboard: (projectId, moodboardId) => ipcRenderer.invoke(IPC.projectsUnlinkMoodboard, projectId, moodboardId)
  },
  moodboards: {
    list: () => ipcRenderer.invoke(IPC.moodboardsList),
    get: (id) => ipcRenderer.invoke(IPC.moodboardsGet, id),
    create: (input) => ipcRenderer.invoke(IPC.moodboardsCreate, input),
    save: (doc) => ipcRenderer.invoke(IPC.moodboardsSave, doc),
    flush: (doc) => ipcRenderer.send(IPC.moodboardsFlush, doc),
    updateMeta: (id, patch) => ipcRenderer.invoke(IPC.moodboardsUpdateMeta, id, patch),
    remove: (id) => ipcRenderer.invoke(IPC.moodboardsRemove, id),
    addImage: (boardId, photo) => ipcRenderer.invoke(IPC.moodboardsAddImage, boardId, photo),
    clonePhoto: (boardId, photo) => ipcRenderer.invoke(IPC.moodboardsClonePhoto, boardId, photo),
    pickImages: (boardId) => ipcRenderer.invoke(IPC.moodboardsPickImages, boardId),
    readPickedPhoto: (token) => ipcRenderer.invoke(IPC.moodboardsReadPickedPhoto, token),
    exportImage: (defaultName, data, format) => ipcRenderer.invoke(IPC.moodboardsExportImage, defaultName, data, format)
  },
  browserDrawer: {
    setVisible: (visible) => ipcRenderer.invoke(IPC.browserDrawerSetVisible, visible),
    setBounds: (bounds) => ipcRenderer.invoke(IPC.browserDrawerSetBounds, bounds),
    navigate: (urlOrQuery) => ipcRenderer.invoke(IPC.browserDrawerNavigate, urlOrQuery),
    goBack: () => ipcRenderer.invoke(IPC.browserDrawerGoBack),
    goForward: () => ipcRenderer.invoke(IPC.browserDrawerGoForward),
    reload: () => ipcRenderer.invoke(IPC.browserDrawerReload),
    onState: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, state: BrowserDrawerState) => listener(state)
      ipcRenderer.on(IPC.browserDrawerState, handler)
      return () => ipcRenderer.removeListener(IPC.browserDrawerState, handler)
    },
    onImageAdded: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: BrowserDrawerImageAdded) => listener(payload)
      ipcRenderer.on(IPC.browserDrawerImageAdded, handler)
      return () => ipcRenderer.removeListener(IPC.browserDrawerImageAdded, handler)
    },
    onError: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, message: string) => listener(message)
      ipcRenderer.on(IPC.browserDrawerError, handler)
      return () => ipcRenderer.removeListener(IPC.browserDrawerError, handler)
    }
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
  maps: {
    resolveShortLink: (url) => ipcRenderer.invoke(IPC.mapsResolveShortLink, url)
  },
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  onMenuCommand: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, command: MenuCommand) => listener(command)
    ipcRenderer.on(IPC.menuCommand, handler)
    return () => ipcRenderer.removeListener(IPC.menuCommand, handler)
  }
}

contextBridge.exposeInMainWorld('photoearth', api)
