import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import type { ApiKeys } from '@shared/types'

/** .env variable → API key it provides. */
export const DEV_ENV_KEYS: Record<string, keyof ApiKeys> = {
  GOOGLE_CLOUD_API_TOKEN: 'googleApiKey',
  CESIUM_ION_API_TOKEN: 'cesiumIonToken'
}

/**
 * Dev-server only: API keys from `<project>/.env` (gitignored), with variables already set
 * in the environment taking precedence. Read in the main process so the tokens never get
 * inlined into the renderer bundle the way VITE_-prefixed variables would.
 */
export function loadDevEnvKeys(projectDir: string): Partial<ApiKeys> {
  const file = join(projectDir, '.env')
  let fromFile: Record<string, string> = {}
  if (existsSync(file)) {
    try {
      fromFile = parseEnv(readFileSync(file, 'utf8')) as Record<string, string>
    } catch (err) {
      console.error('[photoearth] Could not read .env:', err)
    }
  }
  const keys: Partial<ApiKeys> = {}
  for (const [variable, key] of Object.entries(DEV_ENV_KEYS)) {
    const value = (process.env[variable] ?? fromFile[variable])?.trim()
    if (value) keys[key] = value
  }
  return keys
}
