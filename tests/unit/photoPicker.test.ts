import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PhotoPicker, type OpenDialog } from '../../src/main/photoPicker'
import { MAX_PHOTO_BYTES } from '../../src/shared/locations'

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1])

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

function files(entries: Record<string, Uint8Array | string>): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'photoearth-picker-'))
  dirs.push(dir)
  return Object.entries(entries).map(([name, data]) => {
    writeFileSync(join(dir, name), data)
    return join(dir, name)
  })
}

/** A dialog that "chooses" the given paths and records what it was opened with. */
function fakeDialog(paths: string[], canceled = false) {
  const calls: Array<Parameters<OpenDialog>[0]> = []
  const open: OpenDialog = async (options) => {
    calls.push(options)
    return { canceled, filePaths: canceled ? [] : paths }
  }
  return { open, calls }
}

describe('PhotoPicker', () => {
  it('opens a multi-select image dialog and hands out tokens, never paths', async () => {
    const [a, b] = files({ 'IMG_1.jpg': JPEG, 'IMG_2.jpg': JPEG })
    const dialog = fakeDialog([a, b])
    const picker = new PhotoPicker(dialog.open)
    const picked = await picker.pick('Add photos to “Ridge”')
    expect(dialog.calls[0]).toMatchObject({
      title: 'Add photos to “Ridge”',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif'] }]
    })
    expect(picked.map((p) => [p.name, p.bytes])).toEqual([
      ['IMG_1.jpg', JPEG.byteLength],
      ['IMG_2.jpg', JPEG.byteLength]
    ])
    expect(JSON.stringify(picked)).not.toContain(a)
    expect(await picker.read(picked[0].token)).toEqual({ ok: true, data: JPEG })
    // Each token reads once.
    expect(await picker.read(picked[0].token)).toMatchObject({ ok: false })
    expect(await picker.read('made-up')).toMatchObject({ ok: false })
    // The next dialog starts in the same folder, and its picks replace the old tokens.
    await picker.pick('again')
    expect(dialog.calls[1].defaultPath).toBe(join(a, '..'))
    expect(await picker.read(picked[1].token)).toMatchObject({ ok: false })
  })

  it('returns nothing when cancelled', async () => {
    const picker = new PhotoPicker(fakeDialog([], true).open)
    expect(await picker.pick('x')).toEqual([])
  })

  it('refuses huge files and non-images', async () => {
    const huge = new Uint8Array(MAX_PHOTO_BYTES + 1)
    huge.set(JPEG)
    const [big, text] = files({ 'big.jpg': huge, 'notes.jpg': 'not an image at all' })
    const picker = new PhotoPicker(fakeDialog([big, text]).open)
    const [p1, p2] = await picker.pick('x')
    expect(p1.bytes).toBe(MAX_PHOTO_BYTES + 1)
    expect(await picker.read(p1.token)).toEqual({ ok: false, error: expect.stringContaining('at most 40 MB') })
    expect(await picker.read(p2.token)).toEqual({ ok: false, error: expect.stringContaining('JPEG, PNG') })
  })

  it('reports a file that disappeared after it was picked', async () => {
    const [a] = files({ 'gone.jpg': JPEG })
    const picker = new PhotoPicker(fakeDialog([a]).open)
    const [p] = await picker.pick('x')
    rmSync(a)
    expect(await picker.read(p.token)).toEqual({ ok: false, error: 'The file could not be read.' })
  })
})
