import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CESIUM_PATCHES, cesiumOptimizations } from '../../vite/cesium'

const ENGINE = resolve(__dirname, '../../node_modules/@cesium/engine/Source')

describe('build-time Cesium patches (vite/cesium.ts)', () => {
  const plugin = cesiumOptimizations()
  const files = [...new Set(CESIUM_PATCHES.map((p) => p.file))]

  // A Cesium upgrade that changes a patched function fails here, not in a packaged build.
  it.each(files)('every patch applies exactly once to %s', (file) => {
    const id = `${ENGINE}${file}`
    const code = readFileSync(id, 'utf8')
    const out = plugin.transform(code, id)?.code ?? code
    for (const patch of CESIUM_PATCHES.filter((p) => p.file === file)) {
      expect(out.split(patch.replace).length - 1, patch.find).toBe(1)
    }
  })

  it('strips debug-only checks from Cesium sources and leaves other modules alone', () => {
    const id = `${ENGINE}/Scene/Model/pickModel.js`
    const code = readFileSync(id, 'utf8')
    expect(code).toContain("//>>includeStart('debug'")
    expect(plugin.transform(code, id)!.code).not.toContain("//>>includeStart('debug'")
    expect(plugin.transform(code, '/project/src/renderer/src/engine/Engine.ts')).toBeNull()
  })
})
