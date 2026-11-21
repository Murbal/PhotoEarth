import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** How long a failed background write waits before it is tried again, doubling up to the cap. */
const RETRY_MS = 2000
const MAX_RETRY_MS = 60_000

/**
 * A small JSON file store: synchronous read at startup, debounced atomic writes
 * (write to a temp file, then rename) so a crash never leaves a truncated file.
 */
export class JsonFile<T> {
  private value: T
  private timer: NodeJS.Timeout | null = null
  /**
   * The file existed but couldn't be read, so the store started from defaults (the
   * unreadable file is kept as `<name>.corrupt-<time>`). Its contents are unknown, so
   * nothing that depends on them, such as cleaning up files it referred to, should run.
   */
  readonly recovered: boolean

  constructor(
    private readonly file: string,
    private readonly sanitize: (raw: unknown) => T,
    private readonly delayMs = 300
  ) {
    const { value, recovered } = this.load()
    this.value = value
    this.recovered = recovered
  }

  get(): T {
    return this.value
  }

  set(value: T): void {
    this.value = value
    this.schedule(this.delayMs)
  }

  /** Writes pending changes immediately (used on quit). Throws if the file can't be written. */
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

  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      try {
        this.flush()
      } catch (err) {
        // A full disk, or a file briefly locked by a virus scanner or sync tool (EPERM/EBUSY
        // on Windows). Keep the value in memory and try again, rather than throwing from a timer.
        const retry = Math.min(MAX_RETRY_MS, Math.max(RETRY_MS, delayMs * 2))
        console.error(`[photoearth] Could not write ${this.file}, retrying in ${retry / 1000} s:`, err)
        if (!this.timer) this.schedule(retry)
      }
    }, delayMs)
  }

  private load(): { value: T; recovered: boolean } {
    if (!existsSync(this.file)) return { value: this.sanitize(undefined), recovered: false }
    try {
      return { value: this.sanitize(JSON.parse(readFileSync(this.file, 'utf8'))), recovered: false }
    } catch (err) {
      // Keep the unreadable file for inspection instead of silently overwriting it.
      try {
        renameSync(this.file, `${this.file}.corrupt-${Date.now()}`)
      } catch {
        /* ignore */
      }
      console.error(`[photoearth] Could not read ${this.file}, using defaults:`, err)
      return { value: this.sanitize(undefined), recovered: true }
    }
  }
}
