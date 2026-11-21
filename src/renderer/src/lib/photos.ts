import { THUMB_HEIGHT, THUMB_MAX_WIDTH } from '@shared/locations'

/** Pixel size as shown (EXIF orientation applied), read from the header without decoding the image. */
function displaySize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => reject(new Error('not an image'))
    img.src = url
  })
}

/**
 * The thumbnail's pixel size for an image shown at `width` × `height`: THUMB_HEIGHT high (or
 * the image's own height, if smaller, so nothing is enlarged), at the image's aspect ratio. A
 * panorama wider than 4:1 would be wider than THUMB_MAX_WIDTH, so it is capped at that width and
 * gets a proportionally shorter thumbnail (at least 1 px) instead of being squashed.
 */
export function thumbnailSize(width: number, height: number): { width: number; height: number } {
  const h = Math.min(THUMB_HEIGHT, height)
  const w = (width / height) * h
  if (w <= THUMB_MAX_WIDTH) return { width: Math.max(1, Math.round(w)), height: h }
  return { width: THUMB_MAX_WIDTH, height: Math.max(1, Math.round((THUMB_MAX_WIDTH * height) / width)) }
}

/**
 * A small JPEG thumbnail of an image file. The decode and resize run off the main thread
 * (createImageBitmap), so even a large photo doesn't stall the map; the original's full-size
 * pixels are never held by the page.
 */
export async function makeThumbnail(file: Blob): Promise<{ thumb: Uint8Array; width: number; height: number }> {
  const url = URL.createObjectURL(file)
  try {
    const { width, height } = await displaySize(url)
    if (!width || !height) throw new Error('empty image')
    const size = thumbnailSize(width, height)
    const bitmap = await createImageBitmap(file, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'high', imageOrientation: 'from-image' })
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('no 2d context')
      // JPEG has no alpha: transparent areas go dark like the panel, not black.
      ctx.fillStyle = '#141922'
      ctx.fillRect(0, 0, bitmap.width, bitmap.height)
      ctx.drawImage(bitmap, 0, 0)
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 })
      return { thumb: new Uint8Array(await blob.arrayBuffer()), width, height }
    } finally {
      bitmap.close()
    }
  } finally {
    URL.revokeObjectURL(url)
  }
}
