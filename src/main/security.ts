import { session, shell, type Session, type WebContents } from 'electron'
import { GOOGLE_REFERER } from './network'

export const APP_SCHEME = 'app'
export const APP_HOST = 'photoearth'
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`

/** Remote origins the renderer may talk to: Google Map Tiles and Cesium ion. */
const TILE_ORIGINS = ['https://tile.googleapis.com']
const ION_ORIGINS = ['https://api.cesium.com', 'https://assets.ion.cesium.com', 'https://assets.cesium.com']

export function contentSecurityPolicy(devServer?: string): string {
  const dev = devServer ? new URL(devServer) : null
  const devHttp = dev ? `${dev.origin}` : ''
  const devWs = dev ? `ws://${dev.host}` : ''
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    // wasm-unsafe-eval: Cesium's Draco / KTX2 decoders are WebAssembly.
    // Dev server only: React Refresh injects an inline preamble, and Vite pre-bundles all of
    // Cesium (including protobufjs, which probes modules with eval). Production builds are
    // tree-shaken and run under the strict policy.
    'script-src': ["'self'", "'wasm-unsafe-eval'", ...(dev ? ["'unsafe-inline'", "'unsafe-eval'", devHttp] : [])],
    'worker-src': ["'self'", 'blob:'],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:', ...TILE_ORIGINS, ...ION_ORIGINS],
    'connect-src': ["'self'", 'data:', 'blob:', ...TILE_ORIGINS, ...ION_ORIGINS, ...(dev ? [devHttp, devWs] : [])],
    'font-src': ["'self'", 'data:'],
    'media-src': ["'none'"],
    'object-src': ["'none'"],
    'frame-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'none'"],
    'frame-ancestors': ["'none'"]
  }
  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(' ')}`)
    .join('; ')
}

const ALLOWED_PERMISSIONS = new Set(['pointerLock', 'clipboard-sanitized-write', 'fullscreen'])

const GOOGLE_REQUESTS = { urls: ['https://*.googleapis.com/*'] }
const refererHooked = new WeakMap<Session, boolean>()

/**
 * Fixed Referer for Google origins so referrer-restricted keys can work from app://. The hook
 * makes every matching request (each 3D tile) wait on this process's JS thread, so it's only
 * installed while the key may need it (see mapTilesNeedsReferer).
 */
export function setGoogleRefererHook(ses: Session, enabled: boolean): void {
  if ((refererHooked.get(ses) ?? false) === enabled) return
  refererHooked.set(ses, enabled)
  ses.webRequest.onBeforeSendHeaders(
    GOOGLE_REQUESTS,
    enabled
      ? (details, callback) => callback({ requestHeaders: { ...details.requestHeaders, Referer: GOOGLE_REFERER } })
      : null
  )
}

export function hardenSession(ses: Session, devServer?: string): void {
  // On until a probe shows the key works without it.
  setGoogleRefererHook(ses, true)

  if (devServer) {
    const origin = new URL(devServer).origin
    const csp = contentSecurityPolicy(devServer)
    ses.webRequest.onHeadersReceived({ urls: [`${origin}/*`] }, (details, callback) => {
      callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } })
    })
  }

  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)))
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission))
}

function isAppUrl(url: string, devServer?: string): boolean {
  return url.startsWith(`${APP_ORIGIN}/`) || (!!devServer && url.startsWith(devServer))
}

export function openExternalSafely(url: string): void {
  try {
    const { protocol } = new URL(url)
    if (protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:') void shell.openExternal(url)
  } catch {
    /* ignore malformed URLs */
  }
}

export function hardenWebContents(contents: WebContents, devServer?: string): void {
  contents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url, devServer)) {
      event.preventDefault()
      openExternalSafely(url)
    }
  })
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url)
    return { action: 'deny' }
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
}

export { session }
