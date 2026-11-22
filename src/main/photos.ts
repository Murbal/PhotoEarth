import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_PHOTO_BYTES, MAX_THUMB_BYTES, PHOTO_FILE, sanitizeName, thumbFile } from '@shared/locations'
import type { LocationPhoto } from '@shared/types'

export type PhotoType = 'jpg' | 'png' | 'webp' | 'gif' | 'avif'

export const PHOTO_MIME: Record<PhotoType, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif'
}

const ascii = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end))

/** The image type from the file's first bytes (never from its name). */
export function sniffImage(bytes: Uint8Array): PhotoType | null {
  if (bytes.length < 12) return null
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  if (bytes[0] === 0x89 && ascii(bytes, 1, 4) === 'PNG' && bytes[4] === 0x0d && bytes[5] === 0x0a) return 'png'
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return 'gif'
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'webp'
  if (ascii(bytes, 4, 8) === 'ftyp') {
    const major = ascii(bytes, 8, 12)
    if (major === 'avif' || major === 'avis') return 'avif'
    if (major === 'mif1' || major === 'msf1') {
      const end = Math.min(bytes.length, 64)
      for (let i = 16; i + 4 <= end; i += 4) {
        const brand = ascii(bytes, i, i + 4)
        if (brand === 'avif' || brand === 'avis') return 'avif'
      }
    }
  }
  return null
}

export interface PhotoInput {
  name: unknown
  data: unknown
  thumb: unknown
  width: unknown
  height: unknown
}

/** IPC delivers typed arrays as Uint8Array, but accept a bare ArrayBuffer too. */
export function asBytes(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v
  if (v instanceof ArrayBuffer) return new Uint8Array(v)
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
  return null
}

export class PhotoError extends Error {}

const MB = 1024 * 1024

/**
 * Reference photos live in their own directory under userData: copied in on import, served
 * read-only to the renderer by the photo:// scheme, and deleted with their location.
 */
export class PhotoStore {
  constructor(readonly dir: string) {}

  /** Validates and writes an original and its thumbnail. Throws PhotoError with a user-facing message. */
  save(input: PhotoInput): LocationPhoto {
    const data = asBytes(input.data)
    const thumb = asBytes(input.thumb)
    if (!data || !thumb) throw new PhotoError('The photo could not be read.')
    if (data.byteLength > MAX_PHOTO_BYTES) {
      throw new PhotoError(`Photos can be at most ${MAX_PHOTO_BYTES / MB} MB (this one is ${(data.byteLength / MB).toFixed(1)} MB).`)
    }
    const type = sniffImage(data)
    if (!type) throw new PhotoError('Only JPEG, PNG, WebP, GIF and AVIF images can be added.')
    if (thumb.byteLength > MAX_THUMB_BYTES || sniffImage(thumb) !== 'jpg') throw new PhotoError('The photo could not be read.')
    const dim = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100_000, Math.round(v))) : 0)
    const id = randomUUID()
    const photo: LocationPhoto = {
      id,
      file: `${id}.${type}`,
      name: sanitizeName(input.name, `photo.${type}`).slice(0, 260),
      bytes: data.byteLength,
      width: dim(input.width),
      height: dim(input.height),
      addedAt: new Date().toISOString()
    }
    mkdirSync(this.dir, { recursive: true })
    this.write(photo.file, data)
    try {
      this.write(thumbFile(photo), thumb)
    } catch (err) {
      this.remove(photo)
      throw err
    }
    return photo
  }

  remove(photo: Pick<LocationPhoto, 'id' | 'file'>): void {
    for (const file of [photo.file, thumbFile(photo)]) {
      if (PHOTO_FILE.test(file)) rmSync(join(this.dir, file), { force: true })
    }
  }

  /**
   * Duplicates an already-stored photo under a fresh UUID so another store (e.g. a project
   * cover picked from a location) owns an independent copy that survives deletions of the source.
   */
  clone(source: Pick<LocationPhoto, 'id' | 'file' | 'name' | 'width' | 'height'>): LocationPhoto {
    const srcPath = this.resolve(source.file)
    const srcThumbPath = this.resolve(thumbFile(source))
    if (!srcPath || !srcThumbPath || !existsSync(srcPath) || !existsSync(srcThumbPath)) {
      throw new PhotoError('The source photo is no longer available.')
    }
    const data = new Uint8Array(readFileSync(srcPath))
    const thumb = new Uint8Array(readFileSync(srcThumbPath))
    return this.save({ name: source.name, data, thumb, width: source.width, height: source.height })
  }

  /** The path of a stored file, or null for any name the store wouldn't have written. */
  resolve(file: string): string | null {
    return PHOTO_FILE.test(file) ? join(this.dir, file) : null
  }

  /**
   * Deletes stored files that no location refers to (left by a crash between writing a photo
   * and saving its location). Only names the store writes are ever touched.
   */
  removeOrphans(photos: Iterable<Pick<LocationPhoto, 'id' | 'file'>>): number {
    if (!existsSync(this.dir)) return 0
    const keep = new Set<string>()
    for (const p of photos) keep.add(p.file).add(thumbFile(p))
    let removed = 0
    for (const file of readdirSync(this.dir)) {
      if (PHOTO_FILE.test(file) && !keep.has(file)) {
        rmSync(join(this.dir, file), { force: true })
        removed++
      }
    }
    return removed
  }

  private write(file: string, bytes: Uint8Array): void {
    const target = join(this.dir, file)
    const tmp = `${target}.tmp`
    writeFileSync(tmp, bytes)
    renameSync(tmp, target)
  }
}

/** A store that references assets inside the shared PhotoStore. */
export interface PhotoOwner {
  /** False when the store's file was corrupt/unreadable or from a newer schema version. */
  readonly canCleanOrphans: boolean
  referencedPhotos(): Iterable<Pick<LocationPhoto, 'id' | 'file'>>
}

/**
 * Deletes stored photo files not referenced by any owner, only if every owner loaded cleanly.
 * Run once at startup after all photo-owning stores (bookmarks, projects, moodboards) have loaded.
 */
export function cleanOrphanPhotos(photos: PhotoStore, owners: readonly PhotoOwner[]): number {
  if (owners.some((o) => !o.canCleanOrphans)) {
    console.error('[photoearth] Keeping all stored photos: at least one store was not fully read.')
    return 0
  }
  const kept: Array<Pick<LocationPhoto, 'id' | 'file'>> = []
  for (const owner of owners) {
    for (const photo of owner.referencedPhotos()) kept.push(photo)
  }
  try {
    return photos.removeOrphans(kept)
  } catch (err) {
    console.error('[photoearth] Could not clean up the photo directory:', err)
    return 0
  }
}
