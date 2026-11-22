// Renders a Moodboard (all items or current selection) onto an offscreen canvas and exports
// PNG/JPEG via Electron's native Save dialog.

import { formatLatLon } from '@shared/coords'
import { photoUrl, thumbFile } from '@shared/locations'
import { connectorBezier, worldBoundsOfItems } from '@shared/moodboards'
import type {
  Bookmark,
  CoordFormat,
  MoodboardDocument,
  MoodboardExportFormat,
  MoodboardItem,
  MoodboardNoteTint,
  Theme
} from '@shared/types'

const MAX_EXPORT_DIM = 4096
const PADDING = 48

const TINT_FILL_DARK: Record<MoodboardNoteTint, { bg: string; border: string }> = {
  neutral: { bg: '#18202c', border: 'rgba(255,255,255,0.12)' },
  amber: { bg: '#2b2214', border: 'rgba(255,181,71,0.34)' },
  blue: { bg: '#122236', border: 'rgba(79,179,255,0.34)' },
  rose: { bg: '#2e1622', border: 'rgba(251,113,133,0.34)' },
  emerald: { bg: '#122922', border: 'rgba(76,209,138,0.34)' },
  transparent: { bg: 'transparent', border: 'transparent' }
}

const TINT_FILL_LIGHT: Record<MoodboardNoteTint, { bg: string; border: string }> = {
  neutral: { bg: '#ffffff', border: 'rgba(15,23,42,0.12)' },
  amber: { bg: '#fff8eb', border: 'rgba(217,119,6,0.28)' },
  blue: { bg: '#eff7ff', border: 'rgba(31,141,224,0.28)' },
  rose: { bg: '#fff1f4', border: 'rgba(225,29,72,0.25)' },
  emerald: { bg: '#eefcf5', border: 'rgba(23,134,76,0.25)' },
  transparent: { bg: 'transparent', border: 'transparent' }
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = url
  })
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rad = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rad, y)
  ctx.arcTo(x + w, y, x + w, y + h, rad)
  ctx.arcTo(x + w, y + h, x, y + h, rad)
  ctx.arcTo(x, y + h, x, y, rad)
  ctx.arcTo(x, y, x + w, y, rad)
  ctx.closePath()
}

function drawWrappedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxY: number
): void {
  const paragraphs = text.split(/\r?\n/)
  let curY = y
  for (const para of paragraphs) {
    if (curY > maxY) break
    const words = para.split(/\s+/)
    let line = ''
    for (const word of words) {
      const test = line ? `${line} ${word}` : word
      if (ctx.measureText(test).width > maxWidth && line) {
        ctx.fillText(line, x, curY)
        curY += lineHeight
        if (curY > maxY) return
        line = word
      } else {
        line = test
      }
    }
    if (line) {
      ctx.fillText(line, x, curY)
      curY += lineHeight
    } else {
      curY += lineHeight * 0.6
    }
  }
}

export async function renderBoardToBytes(
  doc: MoodboardDocument,
  options: {
    format: MoodboardExportFormat
    theme: Theme
    coordFormat: CoordFormat
    bookmarksById: ReadonlyMap<string, Bookmark>
    selectedIds?: readonly string[]
  }
): Promise<Uint8Array | null> {
  const subset =
    options.selectedIds && options.selectedIds.length > 0
      ? doc.items.filter((i) => options.selectedIds!.includes(i.id))
      : doc.items
  const bounds = worldBoundsOfItems(subset)
  if (!bounds) return null

  const worldW = bounds.width + PADDING * 2
  const worldH = bounds.height + PADDING * 2
  const scale = Math.min(2, MAX_EXPORT_DIM / Math.max(worldW, worldH))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(worldW * scale))
  canvas.height = Math.max(1, Math.round(worldH * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const dark = options.theme === 'dark'
  const tints = dark ? TINT_FILL_DARK : TINT_FILL_LIGHT
  const textMain = dark ? '#e7edf4' : '#18212d'
  const textMuted = dark ? '#94a3b4' : '#556274'
  const accent = dark ? '#4fb3ff' : '#1f8de0'

  // Background
  ctx.fillStyle = dark ? '#0b0e14' : '#f4f6fa'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  ctx.save()
  ctx.scale(scale, scale)
  ctx.translate(-bounds.x + PADDING, -bounds.y + PADDING)

  // Preload all images needed
  const subsetIds = new Set(subset.map((i) => i.id))
  const imageCache = new Map<string, HTMLImageElement | null>()
  await Promise.all(
    subset.map(async (item) => {
      if (item.kind === 'image') {
        imageCache.set(item.id, await loadImage(photoUrl(item.photo.file)))
      } else if (item.kind === 'location') {
        const bm = options.bookmarksById.get(item.locationId)
        if (bm?.photos[0]) {
          imageCache.set(item.id, await loadImage(photoUrl(thumbFile(bm.photos[0]))))
        }
      }
    })
  )

  // 1. Groups (behind everything)
  const groups = subset.filter((i) => i.kind === 'group').sort((a, b) => a.zIndex - b.zIndex)
  for (const g of groups) {
    const t = tints[g.tint] ?? tints.neutral
    const h = g.collapsed ? 42 : g.height
    ctx.save()
    roundRectPath(ctx, g.x, g.y, g.width, h, 14)
    ctx.fillStyle = dark ? 'rgba(255,255,255,0.035)' : 'rgba(15,23,42,0.035)'
    ctx.fill()
    ctx.strokeStyle = t.border === 'transparent' ? (dark ? 'rgba(255,255,255,0.12)' : 'rgba(15,23,42,0.12)') : t.border
    ctx.lineWidth = 1.5
    ctx.stroke()
    ctx.fillStyle = textMuted
    ctx.font = '600 13px system-ui, sans-serif'
    ctx.fillText(g.title, g.x + 14, g.y + 25, g.width - 28)
    ctx.restore()
  }

  // 2. Connectors between included items
  const itemById = new Map<string, MoodboardItem>(subset.map((i) => [i.id, i]))
  for (const conn of doc.connectors) {
    if (!subsetIds.has(conn.fromId) || !subsetIds.has(conn.toId)) continue
    const from = itemById.get(conn.fromId)
    const to = itemById.get(conn.toId)
    if (!from || !to) continue
    const curve = connectorBezier(from, to)
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(curve.x1, curve.y1)
    ctx.bezierCurveTo(curve.cx1, curve.cy1, curve.cx2, curve.cy2, curve.x2, curve.y2)
    ctx.strokeStyle = accent
    ctx.lineWidth = 2
    ctx.stroke()
    if (conn.directed) {
      const ang = Math.atan2(curve.y2 - curve.cy2, curve.x2 - curve.cx2)
      const len = 10
      ctx.beginPath()
      ctx.moveTo(curve.x2, curve.y2)
      ctx.lineTo(curve.x2 - len * Math.cos(ang - 0.45), curve.y2 - len * Math.sin(ang - 0.45))
      ctx.lineTo(curve.x2 - len * Math.cos(ang + 0.45), curve.y2 - len * Math.sin(ang + 0.45))
      ctx.closePath()
      ctx.fillStyle = accent
      ctx.fill()
    }
    if (conn.label) {
      ctx.font = '500 11px system-ui, sans-serif'
      const tw = ctx.measureText(conn.label).width + 14
      roundRectPath(ctx, curve.midX - tw / 2, curve.midY - 11, tw, 22, 11)
      ctx.fillStyle = dark ? '#141922' : '#ffffff'
      ctx.fill()
      ctx.strokeStyle = dark ? 'rgba(255,255,255,0.14)' : 'rgba(15,23,42,0.14)'
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.fillStyle = textMain
      ctx.textAlign = 'center'
      ctx.fillText(conn.label, curve.midX, curve.midY + 4)
      ctx.textAlign = 'left'
    }
    ctx.restore()
  }

  // 3. Foreground cards sorted by zIndex
  const cards = subset.filter((i) => i.kind !== 'group').sort((a, b) => a.zIndex - b.zIndex)
  for (const item of cards) {
    ctx.save()
    if (item.kind === 'image') {
      const img = imageCache.get(item.id)
      const captionH = item.caption && !item.borderless ? 28 : 0
      const imgH = Math.max(20, item.height - captionH)
      roundRectPath(ctx, item.x, item.y, item.width, item.height, item.borderless ? 4 : 10)
      if (!item.borderless) {
        ctx.fillStyle = dark ? '#141922' : '#ffffff'
        ctx.fill()
      }
      ctx.save()
      roundRectPath(ctx, item.x, item.y, item.width, imgH, item.borderless ? 4 : 10)
      ctx.clip()
      if (img) {
        ctx.drawImage(img, item.x, item.y, item.width, imgH)
      } else {
        ctx.fillStyle = dark ? '#1d2430' : '#e2e8f0'
        ctx.fillRect(item.x, item.y, item.width, imgH)
      }
      ctx.restore()
      if (!item.borderless) {
        roundRectPath(ctx, item.x, item.y, item.width, item.height, 10)
        ctx.strokeStyle = dark ? 'rgba(255,255,255,0.1)' : 'rgba(15,23,42,0.1)'
        ctx.lineWidth = 1
        ctx.stroke()
        if (item.caption) {
          ctx.fillStyle = textMuted
          ctx.font = '500 11.5px system-ui, sans-serif'
          ctx.fillText(item.caption, item.x + 10, item.y + imgH + 18, item.width - 20)
        }
      }
    } else if (item.kind === 'note') {
      const t = tints[item.tint] ?? tints.neutral
      if (!item.isHeading && item.tint !== 'transparent') {
        roundRectPath(ctx, item.x, item.y, item.width, item.height, 12)
        ctx.fillStyle = t.bg
        ctx.fill()
        ctx.strokeStyle = t.border
        ctx.lineWidth = 1
        ctx.stroke()
      }
      let cursorY = item.y + 24
      if (item.title) {
        ctx.fillStyle = textMain
        ctx.font = item.isHeading ? '700 22px system-ui, sans-serif' : '600 14px system-ui, sans-serif'
        ctx.fillText(item.title, item.x + 14, cursorY, item.width - 28)
        cursorY += item.isHeading ? 28 : 20
      }
      if (item.body) {
        ctx.fillStyle = textMuted
        ctx.font = '400 12.5px system-ui, sans-serif'
        drawWrappedText(ctx, item.body, item.x + 14, cursorY, item.width - 28, 18, item.y + item.height - 12)
      }
    } else if (item.kind === 'palette') {
      roundRectPath(ctx, item.x, item.y, item.width, item.height, 12)
      ctx.fillStyle = dark ? '#141922' : '#ffffff'
      ctx.fill()
      ctx.strokeStyle = dark ? 'rgba(255,255,255,0.12)' : 'rgba(15,23,42,0.12)'
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.fillStyle = textMain
      ctx.font = '600 13px system-ui, sans-serif'
      ctx.fillText(item.title, item.x + 14, item.y + 24, item.width - 28)
      const count = Math.max(1, item.colors.length)
      const swatchY = item.y + 36
      const swatchH = Math.max(32, item.height - 68)
      const innerW = item.width - 28
      const sw = innerW / count
      item.colors.forEach((hex, idx) => {
        ctx.fillStyle = hex
        ctx.fillRect(item.x + 14 + idx * sw, swatchY, sw - 2, swatchH)
        ctx.fillStyle = textMuted
        ctx.font = '500 9.5px ui-monospace, monospace'
        ctx.fillText(hex.toUpperCase(), item.x + 14 + idx * sw, swatchY + swatchH + 14, sw - 2)
      })
    } else if (item.kind === 'location') {
      const bm = options.bookmarksById.get(item.locationId)
      roundRectPath(ctx, item.x, item.y, item.width, item.height, 12)
      ctx.fillStyle = dark ? '#141922' : '#ffffff'
      ctx.fill()
      ctx.strokeStyle = dark ? 'rgba(255,255,255,0.12)' : 'rgba(15,23,42,0.12)'
      ctx.lineWidth = 1
      ctx.stroke()
      const img = imageCache.get(item.id)
      const thumbH = Math.min(96, item.height * 0.5)
      if (img) {
        ctx.save()
        roundRectPath(ctx, item.x, item.y, item.width, thumbH, 12)
        ctx.clip()
        ctx.drawImage(img, item.x, item.y, item.width, thumbH)
        ctx.restore()
      }
      const textTop = item.y + (img ? thumbH + 20 : 26)
      ctx.fillStyle = textMain
      ctx.font = '600 13.5px system-ui, sans-serif'
      ctx.fillText(bm ? bm.name : 'Saved Location', item.x + 12, textTop, item.width - 24)
      if (bm) {
        ctx.fillStyle = textMuted
        ctx.font = '400 11px ui-monospace, monospace'
        ctx.fillText(
          formatLatLon(bm.position.latitude, bm.position.longitude, options.coordFormat),
          item.x + 12,
          textTop + 18,
          item.width - 24
        )
        if (bm.bestTime) {
          ctx.font = '400 11.5px system-ui, sans-serif'
          ctx.fillText(bm.bestTime, item.x + 12, textTop + 36, item.width - 24)
        }
      }
    }
    ctx.restore()
  }

  ctx.restore()

  const mime = options.format === 'jpg' ? 'image/jpeg' : 'image/png'
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, 0.92))
  if (!blob) return null
  return new Uint8Array(await blob.arrayBuffer())
}
