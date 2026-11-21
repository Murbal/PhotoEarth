# PhotoEarth — Specification

> Status: Draft v0.1 · Scope: core map, 3D, elevation, sun simulation

## 1. Overview

PhotoEarth is a desktop 3D globe application, in the spirit of Google Earth Pro, built for **photography location scouting**. The user explores real-world terrain in photorealistic 3D, reads elevation, and simulates the sun's position for any date and time to see where light and shadows fall.

This first spec covers the **foundation only**: the map view, 3D rendering and navigation, elevation visualization, and sun/shadow simulation. Photography-specific tools (lens/FOV previews, shot planning, and so on) are listed in §11 as future work and are out of scope here.

### 1.1 Goals

1. A fast, smooth, **photorealistic 3D globe** with modern navigation controls.
2. **Elevation as a first-class layer**: readouts, shaded relief, contours, and profiles that make mountain ranges and ridgelines easy to read.
3. **An accurate sun simulation** driven by date and time sliders, casting realistic shadows on terrain and 3D geometry.
4. A clean, modern, keyboard-friendly UI that stays out of the way of the map.

### 1.2 Non-goals (for this spec)

- Photography tools (camera frustums, focal length simulation, shot lists): see §11.
- Offline mode or persistent tile caching (also restricted by the tile provider's terms, see §9).
- Mobile or web builds. Electron desktop only.
- Multi-user features, accounts, or cloud sync.
- Editing or authoring geodata (KML authoring, drawing tools beyond basic markers).

## 2. Platform & Tech Stack

| Concern | Choice | Notes |
|---|---|---|
| Shell | **Electron** (latest stable) | **Windows (x64) is the primary target**: packaging, GPU testing, and performance targets are measured there. Linux and macOS (Apple Silicon, ad-hoc signed) are best effort. |
| Language | **TypeScript** (strict) | Main, preload, and renderer. |
| Build | **electron-vite** | Vite for the renderer, with separate main and preload bundles. |
| 3D engine | **CesiumJS** | Native 3D Tiles support, a WGS84 globe, built-in sun lighting and shadow maps, terrain providers, and globe materials for elevation styling. |
| UI | **React** + a small state store (e.g. Zustand) | The map canvas is owned by Cesium; React renders overlay UI only. |
| Sun math | **SunCalc** (or equivalent) | For human-readable readouts (azimuth, altitude, sunrise/sunset). Rendering uses Cesium's own sun model. |
| Time zones | **tz-lookup** / **geo-tz** (offline) | Maps a coordinate to an IANA time zone so time sliders show local time. |
| Tests | **Vitest** (unit), **Playwright for Electron** (smoke/E2E) | |
| Packaging | **electron-builder** | |

### 2.1 Why CesiumJS

CesiumJS natively supports Google Photorealistic 3D Tiles, simulates sun lighting from a clock date, renders shadow maps on 3D Tiles and terrain, supports vertical exaggeration, and ships globe materials for elevation ramps, contours, and slope. That covers almost all of the core requirements with no custom rendering engine.

## 3. Data Sources

### 3.1 Google Map Tiles API (primary, user-supplied key)

The app uses the **Google Map Tiles API** with an API key the user supplies:

- **Photorealistic 3D Tiles**: the main 3D view (textured terrain, buildings, vegetation).
- **2D Tiles** (`satellite`, `terrain`, `roadmap` map types): imagery draped on the terrain globe in Elevation mode (§5.2), and an optional 2D/overview map.

Requirements:
- Use the session token flow for 2D Tiles, and handle the session expiring.
- Show the **required attributions and Google logo** at all times, collecting them from the tileset's copyright data.
- Handle errors clearly: invalid key, API not enabled, quota exceeded, network offline. Show a non-blocking banner explaining the problem, not just a blank globe.

### 3.2 Elevation / terrain source

Photorealistic 3D Tiles are a textured mesh with **no separate height data**, so they can't drive elevation materials like contours or a hypsometric tint. Elevation mode needs a terrain heightmap provider.

**Decision: Cesium World Terrain**, loaded with a Cesium ion access token the user supplies and stores like the Google key (§4.1).

- It provides contours, hypsometric tint, slope, and hillshade in Elevation mode (§7.2), and powers the fallback terrain shadow overlay (§8.1.1).
- It's loaded behind a `TerrainManager` abstraction, so another heightmap source (e.g. AWS Terrain Tiles) could be swapped in later without touching the rest of the app.
- The free Cesium ion tier has usage limits. Show a clear message if the token is invalid or the quota is exceeded.

Point elevation readouts in Photorealistic mode come from sampling the 3D tileset directly (`scene.sampleHeightMostDetailed` / `globe.getHeight` as a fallback), so they don't need the terrain source.

### 3.3 Geocoding / search

- **Decision: Google Places API (New)**, using the same Google key (the user must enable Places API in Cloud Console).
  - Autocomplete as the user types in the command palette, then Place Details (location fields only) for the chosen result.
  - Use **autocomplete session tokens**, so one search session is billed as one search rather than one charge per keystroke.
  - Request only the fields needed (name, formatted address, location, viewport), to stay on the cheaper Essentials and Pro billing tiers.
  - Debounce input (≈250 ms) and require at least 3 characters before querying.
- Direct coordinate entry is always available, even without a geocoding API. Accepted formats: decimal degrees, DMS, and Google Maps URLs.

## 4. Application Architecture

```
┌──────────────────────── Electron main process ────────────────────────┐
│ • Window lifecycle, menus, global shortcuts                           │
│ • Settings store (JSON in userData)                                   │
│ • Secrets: API keys encrypted with electron.safeStorage               │
│ • IPC handlers: getKeys/setKeys, settings, bookmarks CRUD             │
└───────────────────────────────▲───────────────────────────────────────┘
                                │ typed IPC (contextBridge)
┌───────────────────────────────┴──── preload ──────────────────────────┐
│ • Exposes a minimal, typed `window.photoearth` API                    │
└───────────────────────────────▲───────────────────────────────────────┘
┌───────────────────────────────┴──── renderer ─────────────────────────┐
│  CesiumViewer (owns <canvas>)        React overlay UI                 │
│  ├─ TilesetManager (3D Tiles)        ├─ Search / command palette      │
│  ├─ TerrainManager (elevation)       ├─ Layer & mode switcher         │
│  ├─ CameraController (navigation)    ├─ Compass / tilt / zoom widget  │
│  ├─ SunController (clock, shadows)   ├─ Time & date sliders           │
│  └─ ElevationTools (materials,       ├─ Status bar (coords, elev)     │
│     profile, sampling)               └─ Settings / onboarding         │
│                   ▲                         ▲                         │
│                   └──── app state store ────┘                         │
└───────────────────────────────────────────────────────────────────────┘
```

### 4.1 Security

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.
- A strict Content Security Policy that allows only the required Google / Cesium / terrain origins.
- API keys are never written in plaintext. They are encrypted with `safeStorage` in the main process and sent to the renderer only when needed. Tile requests necessarily include the key, so the user should **restrict the key by API** (Map Tiles API, Places, etc.) in Google Cloud Console.
- Google API keys restricted by HTTP referrer don't work from `file://`. Either document using API restrictions instead, or set a fixed `Referer` header with `session.webRequest.onBeforeSendHeaders` for Google origins and document the referrer to allow.

### 4.2 Persistence (userData)

- `settings.json`: UI preferences, quality settings, last camera position, last mode.
- `bookmarks.json`: saved views (name, camera position/orientation, optional date/time).
- `secrets`: encrypted API keys.

## 5. Map View & Rendering

### 5.1 Photorealistic mode (default)

- A full-window Cesium viewer with Google Photorealistic 3D Tiles.
- The Cesium base globe is hidden or used as a low-detail backdrop, so it never z-fights with the tileset.
- Atmosphere, sky, and fog are enabled for depth cues at distance. This matters for judging layered ridgelines.
- On startup, the camera restores the last position, or a default view on first run.

### 5.2 Elevation mode

- The Cesium globe with the terrain provider (§3.2), draped with Google 2D satellite or terrain imagery.
- Elevation styling options (§7) are available only in this mode, because they need real height data.
- Switching modes keeps the camera position and orientation.

### 5.3 Quality & performance

- Target: **60 fps** on a mid-range discrete GPU at 1440p, and ≥30 fps on integrated graphics at reduced quality.
- Quality presets (Low / Medium / High / Ultra) control:
  - `maximumScreenSpaceError` of the tileset
  - Shadow map size and cascades, detail shadow range, and terrain shadow grid resolution
  - MSAA / FXAA
  - Resolution scale (with an option for device-pixel-ratio-aware rendering)
- An optional on-screen FPS and tile-load indicator.
- Rendering only when needed (`requestRenderMode`) when the scene is idle, to save power. Animation (sun playback, flying) forces continuous rendering.
- A subtle loading indicator while tiles stream in.

### 5.4 Vertical exaggeration

- A slider from 1.0× to 3.0× (default 1.0×), applied to terrain and 3D tiles where supported.
- A clear visual indicator when it isn't 1.0×, so the user doesn't misjudge real scenery.

## 6. Navigation & Controls

The aim is controls that feel **modern and predictable**, closer to a 3D modeling tool or game than to classic Google Earth Pro.

### 6.1 Mouse / trackpad (default "Orbit" scheme)

| Input | Action |
|---|---|
| Left-drag | Pan. The point under the cursor stays under the cursor (grab the ground). |
| Right-drag **or** Ctrl+Left-drag | Orbit / tilt around the point under the cursor. |
| Middle-drag **or** Shift+Left-drag | Rotate the heading around the point under the cursor. |
| Scroll | Smooth zoom **toward the cursor**, speed scaled by height above ground. |
| Double-click | Fly to the clicked point at a closer range. |
| Trackpad two-finger scroll | Pan (grab the ground); at eye level, look around. Detected automatically; a setting can force scroll to pan or zoom. |
| Trackpad pinch | Smooth zoom toward the cursor. |
| Alt/⌥ + trackpad two-finger scroll | Orbit around the point under the cursor: sideways turns the heading, up/down tilts. |

All movement has **inertia** with a configurable damping and an "Off" option.

### 6.2 Keyboard / fly mode

| Key | Action |
|---|---|
| `W A S D` | Move forward / left / back / right (ground-relative). |
| `Q` / `E` | Descend / ascend. |
| Arrow keys | Look around (pitch / heading). |
| `Shift` (hold) | Move faster. `Alt` (hold) moves slower / with precision. |
| `F` | Toggle **first-person fly mode**: pointer lock, mouse-look, WASD flight. `Esc` exits. |
| `N` | Reset heading to north. |
| `U` | Reset tilt to top-down. |
| `R` | Reset to a level horizon view (tilt to eye-level at the current position). |
| `Ctrl/Cmd+K` | Open the search / command palette. |
| `Ctrl/Cmd+B` | Save a bookmark of the current view. |
| `1` / `2` | Switch Photorealistic / Elevation mode. |
| `Space` | Play / pause sun animation (when the time panel is open). |
| `?` | Show the shortcuts overlay. |

- Movement speed scales automatically with altitude above ground.
- **Ground collision**: the camera can't go below the terrain or tileset surface, with a configurable minimum clearance (default 2 m).
- **Eye-level mode**: drop the camera to a standing height (≈1.7 m) above the ground at the cursor and level the horizon. This is the core "what would I see from here" view.

### 6.3 On-screen widgets

- **Compass**: shows heading. Click resets to north, and dragging rotates.
- **Tilt indicator**: shows pitch. Click toggles top-down / oblique.
- **Zoom +/−**, low-key and optional.
- **Status bar**: cursor lat/lon (switchable between decimal and DMS), **cursor elevation**, camera altitude, heading/pitch, scale bar, and attributions.

### 6.4 Search & go-to

- A command palette (`Ctrl/Cmd+K`) that combines:
  - Place search (geocoding, §3.3) with autocomplete
  - Coordinate entry
  - Bookmarks
  - App commands (switch mode, toggle shadows, open settings, etc.)
- Choosing a result **flies** the camera there with a smooth eased arc. The duration scales with distance and can be interrupted by any user input.

### 6.5 Bookmarks

- Save, rename, delete, and fly to saved views.
- A bookmark stores the camera position, heading, pitch, roll, the mode, and optionally the simulated date/time.
- Bookmarks are listed in a collapsible side panel and in the command palette.

## 7. Elevation Features

### 7.1 Readouts (both modes)

- Cursor elevation in the status bar (meters, or feet as a setting), debounced, from surface sampling.
- Camera altitude, both above sea level and above ground.

### 7.2 Elevation styling (Elevation mode)

These can be toggled and combined:

- **Hypsometric tint**: a color ramp by height. The range is auto-fit to the visible area or set manually, and there are several palettes.
- **Contour lines**: configurable interval (e.g. 10 / 20 / 50 / 100 m), line width, and color. Every 5th line is a highlighted index contour.
- **Slope shading**: color by slope angle. Useful for reading ridges, cliffs, and gullies.
- **Hillshade**: relief shading that **follows the simulated sun by default** (§8): light comes from the current sun azimuth and altitude, so scrubbing time re-lights the relief live. A toggle switches to a fixed classic light (from the northwest, 45° altitude) for reading terrain shape regardless of time.
  - When the sun is below the horizon, hillshade fades to flat night shading rather than lighting the terrain from below.
- An opacity slider blends each style with the imagery.
- A legend shows the active ramp and its value range.

### 7.3 Elevation profile tool

- Click two or more points to draw a path across the terrain.
- A bottom panel shows a profile chart (distance vs. elevation) with min, max, total ascent and descent, and distance.
- Hovering the chart highlights the matching point on the map, and the other way around.
- Profiles are temporary in this spec. Saving them is future work.

### 7.4 Peak / point inspection

- Click a point to drop a temporary marker that shows coordinates and elevation. It can be copied to the clipboard.

## 8. Sun Simulation & Shadows

### 8.1 Behavior

- The simulated date/time drives the Cesium clock. Scene lighting uses the **sun's actual position** for that instant and for the camera's location on Earth.
- **Shadows** are cast by terrain and 3D tiles onto terrain and 3D tiles, with soft shadows where quality settings allow.
- **Terrain shadows come from a heightmap** of Cesium World Terrain (resolved by the spike, §8.1.1): ray-marched toward the sun on the GPU, covering ±80 km around the view in both modes, and applied to the 3D tiles and the globe.
- In Photorealistic mode, a **short-range shadow map** adds shadows of what the terrain model lacks (buildings, trees) near a low camera. It folds into the terrain shadow rather than darkening twice.
- Without a Cesium ion token, shadow maps on the 3D tiles do all the shadowing, with the limits listed below.

### 8.1.1 Shadow accuracy risks (verify with an early spike)

The main use case is mountains casting long shadows when the sun is low. Real-time shadow maps have known limits here:

1. **Off-screen casters:** 3D Tiles load only the tiles in the camera's view. A peak behind the camera, or off to the side, may not be loaded, so its shadow is missing from the view.
2. **Low detail at distance:** far-away ridges load at coarse detail, which makes their shadow edges imprecise.
3. **Shadow map range:** shadow maps cover a limited distance. A shadow cast by a ridge 10–30 km away may be cut off or blurry.

**Outcome:** the spike confirmed these problems, plus shadow acne: Google's tiles carry no normals, so Cesium's normal-offset bias is skipped and slopes under a low sun shadow themselves in stripes. Terrain shadows are therefore computed from the §3.2 heightmap:

- Three nested height grids follow the view (High preset: ±5 km at ~20 m, ±20 km at ~80 m, ±80 km at ~400 m cells), in a local tangent-plane frame.
- A GPU pass marches each cell toward the sun through all grids. It includes earth curvature, terrestrial refraction (k = 0.13) and the sun setting behind the horizon past the data. Each cell stores the **shadow top**: the height above which its vertical is sunlit, plus the occluder distance.
- Receivers shade by comparing their height with the shadow top, so buildings, tree tops and cliff faces inside a cell are handled. The penumbra width follows from the sun's angular size and the occluder distance.
- The pass runs only when the sun or the data changes, one grid level per frame.
- Shadow maps remain for short-range detail, with derived normals to remove the acne.
- A **"Now"** button resets to the current real time.
- Lighting can be switched between **Simulated sun** and **Flat/neutral**. Flat lighting is useful for scouting geometry without harsh shadows.

### 8.2 Time & date controls

- **Time-of-day slider** (00:00–23:59), shown in the **local time zone of the viewed location** (from the camera target's coordinates), with the UTC offset displayed.
  - Markers on the slider for **sunrise, solar noon, and sunset** on the selected date.
  - The slider background is shaded for night and twilight.
- **Date slider** (Jan 1–Dec 31) plus a year selector, with markers for **solstices and equinoxes**.
- A precise date/time picker for typing an exact value.
- **Playback**: play/pause animation through the day at selectable speeds (e.g. 1 min/s, 10 min/s, 1 h/s). Playback can also step through days at a fixed time of day, to see how light changes across the season.
- Keyboard nudges: `[` / `]` move ±15 min, and `Shift+[` / `Shift+]` move ±1 day.

### 8.3 Sun readouts

- Sun **azimuth** and **altitude** for the camera target.
- Sunrise, sunset, and solar noon times for the date.
- An optional on-map **sun direction indicator**: a ground arrow or a line from the target point toward the sun's azimuth.

### 8.4 Accuracy requirements

- The sun position should match a reference (NOAA solar calculator / SunCalc) within **±0.5°** in azimuth and altitude.
- Time zone and DST handling must be correct for the viewed location, not the computer's location.
- Unit tests cover the sun position, time zone resolution, and sunrise/sunset at a set of reference locations, including high latitudes with polar day and night.

## 9. Licensing & Terms Constraints

- Follow the **Google Map Tiles API** policies: attribution display, no scraping or bulk download, and no persistent caching beyond what the terms allow. The standard HTTP cache is fine.
- No exporting of Google imagery or 3D geometry in this spec.
- Cesium ion and other terrain sources: follow their attribution requirements as well.

## 10. Onboarding & Settings

### 10.1 First run

1. A welcome screen explaining the required API key(s).
2. Fields for the **Google Maps Platform API key** and the **Cesium ion access token**.
3. **Validate** each key with a test request, and show which APIs are enabled or missing (Map Tiles, Places API (New), Cesium ion).
4. Land on a default view.

### 10.2 Settings panel

- API keys: update, re-validate, or clear.
- Units (metric / imperial) and the coordinate format.
- Quality preset plus advanced overrides (§5.3).
- Navigation: inertia, speed multiplier, invert Y in fly mode, minimum ground clearance.
- Theme: dark (default) and light, for the UI chrome only.

### 10.3 UI style

- Minimal, map-first. Panels are translucent overlays with blur that collapse to icons.
- Dark theme by default, so it doesn't compete with the imagery.
- Every feature can be reached from the command palette.

## 11. Future Work (explicitly out of scope)

These will get their own spec later:

- **Camera / lens simulation**: place a virtual camera, choose sensor and focal length, and preview the framing and field-of-view frustum on the map. *First slice done: the viewfinder (§11.1).*
- **Shot planning**: lines from a camera position to a subject, alignment with the sun or moon azimuth, and line-of-sight / visibility checks.
- **Moon simulation**: position, phase, rise and set.
- **Golden hour / blue hour** bands and twilight phases.
- **Milky Way / galactic core** position.
- **Viewshed analysis**: what is visible from a point.
- Saved scouting locations with notes, photos, and tags. KML/GPX import and export.
- Weather / cloud cover overlays.
- Screenshot / export of views, within the licensing limits.

### 11.1 Viewfinder (implemented)

The first slice of the camera simulation frames the current view through a real lens:

- **Lens**: sensor presets (36 × 24, 23.5 × 15.6, 22.3 × 14.9, 17.3 × 13, 13.2 × 8.8, 44 × 33, a 4:3 phone main camera whose focal length is entered as its 35 mm equivalent) or a custom size; focal length 8–800 mm on a logarithmic slider, a numeric field and presets (14 … 600 mm). Angles of view are those of a rectilinear lens: `2·atan(d / 2f)` across the frame's width, height and diagonal. Crop factors are diagonal ratios to 36 × 24.
- **Frame**: the sensor's ratio or 3:2, 4:3, 1:1, 4:5, 5:4, 16:9, 65:24, cut from the sensor as the largest rectangle of that ratio (as in-camera crop modes do); portrait turns the camera 90°. On screen it is the largest centered rectangle of the ratio inside the window less a small margin (clear of the status bar); outside it the view is dimmed.
- **Field of view**: Cesium's `PerspectiveFrustum.fov` spans the longer side of the canvas (horizontal when `aspectRatio > 1`, else vertical). It is set to `2·atan(tan(aov / 2) · view / frame)` along that side so the frame, not the window, shows the angle of view, recomputed on every resize. Switching off restores the navigation mode's default field of view exactly.
- **Guides**: none, rule of thirds, phi grid (0.382 / 0.618), center cross, diagonals; drawn in SVG with `pointer-events: none`.
- **Readout**: focal length, sensor, frame ratio, horizontal × vertical (and diagonal) angle of view, the 35 mm equivalent, and the lens's compass bearing and tilt.
- **Persistence**: the lens settings are part of `settings.json`; bookmarks saved in viewfinder mode store them and reopen framed.

Level of detail follows from the narrower frustum by itself (Cesium's screen-space error uses the frustum's vertical field of view), so distant terrain seen through a long lens streams in at the detail its on-screen size needs.

The architecture should not rule any of these out. In particular, `SunController` should be general enough to model other celestial bodies later.

## 12. Open Questions

None currently. Resolved decisions:

- **Terrain source** → Cesium World Terrain (§3.2). AWS Terrain Tiles remain a possible swap-in behind `TerrainManager`.
- **Search** → Google Places API (New) (§3.3).
- **Target OS** → Windows (§2).
- **Shadows in Elevation mode** → hillshade follows the simulated sun by default, and terrain casts real shadows in Elevation mode too (§7.2, §8.1).
- **Mountain shadow accuracy** → settled by the shadow spike that opens M4 (§8.1.1, §13).

## 13. Milestones

### M0 — Scaffold
- An electron-vite + TypeScript + React project, with Cesium integrated (static assets copied and `CESIUM_BASE_URL` configured).
- Secure Electron defaults, CSP, typed IPC, a settings store, and safeStorage key storage.
- First-run API key entry and validation.
- CI: lint, typecheck, unit tests.

**Done when:** the app launches, takes and stores a key, and renders an empty Cesium globe.

### M1 — Photorealistic 3D map & navigation
- Google Photorealistic 3D Tiles with attributions and error handling.
- The navigation scheme in §6.1–6.3: orbit, cursor-anchored zoom, inertia, the keyboard controls, fly mode, eye-level mode, ground collision, and the compass and tilt widgets.
- A status bar with coordinates and cursor elevation.
- Quality presets and an FPS indicator.
- Restoring the last camera position.

**Done when:** you can smoothly fly from a global view to eye level on a mountain ridge, and the controls feel natural with mouse and keyboard.

### M2 — Search & bookmarks
- The command palette, geocoding, coordinate entry, and fly-to.
- Bookmarks: CRUD, persistence, and the side panel.

**Done when:** you can type a place or coordinates, fly there, save the view, and return to it after a restart.

### M3 — Elevation
- Elevation mode with the terrain provider and draped 2D imagery.
- Hypsometric tint, contours, slope, and hillshade, with legends.
- The elevation profile tool and point inspection.
- Vertical exaggeration.

**Done when:** you can switch to Elevation mode over a mountain range, see contours and a tint with a legend, and draw a profile across a valley.

### M4 — Sun & shadows
- **Shadow spike first** (§8.1.1): pick a known valley with a reference photo (known date, time, and place) and compare it against Cesium's shadow maps on 3D Tiles at low sun angles. Check off-screen casters, distant ridges, and shadow range. Outcome: either shadow maps are good enough, or the heightmap-based terrain shadow overlay becomes part of M4.
- `SunController` driving the Cesium clock, lighting, and shadow maps.
- Time and date sliders in local time, with sunrise/sunset and solstice/equinox markers.
- Playback, keyboard nudges, sun readouts, and the sun direction indicator.
- Flat lighting toggle. Hillshade follows the sun by default, and terrain casts shadows in Elevation mode.
- Unit tests for sun position and time zone accuracy (§8.4).

**Done when:** you can pick a mountain, set a date and time, and watch shadows move across the terrain as you scrub the slider, with the sun position matching a reference calculator.

## 14. Acceptance Criteria (summary)

- [ ] Launches on Windows and stores API keys encrypted.
- [ ] Renders Google Photorealistic 3D Tiles with correct attribution.
- [ ] Navigation: cursor-anchored zoom/orbit, inertia, WASD/fly mode, eye-level mode, no clipping through the ground.
- [ ] Holds 60 fps at the High preset on reference hardware while idle-orbiting a mountain scene.
- [ ] Search, coordinates, and bookmarks work and persist.
- [ ] Elevation mode shows tint, contours, slope, and hillshade with legends, plus a working profile tool.
- [ ] Sun position is within ±0.5° of the reference, local time zone and DST are correct, and shadows update live with the sliders.
