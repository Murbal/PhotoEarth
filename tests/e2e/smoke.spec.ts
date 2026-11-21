import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

// Requires a test build: `VITE_PHOTOEARTH_TEST=1 npm run build` (done by `npm run test:e2e`).
// No API keys are needed: the smoke test covers what works offline.

let app: ElectronApplication
let page: Page
let userData: string
const errors: string[] = []

/** A throwaway profile, and a hidden window that never takes focus from the desktop (see src/main/index.ts). */
const launchEnv = () => ({ ...process.env, PHOTOEARTH_USER_DATA: userData, PHOTOEARTH_BACKGROUND: '1' })

/**
 * Answers forecast requests in the main process with a fixed 17-day forecast instead of calling
 * Open-Meteo: broken high cloud over the view center, clear toward the sun. Requests are kept
 * in `globalThis.forecastRequests`.
 */
async function mockForecast(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { forecastRequests: unknown[] }
    g.forecastRequests = []
    ipcMain.removeHandler('weather:forecast')
    ipcMain.handle('weather:forecast', (_event, req: { points: Array<{ latitude: number; longitude: number }> }) => {
      g.forecastRequests.push(req)
      const day = 86_400_000
      const start = Math.floor(Date.now() / day) * day - day
      const col = (f: (i: number) => number) => Array.from({ length: 17 * 24 }, (_, i) => f(i))
      const data = req.points.map((p, k) => ({
        latitude: p.latitude,
        longitude: p.longitude,
        elevation: 0,
        time: col((i) => start + i * 3_600_000),
        cloudLow: col(() => 0),
        cloudMid: col(() => 10),
        cloudHigh: col(() => (k === 0 ? 50 : 0)),
        visibility: col(() => 30_000),
        windSpeed: col(() => 2.5),
        windGusts: col(() => 5),
        windDirection: col(() => 270),
        precipitationProbability: col(() => 0),
        precipitation: col(() => 0),
        temperature: col(() => 10),
        dewPoint: col(() => 2),
        humidity: col(() => 60),
        weatherCode: col(() => 2)
      }))
      return { ok: true, data }
    })
  })
}

/** A bookmark as version 1 of the app stored it (views only), migrated at the first start. */
const LEGACY_BOOKMARKS = {
  version: 1,
  bookmarks: [
    {
      id: 'legacy',
      name: 'Legacy view',
      createdAt: '2025-06-01T08:00:00.000Z',
      camera: { longitude: 7.9, latitude: 46.55, height: 4000, heading: 180, pitch: -30, roll: 0 },
      mode: 'photorealistic',
      time: { utc: '2025-06-21T04:30:00.000Z', timeZone: 'Europe/Zurich' }
    }
  ]
}

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'photoearth-e2e-'))
  writeFileSync(join(userData, 'bookmarks.json'), JSON.stringify(LEGACY_BOOKMARKS))
  app = await electron.launch({ args: ['.'], env: launchEnv() })
  page = await app.firstWindow()
  await mockForecast(app)
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/GPU stall|WebGL/.test(m.text())) errors.push(m.text())
  })
})

test.afterAll(async () => {
  await app?.close()
  rmSync(userData, { recursive: true, force: true })
})

test('launches with secure defaults and shows onboarding', async () => {
  await expect(page.locator('.onboarding')).toBeVisible({ timeout: 30_000 })
  expect(await page.title()).toBe('PhotoEarth')
  // Sandboxed renderer: no Node globals, only the typed bridge.
  expect(await page.evaluate(() => typeof (globalThis as { require?: unknown }).require)).toBe('undefined')
  expect(await page.evaluate(() => typeof window.photoearth.settings.get)).toBe('function')
  expect(page.url()).toMatch(/^app:\/\/photoearth\//)
})

test('renders the Cesium globe after skipping onboarding', async () => {
  await page.getByText('Skip for now').click()
  await expect(page.locator('.onboarding')).toBeHidden()
  await expect(page.locator('.map canvas')).toBeVisible()
  await page.waitForFunction(() => !!(window as unknown as { __photoearth?: unknown }).__photoearth)
  await expect(page.locator('.statusbar')).toContainText('Cam')
})

test('a version-1 bookmark is migrated into a saved location, and the original kept', async () => {
  const list = await page.evaluate(() => window.photoearth.bookmarks.list())
  expect(list).toHaveLength(1)
  expect(list[0]).toMatchObject({ id: 'legacy', name: 'Legacy view', status: 'to-visit', notes: '', tags: [], photos: [], time: LEGACY_BOOKMARKS.bookmarks[0].time })
  // Estimated from the camera until it is visited again.
  expect(list[0].position.height).toBeNull()
  expect(JSON.parse(readFileSync(join(userData, 'bookmarks.v1.backup.json'), 'utf8'))).toEqual(LEGACY_BOOKMARKS)
  await expect.poll(() => JSON.parse(readFileSync(join(userData, 'bookmarks.json'), 'utf8')).version).toBe(2)
})

test('under WSL with GPU support, WebGL runs on the GPU rather than a software renderer', async () => {
  // playwright.config.ts selects Mesa d3d12 exactly when this applies (see src/main/wslGpu.ts).
  test.skip(!existsSync('/dev/dxg') || process.env.GALLIUM_DRIVER !== 'd3d12', 'not WSL2 with GPU paravirtualization')
  const renderer = await page.evaluate(() => {
    const gl = (window as unknown as { __photoearth: any }).__photoearth.scene.context._gl as WebGL2RenderingContext
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
  })
  expect(renderer).toContain('D3D12')
  expect(renderer).not.toMatch(/SwiftShader|llvmpipe/)
})

test('the custom elevation material compiles', async () => {
  const result = await page.evaluate(async () => {
    const w = window as unknown as { Cesium: Record<string, any>; __photoearth: any }
    await new Promise((r) => {
      const t = setInterval(() => w.Cesium && (clearInterval(t), r(null)), 50)
    })
    const C = w.Cesium
    const e = w.__photoearth
    const style = {
      tint: { enabled: true, opacity: 0.6, palette: 'terrain', autoRange: false, min: 0, max: 4000 },
      contours: { enabled: true, interval: 50, width: 1.5, color: '#ffffff', opacity: 0.8 },
      slope: { enabled: true, opacity: 0.5 },
      hillshade: { enabled: true, opacity: 0.5, followSun: true }
    }
    // With terrain shadows and viewshed enabled, so both shared receivers compile in the globe material.
    e.styler.apply(style, true, null, true, false, true)
    const errors: string[] = []
    e.scene.renderError.addEventListener((_s: unknown, err: Error) => errors.push(String(err?.message ?? err)))
    const primitive = new C.Primitive({
      geometryInstances: new C.GeometryInstance({
        geometry: new C.RectangleGeometry({
          rectangle: C.Rectangle.fromDegrees(7.6, 46.4, 8.1, 46.7),
          height: 1500,
          vertexFormat: C.MaterialAppearance.MaterialSupport.ALL.vertexFormat
        })
      }),
      appearance: new C.MaterialAppearance({ material: e.scene.globe.material, materialSupport: C.MaterialAppearance.MaterialSupport.ALL }),
      asynchronous: false
    })
    e.scene.primitives.add(primitive)
    for (let i = 0; i < 3; i++) {
      e.scene.render()
      await new Promise((r) => setTimeout(r, 100))
    }
    e.scene.primitives.remove(primitive)
    e.styler.apply(style, false, null)
    return errors
  })
  expect(result).toEqual([])
})

test('the GPU terrain shadow pass matches the CPU reference', async () => {
  const result = await page.evaluate(() => {
    const w = window as unknown as { Cesium: Record<string, any>; __photoearth: any }
    const T = w.Cesium.terrainShadow
    const e = w.__photoearth
    const DEG = Math.PI / 180
    // Smooth synthetic terrain: a tilted plain with mountains near, mid and far.
    const peaks = [
      [-30000, 5000, 2600, 2500],
      [12000, -8000, 1800, 1200],
      [1500, 2500, 900, 400],
      [60000, 30000, 3200, 6000]
    ]
    const height = (x: number, y: number) => {
      let h = 600 + 0.004 * x
      for (const [px, py, ph, sigma] of peaks) h += ph * Math.exp(-((x - px) ** 2 + (y - py) ** 2) / (2 * sigma * sigma))
      return h
    }
    const makeLevel = (half: number, n: number, cx: number, cy: number) => {
      const heights = new Float32Array(n * n)
      const cell = (2 * half) / n
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) heights[j * n + i] = height(cx - half + (i + 0.5) * cell, cy - half + (j + 0.5) * cell)
      const r = T.heightRange(heights)
      return { cx, cy, half, n, heights, minHeight: r.min, maxHeight: r.max }
    }
    const levels = [makeLevel(5000, 128, 1000, -500), makeLevel(20000, 128, 0, 0), makeLevel(80000, 96, 0, 0)]
    const frame = e.terrainShadows.debugUseLevels(8 * DEG, 46 * DEG, levels)
    const maxHeight = Math.max(...levels.map((l) => l.maxHeight))
    const farHeight = levels[2].minHeight - 100
    let seed = 7
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    const report: Array<{ sun: number[]; level: number; topWithin2m: number; visAgree: number; shadowed: number; lit: number; worstTop: number }> = []
    for (const [az, alt] of [
      [250, 6],
      [110, 2.5],
      [200, 35]
    ]) {
      const sun = { x: Math.sin(az * DEG) * Math.cos(alt * DEG), y: Math.cos(az * DEG) * Math.cos(alt * DEG), z: Math.sin(alt * DEG) }
      e.terrainShadows.compute.setSun(sun, true)
      for (let i = 0; i < 6; i++) {
        e.scene.requestRender()
        e.scene.render()
      }
      for (let k = 0; k < 3; k++) {
        const m = e.terrainShadows.debugReadMask(k)
        const l = levels[k]
        const cell = T.levelCell(l)
        let within = 0
        let agree = 0
        let shadowed = 0
        let lit = 0
        let worst = 0
        const samples = 200
        for (let s = 0; s < samples; s++) {
          const i = Math.floor(rand() * l.n)
          const j = Math.floor(rand() * l.n)
          const o = (j * l.n + i) * 4
          const gpu = T.decodeShadow(m.data[o], m.data[o + 1], m.data[o + 2], m.data[o + 3], m.base)
          const ground = l.heights[j * l.n + i]
          const x = l.cx - l.half + (i + 0.5) * cell
          const y = l.cy - l.half + (j + 0.5) * cell
          const cpu = T.shadowTop(levels, x, y, ground, cell, sun, { radius: frame.radius, farHeight, maxHeight })
          const cpuTop = Math.min(m.base + 65535 * 0.25, Math.max(m.base, cpu.top))
          const err = Math.abs(gpu.top - cpuTop)
          worst = Math.max(worst, err)
          if (err <= 2) within++
          const vg = T.receiverVisibility(gpu, ground, cell)
          const vc = T.receiverVisibility({ top: cpuTop, distance: cpu.distance }, ground, cell)
          if (Math.abs(vg - vc) < 0.1) agree++
          if (vc < 0.5) shadowed++
          else lit++
        }
        report.push({ sun: [az, alt], level: k, topWithin2m: within / samples, visAgree: agree / samples, shadowed, lit, worstTop: worst })
      }
    }
    return report
  })
  for (const r of result) {
    expect(r.topWithin2m, JSON.stringify(r)).toBeGreaterThanOrEqual(0.97)
    expect(r.visAgree, JSON.stringify(r)).toBeGreaterThanOrEqual(0.98)
  }
  // Not vacuous: the low suns put a good share of the terrain in shadow.
  expect(result.filter((r) => r.sun[1] < 10).every((r) => r.shadowed >= 5 && r.lit >= 5), JSON.stringify(result)).toBe(true)
})

test('the tileset shader and patched detail shadows compile on a mesh without normals', async () => {
  const result = await page.evaluate(async () => {
    const w = window as unknown as { Cesium: Record<string, any>; __photoearth: any }
    const C = w.Cesium
    const e = w.__photoearth
    // A 400 m ground quad with a 60 m wall on it, positions only (like Google's tiles).
    const pos = new Float32Array([
      -200, 0, -200, 200, 0, -200, 200, 0, 200, -200, 0, 200, // ground (glTF is y-up)
      -100, 0, 0, 100, 0, 0, 100, 60, 0, -100, 60, 0 // wall
    ])
    const idx = new Uint16Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7])
    const bytes = new Uint8Array(pos.byteLength + idx.byteLength)
    bytes.set(new Uint8Array(pos.buffer), 0)
    bytes.set(new Uint8Array(idx.buffer), pos.byteLength)
    let bin = ''
    bytes.forEach((b) => (bin += String.fromCharCode(b)))
    const gltf = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
      materials: [{ doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [0.8, 0.8, 0.8, 1] } }],
      buffers: [{ byteLength: bytes.byteLength, uri: `data:application/octet-stream;base64,${btoa(bin)}` }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: pos.byteLength, target: 34962 },
        { buffer: 0, byteOffset: pos.byteLength, byteLength: idx.byteLength, target: 34963 }
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-200, 0, -200], max: [200, 60, 200] },
        { bufferView: 1, componentType: 5123, count: 12, type: 'SCALAR' }
      ]
    }
    const errors: string[] = []
    const onError = (_s: unknown, err: Error) => errors.push(String(err?.message ?? err))
    e.scene.renderError.addEventListener(onError)
    // Inside the synthetic terrain-shadow area of the previous test, so the receiver path runs.
    const model = await C.Model.fromGltfAsync({
      gltf,
      modelMatrix: C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(8.01, 46.0, 650)),
      customShader: e.tiles.customShader,
      shadows: C.ShadowMode.ENABLED
    })
    e.scene.primitives.add(model)
    const frame = () => {
      e.scene.shadowMap.enabled = true
      e.scene.requestRender()
      e.scene.render()
    }
    for (let i = 0; i < 200 && !model.ready; i++) {
      frame()
      await new Promise((r) => setTimeout(r, 25))
    }
    const ready = model.ready
    if (ready) e.scene.camera.flyToBoundingSphere(model.boundingSphere, { duration: 0 })
    for (let i = 0; i < 5; i++) {
      frame()
      await new Promise((r) => setTimeout(r, 50))
    }
    e.scene.renderError.removeEventListener(onError)
    // Kept for the next test.
    ;(w as unknown as { __testModel: unknown }).__testModel = model
    return { ready, errors }
  })
  expect(result.errors).toEqual([])
  expect(result.ready).toBe(true)
})

test('terrain shadows darken a rendered surface exactly where the CPU reference predicts', async () => {
  const result = await page.evaluate(() => {
    const w = window as unknown as { Cesium: Record<string, any>; __photoearth: any; __testModel: any }
    const C = w.Cesium
    const T = C.terrainShadow
    const e = w.__photoearth
    const model = w.__testModel
    const DEG = Math.PI / 180
    const ts = e.terrainShadows
    const frame = ts.frame
    const levels = ts.levels
    const sun = { x: Math.sin(110 * DEG) * Math.cos(2.5 * DEG), y: Math.cos(110 * DEG) * Math.cos(2.5 * DEG), z: Math.sin(2.5 * DEG) }
    // Moving the camera updates the view target, which would push the real current sun in.
    const realSetSun = ts.setSun
    ts.setSun = () => undefined
    ts.compute.setSun(sun, true)
    model.shadows = C.ShadowMode.DISABLED
    const render = () => {
      e.scene.shadowMap.enabled = false
      e.tiles.setDaylight(1)
      e.scene.requestRender()
      e.scene.render()
    }
    for (let i = 0; i < 6; i++) render()
    const maxHeight = Math.max(...levels.map((l: any) => l.maxHeight))
    const farHeight = levels[2].minHeight - 100
    const fine = levels[0]
    const cell = T.levelCell(fine)
    // Ground-level visibility at a point, by the CPU reference.
    const cpuVis = (x: number, y: number) => {
      const ground = T.sampleLevel(fine, x, y)
      const s = T.shadowTop(levels, x, y, ground, cell, sun, { radius: frame.radius, farHeight, maxHeight })
      return { ground, vis: T.receiverVisibility(s, ground, cell) }
    }
    // Find a deeply shadowed and a clearly lit spot, each uniform over the quad's footprint.
    const find = (want: number) => {
      for (let y = -3500; y <= 3500; y += 250) {
        for (let x = -2500; x <= 4500; x += 250) {
          const ok = [-150, 0, 150].every((dx) => [-150, 0, 150].every((dy) => cpuVis(x + dx, y + dy).vis === want))
          if (ok) return { x, y, ground: cpuVis(x, y).ground }
        }
      }
      return null
    }
    const measure = (spot: { x: number; y: number; ground: number }) => {
      const c = frame.toCartographic(spot.x, spot.y)
      // The quad is flat at the grid's ground height there (the terrain is locally smooth).
      model.modelMatrix = C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromRadians(c.longitude, c.latitude, spot.ground))
      e.scene.camera.setView({
        destination: C.Cartesian3.fromRadians(c.longitude, c.latitude, spot.ground + 250),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 }
      })
      const canvas = e.scene.canvas
      const px = { x: Math.floor(canvas.width / 2), y: Math.floor(canvas.height / 2), width: 1, height: 1 }
      const read = (enabled: number) => {
        ts.compute.binding.params.y = enabled
        render()
        render()
        return Array.from(e.scene.context.readPixels(px)) as number[]
      }
      const on = read(1)
      const off = read(0)
      ts.compute.binding.params.y = 1
      return { on, off }
    }
    const dark = find(0)
    const lit = find(1)
    const out = { dark: dark && measure(dark), lit: lit && measure(lit), found: [!!dark, !!lit] }
    e.scene.primitives.remove(model)
    ts.setSun = realSetSun
    return out
  })
  expect(result.found).toEqual([true, true])
  const { dark, lit } = result as { dark: { on: number[]; off: number[] }; lit: { on: number[]; off: number[] } }
  // Shadowed: clearly darker with terrain shadows on (sRGB of the 0.4–0.54 skylight tint).
  expect(dark.on[0], JSON.stringify(result)).toBeLessThan(dark.off[0] * 0.8)
  expect(dark.off[0]).toBeGreaterThan(100)
  // Lit: unchanged.
  expect(Math.abs(lit.on[0] - lit.off[0]), JSON.stringify(result)).toBeLessThanOrEqual(3)
})

test('a fast-moving camera preloads tiles where it is heading', async () => {
  const result = await page.evaluate(async () => {
    const w = window as unknown as { Cesium: Record<string, any>; __photoearth: any }
    const C = w.Cesium
    const e = w.__photoearth
    const camera = e.scene.camera
    // Records Cesium's tileset passes; 4 is Cesium3DTilePass.PRELOAD_FLIGHT.
    const preloads: Array<{ ahead: number; along: number }> = []
    const spy = {
      update() {},
      updateForPass(_fs: unknown, pass: { pass: number; camera: any; cullingVolume: unknown }) {
        if (pass.pass !== 4 || !pass.cullingVolume) return
        const delta = C.Cartesian3.subtract(pass.camera.positionWC, camera.positionWC, new C.Cartesian3())
        preloads.push({ ahead: C.Cartesian3.magnitude(delta), along: C.Cartesian3.dot(delta, camera.directionWC) })
      },
      isDestroyed: () => false,
      destroy() {}
    }
    e.scene.primitives.add(spy)
    camera.setView({ destination: C.Cartesian3.fromDegrees(8, 46, 3000), orientation: { heading: 0, pitch: -0.2, roll: 0 } })
    const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)))
    const t0 = performance.now()
    for (let i = 0; i < 90; i++) {
      camera.moveForward(10)
      e.scene.requestRender()
      await frame()
    }
    const seconds = (performance.now() - t0) / 1000
    const whileMoving = e.preloader.preloading
    const moving = preloads.slice()
    // Keep rendering while stationary for 2 s: the preloader re-evaluates only on rendered
    // frames, and its smoothed speed (τ = 0.2 s) needs ~1.1 s to fall from 600 m/s below its
    // 2 m/s threshold. (A frame count would depend on the frame rate.)
    const stopped = performance.now()
    while (performance.now() - stopped < 2000) {
      e.scene.requestRender()
      await frame()
    }
    const afterStop = e.preloader.preloading
    e.scene.primitives.remove(spy)
    return { preloads: moving.slice(-5), count: moving.length, speed: 900 / seconds, whileMoving, afterStop }
  })
  expect(result.whileMoving).toBe(true)
  expect(result.afterStop).toBe(false)
  expect(result.count).toBeGreaterThan(10)
  // ~1.5 s ahead at the measured speed, in the direction of travel.
  const last = result.preloads[result.preloads.length - 1]
  expect(last.along, JSON.stringify(result)).toBeGreaterThan(0.6 * result.speed * 1.5)
  expect(last.ahead, JSON.stringify(result)).toBeLessThan(1.6 * result.speed * 1.5)
})

test('coordinates in the palette fly the camera there', async () => {
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('37.7456, -119.5936')
  await expect(page.locator('.palette-item').first()).toContainText('37.74560° N')
  await page.keyboard.press('Enter')
  // The destination stays marked and named after the palette closes.
  await expect(page.locator('.chip.destination')).toContainText('37.74560° N')
  await expect
    .poll(async () => page.evaluate(() => (window as unknown as { __photoearth: any }).__photoearth.currentView().longitude), { timeout: 15_000 })
    .toBeLessThan(-119)
  // Let the flight finish: later tests move the camera themselves.
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const e = (window as unknown as { __photoearth: any }).__photoearth
          const a = e.currentView()
          await new Promise((r) => setTimeout(r, 250))
          const b = e.currentView()
          return Math.abs(a.longitude - b.longitude) + Math.abs(a.latitude - b.latitude) + Math.abs(a.height - b.height) / 1e5
        }),
      { timeout: 15_000 }
    )
    .toBeLessThan(1e-7)
})

/** Runs a test away from the current view, then restores it (later tests rely on it). */
async function awayFromView(run: () => Promise<void>): Promise<void> {
  const view = await page.evaluate(() => (window as unknown as { __photoearth: any }).__photoearth.currentView())
  try {
    await run()
  } finally {
    await page.evaluate((v) => {
      const e = (window as unknown as { __photoearth: any }).__photoearth
      e.camera.setView(v)
      e.scene.requestRender()
    }, view)
  }
}

test('the scale bar (computed without picking) matches a picked ground distance', () => awayFromView(async () => {
  const result = await page.evaluate(() => {
    const w = window as unknown as { Cesium: Record<string, any>; __photoearth: any }
    const C = w.Cesium
    const e = w.__photoearth
    const out: Array<{ pitch: number; analytic: number; picked: number }> = []
    for (const pitch of [-90, -45]) {
      e.scene.camera.setView({
        destination: C.Cartesian3.fromDegrees(8, 46, 6000),
        orientation: { heading: 0, pitch: (pitch * Math.PI) / 180, roll: 0 }
      })
      e.scene.requestRender()
      e.scene.render()
      const canvas = e.scene.canvas
      const scale = e.readouts.computeScale(0)
      // Reference: the previous method, two picks 100 px apart at the bar's row.
      const y = canvas.clientHeight - 60
      const x = canvas.clientWidth / 2
      const pick = (px: number) => e.scene.camera.pickEllipsoid(new C.Cartesian2(px, y))
      const a = pick(x - 50)
      const b = pick(x + 50)
      const picked = C.Cartesian3.distance(a, b) / 100
      // The bar's length in meters over its pixels is the analytic meters per pixel.
      const meters = Number.parseFloat(scale.label) * (scale.label.includes('km') ? 1000 : 1)
      out.push({ pitch, analytic: meters / scale.pixels, picked })
    }
    return out
  })
  for (const r of result) expect(Math.abs(r.analytic / r.picked - 1), JSON.stringify(result)).toBeLessThan(0.02)
}))

test('a drag keeps its height above rising ground instead of hugging it', () => awayFromView(async () => {
  const box = (await page.locator('.map canvas').boundingBox())!
  await page.evaluate(() => {
    const w = window as unknown as { Cesium: Record<string, any>; __photoearth: any }
    w.__photoearth.scene.camera.setView({
      destination: w.Cesium.Cartesian3.fromDegrees(8, 46, 300),
      orientation: { heading: 0, pitch: -0.4, roll: 0 }
    })
    w.__photoearth.scene.requestRender()
  })
  // Let the globe refine first: coarse tiles sag below the surface.
  await page.waitForFunction(() => {
    const e = (window as unknown as { __photoearth: any }).__photoearth
    e.scene.requestRender()
    return e.scene.globe.tilesLoaded
  }, null, { timeout: 15_000 })
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.7)
  await page.mouse.down()
  await page.waitForTimeout(200)
  // Offline the ground is the flat ellipsoid; sinking the camera stands in for ground rising
  // under a drag (the drag itself keeps a constant altitude).
  const heights = await page.evaluate(async () => {
    const w = window as unknown as { Cesium: Record<string, any>; __photoearth: any }
    const e = w.__photoearth
    const C = w.Cesium
    const height = () => e.scene.globe.ellipsoid.cartesianToCartographic(e.scene.camera.positionWC).height
    const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)))
    const before = height()
    e.scene.camera.position = C.Cartesian3.fromDegrees(8, 46, 100)
    for (let i = 0; i < 3; i++) {
      e.scene.requestRender()
      await frame()
    }
    return { before, after: height(), ground: e.scene.globeHeight }
  })
  await page.mouse.up()
  expect(Math.abs(heights.after - heights.before), JSON.stringify(heights)).toBeLessThan(5)
}))

test('arrow keys stop pitching up at 60° outside fly mode', () => awayFromView(async () => {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.down('ArrowUp')
  await page.waitForTimeout(3000)
  await page.keyboard.up('ArrowUp')
  const pitch = await page.evaluate(() => ((window as unknown as { __photoearth: any }).__photoearth.scene.camera.pitch * 180) / Math.PI)
  expect(pitch).toBeLessThanOrEqual(60.01)
  expect(pitch).toBeGreaterThan(55)
}))

test('trackpad scroll pans with the fingers, pinch and Alt+scroll keep the grabbed point; a mouse wheel goes to Cesium', () => awayFromView(async () => {
  const result = await page.evaluate(async () => {
    const w = window as unknown as { Cesium: Record<string, any>; __photoearth: any }
    const C = w.Cesium
    const e = w.__photoearth
    const camera = e.scene.camera
    const canvas = e.scene.canvas as HTMLCanvasElement
    const rect = canvas.getBoundingClientRect()
    const x = Math.round(canvas.clientWidth * 0.4)
    const y = Math.round(canvas.clientHeight * 0.6)
    camera.cancelFlight()
    // Open ocean, so the surface is the ellipsoid whether or not terrain is loaded.
    camera.setView({ destination: C.Cartesian3.fromDegrees(-30, 40, 20000), orientation: { heading: 0.3, pitch: -1, roll: 0 } })
    // The pan grabs the rendered surface: wait for the tiles there, as coarse ones sag well
    // below the ellipsoid these checks measure against.
    const deadline = performance.now() + 15_000
    do {
      e.scene.render()
      await new Promise((r) => setTimeout(r, 50))
    } while (!e.scene.globe.tilesLoaded && performance.now() < deadline)
    const pick = (px: number, py: number) => camera.pickEllipsoid(new C.Cartesian2(px, py))
    let reachedCesium = 0
    const count = () => reachedCesium++
    canvas.addEventListener('wheel', count)
    // Returns whether the event got past the trackpad handling to Cesium's canvas listener.
    const wheel = ({ wheelDeltaY, ...init }: WheelEventInit & { wheelDeltaY: number }) => {
      const ev = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: rect.left + x, clientY: rect.top + y, ...init })
      // WheelEventInit can't set the legacy wheelDelta that real devices report.
      Object.defineProperty(ev, 'wheelDeltaY', { value: wheelDeltaY })
      const before = reachedCesium
      canvas.dispatchEvent(ev)
      return reachedCesium > before
    }
    const pause = () => new Promise((r) => setTimeout(r, 300))

    // Two-finger scroll (diagonal, so unmistakably a trackpad): the ground point at
    // cursor + delta comes to the cursor; the height stays.
    const target = pick(x + 30, y + 40)
    const h0 = e.currentView().height
    const panReached = wheel({ deltaX: 30, deltaY: 40, wheelDeltaY: -120 })
    const panMiss = C.Cartesian3.distance(pick(x, y), target)
    const heightChange = Math.abs(e.currentView().height - h0) / h0

    // Pinch: zooms toward the point under the cursor, which stays put.
    await pause()
    const grabbed = pick(x, y)
    const d0 = C.Cartesian3.distance(camera.positionWC, grabbed)
    const pinchReached = wheel({ deltaY: -10.5, ctrlKey: true, wheelDeltaY: 10 })
    const pinchRatio = C.Cartesian3.distance(camera.positionWC, grabbed) / d0
    const pinchMiss = C.Cartesian3.distance(pick(x, y), grabbed)

    // Alt + scroll: orbits around the point under the cursor.
    await pause()
    const pivot = pick(x, y)
    const heading0 = camera.heading
    const orbitReached = wheel({ deltaX: 40, deltaY: 1, altKey: true, wheelDeltaY: -3 })
    const headingChange = camera.heading - heading0
    const orbitMiss = C.Cartesian3.distance(pick(x, y), pivot)

    // A mouse-wheel notch is left to Cesium.
    await pause()
    const moved = new Promise<void>((resolve) => {
      const off = camera.moveEnd.addEventListener(() => (off(), resolve()))
      setTimeout(() => (off(), resolve()), 5000)
    })
    const mouseReached = wheel({ deltaY: 100, wheelDeltaY: -120 })
    canvas.removeEventListener('wheel', count)
    // Let Cesium's zoom and its inertia finish, so it doesn't carry on after the view is restored.
    await moved
    return { panReached, panMiss, heightChange, pinchReached, pinchRatio, pinchMiss, orbitReached, headingChange, orbitMiss, mouseReached }
  })
  const r = JSON.stringify(result)
  expect(result.panReached, r).toBe(false)
  expect(result.panMiss, r).toBeLessThan(2)
  expect(result.heightChange, r).toBeLessThan(0.001)
  expect(result.pinchReached, r).toBe(false)
  expect(result.pinchRatio, r).toBeCloseTo(Math.exp(-10.5 * 0.012), 3)
  expect(result.pinchMiss, r).toBeLessThan(2)
  expect(result.orbitReached, r).toBe(false)
  // deltaX > 0 is the fingers moving left (natural scrolling): the view turns left, like a drag.
  expect(result.headingChange, r).toBeLessThan(-0.05)
  expect(result.orbitMiss, r).toBeLessThan(2)
  expect(result.mouseReached, r).toBe(true)
}))

test('the search pin is removed with its close button', async () => {
  await page.getByRole('button', { name: 'Remove search pin' }).click()
  await expect(page.locator('.chip.destination')).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { __photoearth: any }).__photoearth.searchMarker.entity)).toBeNull()
})

test('the palette explains invalid coordinates and exposes the highlighted result', async () => {
  await page.keyboard.press('ControlOrMeta+k')
  const input = page.getByRole('combobox', { name: 'Search' })
  await expect(input).toBeFocused()
  await page.keyboard.type('91, 181')
  await expect(page.locator('.palette-notice')).toContainText('Latitude 91° is outside −90° to 90°')
  await expect(page.getByText('No matches.')).toHaveCount(0)

  await input.fill('zoom')
  const activeText = () =>
    page.evaluate(() => {
      const id = document.activeElement?.getAttribute('aria-activedescendant')
      const el = id ? document.getElementById(id) : null
      return el?.getAttribute('aria-selected') === 'true' && el.getAttribute('role') === 'option' ? el.textContent : null
    })
  await expect.poll(activeText).toContain('Zoom in')
  await page.keyboard.press('ArrowDown')
  await expect.poll(activeText).toContain('Zoom out')

  // Tab never leaves the dialog for the toolbar behind it.
  for (let i = 0; i < 4; i++) await page.keyboard.press('Tab')
  expect(await page.evaluate(() => !!document.activeElement?.closest('.palette'))).toBe(true)
  await expect(page.locator('.overlay-root')).toHaveAttribute('inert', '')
  await page.keyboard.press('Escape')
  await expect(page.locator('.palette')).toHaveCount(0)
  await expect(page.locator('.overlay-root')).not.toHaveAttribute('inert', '')
})

test('Tab stays inside the settings dialog', async () => {
  await page.keyboard.press('ControlOrMeta+,')
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toBeVisible()
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press(i % 7 === 6 ? 'Shift+Tab' : 'Tab')
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), `after Tab ${i + 1}`).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})

/** Adds profile points on the ground near the view center. */
async function addProfilePoints(offsets: Array<[number, number]>): Promise<void> {
  await page.evaluate((offs) => {
    const w = window as unknown as { Cesium: Record<string, any>; __photoearth: any }
    const e = w.__photoearth
    const t = e.currentView()
    for (const [dLat, dLon] of offs) e.profile.addPoint(w.Cesium.Cartesian3.fromDegrees(t.longitude + dLon, t.latitude + dLat, 0))
  }, offsets)
}

test('finishing a profile with only a start point keeps it and explains why', async () => {
  await page.keyboard.press('p')
  await addProfilePoints([[0, 0]])
  await expect(page.getByRole('button', { name: 'Finish' })).toBeDisabled()
  await page.keyboard.press('Enter')
  await expect(page.locator('.toast')).toContainText('second point')
  const profile = () => page.evaluate(() => {
    const p = (window as unknown as { __photoearth: any }).__photoearth
    return { drawing: p.profile.drawing, points: p.profile.vertices.length }
  })
  expect(await profile()).toEqual({ drawing: true, points: 1 })
  await addProfilePoints([[0.01, 0.01]])
  await expect(page.getByRole('button', { name: 'Finish' })).toBeEnabled()
  await page.keyboard.press('Enter')
  expect(await profile()).toEqual({ drawing: false, points: 2 })
})

test('side panels never cover the profile and time panels', async () => {
  const rects = () =>
    page.evaluate(() => {
      const r = (sel: string) => Array.from(document.querySelectorAll(sel)).map((el) => el.getBoundingClientRect().toJSON() as DOMRect)
      return { side: r('.side-panel'), bottom: r('.bottom-stack > .panel') }
    })
  const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
  await page.keyboard.press('l')
  await page.keyboard.press('t')
  await page.getByRole('button', { name: 'Saved locations', exact: true }).click()
  try {
    for (const [width, height] of [[1440, 900], [1920, 1080], [1100, 900], [1280, 760]]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]), [width, height])
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width)
      await page.waitForTimeout(100)
      const { side, bottom } = await rects()
      expect(side).toHaveLength(2)
      expect(bottom).toHaveLength(2)
      for (const s of side) for (const b of bottom) expect(overlaps(s, b), `${width}×${height}: ${JSON.stringify({ s, b })}`).toBe(false)
    }
  } finally {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900))
    await page.keyboard.press('l')
    await page.keyboard.press('t')
    await page.getByRole('button', { name: 'Saved locations', exact: true }).click()
    await page.evaluate(() => (window as unknown as { __photoearth: any }).__photoearth.profile.clear())
  }
})

test('eye level stands at a dropped pin, and the same button leaves it again', () => awayFromView(async () => {
  type Pos = { lon: number; lat: number; height: number }
  const state = () =>
    page.evaluate(() => {
      const e = (window as unknown as { __photoearth: any }).__photoearth
      const v = e.currentView()
      return { eyeLevel: e.camera.isEyeLevel as boolean, lon: v.longitude as number, lat: v.latitude as number, height: v.height as number }
    })
  const start = await state()
  // Drop an inspection pin away from the view center (and from the cursor).
  const pin: Pos = await page.evaluate(() => {
    const w = window as unknown as { Cesium: Record<string, any>; __photoearth: any }
    const e = w.__photoearth
    const t = e.currentView()
    const pos = { lon: t.longitude + 0.004, lat: t.latitude + 0.003, height: 0 }
    void e.inspector.inspect(w.Cesium.Cartesian3.fromDegrees(pos.lon, pos.lat, 0))
    return pos
  })
  const button = page.getByRole('button', { name: 'Eye level at the pin (1.7 m)' })
  await button.click()
  await expect.poll(async () => (await state()).eyeLevel, { timeout: 10_000 }).toBe(true)
  const there = await state()
  expect(Math.abs(there.lon - pin.lon)).toBeLessThan(1e-6)
  expect(Math.abs(there.lat - pin.lat)).toBeLessThan(1e-6)
  await expect(page.getByRole('button', { name: 'Leave eye level' })).toHaveAttribute('aria-pressed', 'true')

  // At eye level, clicking the map drops a new marker; the button then walks over to it.
  const canvas = page.locator('.map canvas')
  const box = (await canvas.boundingBox())!
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.75)
  await expect.poll(() => page.evaluate(() => {
    const e = (window as unknown as { __photoearth: any }).__photoearth
    return !!e.inspector.point && e.inspector.point.x
  })).not.toBe(false)
  const pin2 = await page.evaluate(() => (window as unknown as { __photoearth: any }).__photoearth.inspector.point)
  expect(pin2).not.toBeNull()
  await expect.poll(() => page.locator('.rail-btn[aria-keyshortcuts="G"]').getAttribute('aria-label')).toBe('Eye level at the pin (1.7 m)')
  await page.locator('.rail-btn[aria-keyshortcuts="G"]').click()
  await expect.poll(async () => {
    const s = await state()
    return s.eyeLevel && (Math.abs(s.lon - there.lon) > 1e-6 || Math.abs(s.lat - there.lat) > 1e-6)
  }, { timeout: 10_000 }).toBe(true)
  await expect(page.locator('.rail-btn[aria-keyshortcuts="G"]')).toHaveAttribute('aria-label', 'Leave eye level')

  // Clicking it again leaves eye level and returns to the earlier view.
  await page.getByRole('button', { name: 'Leave eye level' }).click()
  await expect(page.getByRole('button', { name: 'Eye level at the pin (1.7 m)' })).toHaveAttribute('aria-pressed', 'false')
  await expect
    .poll(async () => {
      const s = await state()
      return Math.abs(s.lon - start.lon) + Math.abs(s.lat - start.lat) + Math.abs(s.height - start.height) / 1e5
    }, { timeout: 10_000 })
    .toBeLessThan(1e-6)
  expect((await state()).eyeLevel).toBe(false)
  await page.evaluate(() => (window as unknown as { __photoearth: any }).__photoearth.inspector.clear())
}))

test('rising well above the ground ends eye level, so the button enters it again', () => awayFromView(async () => {
  const button = page.locator('.rail-btn[aria-keyshortcuts="G"]')
  await button.click()
  await expect(button).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 })
  // Rise 200 m (as holding E would) and let the readouts see it.
  await page.evaluate(() => {
    const e = (window as unknown as { __photoearth: any }).__photoearth
    const v = e.currentView()
    e.scene.camera.setView({ destination: (window as any).Cesium.Cartesian3.fromDegrees(v.longitude, v.latitude, v.height + 200) })
    e.readouts.refresh()
  })
  await expect(button).toHaveAttribute('aria-pressed', 'false')
  await expect(button).toHaveAttribute('aria-label', 'Eye level at cursor (1.7 m)')
}))

/** The camera field of view and the angles it gives the viewfinder frame. */
function viewfinderState() {
  return page.evaluate(() => {
    const e = (window as unknown as { __photoearth: any }).__photoearth
    const f = e.scene.camera.frustum
    const canvas = e.scene.canvas as HTMLCanvasElement
    const frame = e.viewfinder.frame as { x: number; y: number; width: number; height: number } | null
    // Cesium's PerspectiveFrustum: fov spans the larger side of the view.
    const fovy = f.aspectRatio <= 1 ? f.fov : 2 * Math.atan(Math.tan(f.fov / 2) / f.aspectRatio)
    const fovx = 2 * Math.atan(Math.tan(fovy / 2) * f.aspectRatio)
    const span = (full: number, size: number, view: number) => (2 * Math.atan((Math.tan(full / 2) * size) / view) * 180) / Math.PI
    const svg = document.querySelector('svg.viewfinder')
    return {
      fov: f.fov as number,
      frame,
      drawn: svg?.getAttribute('data-frame')?.split(' ').map(Number) ?? null,
      h: frame ? span(fovx, frame.width, canvas.clientWidth) : null,
      v: frame ? span(fovy, frame.height, canvas.clientHeight) : null
    }
  })
}

test('the viewfinder frame shows exactly the lens angle of view, and switching off restores the field of view', async () => {
  const before = await viewfinderState()
  expect(before.frame).toBeNull()
  try {
    await checkViewfinder(before.fov)
  } finally {
    // Later tests expect the plain view.
    const close = page.getByRole('button', { name: 'Close viewfinder' })
    if (await close.count()) await close.click()
  }
})

async function checkViewfinder(originalFov: number): Promise<void> {
  const lensState = () => viewfinderState()
  await page.keyboard.press('v')
  await expect(page.locator('svg.viewfinder')).toBeVisible()
  await expect(page.locator('.viewfinder-panel')).toContainText('50 mm · FF · 3:2 · 39.6° × 27.0°')
  // 50 mm on full frame: 39.6° × 27.0° across the frame (after the 300 ms ease).
  await expect.poll(async () => (await lensState()).h ?? 0).toBeCloseTo(39.6, 1)
  let s = await lensState()
  expect(s.v).toBeCloseTo(27.0, 1)
  // The overlay draws the same rectangle the engine sized the field of view for.
  expect(s.drawn).toEqual([s.frame!.x, s.frame!.y, s.frame!.width, s.frame!.height])

  // `.` steps to the next longer preset: 85 mm, 23.9° × 16.1°.
  await page.keyboard.press('.')
  await expect(page.locator('.viewfinder-panel')).toContainText('85 mm · FF')
  await expect.poll(async () => (await lensState()).h ?? 0).toBeCloseTo(23.9, 1)

  try {
    // A tall window: Cesium's fov is now vertical, and the frame still shows the lens angle.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(820, 1000))
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(820)
    await expect.poll(async () => (await lensState()).h ?? 0).toBeCloseTo(23.9, 1)
    s = await lensState()
    expect(s.v).toBeCloseTo(16.1, 1)
    expect(s.drawn).toEqual([s.frame!.x, s.frame!.y, s.frame!.width, s.frame!.height])
  } finally {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900))
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1440)
  }

  // Guides are drawn inside the frame.
  await page.locator('.viewfinder-panel select').last().selectOption('diagonals')
  await expect(page.locator('svg.viewfinder line.vf-guide')).toHaveCount(2)
  await page.getByRole('button', { name: '50', exact: true }).click()
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

  // Off again: the original field of view comes back exactly.
  await page.keyboard.press('v')
  await expect(page.locator('svg.viewfinder')).toHaveCount(0)
  await expect.poll(async () => (await lensState()).fov).toBe(originalFov)
  // The lens settings were saved.
  await expect.poll(async () => (await page.evaluate(() => window.photoearth.settings.get())).viewfinder.guide).toBe('diagonals')
}

test('the horizon panorama draws the skyline, the sun path and named peaks', async () => {
  await page.evaluate(() => {
    const w = window as unknown as { __photoearth: any }
    const e = w.__photoearth
    const DEG = Math.PI / 180
    // A ridge in the west-south-west with a notch, foothills elsewhere (x east, y north).
    const mountains = [
      [235, 14000, 2300, 1400],
      [252, 15000, 2200, 1300],
      [244, 30000, 1500, 5000],
      [60, 6000, 600, 900],
      [150, 40000, 2800, 4000]
    ].map(([az, d, h, sigma]) => [Math.sin(az * DEG) * d, Math.cos(az * DEG) * d, h, sigma])
    const height = (x: number, y: number) => {
      let h = 250 + 40 * Math.sin(x / 2000) * Math.cos(y / 1700)
      for (const [px, py, ph, sigma] of mountains) h += ph * Math.exp(-((x - px) ** 2 + (y - py) ** 2) / (2 * sigma * sigma))
      return h
    }
    const levels = [
      [2000, 160],
      [8000, 160],
      [32000, 200],
      [128000, 200]
    ].map(([half, n]) => {
      const heights = new Float32Array(n * n)
      const cell = (2 * half) / n
      let min = Infinity
      let max = -Infinity
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          const v = height(-half + (i + 0.5) * cell, -half + (j + 0.5) * cell)
          heights[j * n + i] = v
          min = Math.min(min, v)
          max = Math.max(max, v)
        }
      return { cx: 0, cy: 0, half, n, heights, minHeight: min, maxHeight: max }
    })
    const [x0, y0] = mountains[0]
    const [x1, y1] = mountains[1]
    e.horizon.debugOpen(-118.25, 34.05, levels, [
      { id: 'p0', name: 'Notch West', x: x0 + 80, y: y0 - 60 },
      { id: 'p1', name: 'Notch East', x: x1, y: y1 },
      { id: 'hidden', name: 'Hidden', x: mountains[2][0], y: mountains[2][1] }
    ])
    // 15:30 in Los Angeles: the sun is low in the south-west.
    e.sun.setInstant(Date.parse('2026-11-21T23:30:00Z'))
  })
  const panel = page.locator('.horizon-panel')
  await expect(panel).toBeVisible()
  await expect(panel.locator('svg.horizon-chart')).toBeVisible()
  await expect(panel.locator('.horizon-peak')).toHaveCount(2)
  await expect(panel).toContainText('Notch West')
  await expect(panel).not.toContainText('Hidden')
  // The sun drops behind the ridge before it would set over a flat horizon.
  await expect(panel.locator('.horizon-stats')).toContainText('Sun over terrain')
  await expect(panel.locator('.horizon-stats')).toContainText('vs flat horizon')
  await page.getByRole('button', { name: 'Sunset' }).click()
  await panel.screenshot({ path: test.info().outputPath('horizon-sunset.png') })
  await page.getByRole('button', { name: '360°', exact: true }).click()
  await panel.screenshot({ path: test.info().outputPath('horizon-360.png') })
  // Hovering the chart reads out the skyline in that direction.
  const box = (await panel.locator('svg.horizon-chart').boundingBox())!
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5)
  await expect(panel.locator('.horizon-hover')).toContainText('skyline')
  await page.mouse.move(box.x + box.width / 2, box.y - 60)
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
})

test('time zone follows the viewed location', async () => {
  await page.keyboard.press('t')
  await expect(page.locator('.time-panel')).toContainText('America/Los_Angeles', { timeout: 10_000 })
  // It says which point the sun is calculated for, and marks it on the map.
  await expect(page.locator('.time-panel')).toContainText('For the view center')
  await expect(page.locator('.sun-target')).toBeVisible()
  // Golden hour, blue hour and twilight times for the day.
  await expect(page.locator('.light-windows')).toContainText('Golden hour')
  await expect(page.locator('.light-windows')).toContainText(/\d\d:\d\d–\d\d:\d\d|all day/)
})

test('moon: readouts, direction line, and the rendered moon where the readouts put it', async () => {
  if (!(await page.locator('.time-panel').isVisible())) await page.keyboard.press('t')
  // The full moon of 2026-03-03 (a total lunar eclipse).
  await page.evaluate(() => (window as unknown as { __photoearth: any }).__photoearth.sun.setInstant(Date.parse('2026-03-03T22:00:00Z')))
  const panel = page.locator('.time-panel')
  await expect(panel.locator('.sky-readouts')).toContainText('Moon')
  await expect(panel.locator('.moon-phase')).toContainText(/Full moon|Waning gibbous/)
  await expect(panel.locator('svg.moon-disc path.moon-disc-lit')).toHaveCount(1)
  await expect(panel.locator('.moon-phase')).toContainText('%')

  // The direction line: two more entities while it's on.
  const entities = () => page.evaluate(() => (window as unknown as { __photoearth: any }).__photoearth.widget.entities.values.length)
  const before = await entities()
  await panel.getByText('Moon direction').click()
  await expect.poll(entities).toBe(before + 2)
  await panel.getByText('Moon direction').click()
  await expect.poll(entities).toBe(before)

  // Cesium's moon is drawn at astronomy-engine's position, not its own series (~200 km, 0.03° off).
  const offset = await page.evaluate(async () => {
    const e = (window as unknown as { __photoearth: any }).__photoearth
    const C = (window as unknown as { Cesium: any }).Cesium
    e.scene.requestRender()
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const m = e.scene.moon._ellipsoidPrimitive.modelMatrix
    const [x, y, z] = C.moonEarthFixed(e.sun.utc)
    return { km: Math.hypot(m[12] - x, m[13] - y, m[14] - z) / 1000, distanceKm: Math.hypot(x, y, z) / 1000 }
  })
  expect(offset.distanceKm).toBeGreaterThan(356_000)
  expect(offset.km).toBeLessThan(1) // < 0.0002°
})

test('milky way: core readout, astro dark-window jump, direction indicator, and horizon arch', async () => {
  const panel = page.locator('.time-panel')
  if (!(await panel.isVisible())) await page.keyboard.press('t')
  // Summer new moon (2026-07-14) in Los Angeles: prime Galactic Core dark window.
  await page.evaluate(() => (window as unknown as { __photoearth: any }).__photoearth.sun.setInstant(Date.parse('2026-07-14T21:00:00Z')))
  await expect(panel.locator('.sky-readouts')).toContainText('Core')
  const astro = panel.locator('.astro-window')
  await expect(astro).toBeVisible()
  await expect(astro).toContainText('Core window')
  await expect(astro).toContainText('Peak core')
  await expect(astro).toContainText('Arch')

  // Clicking Peak core jumps directly into the dark window where the core is visible.
  await astro.getByRole('button', { name: /^\d\d:\d\d \(/ }).click()
  await expect(astro).toContainText('Visible (dark sky)')

  // Core direction indicator: two entities while enabled, removed when disabled.
  const entities = () => page.evaluate(() => (window as unknown as { __photoearth: any }).__photoearth.widget.entities.values.length)
  const before = await entities()
  await panel.getByText('Core direction').click()
  await expect.poll(entities).toBe(before + 2)
  await panel.getByText('Core direction').click()
  await expect.poll(entities).toBe(before)

  // Horizon Panorama draws the Milky Way arch and Galactic Core path, toggled by its checkbox.
  await page.evaluate(() => {
    const e = (window as unknown as { __photoearth: any }).__photoearth
    const heights = new Float32Array(64 * 64).fill(0)
    e.horizon.debugOpen(-119.59, 37.75, [{ cx: 0, cy: 0, half: 20000, n: 64, heights, minHeight: 0, maxHeight: 0 }], [])
  })
  const horizon = page.locator('.horizon-panel')
  await expect(horizon).toBeVisible()
  await expect(horizon.locator('.horizon-milky-way-arch')).toHaveCount(1)
  await expect(horizon.locator('.horizon-core-marker')).toHaveCount(1)
  await expect(horizon.locator('.horizon-stats')).toContainText('Galactic Core')
  await expect(astro).toContainText('skyline')
  await horizon.getByText('Milky Way', { exact: true }).click()
  await expect(horizon.locator('.horizon-milky-way-arch')).toHaveCount(0)
  await horizon.getByText('Milky Way', { exact: true }).click()
  await expect(horizon.locator('.horizon-milky-way-arch')).toHaveCount(1)
  await horizon.getByRole('button', { name: 'Close horizon panorama' }).click()
  await expect(horizon).toBeHidden()
})

test('weather forecast: cloud bands, sunrise and sunset outlook, jumping to a sunset', async () => {
  const panel = page.locator('.time-panel')
  if (!(await panel.isVisible())) {
    // Out of any text field, so the shortcut reaches the app.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('t')
  }
  await expect(panel).toBeVisible()
  await panel.getByRole('button', { name: 'Now' }).click()
  await expect(panel.locator('.cloud-lanes .cloud-lane')).toHaveCount(3, { timeout: 10_000 })
  expect(await panel.locator('.forecast-day').count()).toBeGreaterThanOrEqual(15)
  await expect(panel.locator('.forecast')).toContainText('Open-Meteo')
  // One request: the view center, and the sky 150 km toward the sunset and the sunrise.
  const requests = await app.evaluate(() => (globalThis as unknown as { forecastRequests: Array<{ points: unknown[] }> }).forecastRequests)
  expect(requests.length).toBeGreaterThanOrEqual(1)
  expect(requests.at(-1)!.points).toHaveLength(3)
  // Broken high cloud overhead and a clear path for the light.
  await expect(panel.locator('.forecast-detail')).toContainText('Great')
  await expect(panel.locator('.forecast-hour')).toContainText('Visibility')

  // A day's sunset button sets the date and time to that sunset.
  await panel.locator('.forecast-day').nth(2).getByRole('button', { name: /^Sunset/ }).click()
  await expect(panel.locator('.forecast-day').nth(2)).toHaveClass(/selected/)
  const clock = await panel.locator('.time-big').innerText()
  await expect(panel.locator('.forecast-detail')).toContainText(`Sunset ${clock}`)

  // Out of range, and off.
  await panel.getByLabel('Date').fill('2030-06-01')
  await expect(panel.locator('.forecast')).toContainText('No forecast for Jun 1')
  await panel.getByText('Forecast', { exact: true }).click()
  await expect(panel.locator('.forecast')).toHaveCount(0)
  await expect(panel.locator('.cloud-lanes')).toHaveCount(0)
  await panel.getByText('Forecast', { exact: true }).click()
  await panel.getByRole('button', { name: 'Now' }).click()
})

/** Answers Map Tiles API requests (session, tiles, viewport copyright) so Map mode runs without a key. */
async function mockMapTiles(): Promise<{ sessions: Array<Record<string, unknown>>; tiles: string[]; unroute: () => Promise<void> }> {
  const png = await testPng(256, 256)
  const sessions: Array<Record<string, unknown>> = []
  const tiles: string[] = []
  const pattern = /^https:\/\/(tile\.googleapis\.com|assets\.ion\.cesium\.com\/google-credit\.png)/
  await page.route(pattern, (route) => {
    const url = route.request().url()
    if (url.includes('/v1/createSession')) {
      sessions.push(JSON.parse(route.request().postData() ?? '{}'))
      const expiry = String(Math.floor(Date.now() / 1000) + 14 * 86_400)
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ session: `s${sessions.length}`, expiry, tileWidth: 256, tileHeight: 256 }) })
    }
    if (url.includes('/tile/v1/viewport')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ copyright: 'Map data ©2026 Test', maxZoomRects: [] }) })
    }
    if (url.includes('/v1/2dtiles/')) tiles.push(url)
    return route.fulfill({ status: 200, contentType: 'image/png', body: png })
  })
  return { sessions, tiles, unroute: () => page.unroute(pattern) }
}

const mapView = () => page.evaluate(() => (window as unknown as { __photoearth: any }).__photoearth.mapView() as { longitude: number; latitude: number; zoom: number })
const view3d = () => page.evaluate(() => (window as unknown as { __photoearth: any }).__photoearth.currentView())
const set3dView = (v: { longitude: number; latitude: number; height: number; heading: number; pitch: number }) =>
  page.evaluate((v) => {
    const e = (window as unknown as { __photoearth: any }).__photoearth
    e.camera.setView({ ...v, roll: 0 })
    e.scene.render()
    e.readouts.refresh()
  }, v)
/** Waits until the map has stood still and saved its view. */
const settledMap = async () => {
  await expect.poll(async () => {
    const a = await mapView()
    await page.waitForTimeout(350)
    const b = await mapView()
    const saved = (await page.evaluate(() => window.photoearth.settings.get())).map
    return Math.abs(a.longitude - b.longitude) + Math.abs(a.latitude - b.latitude) + Math.abs(a.zoom - b.zoom) + Math.abs(saved.zoom - b.zoom)
  }).toBeLessThan(1e-9)
  return mapView()
}

test('Map mode: a full-window Google map over the paused 3D view; drag, wheel, keys and search move it; 3D opens at its center', () => awayFromView(async () => {
  const mock = await mockMapTiles()
  try {
    // No search pin left from earlier tests. 3D: 4 km up over flat ground (no terrain
    // token), looking east 30° down.
    await page.evaluate(() => (window as unknown as { __photoearth: any }).__photoearth.searchMarker.clear())
    await set3dView({ longitude: 7.75, latitude: 46, height: 4000, heading: 90, pitch: -30 })
    await page.getByRole('tab', { name: 'Map' }).click()
    const map = page.getByTestId('map-mode')
    await expect(map).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Map' })).toHaveAttribute('aria-selected', 'true')
    await expect.poll(async () => (await page.evaluate(() => window.photoearth.settings.get())).map.open).toBe(true)
    // Cesium's render loop stops under the map.
    expect(await page.evaluate(() => (window as unknown as { __photoearth: any }).__photoearth.widget.useDefaultRenderLoop)).toBe(false)

    // Opens on the 3D view center, 4000 / tan 30° = 6.9 km east of the camera, not on the
    // camera. (The center is picked on the globe, whose still-coarse tiles sag below the
    // ellipsoid here and push the hit up to ~1.5 km further.)
    const opened = await mapView()
    const metersEast = (opened.longitude - 7.75) * 111_320 * Math.cos((46 * Math.PI) / 180)
    expect(metersEast).toBeGreaterThan(6928 - 300)
    expect(metersEast).toBeLessThan(6928 + 2000)
    expect(Math.abs(opened.latitude - 46) * 111_320).toBeLessThan(300)

    // Tiles from Map mode's own session (no key in the test: hand the engine one).
    await page.evaluate(async () => {
      const e = (window as unknown as { __photoearth: any }).__photoearth
      e.keys.googleApiKey = 'test-key'
      await e.mapTiles.configure('test-key', 'roadmap')
    })
    const tileState = () =>
      page.evaluate(() => (window as unknown as { __photoearthMap: any }).__photoearthMap.tileState() as { layers: number; tiles: number; ready: number; urls: string[] })
    await expect.poll(async () => (await tileState()).ready).toBeGreaterThan(4)
    expect(mock.sessions.at(-1)).toMatchObject({ mapType: 'roadmap' })
    for (const src of (await tileState()).urls) {
      expect(src).toMatch(/^https:\/\/tile\.googleapis\.com\/v1\/2dtiles\/\d+\/\d+\/\d+\?session=s\d+&key=test-key$/)
    }
    const attribution = page.getByTestId('map-attribution')
    await expect(attribution.locator('img[alt="Google"]')).toBeVisible()
    await expect(attribution).toContainText('Map data ©2026 Test')
    // The 3D camera is marked, facing its heading.
    await expect(page.locator('.map-marker')).toHaveAttribute('transform', /rotate\(90\.0\)$/)

    // Nothing renders in 3D while the map moves.
    await page.evaluate(() => {
      const e = (window as unknown as { __photoearth: any }).__photoearth
      const g = window as unknown as { __renders: number; __stopCounting: () => void }
      g.__renders = 0
      g.__stopCounting = e.scene.postRender.addEventListener(() => g.__renders++)
    })

    // Drag: the ground follows the pointer (a pause before release: no throw).
    const start = await settledMap()
    await page.mouse.move(700, 450)
    await page.mouse.down()
    for (let i = 1; i <= 10; i++) await page.mouse.move(700 + i * 20, 450)
    await page.waitForTimeout(120)
    await page.mouse.up()
    const dragged = await settledMap()
    expect(dragged.longitude - start.longitude).toBeCloseTo((-200 / (256 * 2 ** start.zoom)) * 360, 6)
    expect(dragged.latitude).toBeCloseTo(start.latitude, 9)

    // Wheel: one notch in is one zoom level, about the cursor.
    await page.mouse.move(400, 300)
    await page.mouse.wheel(0, -100)
    const zoomed = await settledMap()
    expect(zoomed.zoom).toBeCloseTo(dragged.zoom + 1, 3)

    // Arrow keys pan (right: the view moves east).
    await page.keyboard.down('ArrowRight')
    await page.waitForTimeout(300)
    await page.keyboard.up('ArrowRight')
    expect((await settledMap()).longitude).toBeGreaterThan(zoomed.longitude)

    // No flashing while zooming across tile levels, even a quick zoom out by two: the whole map
    // stays covered by visible tiles the whole time (previous levels and the coarse backdrop
    // stay underneath until the new level covers the view).
    // What each frame drew into the canvas, as screen rectangles.
    await page.evaluate(() => (window as unknown as { __photoearthMap: any }).__photoearthMap.drawnTiles())
    await page.waitForTimeout(300)
    const sampling = page.evaluate(async () => {
      const map = (window as unknown as { __photoearthMap: any }).__photoearthMap
      const root = document.querySelector('.map-mode') as HTMLElement
      const W = root.clientWidth
      const H = root.clientHeight
      const points: Array<[number, number]> = []
      for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) points.push([W * (0.05 + 0.1125 * i), H * (0.05 + 0.1125 * j)])
      const visible = () => map.drawnTiles() as Array<{ left: number; top: number; right: number; bottom: number }>
      let worst = 0
      let samples = 0
      const start = performance.now()
      while (performance.now() - start < 4200) {
        const rects = visible()
        const missing = points.filter(([x, y]) => !rects.some((r) => x >= r.left && x < r.right && y >= r.top && y < r.bottom)).length
        worst = Math.max(worst, missing)
        samples++
        await new Promise((r) => setTimeout(r, 8))
      }
      return { worst, samples }
    })
    await page.mouse.move(720, 450)
    for (const dy of [-100, -100, 100, 100, 200]) {
      await page.mouse.wheel(0, dy)
      await page.waitForTimeout(700)
    }
    const coverage = await sampling
    expect(coverage.samples).toBeGreaterThan(50)
    expect(coverage.worst).toBe(0)
    await settledMap()

    expect(await page.evaluate(() => (window as unknown as { __renders: number }).__renders)).toBe(0)
    await page.evaluate(() => (window as unknown as { __stopCounting: () => void }).__stopCounting())

    // Search moves the map (with a pin), not the 3D camera.
    const before3d = await view3d()
    await page.keyboard.press('ControlOrMeta+k')
    await page.keyboard.type('46.5, 8.0')
    await page.keyboard.press('Enter')
    await expect(page.locator('.map-pin.destination')).toHaveCount(1)
    // (The map eases there; in this hidden test window frames are throttled.)
    await expect.poll(async () => Math.abs((await mapView()).latitude - 46.5), { timeout: 10_000 }).toBeLessThan(1e-4)
    const searched = await settledMap()
    expect(searched.latitude).toBeCloseTo(46.5, 4)
    expect(searched.longitude).toBeCloseTo(8.0, 4)
    expect((await view3d()).longitude).toBeCloseTo(before3d.longitude, 9)
    // The pin sits on the place: at the map's center.
    const pinCenter = async () => {
      const r = await page.locator('.map-pin.destination .dot').boundingBox()
      return r ? Math.hypot(r.x + r.width / 2 - 720, r.y + r.height / 2 - 450) : Infinity
    }
    await expect.poll(pinCenter).toBeLessThan(3)

    // Back to 3D: looking at the map's center with the same heading and pitch, from the
    // distance at which the scales match.
    await page.getByRole('tab', { name: 'Photorealistic' }).click()
    await expect(map).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { __photoearth: any }).__photoearth.widget.useDefaultRenderLoop)).toBe(true)
    const back = await view3d()
    expect(back.heading).toBeCloseTo(90, 3)
    expect(back.pitch).toBeCloseTo(-30, 3)
    expect(back.latitude).toBeCloseTo(46.5, 2)
    // Standing west of the center (looking east), at range · cos 30° on flat ground.
    const { width, fov } = await page.evaluate(() => {
      const scene = (window as unknown as { __photoearth: any }).__photoearth.scene
      return { width: scene.canvas.clientWidth as number, fov: scene.camera.frustum.fov as number }
    })
    const range = ((156543.03392 * Math.cos((46.5 * Math.PI) / 180)) / 2 ** searched.zoom) * width / (2 * Math.tan(fov / 2))
    const west = (8.0 - back.longitude) * 111_320 * Math.cos((46.5 * Math.PI) / 180)
    expect(west / (range * Math.cos(Math.PI / 6))).toBeCloseTo(1, 1)
    // Above the ground at the center as the engine knows it (no terrain token here: the globe).
    const ground = await page.evaluate(() => (window as unknown as { __photoearth: any }).__photoearth.groundHeight(8.0, 46.5) as Promise<number>)
    expect((back.height - ground) / (range * Math.sin(Math.PI / 6))).toBeCloseTo(1, 1)

    // Opening the map and closing it without moving it keeps the 3D view exactly.
    await set3dView({ longitude: 7.75, latitude: 46, height: 4000, heading: 200, pitch: -50 })
    const exact = await view3d()
    await page.keyboard.press('3')
    await expect(map).toBeVisible()
    await page.keyboard.press('1')
    await expect(map).toHaveCount(0)
    const restored = await view3d()
    for (const k of ['longitude', 'latitude', 'height', 'heading', 'pitch'] as const) expect(restored[k]).toBeCloseTo(exact[k], 6)
  } finally {
    await page.evaluate(async () => {
      const e = (window as unknown as { __photoearth: any }).__photoearth
      if (window.photoearth && (await window.photoearth.settings.get()).map.open) await e.setMode('photorealistic')
      e.searchMarker.clear()
      e.mapTiles.destroy()
      e.keys.googleApiKey = null
    })
    await mock.unroute()
  }
}))

test('Map mode: only map controls, saved locations as pins, and 3D tools take you back to 3D', async () => {
  const mock = await mockMapTiles()
  try {
    await page.keyboard.press('3')
    const map = page.getByTestId('map-mode')
    await expect(map).toBeVisible()
    // Without a key it says what's missing.
    await expect(map).toContainText('Add a Google Maps Platform key')
    // The rail keeps saved locations, settings and help; the status bar drops the 3D camera.
    const rail = page.getByRole('toolbar', { name: 'Tools' })
    await expect(rail.getByRole('button')).toHaveCount(3)
    await expect(page.getByRole('button', { name: 'Saved locations', exact: true })).toBeVisible()
    await expect(page.locator('.statusbar')).not.toContainText('Cam')
    // The map type is switchable here, and the session follows it.
    await page.evaluate(async () => {
      const e = (window as unknown as { __photoearth: any }).__photoearth
      e.keys.googleApiKey = 'test-key'
      await e.mapTiles.configure('test-key', 'roadmap')
    })
    await page.getByRole('radio', { name: 'Satellite' }).click()
    await expect.poll(() => mock.sessions.at(-1)).toMatchObject({ mapType: 'satellite', layerTypes: ['layerRoadmap'] })

    // Saved locations are pins; clicking one opens it in the panel.
    const [location] = await page.evaluate(() => window.photoearth.bookmarks.list())
    await page.keyboard.press('ControlOrMeta+k')
    await page.keyboard.type(`${location.position.latitude}, ${location.position.longitude}`)
    await page.keyboard.press('Enter')
    const pin = page.getByRole('button', { name: `Saved location: ${location.name}` })
    await expect(pin).toBeVisible()
    await pin.click()
    await expect(page.locator('.side-panel.left')).toBeVisible()
    await expect(map).toBeVisible()
    await page.getByRole('button', { name: 'Saved locations', exact: true }).click()

    // A 3D tool from the palette leaves the map first.
    await page.keyboard.press('ControlOrMeta+k')
    await page.keyboard.type('Top-down view')
    await page.keyboard.press('Enter')
    await expect(map).toHaveCount(0)
    await expect(page.getByRole('tab', { name: 'Photorealistic' })).toHaveAttribute('aria-selected', 'true')
    await expect.poll(async () => (await view3d()).pitch, { timeout: 10_000 }).toBeLessThan(-85)
  } finally {
    await page.evaluate(async () => {
      const e = (window as unknown as { __photoearth: any }).__photoearth
      if ((await window.photoearth.settings.get()).map.open) await e.setMode('photorealistic')
      e.searchMarker.clear()
      e.mapTiles.destroy()
      e.keys.googleApiKey = null
    })
    await mock.unroute()
  }
})

test('Map mode: no seams between tiles at fractional zooms', async () => {
  // Solid tiles: any pixel of another color inside the map is a gap between tiles.
  const tileColor = [0x3a, 0x7b, 0xd5]
  const solid = Buffer.from(
    await page.evaluate(async () => {
      const canvas = new OffscreenCanvas(256, 256)
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#3a7bd5'
      ctx.fillRect(0, 0, 256, 256)
      const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())
      let s = ''
      for (const b of bytes) s += String.fromCharCode(b)
      return btoa(s)
    }),
    'base64'
  )
  const pattern = /^https:\/\/(tile\.googleapis\.com|assets\.ion\.cesium\.com\/google-credit\.png)/
  await page.route(pattern, (route) => {
    const url = route.request().url()
    if (url.includes('/v1/createSession')) {
      const expiry = String(Math.floor(Date.now() / 1000) + 14 * 86_400)
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ session: 'seams', expiry, tileWidth: 256, tileHeight: 256 }) })
    }
    if (url.includes('/tile/v1/viewport')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    return route.fulfill({ status: 200, contentType: 'image/png', body: solid })
  })
  // The camera marker, pins, crosshair, attribution and banners are drawn over the map: hide them.
  const style = await page.addStyleTag({ content: '.map-camera, .map-pins, .map-center, .map-attribution, .map-empty, .top-center { display: none !important }' })
  try {
    await page.keyboard.press('3')
    await expect(page.getByTestId('map-mode')).toBeVisible()
    await page.evaluate(async () => {
      const e = (window as unknown as { __photoearth: any }).__photoearth
      e.keys.googleApiKey = 'test-key'
      await e.mapTiles.configure('test-key', 'roadmap')
    })
    await page.mouse.move(700, 450)
    // Ctrl+wheel to fractional zooms (100 px a zoom): tiles drawn at ~123 %, ~84 % and ~146 %,
    // and the whole world (narrower than the window: drawn twice side by side).
    const base = Math.floor((await mapView()).zoom)
    for (const target of [base + 0.3, base + 0.75, base + 1.45, 2.3]) {
      const dy = Math.round(((await mapView()).zoom - target) * 100)
      await page.keyboard.down('Control')
      await page.mouse.wheel(0, dy)
      await page.keyboard.up('Control')
      // Stood still, no previous zoom left underneath (the backdrop stays), every tile decoded.
      await settledMap()
      await expect
        .poll(() =>
          page.evaluate(() => {
            const t = (window as unknown as { __photoearthMap: any }).__photoearthMap.tileState()
            return t.layers <= 2 && t.ready === t.tiles
          })
        )
        .toBe(true)
      const zoom = await mapView().then((v) => v.zoom)
      expect(Math.abs(zoom - Math.round(zoom))).toBeGreaterThan(0.05)
      // The map between the top bar (and its shadow), the tool rail and the status bar.
      const shot = await page.screenshot({ clip: { x: 20, y: 100, width: 1320, height: 740 } })
      const off = await page.evaluate(
        async ([png, [r, g, b]]) => {
          const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0))
          const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
          const ctx = canvas.getContext('2d')!
          ctx.drawImage(bitmap, 0, 0)
          const d = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data
          let n = 0
          for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - r) > 8 || Math.abs(d[i + 1] - g) > 8 || Math.abs(d[i + 2] - b) > 8) n++
          return n
        },
        [shot.toString('base64'), tileColor] as const
      )
      expect(off, `zoom ${zoom.toFixed(3)}: pixels not covered by tiles`).toBe(0)
    }
  } finally {
    await style.evaluate((el) => (el as HTMLElement).remove())
    await page.evaluate(async () => {
      const e = (window as unknown as { __photoearth: any }).__photoearth
      if ((await window.photoearth.settings.get()).map.open) await e.setMode('photorealistic')
      e.mapTiles.destroy()
      e.keys.googleApiKey = null
    })
    await page.unroute(pattern)
  }
})

test('light pollution: overlay layer, legend, and a sky brightness estimate at the inspected point', async () => {
  // Offline and deterministic: color tiles are a 1×1 PNG, the data tiles a uniform field of
  // 1.29× natural brightness (the 2025 atlas's value for Zermatt), gzipped as served.
  const n = 600
  const tile = new Int8Array(n * n + 1)
  tile[0] = 1
  tile[1] = 74 // 128 + 74 = 202 → (5/195)(e^(0.0195·202) − 1) = 1.291
  const gz = gzipSync(Buffer.from(tile.buffer))
  const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
  const dataRequests: string[] = []
  await page.route(/^https:\/\/(djlorenz\.github\.io|gibs\.earthdata\.nasa\.gov)\//, (route) => {
    const url = route.request().url()
    if (url.endsWith('.dat.gz')) {
      dataRequests.push(url)
      return route.fulfill({ status: 200, contentType: 'application/gzip', body: gz })
    }
    return route.fulfill({ status: 200, contentType: 'image/png', body: png1x1 })
  })
  const engineState = () =>
    page.evaluate(() => {
      const e = (window as unknown as { __photoearth: any }).__photoearth
      const layers = e.scene.imageryLayers
      const urls: string[] = []
      for (let i = 0; i < layers.length; i++) urls.push(String(layers.get(i).imageryProvider.url ?? ''))
      return { urls, shown: e.lightPollution.shown, globeLit: e.scene.globe.enableLighting }
    })
  const before = await engineState()
  expect(before.urls.some((u) => u.includes('djlorenz'))).toBe(false)

  // On from the rail (K is the shortcut; focus may sit in a panel control here).
  await page.getByRole('button', { name: 'Light pollution: sky brightness & Bortle estimate' }).click()
  await expect(page.getByRole('button', { name: 'Light pollution: hide' })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => (await engineState()).urls.filter((u) => u.includes('djlorenz')).length).toBe(1)
  // Without a Google key the globe is the backdrop, so the layer is drawn, and unlit so it
  // reads as its legend at any simulated time.
  const on = await engineState()
  expect(on.urls.length).toBe(before.urls.length + 1)
  expect(on.shown).toBe(true)
  expect(on.globeLit).toBe(false)

  // Legend: one chip per zone.
  if (!(await page.locator('.light-pollution').isVisible())) await page.keyboard.press('l')
  await expect(page.locator('.light-pollution .lp-zones > div')).toHaveCount(15)
  await expect(page.locator('.light-pollution')).toContainText('mag/arcsec²')

  // Inspect the view center.
  const tileUrl = await page.evaluate(() => {
    const e = (window as unknown as { __photoearth: any }).__photoearth
    const C = (window as unknown as { Cesium: any }).Cesium
    const canvas = e.scene.canvas
    const p = e.scene.camera.pickEllipsoid(new C.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2))
    void e.inspector.inspect(p)
    const { longitude, latitude } = e.scene.globe.ellipsoid.cartesianToCartographic(p)
    const lon = (longitude * 180) / Math.PI
    const lat = (latitude * 180) / Math.PI
    const x = Math.floor(((((lon + 180) % 360) + 360) % 360) / 5) + 1
    const y = Math.floor((lat + 65) / 5) + 1
    return `https://djlorenz.github.io/astronomy/binary_tiles/2025/binary_tile_${x}_${y}.dat.gz`
  })
  const readout = page.locator('.inspect-card .sky-readout')
  await expect(readout).toContainText('21.10 mag/arcsec²')
  await expect(readout).toContainText('≈ 4')
  await expect(readout).toContainText('4a')
  await expect(readout).toContainText('Estimate')
  expect(dataRequests).toEqual([tileUrl])

  // Black Marble replaces the layer; readouts keep using the atlas (no refetch).
  await page.getByRole('combobox', { name: 'Light pollution source' }).selectOption('black-marble')
  await expect.poll(async () => (await engineState()).urls.filter((u) => u.includes('gibs.earthdata')).length).toBe(1)
  expect((await engineState()).urls.some((u) => u.includes('djlorenz'))).toBe(false)
  await expect(page.locator('.light-pollution')).toContainText('not sky brightness')
  await expect(readout).toContainText('21.10 mag/arcsec²')
  expect(dataRequests).toHaveLength(1)

  // Off: the layer and the readout are gone, globe lighting is back.
  await page.getByRole('button', { name: 'Light pollution: hide' }).click()
  await expect.poll(async () => (await engineState()).urls.length).toBe(before.urls.length)
  await expect(readout).toHaveCount(0)
  expect((await engineState()).globeLit).toBe(before.globeLit)
  await page.keyboard.press('Escape')
  await page.unroute(/^https:\/\/(djlorenz\.github\.io|gibs\.earthdata\.nasa\.gov)\//)
})

/** A PNG of the given size, drawn in the page (so the test needs no image files). */
async function testPng(width: number, height: number): Promise<Buffer> {
  const base64 = await page.evaluate(async ([w, h]) => {
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#3a7bd5'
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = '#ffd54f'
    ctx.fillRect(0, 0, w / 2, h / 2)
    const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())
    let s = ''
    for (const b of bytes) s += String.fromCharCode(b)
    return btoa(s)
  }, [width, height])
  return Buffer.from(base64, 'base64')
}

test('saved locations: save, edit, filter, photos, profiles and map markers', async () => {
  // Ctrl/Cmd+B saves the view and opens the list, keeping the keyboard on the map.
  await page.keyboard.press('ControlOrMeta+b')
  const panel = page.locator('.locations-panel')
  await expect(panel.locator('.location-row')).toHaveCount(2)
  const saved = (await page.evaluate(() => window.photoearth.bookmarks.list()))[1]
  expect(saved.position.height).not.toBeNull()
  expect(saved.time).toBeDefined()
  const row = panel.locator('.location-row').first()
  await row.hover()
  await row.getByRole('button', { name: /^Edit / }).click()

  // The editor: every field saves on its own.
  const name = panel.getByRole('textbox', { name: 'Name', exact: true })
  await name.fill('Sunset ridge')
  await name.press('Enter')
  await panel.getByRole('group', { name: 'Status' }).getByRole('button', { name: 'Visited' }).click()
  await panel.getByRole('combobox', { name: 'Add tag' }).fill('Sunset, Lake,')
  await panel.getByRole('textbox', { name: 'Best time' }).fill('Late October evenings')
  await panel.getByRole('textbox', { name: 'Best time' }).press('Enter')
  await panel.getByRole('textbox', { name: 'Notes' }).fill('Park at the upper lot.')
  await panel.getByRole('textbox', { name: 'Notes' }).blur()
  await expect
    .poll(async () => (await page.evaluate(() => window.photoearth.bookmarks.list()))[1])
    .toMatchObject({ name: 'Sunset ridge', status: 'visited', tags: ['sunset', 'lake'], bestTime: 'Late October evenings', notes: 'Park at the upper lot.' })

  // "Add photos" opens the native file picker (stubbed here: Playwright can't click OS dialogs).
  // Photos are copied into userData with a thumbnail; huge files are refused before they're read.
  const pickDir = mkdtempSync(join(tmpdir(), 'photoearth-pick-'))
  const ridge = join(pickDir, 'ridge.png')
  writeFileSync(ridge, await testPng(640, 360))
  const huge = join(pickDir, 'huge.jpg')
  writeFileSync(huge, Buffer.alloc(41 * 1024 * 1024, 0xff))
  const pickNext = (paths: string[]) =>
    app.evaluate(({ dialog }, chosen) => {
      const calls: unknown[] = []
      ;(globalThis as { pickerCalls?: unknown[] }).pickerCalls = calls
      dialog.showOpenDialog = (async (...args: unknown[]) => {
        calls.push(args[args.length - 1])
        return { canceled: false, filePaths: chosen }
      }) as typeof dialog.showOpenDialog
    }, paths)
  try {
    await pickNext([ridge])
    await panel.getByRole('button', { name: 'Add photos' }).click()
    await expect(panel.locator('.photo-thumb img')).toHaveCount(1)
    const call = await app.evaluate(() => (globalThis as { pickerCalls?: Array<{ title: string; properties: string[] }> }).pickerCalls?.[0])
    expect(call).toMatchObject({ title: 'Add photos to “Sunset ridge”', properties: ['openFile', 'multiSelections'] })
    await expect.poll(() => panel.locator('.photo-thumb img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(427)
    const photos = readdirSync(join(userData, 'photos'))
    expect(photos.filter((f) => f.endsWith('.png'))).toHaveLength(1)
    expect(photos.filter((f) => f.endsWith('.thumb.jpg'))).toHaveLength(1)
    await pickNext([huge])
    await panel.getByRole('button', { name: 'Add photos' }).click()
    await expect(page.locator('.toast')).toContainText('at most 40 MB')
    await expect(panel.locator('.photo-thumb')).toHaveCount(1)
  } finally {
    rmSync(pickDir, { recursive: true, force: true })
  }
  // Full size in a dialog, served by photo:// (not a path on disk).
  await panel.locator('.photo-open').click()
  const viewer = page.getByRole('dialog', { name: /Sunset ridge: ridge\.png/ })
  await expect(viewer).toBeVisible()
  await expect.poll(() => viewer.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(640)
  expect(await viewer.locator('img').getAttribute('src')).toMatch(/^photo:\/\/local\/[0-9a-f-]{36}\.png$/)
  await page.keyboard.press('Escape')
  await expect(viewer).toHaveCount(0)

  // An elevation profile saved with the location, and one on its own; both reopen.
  await page.keyboard.press('p')
  await addProfilePoints([[0, 0], [0.01, 0.012]])
  await page.keyboard.press('Enter')
  await panel.getByRole('button', { name: 'Save drawn path here' }).click()
  await expect(panel.locator('.profile-row')).toHaveCount(1)
  await page.keyboard.press('p')
  await addProfilePoints([[0, 0], [-0.01, 0.005], [-0.012, 0.012]])
  await page.keyboard.press('Enter')
  await page.locator('.profile-panel').getByRole('button', { name: 'Save path' }).click()
  await page.locator('.profile-panel').getByRole('combobox', { name: 'Save with' }).selectOption('')
  await page.locator('.profile-panel').getByRole('textbox', { name: 'Profile name' }).fill('Valley floor')
  await page.locator('.profile-panel').getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.profile-panel')).toContainText('Valley floor')
  const profiles = await page.evaluate(() => window.photoearth.profiles.list())
  expect(profiles.map((p) => [p.name, p.locationId, p.points.length])).toEqual([
    [expect.stringMatching(/^Path /), saved.id, 2],
    ['Valley floor', null, 3]
  ])
  await page.evaluate(() => (window as unknown as { __photoearth: any }).__photoearth.profile.clear())
  await panel.locator('.profile-row .name').click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __photoearth: any }).__photoearth.profile.vertices.length)).toBe(2)
  await expect(page.locator('.profile-panel strong')).toHaveText('Elevation profile')
  await page.evaluate(() => (window as unknown as { __photoearth: any }).__photoearth.profile.clear())

  // The list filters by status and tag; general profiles are listed under it.
  await panel.getByRole('button', { name: 'Back to all locations' }).click()
  await expect(panel.locator('.location-row')).toHaveCount(2)
  await expect(panel.locator('.profile-row')).toHaveText(/Valley floor/)
  await panel.getByRole('group', { name: 'Filter by status' }).getByRole('button', { name: 'Visited' }).click()
  await expect(panel.locator('.location-row')).toHaveCount(1)
  await expect(panel.locator('.location-row')).toContainText('Sunset ridge')
  await panel.getByRole('group', { name: 'Filter by status' }).getByRole('button', { name: 'All' }).click()
  await panel.getByRole('group', { name: 'Filter by tag' }).getByRole('button', { name: 'lake' }).click()
  await expect(panel.locator('.location-row')).toHaveCount(1)
  // The map shows the same locations as the list.
  expect(await page.evaluate(() => (window as unknown as { __photoearth: any }).__photoearth.markers.markers.length)).toBe(1)
  await panel.getByRole('group', { name: 'Filter by tag' }).getByRole('button', { name: 'lake' }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __photoearth: any }).__photoearth.markers.markers.length)).toBe(2)

  // Clicking its pin opens the location and restores its time. The time panel (left open by
  // earlier tests, and taller with the forecast) would cover the pin at the view center.
  if (await page.locator('.time-panel').isVisible()) await page.getByRole('button', { name: 'Close time & sun' }).click()
  await page.evaluate(() => (window as unknown as { __photoearth: any }).__photoearth.sun.setInstant(Date.parse('2026-01-15T12:00:00Z')))
  // Back at the saved view (reopening the profile framed its path), the pin is where it was saved.
  const pin = await page.evaluate(({ id, camera }) => {
    const e = (window as unknown as { __photoearth: any }).__photoearth
    e.camera.setView(camera)
    e.scene.render()
    return e.markers.screenPosition(id)
  }, { id: saved.id, camera: saved.camera })
  expect(pin).not.toBeNull()
  const box = (await page.locator('.map canvas').boundingBox())!
  await page.mouse.click(box.x + pin.x, box.y + pin.y - 12)
  await expect(panel.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Sunset ridge')
  await expect.poll(() => page.evaluate(() => (window as unknown as { __photoearth: any }).__photoearth.sun.utc)).toBe(Date.parse(saved.time!.utc))
  await panel.getByRole('button', { name: 'Back to all locations' }).click()
})

test('saved locations persist across a restart', async () => {
  const before = await page.evaluate(() => window.photoearth.bookmarks.list())
  expect(before).toHaveLength(2)
  // A known last view (the one a location click flew to may still be in the air).
  await page.evaluate(() => {
    const e = (window as unknown as { __photoearth: any }).__photoearth
    e.scene.camera.cancelFlight()
    e.camera.setView({ longitude: -120.5, latitude: 37.7, height: 5000, heading: 0, pitch: -30, roll: 0 })
  })
  await app.close()
  app = await electron.launch({ args: ['.'], env: launchEnv() })
  page = await app.firstWindow()
  await page.waitForFunction(() => !!(window as unknown as { __photoearth?: unknown }).__photoearth, null, { timeout: 30_000 })
  const list = await page.evaluate(() => window.photoearth.bookmarks.list())
  expect(list).toEqual(before)
  expect((await page.evaluate(() => window.photoearth.profiles.list())).map((p) => p.name)).toContain('Valley floor')
  // The last camera position was restored too.
  const lon = await page.evaluate(() => (window as unknown as { __photoearth: any }).__photoearth.currentView().longitude)
  expect(lon).toBeLessThan(-119)
})

test('shot alignment planner computes geometry, line of sight, and reverse Sun/Moon dates', async () => {
  // X opens the Shot Alignment panel; Esc closes pick mode first, then the panel.
  await page.keyboard.press('x')
  const panel = page.locator('.alignment-panel')
  await expect(panel).toBeVisible()
  await expect(page.locator('.chip-row')).toContainText('place the Camera pin')

  // Populate a Camera → Subject shot facing ~255° WSW at +3.5° elevation in Zurich, with an obstructing ridge.
  await page.evaluate(() => {
    const e = (window as unknown as { __photoearth: any }).__photoearth
    const cam = { latitude: 47.3769, longitude: 8.5417, groundHeight: 450, msl: 400, label: 'Overlook' }
    const sub = { latitude: 47.3536, longitude: 8.4136, groundHeight: 1068, msl: 1018, label: 'Ridge peak' }
    const samples = Array.from({ length: 101 }, (_, i) => {
      const t = i / 100
      const dist = t * 10_000
      // Ridge sticks up 60 m above the straight line around 4 km.
      const ridge = 140 * Math.exp(-(((dist - 4000) / 350) ** 2))
      return {
        latitude: cam.latitude + (sub.latitude - cam.latitude) * t,
        longitude: cam.longitude + (sub.longitude - cam.longitude) * t,
        distance: dist,
        height: 450 + 618 * t - 80 + ridge
      }
    })
    e.alignment.debugSetPins(cam, sub, samples)
  })

  await expect(panel).toContainText('Overlook')
  await expect(panel).toContainText('Ridge peak')
  await expect(panel.locator('.align-los')).toContainText('Obstructed')
  await expect(panel).toContainText('Sun / Moon disc at subject')

  // Clear LOS updates the badge and removes obstruction.
  await page.evaluate(() => {
    const e = (window as unknown as { __photoearth: any }).__photoearth
    const cam = { latitude: 47.3769, longitude: 8.5417, groundHeight: 450, msl: 400, label: 'Overlook' }
    const sub = { latitude: 47.3536, longitude: 8.4136, groundHeight: 1068, msl: 1018, label: 'Ridge peak' }
    const samples = Array.from({ length: 101 }, (_, i) => {
      const t = i / 100
      return {
        latitude: cam.latitude + (sub.latitude - cam.latitude) * t,
        longitude: cam.longitude + (sub.longitude - cam.longitude) * t,
        distance: t * 10_000,
        height: 400
      }
    })
    e.alignment.debugSetPins(cam, sub, samples)
  })
  await expect(panel.locator('.align-los')).toContainText('Clear')

  // Reverse search produces Sun and Moon matches; clicking one sets the simulation clock.
  const results = panel.locator('.align-result')
  await expect.poll(() => results.count()).toBeGreaterThan(2)

  // Switch body filter to Sun only and click the first result.
  await panel.getByRole('group', { name: 'Celestial body' }).getByRole('button', { name: 'Sun' }).click()
  await expect.poll(() => results.count()).toBeGreaterThan(0)
  const beforeUtc = await page.evaluate(() => (window as unknown as { __photoearth: any }).__photoearth.sun.utc)
  await results.first().locator('.align-result-main').click()
  await expect(results.first()).toHaveClass(/active/)
  const afterUtc = await page.evaluate(() => (window as unknown as { __photoearth: any }).__photoearth.sun.utc)
  expect(afterUtc).not.toBe(beforeUtc)

  // Close with X.
  await page.keyboard.press('x')
  await expect(panel).toBeHidden()
})

test('viewshed analysis: missing token notice, GPU pass matches CPU reference, and inspect readout', async () => {
  // Without a Cesium ion token, Shift+V opens the panel with a clear notice and Settings button.
  await page.keyboard.press('Shift+V')
  const panel = page.locator('.viewshed-panel')
  await expect(panel).toBeVisible()
  await expect(panel.locator('.notice')).toContainText('Cesium ion access token')
  await panel.getByRole('button', { name: 'Clear viewshed' }).click()
  await expect(panel).toHaveCount(0)

  // Synthetic terrain with a blocking east ridge: verify GPU compute matches CPU viewshedTop().
  const report = await page.evaluate(() => {
    const w = window as unknown as { Cesium: Record<string, any>; __photoearth: any }
    const T = w.Cesium.terrainShadow
    const V = w.Cesium.viewshed
    const e = w.__photoearth
    const peaks = [
      [2500, 0, 1200, 600],
      [-4000, 3000, 900, 900],
      [7500, -5000, 1500, 1400]
    ]
    const height = (x: number, y: number) => {
      let h = 600 + 0.005 * y
      for (const [px, py, ph, sigma] of peaks) h += ph * Math.exp(-((x - px) ** 2 + (y - py) ** 2) / (2 * sigma * sigma))
      return h
    }
    const makeLevel = (half: number, n: number) => {
      const heights = new Float32Array(n * n)
      const cell = (2 * half) / n
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) heights[j * n + i] = height(-half + (i + 0.5) * cell, -half + (j + 0.5) * cell)
      const r = T.heightRange(heights)
      return { cx: 0, cy: 0, half, n, heights, minHeight: r.min, maxHeight: r.max }
    }
    const radius = 15000
    const halves = V.viewshedLevelHalves(radius)
    const levels = halves.map((h: number) => makeLevel(h, 128))
    const frame = e.viewshed.debugOpen(8, 46, levels, { radius, targetOffset: 1.7, viewerOffset: 1.7 })
    for (let i = 0; i < 6; i++) {
      e.scene.requestRender()
      e.scene.render()
    }
    const maxHeight = Math.max(...levels.map((l: any) => l.maxHeight))
    const targetH = T.heightAt(levels, 0, 0).height + 1.7
    let seed = 13
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    const out: Array<{ level: number; zWithin2m: number; visAgree: number; visible: number; hidden: number }> = []
    for (let k = 0; k < 3; k++) {
      const m = e.viewshed.debugReadMask(k)
      const l = levels[k]
      const cell = T.levelCell(l)
      let within = 0
      let agree = 0
      let visible = 0
      let hidden = 0
      const samples = 200
      for (let s = 0; s < samples; s++) {
        const i = Math.floor(rand() * l.n)
        const j = Math.floor(rand() * l.n)
        const x = l.cx - l.half + (i + 0.5) * cell
        const y = l.cy - l.half + (j + 0.5) * cell
        if (Math.hypot(x, y) > radius) continue
        const o = (j * l.n + i) * 4
        const gpu = V.decodeViewshed(m.data[o], m.data[o + 1], m.data[o + 2], m.data[o + 3], m.base)
        const ground = l.heights[j * l.n + i]
        const cpu = V.viewshedTop(levels, x, y, targetH, cell, { radius: frame.radius, maxRadius: radius, maxHeight })
        const cpuZ = Math.min(m.base + 65535 * 0.25, Math.max(m.base, cpu.zMin))
        if (Math.abs(gpu.zMin - cpuZ) <= 2) within++
        const vg = V.viewshedReceiverVisibility(gpu, ground + 1.7, cell)
        const vc = V.viewshedReceiverVisibility({ zMin: cpuZ, occluderDistance: cpu.occluderDistance }, ground + 1.7, cell)
        if (Math.abs(vg - vc) < 0.1) agree++
        if (vc >= 0.5) visible++
        else hidden++
      }
      const total = visible + hidden
      out.push({ level: k, zWithin2m: within / total, visAgree: agree / total, visible, hidden })
    }
    return out
  })
  for (const r of report) {
    expect(r.zWithin2m, JSON.stringify(r)).toBeGreaterThanOrEqual(0.95)
    expect(r.visAgree, JSON.stringify(r)).toBeGreaterThanOrEqual(0.97)
  }
  expect(report[2].visible, JSON.stringify(report)).toBeGreaterThan(10)
  expect(report[2].hidden, JSON.stringify(report)).toBeGreaterThan(10)

  // Panel shows coverage percentage and area; inspecting a hidden point behind the east ridge reports it hidden,
  // and inspecting a visible point on the west plain reports it visible.
  await expect(panel).toBeVisible()
  await expect(panel.locator('.badge.ok')).toContainText('%')
  const inspectResult = await page.evaluate(() => {
    const w = window as unknown as { Cesium: Record<string, any>; __photoearth: any }
    const e = w.__photoearth
    const hiddenC = e.viewshed.frame.toCartographic(6000, 0)
    const hiddenCheck = e.viewshed.checkPoint(w.Cesium.Cartesian3.fromRadians(hiddenC.longitude, hiddenC.latitude, 600))
    const visibleC = e.viewshed.frame.toCartographic(-2000, 0)
    const visibleCheck = e.viewshed.checkPoint(w.Cesium.Cartesian3.fromRadians(visibleC.longitude, visibleC.latitude, 600))
    return { hidden: hiddenCheck?.visible, visible: visibleCheck?.visible, bearing: visibleCheck?.bearingToTarget }
  })
  expect(inspectResult.hidden).toBe(false)
  expect(inspectResult.visible).toBe(true)
  expect(inspectResult.bearing).toBeCloseTo(90, 0)

  // Rendered pixel check on 3D Tiles custom shader: visible spot gets tinted green/cyan, hidden spot stays gray.
  const pixelCheck = await page.evaluate(async () => {
    const w = window as unknown as { Cesium: Record<string, any>; __photoearth: any }
    const C = w.Cesium
    const e = w.__photoearth
    const pos = new Float32Array([-200, 0, -200, 200, 0, -200, 200, 0, 200, -200, 0, 200])
    const idx = new Uint16Array([0, 1, 2, 0, 2, 3])
    const bytes = new Uint8Array(pos.byteLength + idx.byteLength)
    bytes.set(new Uint8Array(pos.buffer), 0)
    bytes.set(new Uint8Array(idx.buffer), pos.byteLength)
    let bin = ''
    bytes.forEach((b) => (bin += String.fromCharCode(b)))
    const gltf = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
      materials: [{ doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [0.6, 0.6, 0.6, 1] } }],
      buffers: [{ byteLength: bytes.byteLength, uri: `data:application/octet-stream;base64,${btoa(bin)}` }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: pos.byteLength, target: 34962 },
        { buffer: 0, byteOffset: pos.byteLength, byteLength: idx.byteLength, target: 34963 }
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-200, 0, -200], max: [200, 0, 200] },
        { bufferView: 1, componentType: 5123, count: 6, type: 'SCALAR' }
      ]
    }
    const model = await C.Model.fromGltfAsync({
      gltf,
      modelMatrix: C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(8, 46, 600)),
      customShader: e.tiles.customShader,
      shadows: C.ShadowMode.DISABLED
    })
    e.scene.primitives.add(model)
    e.terrainShadows.compute.binding.params.y = 0
    e.tiles.setDaylight(1)
    for (let i = 0; i < 100 && !model.ready; i++) {
      e.scene.requestRender()
      e.scene.render()
      await new Promise((r) => setTimeout(r, 15))
    }
    const measure = (x: number, y: number, ground: number) => {
      const c = e.viewshed.frame.toCartographic(x, y)
      model.modelMatrix = C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromRadians(c.longitude, c.latitude, ground))
      e.scene.camera.setView({
        destination: C.Cartesian3.fromRadians(c.longitude, c.latitude, ground + 250),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 }
      })
      const canvas = e.scene.canvas
      const px = { x: Math.floor(canvas.width / 2), y: Math.floor(canvas.height / 2), width: 1, height: 1 }
      const read = (enabled: number) => {
        e.viewshed.compute.binding.params.y = enabled
        e.scene.requestRender()
        e.scene.render()
        e.scene.render()
        return Array.from(e.scene.context.readPixels(px)) as number[]
      }
      const on = read(1)
      const off = read(0)
      e.viewshed.compute.binding.params.y = 1
      return { on, off }
    }
    const vis = measure(-2000, 0, 600)
    const hid = measure(6000, 0, 600)
    e.scene.primitives.remove(model)
    return { vis, hid }
  })
  // Visible spot shifts noticeably toward green/cyan (G > R by a wide margin); hidden spot stays unchanged.
  expect(pixelCheck.vis.on[1] - pixelCheck.vis.on[0], JSON.stringify(pixelCheck)).toBeGreaterThan(25)
  expect(Math.abs(pixelCheck.hid.on[1] - pixelCheck.hid.off[1]), JSON.stringify(pixelCheck)).toBeLessThanOrEqual(3)

  // Clean up so subsequent tests start with a clear map.
  await page.evaluate(() => {
    const e = (window as unknown as { __photoearth: any }).__photoearth
    e.inspector.clear()
    e.viewshed.clear()
  })
  await expect(panel).toHaveCount(0)
})

test('no runtime errors', () => {
  expect(errors).toEqual([])
})
