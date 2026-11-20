import { describe, expect, it } from 'vitest'
import { applyWslGpuEnv, wslGpuEnv } from '../../src/main/wslGpu'

const WSL = '6.6.87.2-microsoft-standard-WSL2'
const all = () => true

describe('wslGpuEnv', () => {
  it('selects Mesa d3d12 under WSL2 with the GPU device and D3D12 runtime present', () => {
    expect(wslGpuEnv({}, { platform: 'linux', release: WSL, exists: all })).toEqual({ GALLIUM_DRIVER: 'd3d12' })
  })

  it('does nothing outside WSL', () => {
    expect(wslGpuEnv({}, { platform: 'linux', release: '6.8.0-49-generic', exists: all })).toBeNull()
    expect(wslGpuEnv({}, { platform: 'win32', release: '10.0.26100', exists: all })).toBeNull()
  })

  it('does nothing without GPU paravirtualization (e.g. WSL1, or GPU support off)', () => {
    expect(wslGpuEnv({}, { platform: 'linux', release: WSL, exists: (p) => p !== '/dev/dxg' })).toBeNull()
    expect(wslGpuEnv({}, { platform: 'linux', release: WSL, exists: (p) => p === '/dev/dxg' })).toBeNull()
  })

  it('respects a driver the user already chose', () => {
    for (const env of [{ GALLIUM_DRIVER: 'llvmpipe' }, { LIBGL_ALWAYS_SOFTWARE: '1' }, { MESA_LOADER_DRIVER_OVERRIDE: 'zink' }]) {
      expect(wslGpuEnv(env, { platform: 'linux', release: WSL, exists: all })).toBeNull()
    }
  })
})

describe('applyWslGpuEnv', () => {
  it('never overrides a driver that is already set', () => {
    const env = { GALLIUM_DRIVER: 'llvmpipe' }
    expect(applyWslGpuEnv(env)).toBe(false)
    expect(env.GALLIUM_DRIVER).toBe('llvmpipe')
  })
})
