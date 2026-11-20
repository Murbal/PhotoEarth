import { existsSync } from 'node:fs'
import { release } from 'node:os'

// Under WSL2 there is no GPU device for Mesa to detect, so it falls back to llvmpipe
// (CPU-only OpenGL). Chromium blocklists that and drops to SwiftShader, which renders the
// globe at a few frames per second. Mesa's d3d12 driver reaches the real GPU through
// /dev/dxg, but only when asked for by name (GALLIUM_DRIVER=d3d12).
//
// The variable must be in Electron's environment from the start: on Linux the GPU process
// is forked from a zygote that Chromium starts before the main script runs, so setting it
// in the main process is too late. Hence the launchers (electron.vite.config.ts for dev and
// preview, playwright.config.ts for tests) apply it, and a packaged build relaunches itself.

/** The GPU paravirtualization device and the D3D12 runtime WSL maps in from Windows. */
const DXG_DEVICE = '/dev/dxg'
const WSL_D3D12 = '/usr/lib/wsl/lib/libd3d12.so'

export interface WslGpuProbe {
  platform: NodeJS.Platform
  /** Kernel release (WSL2 kernels end in "-microsoft-standard-WSL2"). */
  release: string
  exists: (path: string) => boolean
}

const hostProbe = (): WslGpuProbe => ({ platform: process.platform, release: release(), exists: existsSync })

/**
 * The variable to set, or null when it doesn't apply (not WSL2 with GPU support) or a
 * driver has already been chosen.
 */
export function wslGpuEnv(env: NodeJS.ProcessEnv, probe: WslGpuProbe = hostProbe()): { GALLIUM_DRIVER: string } | null {
  if (probe.platform !== 'linux') return null
  if (!/microsoft/i.test(probe.release)) return null
  // Respect an explicit choice (including forcing software rendering).
  if (env.GALLIUM_DRIVER || env.MESA_LOADER_DRIVER_OVERRIDE || env.LIBGL_ALWAYS_SOFTWARE) return null
  if (!probe.exists(DXG_DEVICE) || !probe.exists(WSL_D3D12)) return null
  return { GALLIUM_DRIVER: 'd3d12' }
}

/** For launchers: adds the variable to `env` (before Electron starts). Returns whether it did. */
export function applyWslGpuEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const patch = wslGpuEnv(env)
  if (patch) Object.assign(env, patch)
  return patch !== null
}

/**
 * For a packaged build started without the variable: relaunches the app once with it set
 * and returns true (the caller then exits). Must run before the single-instance lock is
 * taken, so the new instance can take it.
 */
export function relaunchForWslGpu(app: { relaunch(): void }): boolean {
  if (!applyWslGpuEnv()) return false
  console.log('[photoearth] WSL: relaunching to render on the GPU (Mesa d3d12; set GALLIUM_DRIVER to override)')
  app.relaunch()
  return true
}
