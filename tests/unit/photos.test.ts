import { describe, expect, it } from 'vitest'
import { THUMB_HEIGHT, THUMB_MAX_WIDTH } from '@shared/locations'
import { thumbnailSize } from '@renderer/lib/photos'

describe('thumbnailSize', () => {
  it('makes a normal landscape photo THUMB_HEIGHT high at its aspect ratio', () => {
    expect(thumbnailSize(6000, 4000)).toEqual({ width: 360, height: THUMB_HEIGHT })
    expect(thumbnailSize(1920, 1080)).toEqual({ width: 427, height: THUMB_HEIGHT })
  })

  it('makes a portrait photo THUMB_HEIGHT high and narrower', () => {
    expect(thumbnailSize(4000, 6000)).toEqual({ width: 160, height: THUMB_HEIGHT })
  })

  it('never enlarges an image shorter than THUMB_HEIGHT', () => {
    expect(thumbnailSize(200, 100)).toEqual({ width: 200, height: 100 })
    expect(thumbnailSize(50, 120)).toEqual({ width: 50, height: 120 })
  })

  it('keeps an exactly 4:1 panorama at full height and the maximum width', () => {
    expect(thumbnailSize(8000, 2000)).toEqual({ width: THUMB_MAX_WIDTH, height: THUMB_HEIGHT })
  })

  it('makes a panorama wider than 4:1 shorter instead of squashing it', () => {
    expect(thumbnailSize(20000, 2000)).toEqual({ width: THUMB_MAX_WIDTH, height: 96 })
    // Already shorter than THUMB_HEIGHT, and still too wide.
    expect(thumbnailSize(2000, 200)).toEqual({ width: THUMB_MAX_WIDTH, height: 96 })
  })

  it('keeps at least 1 px on each side for extreme shapes', () => {
    expect(thumbnailSize(5000, 1)).toEqual({ width: THUMB_MAX_WIDTH, height: 1 })
    expect(thumbnailSize(500, 1)).toEqual({ width: 500, height: 1 })
    expect(thumbnailSize(1, 10000)).toEqual({ width: 1, height: THUMB_HEIGHT })
  })

  it('preserves the aspect ratio to within rounding', () => {
    for (const [w, h] of [
      [6000, 4000],
      [4000, 6000],
      [8000, 2000],
      [20000, 2000],
      [12345, 1000],
      [30000, 1500]
    ]) {
      const t = thumbnailSize(w, h)
      expect(t.width).toBeLessThanOrEqual(THUMB_MAX_WIDTH)
      expect(t.height).toBeLessThanOrEqual(THUMB_HEIGHT)
      // Rounding one side by at most half a pixel.
      expect(Math.abs(t.width / t.height - w / h)).toBeLessThan((0.5 / Math.min(t.width, t.height)) * (w / h) + 1e-9)
    }
  })
})
