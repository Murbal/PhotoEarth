import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    // Run in a zone far from the test locations: results must depend only on the
    // viewed location's zone, never on the computer's.
    env: { TZ: 'Pacific/Chatham' }
  }
})
