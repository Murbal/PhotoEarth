import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { protocol } from 'electron'
import { PHOTO_HOST, PHOTO_SCHEME } from '@shared/locations'
import { PHOTO_MIME, sniffImage, type PhotoStore } from './photos'
import { APP_HOST, APP_SCHEME, contentSecurityPolicy } from './security'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ktx2': 'image/ktx2',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.woff2': 'font/woff2'
}

/** Must run before the app is ready. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
    },
    // Reference photos of saved locations; images only (no fetch, no scripts).
    { scheme: PHOTO_SCHEME, privileges: { standard: true, secure: true } }
  ])
}

/**
 * Serves stored reference photos at `photo://local/<file>`. Only names the photo store writes
 * resolve, so nothing else on disk is reachable; the type comes from the bytes, not the name.
 */
export function handlePhotoScheme(photos: PhotoStore): void {
  protocol.handle(PHOTO_SCHEME, async (req) => {
    const url = new URL(req.url)
    const path = url.host === PHOTO_HOST ? photos.resolve(decodeURIComponent(url.pathname.slice(1))) : null
    if (!path) return new Response('Not found', { status: 404 })
    try {
      const data = await readFile(path)
      const type = sniffImage(data)
      if (!type) return new Response('Not found', { status: 404 })
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: { 'Content-Type': PHOTO_MIME[type], 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=31536000, immutable' }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

/**
 * Serves the built renderer from `app://photoearth/`. A real origin (instead of file://)
 * lets Cesium's module workers and wasm load, and gives the CSP a 'self' to refer to.
 */
export function handleAppScheme(rendererDir: string): void {
  const root = normalize(rendererDir + sep)
  const csp = contentSecurityPolicy()
  protocol.handle(APP_SCHEME, async (req) => {
    const url = new URL(req.url)
    if (url.host !== APP_HOST) return new Response('Not found', { status: 404 })
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
    const file = normalize(join(root, rel))
    if (!file.startsWith(root)) return new Response('Forbidden', { status: 403 })
    try {
      const data = await readFile(file)
      const headers: Record<string, string> = {
        'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff'
      }
      if (extname(file) === '.html') headers['Content-Security-Policy'] = csp
      return new Response(new Uint8Array(data), { status: 200, headers })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}
