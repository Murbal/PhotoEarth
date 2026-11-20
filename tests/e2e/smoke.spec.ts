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
    e.styler.apply(style, true, null)
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
