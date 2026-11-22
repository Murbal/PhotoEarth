// 100% local color palette extraction using downscaled canvas sampling + median-cut quantization.
// Zero external dependencies or network calls.

interface Rgb {
  r: number
  g: number
  b: number
}

function toHex(c: Rgb): string {
  const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`
}

function rgbDistSq(a: Rgb, b: Rgb): number {
  const dr = a.r - b.r
  const dg = a.g - b.g
  const db = a.b - b.b
  // Perceptual weights (redmean approximation)
  return 2 * dr * dr + 4 * dg * dg + 3 * db * db
}

function luminance(c: Rgb): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
}

function bucketRange(pixels: Rgb[]): { channel: 'r' | 'g' | 'b'; range: number } {
  let minR = 255
  let maxR = 0
  let minG = 255
  let maxG = 0
  let minB = 255
  let maxB = 0
  for (const p of pixels) {
    if (p.r < minR) minR = p.r
    if (p.r > maxR) maxR = p.r
    if (p.g < minG) minG = p.g
    if (p.g > maxG) maxG = p.g
    if (p.b < minB) minB = p.b
    if (p.b > maxB) maxB = p.b
  }
  const rr = maxR - minR
  const gr = maxG - minG
  const br = maxB - minB
  if (rr >= gr && rr >= br) return { channel: 'r', range: rr }
  if (gr >= rr && gr >= br) return { channel: 'g', range: gr }
  return { channel: 'b', range: br }
}

function averageColor(pixels: Rgb[]): Rgb {
  let r = 0
  let g = 0
  let b = 0
  for (const p of pixels) {
    r += p.r
    g += p.g
    b += p.b
  }
  const n = pixels.length || 1
  return { r: r / n, g: g / n, b: b / n }
}

/**
 * Extracts `count` (3–8) representative hex colors from raw RGBA pixel data via median-cut
 * quantization. Pure function suitable for unit testing without a DOM.
 */
export function extractPaletteFromPixels(rgba: Uint8ClampedArray | Uint8Array, count = 5): string[] {
  const target = Math.max(3, Math.min(8, Math.round(count)))
  const pixels: Rgb[] = []
  // Sample stride keeps extraction sub-10ms even if given larger buffers.
  const totalPixels = Math.floor(rgba.length / 4)
  const stride = Math.max(1, Math.floor(totalPixels / 16384))
  for (let i = 0; i < totalPixels; i += stride) {
    const off = i * 4
    const alpha = rgba[off + 3]
    if (alpha < 128) continue
    pixels.push({ r: rgba[off], g: rgba[off + 1], b: rgba[off + 2] })
  }
  if (pixels.length === 0) {
    return ['#1b2a41', '#3b5978', '#d97736', '#f2b866', '#e8dfd1'].slice(0, target)
  }

  // Over-sample buckets slightly, then deduplicate overly similar colors for visual variety.
  const desiredBuckets = Math.min(pixels.length, target * 2)
  const buckets: Rgb[][] = [pixels]
  while (buckets.length < desiredBuckets) {
    let bestIdx = -1
    let bestScore = -1
    let bestChannel: 'r' | 'g' | 'b' = 'r'
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i]
      if (b.length < 2) continue
      const { channel, range } = bucketRange(b)
      if (range === 0) continue
      const score = range * Math.sqrt(b.length)
      if (score > bestScore) {
        bestScore = score
        bestIdx = i
        bestChannel = channel
      }
    }
    if (bestIdx < 0) break
    const chosen = buckets.splice(bestIdx, 1)[0]
    chosen.sort((a, b) => a[bestChannel] - b[bestChannel])
    const mid = Math.floor(chosen.length / 2)
    buckets.push(chosen.slice(0, mid), chosen.slice(mid))
  }

  // Rank candidate buckets by pixel population, pick visually distinct swatches.
  const candidates = buckets
    .map((b) => ({ color: averageColor(b), weight: b.length }))
    .sort((a, b) => b.weight - a.weight)

  const picked: Rgb[] = []
  const minDistSq = 28 * 28 * 9 // perceptual threshold
  for (const cand of candidates) {
    if (picked.every((p) => rgbDistSq(p, cand.color) >= minDistSq)) {
      picked.push(cand.color)
      if (picked.length >= target) break
    }
  }
  // Fill remaining slots if the image is very monochromatic.
  if (picked.length < target) {
    for (const cand of candidates) {
      const hex = toHex(cand.color)
      if (!picked.some((p) => toHex(p) === hex)) {
        picked.push(cand.color)
        if (picked.length >= target) break
      }
    }
  }

  // Sort from darkest to lightest for a clean editorial color story strip.
  picked.sort((a, b) => luminance(a) - luminance(b))
  const unique = Array.from(new Set(picked.map(toHex)))
  return unique.length > 0 ? unique : ['#1b2a41', '#3b5978', '#e8dfd1']
}

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not decode image'))
    img.src = url
  })
}

const SAMPLE_MAX = 128

/** Extracts a dominant color palette from one or more image URLs (e.g. `photo://local/...`). */
export async function extractPaletteFromImages(urls: readonly string[], count = 5): Promise<string[]> {
  if (urls.length === 0) return ['#1b2a41', '#3b5978', '#d97736', '#f2b866', '#e8dfd1']
  const loaded: HTMLImageElement[] = []
  for (const url of urls.slice(0, 12)) {
    try {
      loaded.push(await loadImageElement(url))
    } catch {
      /* skip broken image */
    }
  }
  if (loaded.length === 0) throw new Error('Could not load image for palette extraction.')

  const perImgSize = Math.max(48, Math.floor(SAMPLE_MAX / Math.sqrt(loaded.length)))
  const canvas = document.createElement('canvas')
  canvas.width = perImgSize * loaded.length
  canvas.height = perImgSize
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('2D canvas unavailable')

  let offsetX = 0
  for (const img of loaded) {
    const scale = Math.min(perImgSize / Math.max(1, img.naturalWidth), perImgSize / Math.max(1, img.naturalHeight), 1)
    const w = Math.max(1, Math.round(img.naturalWidth * scale))
    const h = Math.max(1, Math.round(img.naturalHeight * scale))
    ctx.drawImage(img, offsetX, 0, w, h)
    offsetX += perImgSize
  }
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  return extractPaletteFromPixels(data, count)
}
