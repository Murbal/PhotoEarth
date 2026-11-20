import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * A small JSON file store: synchronous read at startup, debounced atomic writes
 * (write to a temp file, then rename) so a crash never leaves a truncated file.
 */
export class JsonFile<T> {
  private value: T
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly file: string,
    private readonly sanitize: (raw: unknown) => T,
    private readonly delayMs = 300
  ) {
    this.value = this.load()
  }

  get(): T {
    return this.value
  }

  set(value: T): void {
    this.value = value
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), this.delayMs)
  }

  /** Writes pending changes immediately (used on quit). */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.value, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }

  private load(): T {
    if (!existsSync(this.file)) return this.sanitize(undefined)
    try {
      return this.sanitize(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch (err) {
      // Keep the unreadable file for inspection instead of silently overwriting it.
      try {
        renameSync(this.file, `${this.file}.corrupt-${Date.now()}`)
      } catch {
        /* ignore */
      }
      console.error(`[photoearth] Could not read ${this.file}, using defaults:`, err)
      return this.sanitize(undefined)
    }
  }
}
