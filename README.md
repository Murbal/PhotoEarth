<img src="assets/icon.svg" width="64" height="64" alt="">

# PhotoEarth

A desktop 3D globe for photography location scouting: explore photorealistic terrain, read elevation, and simulate the sun, moon and Milky Way for any date and time to see where light and shadow fall, when the moon rises, and when the Galactic Core clears the skyline in dark skies.

> **Status:** a personal project, shared as is under the [MIT License](LICENSE). It isn't maintained for others: issues and pull requests won't be answered, and there are no prebuilt releases. Fork it freely. You'll need your own Google Maps Platform key and Cesium ion token (see [API keys](#api-keys)).

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
| Google Maps Platform API key | Place search and the place names on the map (Places API (New)), and the road map draped on the terrain globe while the 3D Tiles aren't available (Map Tiles API; satellite isn't offered because Google doesn't serve it to EEA accounts) | [Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials). Enable **Map Tiles API** and **Places API (New)**. |
| Cesium ion access token | Photorealistic 3D Tiles (streamed through Cesium ion) and Cesium World Terrain: profiles, long-range terrain shadows, horizon panorama, viewshed analysis | [ion.cesium.com/tokens](https://ion.cesium.com/tokens) |

Both work on their free tiers. Either can be skipped and added later in **Settings → API keys**. Cesium ion's free Community plan allows 1,000 Photorealistic 3D Tiles sessions a month, and each app launch starts one. For UI work that doesn't need the tiles, set `PHOTOEARTH_NO_3D_TILES=1` (see `.env.example`) and the terrain globe shows instead.

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
| Click | Inspect a point: coordinates, elevation, and when the sun actually reaches it over the terrain |
| `W A S D`, `Q`/`E`, arrows | Move (ground-relative), descend/ascend, look. Hold `Shift` for faster, `Alt` for precise |
| `F` | First-person fly mode (pointer lock; `Esc` exits) |
| `G` | Eye level (1.7 m) at the cursor; WASD then walks along the ground |
| `N` / `U` / `R` | Face north / top-down / level horizon |
| `Ctrl+K` | Search places, paste coordinates (decimal, DMS, Google Maps URLs), saved locations and profiles, commands |
| `Ctrl+B` | Save the view as a scouting location |
| `T` / `L` / `P` | Time & sun panel / layers (light pollution, viewshed, exaggeration) / elevation profile |
| `V` | Viewfinder: frame the view through a real sensor and focal length |
| `Shift+V` | Viewshed analysis: highlight all terrain with line of sight to a target |
| `H` | Horizon panorama: the skyline with the sun, moon and Milky Way paths |
| `X` | Shot alignment: Camera → Subject line of sight & reverse Sun/Moon date finder |
| `,` / `.`, `Shift+,` / `Shift+.` | Viewfinder: previous / next focal length preset, ∓5 % |
| `M` | Place names on / off |
| `Space`, `[` `]`, `Shift+[` `]` | Play/pause the sun, ±15 min, ±1 day |
| `?` | All shortcuts |

### Horizon panorama

`H` (or the panorama button on the inspect card, the right rail or the palette) answers "does the sun set into that notch or behind the peak, and when?". From the inspected point (else the search pin or the view center) it traces the terrain skyline through 360° out to ~300 km on Cesium World Terrain, and draws it as a strip chart of altitude against compass direction. Over it go the sun's, moon's and Galactic Core's paths for the chosen date, marked hourly, solid where they are above the skyline and dashed behind it, with the times they clear and drop behind the terrain (compared with a flat-horizon sunrise and sunset) and the hours of direct sun, plus the Milky Way arch at the simulated instant. Named peaks on the skyline are labeled from Google Places.

Scroll to zoom, drag to turn, or jump to the sunrise or sunset close-up; *1:1* shows true angles instead of the stretched skyline. Hovering shows the direction, altitude, distance and height of the skyline and draws the line of sight on the map. Clicking the sun or moon path sets the time to that moment, and *Look* stands you at the observer at eye level, facing the selected direction. While the panorama is open, clicking the map moves the observer. It needs the Cesium ion token; peak names need the Google key.

### Viewshed analysis

`Shift+V` (or *Viewshed from here* on the inspect card, the right rail, the Layers panel or the command palette) answers "where can I stand to see that mountain peak or landmark?". Using three nested grids of Cesium World Terrain heights centered on the target (5 / 15 / 30 / 50 km radius, sharing the terrain-shadow tile cache), a GPU compute pass ray-marches line of sight with Earth curvature and terrestrial refraction (`k = 0.13`) and drapes the visible terrain onto the Photorealistic 3D Tiles (or the terrain globe standing in for them) alongside terrain shadows.

Adjust target height offset (ground/peak 0 m, eye level 1.7 m, tower or drone up to 500 m), surrounding viewer height offset, overlay opacity, distance-tinted or uniform coloring, and concentric distance rings for judging focal-length range, with live visible-area coverage stats. Clicking any point while exploring inspects it as usual, reports whether it has unobstructed line of sight to the target (with distance, bearing, elevation angle and clearance), and lets you drop straight to eye level or open the viewfinder aimed back at the target. Needs a Cesium ion token.

### Shot alignment & reverse date finder

`X` (or the alignment button on the right rail, the inspect card, the command palette, or *Align* in the horizon panorama) plans sun and moon alignments behind specific landmarks, peaks or buildings:

- **Camera → Subject pins**: pick a Camera spot (with configurable eye/tripod height above ground, defaulting to 1.7 m) and a Subject point on terrain or 3D tiles, or adopt the active inspect/search pin. The 3D map draws both pins, a ground reference track, and a 3D sightline colored green when clear or dashed red with a **Blocked** marker at the worst obstructing ridge when terrain intercepts the view.
- **Geometry & framing readouts**: true compass bearing and geodesic reverse bearing, apparent vertical elevation angle (including Earth curvature and standard terrestrial refraction `k = 0.13`), horizontal and 3D slope distance, elevation difference, line-of-sight clearance, apparent Sun/Moon linear disc width at the subject distance (including lunar apogee–perigee range), and framing coverage in the active Viewfinder lens.
- **Reverse Sun & Moon date finder**: searches forward across 30 days, 90 days, 1 year, 2 years or a custom date range (in the observer's local time zone, across DST transitions) for exact dates and times when the Sun or Moon aligns within configurable azimuth and altitude tolerances. Filter Moon shots by minimum illumination % and sky light (golden hour, blue hour, twilight, night or daylight). Clicking a result jumps the simulation to that exact instant; *Look* (or *Frame shot on click*) stands at the Camera pin aimed at the Subject.

### Saved scouting locations

`Ctrl+B` (or *Save current view* in the locations panel, the bookmark button in the right rail) saves the view as a location: its camera, lens and, optionally, the simulated date and time, plus the spot itself (the inspected point or search pin, else the view center). Give it notes, tags, a free-text "best time", a *to visit* / *visited* status, reference photos, and elevation profiles. The list filters by status and tags, and the map shows a pin for each location it lists; clicking a pin or a list entry flies there and restores the saved time. Photos are copied into the app's own data folder (at most 40 MB each), so moving or deleting the originals doesn't affect them. A drawn elevation profile can be saved (*Save path*) on its own or with a location, and reopened later. Bookmarks from earlier versions become locations to visit; the original `bookmarks.json` is kept as `bookmarks.v1.backup.json`.

### Viewfinder

`V` (or the viewfinder button in the right rail, or the palette) answers "what does a 200 mm shot from this ridge look like?". Pick a sensor (full frame, APS-C, Micro Four Thirds, 1″, 44 × 33 medium format, a phone's main camera by its 35 mm-equivalent focal length, or a custom size), a focal length from 8 to 800 mm and a frame (the sensor's own ratio, 3:2, 4:3, 1:1, 4:5, 5:4, 16:9 or 65:24 panorama, landscape or portrait). The largest frame of that ratio that fits the window shows exactly the lens's angle of view; the rest of the window is dimmed. Rule-of-thirds, phi-grid, center-cross and diagonal guides can be drawn in the frame. The panel reads out the angles of view, the 35 mm-equivalent focal length, and the compass bearing and tilt the lens points at.

Navigation is unchanged: the scroll wheel still moves the camera rather than zooming the lens, and `G` (eye level) plus WASD walk you to the spot. Looking around (arrow keys, fly mode) slows down in proportion to the narrower field of view. The lens settings are remembered, and a bookmark saved in viewfinder mode reopens framed with the same lens.

## Development

```bash
npm run lint
npm run typecheck   # main/preload, renderer, and tests
npm test            # Vitest unit tests
npm run build:test  # a build that exposes the engine and a few Cesium classes on `window`, for scripts driving the app
```

Normal builds don't expose anything on `window`.

The sun-position tests compare SunCalc against [astronomy-engine](https://github.com/cosinekitty/astronomy) (VSOP87-based, sub-arcminute) as an independent reference. They cover nine locations, including Tromsø, Longyearbyen and McMurdo for polar day and night, and require ±0.5°. Observed agreement is within 0.1° above 2° altitude. Tests run under `TZ=Pacific/Chatham` to prove results depend only on the viewed location's zone.

The moon goes the other way round: it runs on astronomy-engine (topocentric, so parallax is included), and SunCalc's independent moon series checks it. Agreement is within 0.05° in position and a minute in rise, transit and set across six time zones.

### Weather forecast

The time panel (`T`) shows the [Open-Meteo](https://open-meteo.com/) forecast for the view center, for today and the next 15 days. It needs no key.

- **Cloud bands** under the time slider: high, mid and low cloud through the selected day, brighter where there's more, lined up with the hours above. High cloud is the canvas for sunrise and sunset colour; low cloud hides it.
- **Day strip**: one chip per day with a sunrise (↑) and a sunset (↓) rating from *Poor* to *Great*, plus *fog*/*fog?* when fog is likely or possible around sunrise and *wind* when daylight gusts reach 12 m/s. Clicking ↑ or ↓ sets the date and time to that sunrise or sunset; the tooltip explains the rating.
- **The rating** is a heuristic: colour needs mid or high cloud overhead to catch the light (scattered to broken is best, overcast is dull), little low cloud overhead, and a clear path for the light. That path is judged from the forecast 150 km toward where the sun sets (or rises), so "high cloud plus a clear western horizon" comes out as *Great*, and the same sky with a bank of low cloud to the west as *Poor*. Rain chance lowers it.
- **At the selected hour**: high, mid and low cloud, visibility, wind and gusts (with what they mean for drones and long exposures in the tooltip), rain chance and fog risk. Open-Meteo has no fog probability, so fog is estimated: *likely* when the model forecasts fog or visibility under 1 km, *possible* in near-saturated, still air or mist. Valley radiation fog forms below the model's resolution, so treat *possible* on a calm, clear night as worth a look.

Each request sends only coordinates to Open-Meteo: the view center and the two points 150 km toward the sunset and sunrise. It's made from the main process once the view settles, at most once an hour per place (forecasts are reused within 3 km). Switch it off with *Forecast* in the time panel.

### Milky Way & Astro Dark-Window

The time panel (`T`) and horizon panorama (`H`) include astrophotography planning for the **Galactic Core** (Sagittarius A*) and the **Milky Way arch**:

- **Core readout & arch framing**: live azimuth, altitude, clickable rise/transit/set times (handling DST days and latitudes where the core never rises or is circumpolar), plus the arch's peak elevation and core tilt (*Horizontal pano*, *Diagonal / pano*, or *Vertical / overhead*).
- **Astro Dark-Window**: intersects astronomical night (sun below −18°), moonless skies (or optionally ≤ 10 % crescent moon), Galactic Core visibility above a configurable minimum altitude (and above the traced terrain skyline while Horizon Panorama is open), and Open-Meteo cloud cover when within the 16-day forecast. Click a dark-window time, peak core, or a day's `✦` button in the forecast strip to jump straight to that instant.
- **Horizon Panorama & 3D indicator**: toggle *Milky Way* in the horizon panorama to overlay the Galactic Core path, terrain rise/set crossings and the Milky Way arch at the current instant; toggle *Core direction* in the time panel (or command palette) to draw a 3D direction arrow and ray toward the core on the map and show its bearing in the viewfinder.

## Architecture

```
src/
  main/        Electron main: window, app:// protocol, CSP, Referer, permissions,
               settings.json / bookmarks.json (locations, profiles) / photos/ / secrets.json,
               photo:// protocol, Places, Open-Meteo + key validation over net.fetch
  preload/     contextBridge → typed window.photoearth API
  shared/      types, settings and location sanitization + migration, IPC channels, API error classification
  renderer/src/
    engine/    Engine (owns the CesiumWidget) and its managers:
               TilesetManager, TerrainManager, GoogleImagery, CameraController,
               SunController, MoonController, MilkyWayController, GlobeMaterial, ProfileTool, HorizonTool,
               ViewshedTool, AlignmentTool, PointInspector, Readouts, LocationMarkers,
               TerrainShadows, quality presets
    components/ React overlay UI (the canvas belongs to Cesium)
    store/     Zustand app state; React writes it, the engine subscribes to it
    lib/       pure, unit-tested logic: time zones, sun, moon, milky way & astro windows, alignment, seasons, coordinates, geoid,
               profile math, terrain-shadow & viewshed ray marching, horizon panorama,
               weather outlook, units
```

Notable decisions:

- **`app://photoearth/` protocol** instead of `file://`, so Cesium's module workers and wasm load from a real origin, and the strict CSP (no `unsafe-eval`) has a `'self'`. The window runs with `contextIsolation`, `sandbox`, `nodeIntegration: false`; navigation and new windows are blocked (external links open in the browser).
- **Places API calls and key validation run in the main process.** One autocomplete session token covers a whole search. Input is debounced at 250 ms with a 3-character minimum, and the field masks request only location fields.
- **Place names come from Places API (New) Nearby Search** (towns and mountain peaks), queried in the main process for grid cells around the view once the camera settles. Labels stay upright, anchored on the ground (a downward CPU ray cast onto the loaded 3D tiles or terrain, redone once finer tiles have loaded), and are hidden as a whole when a CPU ray cast finds a ridge or building in the line of sight. These ray casts run on a time budget while the camera rests, never while it moves. They fade with distance and are decluttered on screen. Nearby Search has no population or prominence for towns, and its "popularity" order mostly follows distance from the query's center. So towns named like their district or state (Interlaken, Thun, San Francisco), or that a nearby town is named after ("Matten bei Interlaken"), win the space on screen and stay visible from farther away. From high up, small cells would only find whatever lies nearest their centers, so wide views also ask Text Search for the region's most relevant attractions, train stations and city halls, grouped by the city in their address (New York, Philadelphia; Zürich, Bern, Luzern). States/cantons and countries come from Nearby Search too, and fade in as the camera rises.
- **Heights are shown above mean sea level.** Google tiles and Cesium terrain report ellipsoidal heights; readouts and profiles are corrected with the EGM96 geoid (loaded lazily).
- **The terrain globe stands in for the 3D Tiles** when they aren't loaded (no token, `PHOTOEARTH_NO_3D_TILES`, or an outage). Its material (`GlobeMaterial`) draws the same terrain shadows and viewshed the tiles get from their custom shader.
- **Light pollution on the 3D Tiles** is drawn by the tileset's custom shader, which looks up each fragment's latitude and longitude in two Web Mercator mosaics of the overlay's source tiles: a detailed block reaching at least 150 km around the view center, and, when the camera is high enough to see past it, a coarser half-resolution one out to the horizon that the detailed block fades into. They move along when the camera stops, never while it moves. The stand-in globe gets the overlay as an ordinary imagery layer. While it shows, neither is shaded by day and night, so its colors read as the legend says.
- **Local time follows the camera target.** The time slider is wall-clock time in the target's IANA zone, resolved offline. Crossing into another zone keeps the local time, so "07:30" means 07:30 wherever you look.
- **Google 2D Tiles** (the stand-in globe's road map) use the session-token flow, with renewal before expiry and on repeated 4xx tile failures. Attribution comes from the viewport endpoint for what's on screen. The 3D tileset shows its copyright data on screen.
- **Tiles load ahead of a moving camera.** Cesium skips requesting tiles that are on screen only briefly while the camera moves, so a fast flight used to load little until it slowed down. `TilePreloader` drives Cesium's preload-flight pass with the camera's pose predicted 1.5 s ahead (smoothed velocity and turn rate, widened culling for turns) whenever it moves faster than 2 m/s, so tiles arrive before the view does. This covers fly mode, fast pans and inertia glides, in Photorealistic mode; Cesium's own `flyTo` animations keep preloading their destination. The predicted-pose pass is a full extra tileset traversal, so it runs on every 6th frame and at half the level of detail.
- **Quality presets** set tileset/terrain screen-space error, shadow map size and cascades, soft shadows, shadow distance, terrain shadow resolution, MSAA/FXAA and resolution scale. Each value can be overridden in Settings. The scene uses request-render mode, so idle views cost nothing.

## Frame rate while the camera moves

Panning, orbiting and tilting over Google's 3D tiles hold 60 fps and more on the reference machine (RTX 3060, Windows, High preset, 1440×900, low sun over Zermatt); before this work they ran at 5–17 fps. Almost all of a frame is CesiumJS on the main thread, so the work goes into doing less of it per frame, and never stalling it:

- **No GPU read-backs.** CPU picking (camera collision, surface heights, label line of sight) read vertex buffers back from the GPU on every pick in WebGL 2, a full pipeline flush. The tileset keeps CPU copies of its geometry instead (`enablePick`), ray–mesh tests run in model space, and the app's own per-frame picks (status bar heights, view-center target, label clamping) were replaced by values Cesium already computed or by estimates refined when the camera stops.
- **Less detail while moving.** From camera move start to move end, tiles settle for 1.5× the screen-space error (their already-loaded parents), and full detail returns when the camera stops. This is what brings panning from ~60 to ~75 fps; without it panning holds ~55–60.
- **Shadow casters near the camera only.** With heightmap terrain shadows on, the detail shadow map draws only tiles that can shade its range; at a low sun it used to draw every visible tile, kilometres away, into all four cascades.
- **Bounded work between frames.** While the camera moves, newly arrived tiles get one turn per frame to create their content (`ContentGate`), GPU uploads are capped at 2 ms per job type and frame (`uploadBudget.ts`), and terrain-shadow grids wait to re-center until the camera stops.
- **Cesium patches** (`vite/cesium.ts`, applied at build time and to the dev server's pre-bundled Cesium; the build fails if Cesium changes underneath one, and `tests/unit/cesiumPatches.test.ts` checks them): strips Cesium's debug-only argument checks (its own release build does too), keeps pick geometry on WebGL 2, model-space picking, the shadow caster cut-off, a coarser and less frequent preload pass with a few frames' grace for its requests, the tile content gate, keeping compiled shader programs when their last tile unloads (recompiling one took 60–120 ms), no per-pass copy of the texture statistics, no transform product for tiles without a transform of their own, and the idle "deferred requests" traversal at most 4× a second (it ran on every display refresh, a full CPU core at 144 Hz).

To profile: `PHOTOEARTH_PROFILE=1 npm run build` keeps the renderer bundle unminified, so CPU profiles name Cesium's and the app's functions.

## Shadows

Cesium's shadow maps on Google's 3D tiles miss off-screen and distant ridges, lose detail with range, and (because the tiles have no normals) show acne stripes at low sun. So terrain shadows come from a heightmap instead, and shadow maps only add near detail:

- **Terrain shadows** (needs the ion token): three nested grids of Cesium World Terrain heights follow the view. With the High preset they are ±5 km at ~20 m, ±20 km at ~80 m and ±80 km at ~400 m. Tiles are fetched directly from the provider, independent of what the globe has loaded, and rasterized into a local tangent-plane frame (`engine/shadows/HeightField.ts`).
- **GPU ray-march** (`engine/shadows/ShadowCompute.ts`, `shaders.ts`): a pass inside Cesium's compute stage marches each cell toward the sun through all three grids. It accounts for earth curvature, terrestrial refraction and the sun setting behind the horizon beyond the data. Each cell stores a *shadow top*, the height above which its vertical is sunlit, plus the occluder distance. Receivers compare their own height with it, so roofs, tree tops and cliff faces inside a coarse cell still shade correctly. The penumbra widens with occluder distance from the sun's 0.53° disc. The pass reruns only when the sun or the data changes, one level per frame, so playback stays smooth and a still sun costs nothing.
- **Receivers**: the 3D tiles' custom shader and the stand-in globe's material share one GLSL receiver (`RECEIVER_GLSL`). It uses true heights under vertical exaggeration and cross-fades between levels.
- **Detail shadows** (*Buildings & trees*, Photorealistic mode): a short-range Cesium shadow map near a low camera (600 m–2.5 km by preset; off on Low). A patch to Cesium's receive shader (`detailShadowPatch.ts`) derives normals for the normal-less tiles to remove acne, and folds the result into the terrain shadow instead of darkening twice.
- Without an ion token, shadow maps do everything (previous behavior, with the acne fix).
- The CPU reference in `lib/terrainShadow.ts` mirrors the GPU pass. Unit tests cover its geometry.

## Known limitations

- It's developed and tested mainly on Windows (RTX 3060). The automated suite is unit tests only and runs without keys, so rendering with live Google and Cesium data is checked by hand.
- The first time a new shader variant is needed (a new kind of tile, a setting change) Cesium compiles it synchronously, a 60–120 ms hitch with a cold GPU shader cache. Chromium's on-disk shader cache makes later sessions much faster.
- Terrain shadows cover ±80 km around the view. Wider views (camera above ~100 km) get no cast shadows outside that area, where they'd be sub-pixel anyway. They follow Cesium World Terrain, so they're only as accurate as its heights (bare earth in most places, so forest canopy doesn't cast).
- Place names are billed as Places API Nearby Search Pro and Text Search Pro requests: about 10 per newly explored close view and up to about 17 per newly explored wide view, at most 60 per minute (a guard against runaway requests, not a spending limit: set a daily quota on Places API (New) in Cloud Console for that). Results are cached in memory for the session only, never on disk. Switch them off with `M`. Nearby Search doesn't support neighborhoods, so cities show their town name and named hills only.
- The forecast is Open-Meteo's "best match" blend of weather models: higher-resolution ones for the first days, coarser global ones further out, so the later days are rough and local effects (valley fog, a lake's own cloud) are missed. The sunrise/sunset rating is a heuristic from cloud cover, not a model of sky colour.
- Google Maps short links (`maps.app.goo.gl`) can't be resolved offline; paste the full URL.
- Linux and macOS are best effort. The macOS build (`npm run package:mac`, Apple Silicon only, must run on a Mac) is signed ad hoc, not with a Developer ID, so it isn't notarized: on first launch Gatekeeper blocks it, and you allow it under **System Settings → Privacy & Security → Open Anyway** (or run `xattr -dr com.apple.quarantine /Applications/PhotoEarth.app`).

## Attribution & terms

Google imagery and 3D geometry can't be exported, cached beyond the standard HTTP cache, or bulk-downloaded. Google, Cesium ion and imagery attributions are always shown in the status bar.

Weather data is by [Open-Meteo.com](https://open-meteo.com/) (CC BY 4.0), credited in the time panel next to the forecast. Its free API is for non-commercial use (up to 10,000 requests a day); commercial use needs one of its API plans.

## License

[MIT](LICENSE). The license covers this code only. Google Maps Platform, Cesium ion and Open-Meteo each have their own terms, which apply to whoever supplies the keys and runs the app.
