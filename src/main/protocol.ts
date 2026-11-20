import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { protocol } from 'electron'
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
    }
  ])
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
