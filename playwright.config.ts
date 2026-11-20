import { defineConfig } from '@playwright/test'
import { applyWslGpuEnv } from './src/main/wslGpu'

// Electron under test inherits this environment: under WSL, render on the GPU (see wslGpu.ts).
applyWslGpuEnv()

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: { trace: 'retain-on-failure' }
})
