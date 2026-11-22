import { BrowserWindow, clipboard, Menu, nativeImage, session, WebContentsView } from 'electron'
import { IPC } from '@shared/ipc'
import { MAX_PHOTO_BYTES, THUMB_HEIGHT, THUMB_MAX_WIDTH } from '@shared/locations'
import { decodeImageDataUrl, DEFAULT_INSPIRATION_URL, normalizeBrowserInput, safeImageReferer } from '@shared/moodboards'
import type { BrowserDrawerBounds, BrowserDrawerImageAdded, BrowserDrawerState } from '@shared/types'
import { PHOTO_MIME, PhotoError, PhotoStore, sniffImage } from './photos'
import { openExternalSafely } from './security'

export const INSPIRATION_PARTITION = 'persist:inspiration-browser'

const FETCH_TIMEOUT_MS = 15_000

/** Computes JPEG thumbnail dimensions matching `renderer/src/lib/photos.ts`. */
function thumbDimensions(width: number, height: number): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 1, height: 1 }
  const h = Math.min(THUMB_HEIGHT, height)
  const w = (width / height) * h
  if (w <= THUMB_MAX_WIDTH) return { width: Math.max(1, Math.round(w)), height: h }
  return { width: THUMB_MAX_WIDTH, height: Math.max(1, Math.round((THUMB_MAX_WIDTH * height) / width)) }
}

function fileNameFromUrl(srcUrl: string, fallbackExt: string): string {
  try {
    const pathname = new URL(srcUrl).pathname
    const seg = pathname.split('/').filter(Boolean).pop()
    if (seg && seg.length <= 120) return decodeURIComponent(seg)
  } catch {
    /* ignore */
  }
  return `inspiration.${fallbackExt}`
}

/**
 * Manages the docked Inspiration Browser (`WebContentsView`) for the Moodboard module.
 * Runs in an isolated persistent session partition (`persist:inspiration-browser`) with strict
 * sandbox and no preload script, completely separated from PhotoEarth's main session and API keys.
 */
export class BrowserDrawerController {
  private view: WebContentsView | null = null
  private attachedWindow: BrowserWindow | null = null
  private visible = false
  private bounds: BrowserDrawerBounds = { x: 0, y: 0, width: 0, height: 0 }
  private initialLoaded = false
  private sessionHardened = false

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly photos: PhotoStore
  ) {}

  setVisible(visible: boolean): void {
    this.visible = visible
    if (!visible) {
      if (this.view) {
        this.view.setVisible(false)
      }
      return
    }
    const view = this.ensureView()
    if (!view) return
    view.setBounds(this.bounds)
    view.setVisible(true)
    if (!this.initialLoaded) {
      this.initialLoaded = true
      void view.webContents.loadURL(DEFAULT_INSPIRATION_URL)
    }
    this.emitState()
  }

  setBounds(bounds: BrowserDrawerBounds): void {
    const clean: BrowserDrawerBounds = {
      x: Math.max(0, Math.round(bounds.x)),
      y: Math.max(0, Math.round(bounds.y)),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height))
    }
    this.bounds = clean
    if (this.view) {
      this.view.setBounds(clean)
    }
  }

  navigate(urlOrQuery: string): void {
    const url = normalizeBrowserInput(urlOrQuery)
    const view = this.ensureView()
    if (!view) return
    this.initialLoaded = true
    void view.webContents.loadURL(url)
  }

  goBack(): void {
    if (this.view?.webContents.navigationHistory.canGoBack()) {
      this.view.webContents.navigationHistory.goBack()
    }
  }

  goForward(): void {
    if (this.view?.webContents.navigationHistory.canGoForward()) {
      this.view.webContents.navigationHistory.goForward()
    }
  }

  reload(): void {
    this.view?.webContents.reload()
  }

  destroy(): void {
    if (this.view && this.attachedWindow && !this.attachedWindow.isDestroyed()) {
      try {
        this.attachedWindow.contentView.removeChildView(this.view)
      } catch {
        /* ignore */
      }
    }
    if (this.view) {
      try {
        this.view.webContents.close()
      } catch {
        /* ignore */
      }
    }
    this.view = null
    this.attachedWindow = null
    this.visible = false
    this.initialLoaded = false
  }

  private ensureView(): WebContentsView | null {
    const win = this.getWindow()
    if (!win || win.isDestroyed()) return null
    if (this.view && this.attachedWindow === win && !this.view.webContents.isDestroyed()) {
      return this.view
    }
    this.destroy()

    const ses = session.fromPartition(INSPIRATION_PARTITION)
    if (!this.sessionHardened) {
      this.sessionHardened = true
      const allowed = new Set(['clipboard-sanitized-write'])
      ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)))
      ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission))
    }

    const view = new WebContentsView({
      webPreferences: {
        partition: INSPIRATION_PARTITION,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true
      }
    })
    const wc = view.webContents

    // Only allow normal http(s) browsing inside the drawer; open target=_blank in the same view.
    wc.on('will-navigate', (event, url) => {
      if (!/^https?:\/\//i.test(url)) event.preventDefault()
    })
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void wc.loadURL(url)
      return { action: 'deny' }
    })
    wc.on('will-attach-webview', (event) => event.preventDefault())

    wc.on('did-start-loading', () => this.emitState())
    wc.on('did-stop-loading', () => this.emitState())
    wc.on('did-navigate', () => this.emitState())
    wc.on('did-navigate-in-page', () => this.emitState())
    wc.on('page-title-updated', () => this.emitState())

    wc.on('context-menu', (_event, params) => {
      const items: Electron.MenuItemConstructorOptions[] = []
      if (params.mediaType === 'image' && params.srcURL) {
        const srcURL = params.srcURL
        const pageURL = params.pageURL || wc.getURL()
        const pageTitle = wc.getTitle()
        const clickX = params.x
        const clickY = params.y
        items.push(
          {
            label: 'Add image to Moodboard',
            click: () => void this.captureImage(srcURL, pageURL, pageTitle, clickX, clickY)
          },
          {
            label: 'Copy image',
            click: () => wc.copyImageAt(clickX, clickY)
          },
          { type: 'separator' }
        )
      }
      if (params.linkURL && /^https?:\/\//i.test(params.linkURL)) {
        const link = params.linkURL
        items.push({
          label: 'Open link in external browser',
          click: () => openExternalSafely(link)
        })
      }
      if (params.selectionText) {
        items.push({ role: 'copy' })
      }
      if (items.length > 0) items.push({ type: 'separator' })
      items.push(
        { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
        { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
        { label: 'Reload', click: () => wc.reload() }
      )
      const menu = Menu.buildFromTemplate(items)
      const hostWin = this.getWindow()
      if (hostWin && !hostWin.isDestroyed()) menu.popup({ window: hostWin })
    })

    win.contentView.addChildView(view)
    view.setBounds(this.bounds)
    view.setVisible(this.visible)
    this.view = view
    this.attachedWindow = win
    return view
  }

  private emitState(): void {
    const win = this.getWindow()
    if (!win || win.isDestroyed() || !this.view || this.view.webContents.isDestroyed()) return
    const wc = this.view.webContents
    const state: BrowserDrawerState = {
      url: wc.getURL(),
      title: wc.getTitle(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      loading: wc.isLoading()
    }
    win.webContents.send(IPC.browserDrawerState, state)
  }

  private emitError(message: string): void {
    const win = this.getWindow()
    if (!win || win.isDestroyed()) return
    win.webContents.send(IPC.browserDrawerError, message)
  }

  private async fetchImageBytes(srcUrl: string, pageUrl: string): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: string }> {
    if (!this.view || this.view.webContents.isDestroyed()) {
      return { ok: false, error: 'Inspiration Browser is not open.' }
    }
    const wc = this.view.webContents
    const ses = wc.session
    const referer = safeImageReferer(srcUrl, pageUrl)
    const userAgent = wc.getUserAgent()

    const attempt = async (withReferer: boolean): Promise<Response> => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
      try {
        const headers: Record<string, string> = {
          Accept: 'image/avif,image/webp,image/apng,image/jpeg,image/png,*/*;q=0.8'
        }
        if (userAgent) headers['User-Agent'] = userAgent
        if (withReferer && referer) headers.Referer = referer
        return await ses.fetch(srcUrl, {
          headers,
          credentials: 'include',
          signal: controller.signal
        })
      } finally {
        clearTimeout(timer)
      }
    }

    let res: Response
    try {
      res = await attempt(!!referer)
      if (!res.ok && referer && (res.status === 403 || res.status === 401 || res.status === 400)) {
        res = await attempt(false)
      }
    } catch (err) {
      if (referer) {
        // Retry once without Referer in case a CDN or policy rejected the Referer header.
        res = await attempt(false)
      } else {
        throw err
      }
    }

    if (!res.ok) {
      return { ok: false, error: `Could not download image (HTTP ${res.status}).` }
    }
    const contentLen = Number(res.headers.get('content-length') ?? 0)
    if (contentLen > MAX_PHOTO_BYTES) {
      return { ok: false, error: `Image exceeds the ${MAX_PHOTO_BYTES / (1024 * 1024)} MB limit.` }
    }
    const buf = await res.arrayBuffer()
    if (buf.byteLength > MAX_PHOTO_BYTES) {
      return { ok: false, error: `Image exceeds the ${MAX_PHOTO_BYTES / (1024 * 1024)} MB limit.` }
    }
    return { ok: true, bytes: new Uint8Array(buf) }
  }

  /**
   * Fallback for blob: URLs or hotlink/WAF-blocked images: uses Blink's built-in `copyImageAt`
   * to read the already-decoded image at the right-clicked point, restoring prior clipboard text.
   */
  private async captureViaRenderedBitmap(x: number, y: number): Promise<Uint8Array | null> {
    if (!this.view || this.view.webContents.isDestroyed()) return null
    const prevText = await clipboard.readText().catch(() => '')
    try {
      clipboard.clear()
      this.view.webContents.copyImageAt(x, y)
      const deadline = Date.now() + 800
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 40))
        const items = await clipboard.read()
        for (const item of items) {
          const imageType = item.types.find((t) => t === 'image/png' || t === 'image/jpeg' || t === 'image/webp')
          if (!imageType) continue
          const blob = await item.getType(imageType)
          if (blob instanceof Blob && blob.size > 0 && blob.size <= MAX_PHOTO_BYTES) {
            return new Uint8Array(await blob.arrayBuffer())
          }
        }
      }
      return null
    } catch {
      return null
    } finally {
      if (prevText) await clipboard.writeText(prevText).catch(() => {})
    }
  }

  private saveNativeImageAndSend(
    img: Electron.NativeImage,
    bytes: Uint8Array,
    name: string,
    sourceUrl: string,
    sourceTitle: string
  ): void {
    const win = this.getWindow()
    if (!win || win.isDestroyed()) return
    const size = img.getSize()
    const tSize = thumbDimensions(size.width, size.height)
    const resized = img.resize({ width: tSize.width, height: tSize.height, quality: 'good' })
    const thumbBuf = resized.toJPEG(82)
    const thumb = new Uint8Array(thumbBuf.buffer, thumbBuf.byteOffset, thumbBuf.byteLength)

    const photo = this.photos.save({
      name,
      data: bytes,
      thumb,
      width: size.width,
      height: size.height
    })
    const payload: BrowserDrawerImageAdded = { kind: 'photo', photo, sourceUrl, sourceTitle }
    win.webContents.send(IPC.browserDrawerImageAdded, payload)
  }

  private async captureImage(
    srcUrl: string,
    pageUrl: string,
    pageTitle: string,
    clickX: number,
    clickY: number
  ): Promise<void> {
    if (!this.view || this.view.webContents.isDestroyed()) return
    const sourceUrl = /^https?:\/\//i.test(pageUrl) ? pageUrl : ''
    const sourceTitle = pageTitle.slice(0, 300)

    try {
      let bytes: Uint8Array | null = null
      let fetchError: string | null = null

      if (srcUrl.startsWith('data:')) {
        bytes = decodeImageDataUrl(srcUrl)
        if (!bytes) fetchError = 'That inline image could not be decoded or is too large.'
      } else if (/^https?:\/\//i.test(srcUrl)) {
        try {
          const fetched = await this.fetchImageBytes(srcUrl, pageUrl)
          if (fetched.ok) bytes = fetched.bytes
          else fetchError = fetched.error
        } catch (err) {
          console.warn('[photoearth] Direct image fetch failed, trying rendered bitmap fallback:', err)
          fetchError = err instanceof Error ? err.message : 'Download failed'
        }
      }

      const type = bytes ? sniffImage(bytes) : null
      if (bytes && type) {
        const name = fileNameFromUrl(srcUrl, type)
        const img = nativeImage.createFromBuffer(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
        if (!img.isEmpty()) {
          // Fast path for JPEG/PNG: decode & thumbnail directly in main process.
          this.saveNativeImageAndSend(img, bytes, name, sourceUrl, sourceTitle)
          return
        }
        // WebP / GIF / AVIF: forward validated bytes to renderer so Chromium's createImageBitmap
        // generates the JPEG thumbnail and saves the full-res original.
        const win = this.getWindow()
        if (win && !win.isDestroyed()) {
          const payload: BrowserDrawerImageAdded = {
            kind: 'raw',
            data: bytes,
            mimeType: PHOTO_MIME[type],
            name,
            sourceUrl,
            sourceTitle
          }
          win.webContents.send(IPC.browserDrawerImageAdded, payload)
        }
        return
      }

      // Fallback: grab the already-rendered image bitmap at the clicked coordinates (handles
      // blob: URLs, hotlink-protected CDNs, Cloudflare challenges, or unsupported wrappers).
      const renderedBytes = await this.captureViaRenderedBitmap(clickX, clickY)
      const renderedType = renderedBytes ? sniffImage(renderedBytes) : null
      if (renderedBytes && renderedType) {
        const renderedImg = nativeImage.createFromBuffer(
          Buffer.from(renderedBytes.buffer, renderedBytes.byteOffset, renderedBytes.byteLength)
        )
        if (!renderedImg.isEmpty()) {
          this.saveNativeImageAndSend(
            renderedImg,
            renderedBytes,
            fileNameFromUrl(srcUrl, renderedType),
            sourceUrl,
            sourceTitle
          )
          return
        }
      }

      this.emitError(
        fetchError
          ? `${fetchError} Try "Copy image" and paste onto the canvas.`
          : 'Could not save that image. Try "Copy image" and paste onto the canvas.'
      )
    } catch (err) {
      if (err instanceof PhotoError) {
        this.emitError(err.message)
      } else {
        console.error('[photoearth] Inspiration Browser image capture failed:', err)
        this.emitError('Could not save that image. Try "Copy image" and paste onto the canvas.')
      }
    }
  }
}
