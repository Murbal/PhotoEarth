import { cpSync, createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Cesium ships pre-built workers, assets and third-party wasm that must be served
// from CESIUM_BASE_URL at runtime. This plugin serves them in dev and copies them
// next to the renderer bundle in production builds.
const CESIUM_BUILD = resolve(__dirname, 'node_modules/cesium/Build/Cesium')
const CESIUM_DIRS = ['Workers', 'ThirdParty', 'Assets', 'Widgets']
const MIME: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.css': 'text/css',
  '.ktx2': 'image/ktx2'
}

function cesiumAssets(): Plugin {
  let outDir = ''
  return {
    name: 'photoearth:cesium-assets',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    configureServer(server) {
      server.middlewares.use('/cesium', (req, res, next) => {
        const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0])
        const file = normalize(join(CESIUM_BUILD, urlPath))
        if (!file.startsWith(CESIUM_BUILD) || !existsSync(file) || !statSync(file).isFile()) {
          next()
          return
        }
        res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream')
        createReadStream(file).pipe(res)
      })
    },
    writeBundle() {
      for (const dir of CESIUM_DIRS) {
        cpSync(join(CESIUM_BUILD, dir), join(outDir, 'cesium', dir), { recursive: true })
      }
    }
  }
}

const sharedAlias = { '@shared': resolve(__dirname, 'src/shared') }

export default defineConfig({
  main: {
    resolve: { alias: sharedAlias },
    build: { outDir: 'out/main' }
  },
  preload: {
    resolve: { alias: sharedAlias },
    build: { outDir: 'out/preload' }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        ...sharedAlias,
        '@renderer': resolve(__dirname, 'src/renderer/src')
      }
    },
    define: {
      // Absolute path so it resolves both on the dev server and on the app:// protocol.
      CESIUM_BASE_URL: JSON.stringify('/cesium/')
    },
    plugins: [react(), cesiumAssets()],
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      chunkSizeWarningLimit: 8000,
      minify: true,
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html')
      }
    },
    server: { port: 5173 }
  }
})
