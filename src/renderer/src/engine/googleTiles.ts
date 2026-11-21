import type { ImageryType } from '@shared/types'

/** Google Map Tiles API: 2D tile sessions, tiles and viewport attribution (SPEC §3.1). */
export const TILES_ENDPOINT = 'https://tile.googleapis.com'

/** The Google logo Cesium credits Google data with (the CSP allows assets.ion.cesium.com). */
export const GOOGLE_LOGO_URL = 'https://assets.ion.cesium.com/google-credit.png'

export interface TileSessionOptions {
  /** Overlay the roadmap's roads and labels on satellite imagery (hybrid). */
  labels?: boolean
  /** 2× tiles (same coverage, twice the pixels) for dense displays. */
  highDpi?: boolean
}

export interface TileSession {
  token: string
  /** Epoch ms. */
  expiry: number
  tileWidth: number
  tileHeight: number
}

/** Thrown when a session can't be created: HTTP status (0 offline) and response body. */
export interface TileSessionError {
  statusCode: number
  response: string
}

export function sessionBody(mapType: ImageryType, opts: TileSessionOptions = {}): Record<string, unknown> {
  const body: Record<string, unknown> = { mapType, language: 'en-US', region: 'US' }
  // The terrain map type requires the roadmap layer; on satellite it is optional (hybrid).
  if (mapType === 'terrain' || (mapType === 'satellite' && opts.labels)) body.layerTypes = ['layerRoadmap']
  if (opts.highDpi) {
    body.scale = 'scaleFactor2x'
    body.highDpi = true
  }
  return body
}

export async function createTileSession(key: string, mapType: ImageryType, opts: TileSessionOptions = {}): Promise<TileSession> {
  const res = await fetch(`${TILES_ENDPOINT}/v1/createSession?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sessionBody(mapType, opts))
  }).catch(() => null)
  if (!res) throw { statusCode: 0, response: '' } satisfies TileSessionError
  const text = await res.text()
  if (!res.ok) throw { statusCode: res.status, response: text } satisfies TileSessionError
  const json = JSON.parse(text) as { session: string; expiry: string; tileWidth: number; tileHeight: number }
  return {
    token: json.session,
    expiry: Number(json.expiry) * 1000,
    tileWidth: json.tileWidth || 256,
    tileHeight: json.tileHeight || 256
  }
}

/** URL template of a session's tiles (`{z}`, `{x}`, `{y}`). */
export function tileTemplate(session: TileSession, key: string): string {
  return `${TILES_ENDPOINT}/v1/2dtiles/{z}/{x}/{y}?session=${encodeURIComponent(session.token)}&key=${encodeURIComponent(key)}`
}

/** When to renew a session: an hour before it expires (setTimeout can't wait past ~24.8 days). */
export function renewalDelay(session: TileSession, now = Date.now()): number {
  return Math.min(Math.max(session.expiry - now - 3600_000, 60_000), 2_000_000_000)
}

export interface ViewportBounds {
  north: number
  south: number
  east: number
  west: number
}

/** A cache key for a viewport query (4 decimals, whole zoom). */
export function viewportKey(b: ViewportBounds, zoom: number): string {
  return [Math.min(85, b.north), Math.max(-85, b.south), b.east, b.west].map((v) => v.toFixed(4)).join(',') + `@${Math.round(zoom)}`
}

/**
 * The copyright line for what a viewport shows, from the session's viewport endpoint.
 * Null when there is nothing to credit; undefined when the request failed.
 */
export async function viewportCopyright(
  session: TileSession,
  key: string,
  b: ViewportBounds,
  zoom: number
): Promise<string | null | undefined> {
  const params = new URLSearchParams({
    session: session.token,
    key,
    zoom: String(Math.max(0, Math.min(22, Math.round(zoom)))),
    north: Math.min(85, b.north).toFixed(6),
    south: Math.max(-85, b.south).toFixed(6),
    east: b.east.toFixed(6),
    west: b.west.toFixed(6)
  })
  try {
    const res = await fetch(`${TILES_ENDPOINT}/tile/v1/viewport?${params.toString()}`)
    if (!res.ok) return undefined
    const json = (await res.json()) as { copyright?: string }
    return json.copyright ? json.copyright : null
  } catch {
    return undefined
  }
}
