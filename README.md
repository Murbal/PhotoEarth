<img src="assets/icon.svg" width="64" height="64" alt="">

# PhotoEarth

A desktop 3D globe for photography location scouting: explore photorealistic terrain, read elevation, and simulate the sun for any date and time to see where light and shadow fall. See [SPEC.md](SPEC.md) for the full specification.

## Getting started

Requires Node.js 22.12+ (CI uses Node 24).

```bash
npm install
npm run dev        # electron-vite dev server with hot reload
npm run build      # production bundles in out/
npm start          # run the production build
npm run package    # Windows x64 NSIS installer in release/ (package:linux for an AppImage, package:mac for an Apple Silicon DMG)
```

The Electron binary is downloaded on the first run.

### API keys

On first launch PhotoEarth asks for two keys, validates them with a test request, and shows which APIs are enabled:

| Key | Used for | Where |
|---|---|---|
| Google Maps Platform API key | Photorealistic 3D Tiles, 2D satellite/terrain imagery (Map Tiles API), place search and the place names on the map (Places API (New)) | [Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials). Enable **Map Tiles API** and **Places API (New)**. |
| Cesium ion access token | Cesium World Terrain: Elevation mode, profiles, long-range terrain shadows | [ion.cesium.com/tokens](https://ion.cesium.com/tokens) |

Both work on their free tiers. Either can be skipped and added later in **Settings → API keys**.

For development, `npm run dev` also reads keys from a `.env` file in the project root (gitignored). Variables already set in the environment win:

```sh
GOOGLE_CLOUD_API_TOKEN=AIza...
CESIUM_ION_API_TOKEN=eyJ...
```

They're loaded in the main process only, so they never end up in the renderer bundle, and they're used for the session without being written to the encrypted key store. Keys entered in Settings replace them as usual. Packaged and test builds ignore `.env`.

- Keys are encrypted with Electron `safeStorage` (DPAPI on Windows) and never written in plaintext. If the OS has no keyring (for example Linux without libsecret), keys are kept for the session only.
- Tile requests necessarily carry the Google key, so **restrict the key by API** (Map Tiles + Places). If you restrict it by HTTP referrer instead, allow `https://photoearth.local/*`: the app sends that fixed `Referer` on all Google requests.

## Using it

| | |
|---|---|
| Left-drag | Pan (grab the ground) |
| Right-drag / Ctrl+Left-drag | Orbit around the point under the cursor |
| Middle-drag / Shift+Left-drag | Rotate heading around the point under the cursor |
| Scroll wheel | Zoom toward the cursor |
| Trackpad: two-finger scroll / pinch | Pan (look around at eye level) / zoom toward the cursor |
| Trackpad: `Alt`/`⌥` + two-finger scroll | Orbit around the point under the cursor |
| Double-click | Fly closer to the point |
| Click | Inspect a point (coordinates and elevation, copyable) |
| `W A S D`, `Q`/`E`, arrows | Move (ground-relative), descend/ascend, look. Hold `Shift` for faster, `Alt` for precise |
| `F` | First-person fly mode (pointer lock; `Esc` exits) |
| `G` | Eye level (1.7 m) at the cursor; WASD then walks along the ground |
| `N` / `U` / `R` | Face north / top-down / level horizon |
| `1` / `2` | Photorealistic / Elevation mode |
| `Ctrl+K` | Search places, paste coordinates (decimal, DMS, Google Maps URLs), bookmarks, commands |
| `Ctrl+B` | Save a bookmark |
| `T` / `L` / `P` | Time & sun panel / elevation styling / elevation profile |
| `M` | Place names on / off |
| `Space`, `[` `]`, `Shift+[` `]` | Play/pause the sun, ±15 min, ±1 day |
| `?` | All shortcuts |

## Development

```bash
npm run lint
npm run typecheck   # main/preload, renderer, and tests
npm test            # Vitest unit tests
npm run test:e2e    # builds with VITE_PHOTOEARTH_TEST=1, then Playwright drives Electron
```

On Linux the E2E suite needs a display (`xvfb-run -a npm run test:e2e`). Test builds expose the engine and a few Cesium classes on `window` for assertions; normal builds don't.

The sun-position tests compare SunCalc against [astronomy-engine](https://github.com/cosinekitty/astronomy) (VSOP87-based, sub-arcminute) as an independent reference. They cover nine locations, including Tromsø, Longyearbyen and McMurdo for polar day and night, and require ±0.5° (§8.4). Observed agreement is within 0.1° above 2° altitude. Tests run under `TZ=Pacific/Chatham` to prove results depend only on the viewed location's zone.

## Architecture

```
src/
  main/        Electron main: window, app:// protocol, CSP, Referer, permissions,
               settings.json / bookmarks.json / secrets.json, Places + key validation over net.fetch
  preload/     contextBridge → typed window.photoearth API
  shared/      types, settings defaults + sanitization, IPC channels, API error classification
  renderer/src/
    engine/    Engine (owns the CesiumWidget) and the managers from SPEC §4:
               TilesetManager, TerrainManager, GoogleImagery, CameraController,
               SunController, ElevationStyler, ProfileTool, PointInspector, Readouts,
               TerrainShadowOverlay, quality presets
    components/ React overlay UI (the canvas belongs to Cesium)
    store/     Zustand app state; React writes it, the engine subscribes to it
    lib/       pure, unit-tested logic: time zones, sun, seasons, coordinates, geoid,
               profile math, terrain-shadow ray marching, palettes, units
```

Notable decisions:

- **`app://photoearth/` protocol** instead of `file://`, so Cesium's module workers and wasm load from a real origin, and the strict CSP (no `unsafe-eval`) has a `'self'`. The window runs with `contextIsolation`, `sandbox`, `nodeIntegration: false`; navigation and new windows are blocked (external links open in the browser).
- **Places API calls and key validation run in the main process.** One autocomplete session token covers a whole search. Input is debounced at 250 ms with a 3-character minimum, and the field masks request only location fields.
- **Place names come from Places API (New) Nearby Search** (towns and mountain peaks), queried in the main process for grid cells around the view once the camera settles. Labels stay upright, anchored on the ground (clamped to the 3D tiles or terrain), and are hidden as a whole when a CPU ray cast finds a ridge or building in the line of sight. They fade with distance and are decluttered on screen. Nearby Search has no population or prominence for towns, and its "popularity" order mostly follows distance from the query's center. So towns named like their district or state (Interlaken, Thun, San Francisco), or that a nearby town is named after ("Matten bei Interlaken"), win the space on screen and stay visible from farther away. From high up, small cells would only find whatever lies nearest their centers, so wide views also ask Text Search for the region's most relevant attractions, train stations and city halls, grouped by the city in their address (New York, Philadelphia; Zürich, Bern, Luzern). States/cantons and countries come from Nearby Search too, and fade in as the camera rises.
- **Heights are shown above mean sea level.** Google tiles and Cesium terrain report ellipsoidal heights; readouts, profiles and contours are corrected with the EGM96 geoid (loaded lazily).
- **One custom globe material** composites hypsometric tint, slope classes, hillshade and contours (every 5th an index line). Hillshade follows the simulated sun (fading to flat shading at night) or uses the classic NW 45° light. It corrects for vertical exaggeration.
- **Local time follows the camera target.** The time slider is wall-clock time in the target's IANA zone, resolved offline. Crossing into another zone keeps the local time, so "07:30" means 07:30 wherever you look.
- **Google 2D Tiles** use the session-token flow, with renewal before expiry and on repeated 4xx tile failures. Attribution comes from the viewport endpoint for what's on screen. The 3D tileset shows its copyright data on screen.
- **Tiles load ahead of a moving camera.** Cesium skips requesting tiles that are on screen only briefly while the camera moves, so a fast flight used to load little until it slowed down. `TilePreloader` drives Cesium's preload-flight pass with the camera's pose predicted 1.5 s ahead (smoothed velocity and turn rate, widened culling for turns) whenever it moves faster than 2 m/s, so tiles arrive before the view does. This covers fly mode, fast pans and inertia glides, in Photorealistic mode; Cesium's own `flyTo` animations keep preloading their destination.
- **Quality presets** set tileset/terrain screen-space error, shadow map size and cascades, soft shadows, shadow distance, terrain shadow resolution, MSAA/FXAA and resolution scale. Each value can be overridden in Settings. The scene uses request-render mode, so idle views cost nothing.

## Shadows (§8.1.1)

Cesium's shadow maps on Google's 3D tiles miss off-screen and distant ridges, lose detail with range, and (because the tiles have no normals) show acne stripes at low sun. So terrain shadows come from a heightmap instead, and shadow maps only add near detail:

- **Terrain shadows** (needs the ion token): three nested grids of Cesium World Terrain heights follow the view. With the High preset they are ±5 km at ~20 m, ±20 km at ~80 m and ±80 km at ~400 m. Tiles are fetched directly from the provider, independent of what the globe has loaded, and rasterized into a local tangent-plane frame (`engine/shadows/HeightField.ts`).
- **GPU ray-march** (`engine/shadows/ShadowCompute.ts`, `shaders.ts`): a pass inside Cesium's compute stage marches each cell toward the sun through all three grids. It accounts for earth curvature, terrestrial refraction and the sun setting behind the horizon beyond the data. Each cell stores a *shadow top*, the height above which its vertical is sunlit, plus the occluder distance. Receivers compare their own height with it, so roofs, tree tops and cliff faces inside a coarse cell still shade correctly. The penumbra widens with occluder distance from the sun's 0.53° disc. The pass reruns only when the sun or the data changes, one level per frame, so playback stays smooth and a still sun costs nothing.
- **Receivers**: the 3D tiles' custom shader and the Elevation-mode globe material share one GLSL receiver (`RECEIVER_GLSL`). It uses true heights under vertical exaggeration and cross-fades between levels.
- **Detail shadows** (*Buildings & trees*, Photorealistic mode): a short-range Cesium shadow map near a low camera (600 m–2.5 km by preset; off on Low). A patch to Cesium's receive shader (`detailShadowPatch.ts`) derives normals for the normal-less tiles to remove acne, and folds the result into the terrain shadow instead of darkening twice.
- Without an ion token, shadow maps do everything (previous behavior, with the acne fix).
- The CPU reference in `lib/terrainShadow.ts` mirrors the GPU pass. Unit tests cover its geometry. The end-to-end suite checks that the GPU output matches it to the encoding step (0.25 m), and that a rendered surface darkens exactly where the reference predicts shadow.

## Known limitations

- Visual behavior with live Google and Cesium data, the 60 fps target, and the shadow spike must be checked on Windows with real keys. The automated suite runs without keys.
- Terrain shadows cover ±80 km around the view. Wider views (camera above ~100 km) get no cast shadows outside that area, where they'd be sub-pixel anyway. They follow Cesium World Terrain, so they're only as accurate as its heights (bare earth in most places, so forest canopy doesn't cast).
- Place names are billed as Places API Nearby Search Pro and Text Search Pro requests: about 10 per newly explored close view and up to about 17 per newly explored wide view, at most 60 per minute (a guard against runaway requests, not a spending limit: set a daily quota on Places API (New) in Cloud Console for that). Results are cached in memory for the session only, never on disk. Switch them off with `M`. Nearby Search doesn't support neighborhoods, so cities show their town name and named hills only.
- Google Maps short links (`maps.app.goo.gl`) can't be resolved offline; paste the full URL.
- Linux and macOS are best effort. The macOS build (`npm run package:mac`, Apple Silicon only, must run on a Mac) is signed ad hoc, not with a Developer ID, so it isn't notarized: on first launch Gatekeeper blocks it, and you allow it under **System Settings → Privacy & Security → Open Anyway** (or run `xattr -dr com.apple.quarantine /Applications/PhotoEarth.app`).

## Attribution & terms

Google imagery and 3D geometry can't be exported, cached beyond the standard HTTP cache, or bulk-downloaded. Google, Cesium ion and imagery attributions are always shown in the status bar.
