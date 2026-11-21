import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JsonFile } from '../../src/main/jsonStore'

const dirs: string[] = []
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'photoearth-json-'))
  dirs.push(dir)
  return dir
}
const asObject = (raw: unknown) => (typeof raw === 'object' && raw !== null ? (raw as { n?: number }) : { n: 0 })

describe('JsonFile', () => {
  it('says when it started from defaults because the file was unreadable', () => {
    const dir = tempDir()
    expect(new JsonFile(join(dir, 'missing.json'), asObject).recovered).toBe(false)
    writeFileSync(join(dir, 'good.json'), '{"n":1}')
    expect(new JsonFile(join(dir, 'good.json'), asObject).recovered).toBe(false)
    writeFileSync(join(dir, 'bad.json'), '{ nope')
    const bad = new JsonFile(join(dir, 'bad.json'), asObject)
    expect(bad.recovered).toBe(true)
    expect(bad.get()).toEqual({ n: 0 })
  })

  it('retries a failed background write instead of throwing from the timer', () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const dir = tempDir()
    // The parent "directory" is a file, so every write fails until it is removed.
    writeFileSync(join(dir, 'blocked'), '')
    const path = join(dir, 'blocked', 'store.json')
    const store = new JsonFile(path, asObject, 10)
    store.set({ n: 5 })
    expect(() => vi.advanceTimersByTime(10)).not.toThrow()
    expect(console.error).toHaveBeenCalledTimes(1)
    rmSync(join(dir, 'blocked'))
    vi.advanceTimersByTime(2000)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ n: 5 })
  })
})
