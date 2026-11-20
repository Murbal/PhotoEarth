import { join } from 'node:path'
import { app, BrowserWindow, session, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { sanitizeSettings } from '@shared/settings'
import { BookmarkStore } from './bookmarks'
import { DEV_ENV_KEYS, loadDevEnvKeys } from './devEnv'
import { registerIpc } from './ipc'
import { JsonFile } from './jsonStore'
import { buildMenu } from './menu'
import { handleAppScheme, registerAppScheme } from './protocol'
import { SecretStore } from './secrets'
import { APP_ORIGIN, hardenSession, hardenWebContents } from './security'

const devServer = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined

// Allow isolated test runs (Playwright) to use a throwaway profile.
if (process.env.PHOTOEARTH_USER_DATA) app.setPath('userData', process.env.PHOTOEARTH_USER_DATA)

registerAppScheme()

if (!app.requestSingleInstanceLock()) {
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
      backgroundThrottling: true
    }
  })
  hardenWebContents(win.webContents, devServer)
  win.once('ready-to-show', () => win.show())
  if (devServer) {
    void win.loadURL(devServer)
  } else {
    void win.loadURL(`${APP_ORIGIN}/index.html`)
  }
  return win
}

void app.whenReady().then(async () => {
  const settings = new JsonFile(join(app.getPath('userData'), 'settings.json'), sanitizeSettings, 500)
  const secrets = await SecretStore.create()
  if (devServer) {
    const keys = loadDevEnvKeys(app.getAppPath())
    secrets.useSessionKeys(keys)
    const loaded = Object.entries(DEV_ENV_KEYS).filter(([, key]) => keys[key]).map(([variable]) => variable)
    if (loaded.length) console.log(`[photoearth] dev: using ${loaded.join(', ')} from .env`)
  }
  const bookmarks = new BookmarkStore()

  hardenSession(session.defaultSession, devServer)
  handleAppScheme(join(__dirname, '../renderer'))

  const isTrustedSender = (event: IpcMainInvokeEvent | IpcMainEvent): boolean => {
    const url = event.senderFrame?.url ?? ''
    return url.startsWith(`${APP_ORIGIN}/`) || (!!devServer && url.startsWith(devServer))
  }
  registerIpc({ settings, secrets, bookmarks, isTrustedSender })
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
    settings.flush()
    bookmarks.flush()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
