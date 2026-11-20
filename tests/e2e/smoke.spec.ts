import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

// Requires a test build: `VITE_PHOTOEARTH_TEST=1 npm run build` (done by `npm run test:e2e`).
// No API keys are needed: the smoke test covers what works offline.

let app: ElectronApplication
let page: Page
let userData: string
const errors: string[] = []

/** A throwaway profile, and a hidden window that never takes focus from the desktop (see src/main/index.ts). */
const launchEnv = () => ({ ...process.env, PHOTOEARTH_USER_DATA: userData, PHOTOEARTH_BACKGROUND: '1' })

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'photoearth-e2e-'))
  app = await electron.launch({ args: ['.'], env: launchEnv() })
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
  await page.keyboard.press('Control+k')
  await page.keyboard.type('37.7456, -119.5936')
  await expect(page.locator('.palette-item').first()).toContainText('37.74560° N')
  await page.keyboard.press('Enter')
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
  app = await electron.launch({ args: ['.'], env: launchEnv() })
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
