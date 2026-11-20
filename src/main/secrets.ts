import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import type { ApiKeys, SecretsStatus } from '@shared/types'
import { JsonFile } from './jsonStore'

type KeyName = keyof ApiKeys
const KEY_NAMES: KeyName[] = ['googleApiKey', 'cesiumIonToken']

interface SecretsFile {
  version: 1
  /** Base64 of safeStorage-encrypted bytes. Never plaintext. */
  encrypted: Partial<Record<KeyName, string>>
}

function sanitize(raw: unknown): SecretsFile {
  const out: SecretsFile = { version: 1, encrypted: {} }
  const enc = (raw as { encrypted?: Record<string, unknown> } | undefined)?.encrypted
  if (enc && typeof enc === 'object') {
    for (const name of KEY_NAMES) {
      if (typeof enc[name] === 'string') out.encrypted[name] = enc[name] as string
    }
  }
  return out
}

/**
 * API keys encrypted with Electron safeStorage (DPAPI on Windows, Keychain on macOS,
 * libsecret/kwallet on Linux). If no OS-backed encryption is available, keys are kept in
 * memory for the session only, so they are never written to disk in plaintext.
 */
export class SecretStore {
  private readonly file: JsonFile<SecretsFile>
  private readonly cache: ApiKeys = { googleApiKey: null, cesiumIonToken: null }
  private available = false

  private constructor() {
    this.file = new JsonFile(join(app.getPath('userData'), 'secrets.json'), sanitize, 0)
  }

  /** Must be called after the app is ready. */
  static async create(): Promise<SecretStore> {
    const store = new SecretStore()
    await store.init()
    return store
  }

  private async init(): Promise<void> {
    // basic_text on Linux is a hard-coded obfuscation key, i.e. effectively plaintext.
    this.available = (await safeStorage.isAsyncEncryptionAvailable()) && this.backend() !== 'basic_text'
    if (!this.available) return
    const { encrypted } = this.file.get()
    let reEncrypt = false
    for (const name of KEY_NAMES) {
      const blob = encrypted[name]
      if (!blob) continue
      try {
        const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(blob, 'base64'))
        this.cache[name] = result
        reEncrypt ||= shouldReEncrypt
      } catch (err) {
        console.error(`[photoearth] Could not decrypt ${name}; it must be entered again.`, err)
      }
    }
    // The OS rotated the key: store the secrets again under the new one.
    if (reEncrypt) await this.persist()
  }

  private backend(): string {
    return process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'os'
  }

  get(): ApiKeys {
    return { ...this.cache }
  }

  async set(patch: Partial<ApiKeys>): Promise<SecretsStatus> {
    for (const name of KEY_NAMES) {
      if (!(name in patch)) continue
      const value = patch[name]
      this.cache[name] = typeof value === 'string' && value.trim() ? value.trim() : null
    }
    await this.persist()
    return this.status()
  }

  private async persist(): Promise<void> {
    if (!this.available) return
    const encrypted: SecretsFile['encrypted'] = {}
    for (const name of KEY_NAMES) {
      const value = this.cache[name]
      if (value) encrypted[name] = (await safeStorage.encryptStringAsync(value)).toString('base64')
    }
    this.file.set({ version: 1, encrypted })
    this.file.flush()
  }

  status(): SecretsStatus {
    return {
      encryptionAvailable: this.available,
      backend: this.backend(),
      memoryOnly: !this.available,
      hasGoogleApiKey: !!this.cache.googleApiKey,
      hasCesiumIonToken: !!this.cache.cesiumIonToken
    }
  }
}
