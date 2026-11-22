import { join } from 'node:path'
import { app, BrowserWindow, session, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { sanitizeSettings } from '@shared/settings'
import { BookmarkStore } from './bookmarks'
import { BrowserDrawerController } from './browserDrawer'
import { DEV_ENV_KEYS, loadDevEnvFlags, loadDevEnvKeys } from './devEnv'
import { registerIpc } from './ipc'
import { JsonFile } from './jsonStore'
import { buildMenu } from './menu'
import { MoodboardStore } from './moodboards'
import { cleanOrphanPhotos, PhotoStore } from './photos'
import { ProjectStore } from './projects'
import { handleAppScheme, handlePhotoScheme, registerAppScheme } from './protocol'
import { SecretStore } from './secrets'
import { mapTilesNeedsReferer } from './network'
import { APP_ORIGIN, hardenSession, hardenWebContents, setGoogleRefererHook } from './security'
import { relaunchForWslGpu } from './wslGpu'

const devServer = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined

// Allow scripted runs (benchmarks) to use a throwaway profile.
if (process.env.PHOTOEARTH_USER_DATA) app.setPath('userData', process.env.PHOTOEARTH_USER_DATA)

// Scripted runs: never show the window or activate the app, so a run doesn't pop up
// over or take focus from whatever the user is doing. The page still renders at full rate
// (no background throttling), and the script drives it over CDP, which needs no OS focus.
const background = process.env.PHOTOEARTH_BACKGROUND === '1'
if (background) {
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  // macOS: no dock icon, and the app never becomes the active one.
  if (process.platform === 'darwin') app.setActivationPolicy('accessory')
}

// Under WSL, a packaged build started without GPU support in its environment restarts with it
// (dev, preview and test launchers set it themselves; see wslGpu.ts). Before the lock below.
const relaunching = app.isPackaged && relaunchForWslGpu(app)
if (relaunching) app.exit(0)

registerAppScheme()

if (relaunching) {
  // Exiting; don't take the lock the new instance needs.
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 560,
    show: false,
    title: 'PhotoEarth',
    backgroundColor: '#0a0d12',
    autoHideMenuBar: true,
    icon: app.isPackaged ? undefined : join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: !background
    }
  })
  hardenWebContents(win.webContents, devServer)
  if (!background) win.once('ready-to-show', () => win.show())
  if (devServer) {
    void win.loadURL(devServer)
  } else {
    void win.loadURL(`${APP_ORIGIN}/index.html`)
  }
  return win
}

void app.whenReady().then(async () => {
  if (relaunching) return
  const settings = new JsonFile(join(app.getPath('userData'), 'settings.json'), sanitizeSettings, 500)
  const secrets = await SecretStore.create()
  let disable3dTiles = false
  if (devServer) {
    const keys = loadDevEnvKeys(app.getAppPath())
    secrets.useSessionKeys(keys)
    const loaded = Object.entries(DEV_ENV_KEYS).filter(([, key]) => keys[key]).map(([variable]) => variable)
    if (loaded.length) console.log(`[photoearth] dev: using ${loaded.join(', ')} from .env`)
    disable3dTiles = loadDevEnvFlags(app.getAppPath()).disable3dTiles
    if (disable3dTiles) console.log('[photoearth] dev: 3D Tiles disabled (PHOTOEARTH_NO_3D_TILES)')
  }
  const userData = app.getPath('userData')
  const photos = new PhotoStore(join(userData, 'photos'))
  const moodboards = new MoodboardStore(userData, {
    photos,
    onRemove: (boardId) => {
      projects.unlinkMoodboardFromAll(boardId)
    },
    onCreate: (summary) => {
      if (summary.projectId) projects.linkMoodboard(summary.projectId, summary.id)
    }
  })
  const projects = new ProjectStore(userData, {
    photos,
    onRemove: (projectId) => {
      moodboards.unlinkProjectFromAll(projectId)
    }
  })
  const bookmarks = new BookmarkStore(userData, {
    photos,
    onRemove: (locationId) => {
      projects.unlinkLocationFromAll(locationId)
    }
  })
  cleanOrphanPhotos(photos, [bookmarks, projects, moodboards])
  const browserDrawer = new BrowserDrawerController(() => mainWindow, photos)

  hardenSession(session.defaultSession, devServer)
  handleAppScheme(join(__dirname, '../renderer'))
  handlePhotoScheme(photos)

  // Drop the per-request Referer hook when the key doesn't need it. It goes back on while a
  // new key is probed, so requests never go out without it while that's unknown.
  let probe = 0
  let probedKey: string | null | undefined
  const updateRefererHook = (key: string | null): void => {
    if (key === probedKey) return
    probedKey = key
    const id = ++probe
    setGoogleRefererHook(session.defaultSession, true)
    if (!key) return
    void mapTilesNeedsReferer(key).then((needed) => {
      if (id === probe) setGoogleRefererHook(session.defaultSession, needed)
    })
  }
  updateRefererHook(secrets.get().googleApiKey)

  const isTrustedSender = (event: IpcMainInvokeEvent | IpcMainEvent): boolean => {
    const url = event.senderFrame?.url ?? ''
    return url.startsWith(`${APP_ORIGIN}/`) || (!!devServer && url.startsWith(devServer))
  }
  registerIpc({
    settings,
    secrets,
    bookmarks,
    projects,
    moodboards,
    browserDrawer,
    disable3dTiles,
    isTrustedSender,
    onKeysChanged: (keys) => updateRefererHook(keys.googleApiKey)
  })
  buildMenu()

  mainWindow = createWindow()

  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })

  app.on('before-quit', () => {
    browserDrawer.destroy()
    for (const store of [settings, bookmarks, projects, moodboards]) {
      try {
        store.flush()
      } catch (err) {
        console.error('[photoearth] Could not save on quit:', err)
      }
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
