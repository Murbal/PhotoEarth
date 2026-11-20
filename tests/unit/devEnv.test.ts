import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadDevEnvKeys } from '../../src/main/devEnv'

const dirs: string[] = []
function project(env?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'photoearth-env-'))
  dirs.push(dir)
  if (env !== undefined) writeFileSync(join(dir, '.env'), env)
  return dir
}

afterEach(() => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
  delete process.env.GOOGLE_CLOUD_API_TOKEN
  delete process.env.CESIUM_ION_API_TOKEN
})

describe('dev .env keys', () => {
  it('reads both tokens', () => {
    const dir = project('# keys\nGOOGLE_CLOUD_API_TOKEN=AIza-test\nCESIUM_ION_API_TOKEN="eyJ.test"\nOTHER=1\n')
    expect(loadDevEnvKeys(dir)).toEqual({ googleApiKey: 'AIza-test', cesiumIonToken: 'eyJ.test' })
  })

  it('lets the environment override the file and skips blanks', () => {
    const dir = project('GOOGLE_CLOUD_API_TOKEN=from-file\nCESIUM_ION_API_TOKEN=\n')
    process.env.GOOGLE_CLOUD_API_TOKEN = 'from-env'
    expect(loadDevEnvKeys(dir)).toEqual({ googleApiKey: 'from-env' })
  })

  it('is empty without a .env file', () => {
    expect(loadDevEnvKeys(project())).toEqual({})
  })
})
