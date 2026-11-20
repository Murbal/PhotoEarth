import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

// Requires a test build: `VITE_PHOTOEARTH_TEST=1 npm run build` (done by `npm run test:e2e`).
// No API keys are needed: the smoke test covers what works offline.

let app: ElectronApplication
let page: Page
let userData: string
const errors: string[] = []

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'photoearth-e2e-'))
  app = await electron.launch({ args: ['.'], env: { ...process.env, PHOTOEARTH_USER_DATA: userData } })
  page = await app.firstWindow()
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
    // With the terrain shadow layer, so the shared receiver code compiles in the globe material too.
    e.styler.apply(style, true, null, true)
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
    for (let i = 0; i < 60; i++) await frame()
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
  await page.keyboard.press('Control+k')
  await page.keyboard.type('37.7456, -119.5936')
  await expect(page.locator('.palette-item').first()).toContainText('37.74560° N')
  await page.keyboard.press('Enter')
  await expect
    .poll(async () => page.evaluate(() => (window as unknown as { __photoearth: any }).__photoearth.currentView().longitude), { timeout: 15_000 })
    .toBeLessThan(-119)
})

test('time zone follows the viewed location', async () => {
  await page.keyboard.press('t')
  await expect(page.locator('.time-panel')).toContainText('America/Los_Angeles', { timeout: 10_000 })
})

test('bookmarks persist across a restart', async () => {
  await page.keyboard.press('Control+b')
  await expect(page.locator('.bookmark')).toHaveCount(1)
  const saved = await page.evaluate(() => window.photoearth.bookmarks.list())
  expect(saved).toHaveLength(1)
  await app.close()
  app = await electron.launch({ args: ['.'], env: { ...process.env, PHOTOEARTH_USER_DATA: userData } })
  page = await app.firstWindow()
  await page.waitForFunction(() => !!(window as unknown as { __photoearth?: unknown }).__photoearth, null, { timeout: 30_000 })
  const list = await page.evaluate(() => window.photoearth.bookmarks.list())
  expect(list).toHaveLength(1)
  // The last camera position was restored too.
  const lon = await page.evaluate(() => (window as unknown as { __photoearth: any }).__photoearth.currentView().longitude)
  expect(lon).toBeLessThan(-119)
})

test('no runtime errors', () => {
  expect(errors).toEqual([])
})
