import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import type { ApiKeys } from '@shared/types'

/** .env variable → API key it provides. */
export const DEV_ENV_KEYS: Record<string, keyof ApiKeys> = {
  GOOGLE_CLOUD_API_TOKEN: 'googleApiKey',
  CESIUM_ION_API_TOKEN: 'cesiumIonToken'
}

export interface DevEnvFlags {
  /** Skip loading Google Photorealistic 3D Tiles in dev (saves Cesium ion sessions in worktrees). */
  disable3dTiles: boolean
}

function readDotEnv(projectDir: string): Record<string, string> {
  const file = join(projectDir, '.env')
  if (!existsSync(file)) return {}
  try {
    return parseEnv(readFileSync(file, 'utf8')) as Record<string, string>
  } catch (err) {
    console.error('[photoearth] Could not read .env:', err)
    return {}
  }
}

function isTruthyFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes'
}

/**
 * Dev-server only: API keys from `<project>/.env` (gitignored), with variables already set
 * in the environment taking precedence. Read in the main process so the tokens never get
 * inlined into the renderer bundle the way VITE_-prefixed variables would.
 */
export function loadDevEnvKeys(projectDir: string): Partial<ApiKeys> {
  const fromFile = readDotEnv(projectDir)
  const keys: Partial<ApiKeys> = {}
  for (const [variable, key] of Object.entries(DEV_ENV_KEYS)) {
    const value = (process.env[variable] ?? fromFile[variable])?.trim()
    if (value) keys[key] = value
  }
  return keys
}

/** Dev-server only: optional toggles from `<project>/.env` or the process environment. */
export function loadDevEnvFlags(projectDir: string): DevEnvFlags {
  const fromFile = readDotEnv(projectDir)
  return {
    disable3dTiles: isTruthyFlag(process.env.PHOTOEARTH_NO_3D_TILES ?? fromFile.PHOTOEARTH_NO_3D_TILES)
  }
}
