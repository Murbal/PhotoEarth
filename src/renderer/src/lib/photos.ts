import { THUMB_HEIGHT } from '@shared/locations'

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
 * A small JPEG thumbnail of an image file. The decode and resize run off the main thread
 * (createImageBitmap), so even a large photo doesn't stall the map; the original's full-size
 * pixels are never held by the page.
 */
export async function makeThumbnail(file: Blob): Promise<{ thumb: Uint8Array; width: number; height: number }> {
  const url = URL.createObjectURL(file)
  try {
    const { width, height } = await displaySize(url)
    if (!width || !height) throw new Error('empty image')
    const h = Math.min(THUMB_HEIGHT, height)
    // A very wide panorama stays legible but bounded.
    const w = Math.max(1, Math.min(THUMB_HEIGHT * 4, Math.round((width / height) * h)))
    const bitmap = await createImageBitmap(file, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high', imageOrientation: 'from-image' })
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
