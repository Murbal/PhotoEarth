import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { MAX_PHOTO_BYTES } from '@shared/locations'
import type { PickedPhoto, PickedPhotoData } from '@shared/types'
import { sniffImage } from './photos'

/** The parts of Electron's dialog.showOpenDialog the picker needs (injectable for tests). */
export type OpenDialog = (options: {
  title: string
  defaultPath?: string
  buttonLabel: string
  properties: Array<'openFile' | 'multiSelections'>
  filters: Array<{ name: string; extensions: string[] }>
}) => Promise<{ canceled: boolean; filePaths: string[] }>

export const PHOTO_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif']

const MB = 1024 * 1024

/**
 * The native file picker for reference photos. The renderer never sees a path: it gets a
 * one-time token per chosen file and reads the files one at a time through it, so a large
 * selection never sits in memory at once. Sizes are checked on disk before anything is read.
 */
export class PhotoPicker {
  /** Token → path, for the files chosen in the last dialog only. */
  private picked = new Map<string, string>()
  private lastDir: string | undefined

  constructor(private readonly openDialog: OpenDialog) {}

  async pick(title: string, opts?: { multi?: boolean }): Promise<PickedPhoto[]> {
    const multi = opts?.multi !== false
    const result = await this.openDialog({
      title,
      defaultPath: this.lastDir,
      buttonLabel: multi ? 'Add' : 'Choose',
      properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [{ name: 'Images', extensions: PHOTO_EXTENSIONS }]
    })
    this.picked.clear()
    if (result.canceled || result.filePaths.length === 0) return []
    this.lastDir = dirname(result.filePaths[0])
    const out: PickedPhoto[] = []
    for (const path of result.filePaths) {
      const token = randomUUID()
      let bytes = 0
      try {
        bytes = (await stat(path)).size
      } catch {
        /* reported when read */
      }
      this.picked.set(token, path)
      out.push({ token, name: basename(path), bytes })
    }
    return out
  }

  /** Reads one picked file (once). Refuses it unread when it is too large. */
  async read(token: string): Promise<PickedPhotoData> {
    const path = this.picked.get(token)
    if (!path) return { ok: false, error: 'The file is no longer available; pick it again.' }
    this.picked.delete(token)
    try {
      const { size, isFile } = await stat(path).then((s) => ({ size: s.size, isFile: s.isFile() }))
      if (!isFile) return { ok: false, error: 'Not a file.' }
      if (size > MAX_PHOTO_BYTES) {
        return { ok: false, error: `Photos can be at most ${MAX_PHOTO_BYTES / MB} MB (this one is ${(size / MB).toFixed(1)} MB).` }
      }
      const data = new Uint8Array(await readFile(path))
      if (!sniffImage(data)) return { ok: false, error: 'Only JPEG, PNG, WebP, GIF and AVIF images can be added.' }
      return { ok: true, data }
    } catch {
      return { ok: false, error: 'The file could not be read.' }
    }
  }
}
