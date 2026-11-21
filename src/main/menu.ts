import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { IPC } from '@shared/ipc'
import type { MenuCommand } from '@shared/types'
import { openExternalSafely } from './security'

function send(command: MenuCommand): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.send(IPC.menuCommand, command)
}

/**
 * Application menu. Accelerators here are window-scoped (only active while PhotoEarth
 * is focused); map shortcuts such as WASD are handled in the renderer.
 */
export function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: '&File',
      submenu: [
        { label: 'Search or Go To…', accelerator: 'CmdOrCtrl+K', click: () => send('open-palette') },
        { label: 'Save Bookmark', accelerator: 'CmdOrCtrl+B', click: () => send('save-bookmark') },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => send('open-settings') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    // macOS routes ⌘A, ⌘C, ⌘V, ⌘Z… in text fields through the Edit menu's roles; without
    // one, Select All does nothing in the search field and in the key inputs.
    ...(isMac ? [{ role: 'editMenu' as const }] : []),
    {
      label: '&View',
      submenu: [
        { label: 'Photorealistic Mode', click: () => send('mode-photorealistic') },
        { label: 'Elevation Mode', click: () => send('mode-elevation') },
        { type: 'separator' },
        { label: 'Bookmarks Panel', click: () => send('toggle-bookmarks') },
        { label: 'Time & Sun Panel', click: () => send('toggle-time-panel') },
        { label: 'Viewfinder', click: () => send('toggle-viewfinder') },
        { label: 'FPS Indicator', click: () => send('toggle-fps') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'resetZoom', label: 'Reset UI Zoom' },
        { role: 'zoomIn', label: 'UI Zoom In' },
        { role: 'zoomOut', label: 'UI Zoom Out' },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' }
      ]
    },
    {
      label: '&Help',
      submenu: [
        { label: 'Keyboard Shortcuts', accelerator: 'Shift+/', click: () => send('open-shortcuts'), registerAccelerator: false },
        {
          label: 'Google Map Tiles API',
          click: () => openExternalSafely('https://developers.google.com/maps/documentation/tile/overview')
        },
        { label: 'Cesium ion Tokens', click: () => openExternalSafely('https://ion.cesium.com/tokens') },
        { type: 'separator' },
        { label: `PhotoEarth ${app.getVersion()}`, enabled: false }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
