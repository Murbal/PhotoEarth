# PhotoEarth — Modular Architecture Plan

> Status: Proposal · Scope: App shell overhaul, module system, Cesium lifecycle, shared data & IPC

## 1. Why Move to Modules?

PhotoEarth today is a single-surface application: [`App.tsx`](../src/renderer/src/App.tsx) mounts the CesiumJS 3D globe directly at the root, and every feature (weather, viewfinder, horizon panorama, saved locations, alignment) lives as an overlay panel on top of it.

As PhotoEarth evolves into a complete **photography planning and brainstorming suite**, the 3D globe becomes one specialized workspace among several—not the only canvas. Early brainstorming (moodboards, concept notes, color stories) and high-level shoot organization (projects, linked spots, future shot lists and itineraries) need full-window, distraction-free workspaces of their own.

### Design Goals
1. **The 3D Globe remains first-class and instant.** Switching between Projects, Moodboards, and the Globe must not reload Cesium, lose the camera pose, or trigger shader recompilation hitches.
2. **Project-centric workflow, not siloed tools.** Modules share data cleanly: a Project links Globe locations and Moodboards; the Globe can snapshot its Viewfinder directly onto a Moodboard; a Moodboard card can jump straight back to a Globe location.
3. **Preserve PhotoEarth's existing engineering standards.** Strict TypeScript, `contextIsolation` + `sandbox`, main-process-only persistence and third-party API calls, versioned JSON files with automatic migration, and zero regressions to existing unit/E2E tests.
4. **Incremental migration.** The modular shell can be introduced first with the Globe as the sole module, followed by Projects Hub and Moodboards without a "big bang" rewrite.

---

## 2. Application Shell & Navigation

### 2.1 Layout Structure
Replace the bare full-window canvas root with a minimal **Workspace Shell**:

```
┌──────┬────────────────────────────────────────────────────────────────┐
│ Rail │  Active Module Viewport                                        │
│ 52px │                                                                │
│      │  • Projects Hub    (project index + scoped project workspace)  │
│ [P]  │  • 3D Globe        (existing MapView + MapMode + overlays)     │
│ [G]  │  • Moodboards      (board index + infinite 2D canvas)          │
│ [M]  │  • (Future: Conditions, Gear, Library...)                      │
│      │                                                                │
│ ──── │                                                                │
│ [K]  │  Global Modals (Command Palette, Settings, Shortcuts, Viewer)  │
│ [⚙]  │                                                                │
└──────┴────────────────────────────────────────────────────────────────┘
```

- **Left Activity Rail (52 px wide, collapsible or auto-compactable):**
  - Top: Module icons with tooltips and shortcut hints (`Ctrl+1` Projects, `Ctrl+2` Globe, `Ctrl+3` Moodboards).
  - Middle (optional indicator): Active Project pill/badge showing which project is currently in context, with a quick switcher popover.
  - Bottom: Command Palette (`Ctrl+K`), Shortcuts (`?`), Settings (`Ctrl+,`).
- **Module Viewport:** Occupies `calc(100vw - 52px)` × `100vh`.
  - When the **Globe** module is active, `useOverlayLayout` in [`App.tsx`](../src/renderer/src/App.tsx) measures the module viewport container (`rootEl.clientWidth`) instead of `window.innerWidth`, so all existing side panels, tool rail, and bottom stack adapt automatically.

### 2.2 Global vs. Module-Scoped Shortcuts
Currently [`useShortcuts.ts`](../src/renderer/src/hooks/useShortcuts.ts) binds single-key shortcuts (`W/A/S/D`, `V`, `H`, `X`, `T`, `Space`, etc.) globally on `window`. In a multi-module app, those must be scoped:

| Scope | Shortcuts | Behavior |
|---|---|---|
| **Global (Shell)** | `Ctrl+1..9` (switch module), `Ctrl+K` (Command Palette), `Ctrl+,` (Settings), `?` (Shortcuts help for active module) | Always active unless a modal/text input captures them. |
| **Globe Module** | `WASD`, `G`, `F`, `V`, `H`, `X`, `T`, `L`, `P`, `1/2`, `Space`, `[` `]`, `Ctrl+B` | Active **only** when `activeModule === 'globe'` and no modal/input is focused. |
| **Projects Module** | `N` (new project), `/` (focus filter), `Esc` (back to index) | Active only when `activeModule === 'projects'`. |
| **Moodboard Module** | `Space+Drag` (pan), `V` (select), `T` (note), `F` (fit view), `Ctrl+Z/Y` (undo/redo), `Ctrl+V` (paste image), `Delete` | Active only when `activeModule === 'moodboard'`. |

### 2.3 Unified Command Palette (`Ctrl+K`)
The existing [`CommandPalette.tsx`](../src/renderer/src/components/CommandPalette.tsx) stays global and gains cross-module awareness:
- **Always searchable:** Projects, Moodboards, Saved Locations, Elevation Profiles, and Switch-Module commands.
- **Context-aware actions:** Globe-specific actions (e.g. *Toggle Viewshed*, *Search Google Places*) either run directly when on the Globe or switch to the Globe first and execute.
- **Shortcuts Overlay (`?`):** Displays Global shortcuts plus the section for whichever module is currently active.

---

## 3. CesiumJS Lifecycle & Performance Strategy

Initializing CesiumJS, Google 3D Tiles, terrain shadow compute stages, and compiled WebGL shaders is expensive (60–120 ms+ per shader variant and several hundred megabytes of tile cache). Unmounting `<MapView />` when the user clicks "Moodboards" would ruin the experience.

### Strategy: Lazy-Mount, Keep-Alive, Hibernate When Hidden
1. **Lazy First Mount:**
   - Track `globeMounted: boolean` in shell state.
   - If the app launches directly into the Globe (default for existing users or configurable in Settings), it mounts immediately.
   - If the user configures startup on **Projects Hub**, Cesium does not initialize until the user opens the Globe module for the first time (faster cold start and lower memory when only brainstorming).
2. **Keep Mounted, Hide Visually:**
   - Once mounted, the Globe container stays in the DOM and is hidden via CSS (`visibility: hidden; pointer-events: none; position: absolute; inset: 0; z-index: -1;`) plus the `inert` attribute when another module is active.
   - Avoid `display: none` on the Cesium canvas container, as Chromium can report `0×0` client dimensions and trigger unnecessary framebuffer reallocations or WebGL resize churn.
3. **Explicit Engine Hibernation (`engine.setSuspended(true)`):**
   - PhotoEarth already uses `requestRenderMode`, so idle frames cost little—but background activity still needs pausing:
     - Pause sun/time playback (`playing = false` or suspend tick loop while hidden).
     - Exit pointer-lock fly mode (`F`) if active.
     - Suppress `useForecastFeed` and `PlaceLabels` network queries while hidden.
     - Suppress `ResizeObserver` / `requestRender()` triggers until `setSuspended(false)`.
   - On returning to the Globe module (`setSuspended(false)`), trigger a single `scene.requestRender()` and resume normal input.
4. **Canvas Capture Helper:**
   - Expose a clean method on `Engine` (e.g., `captureViewfinderFrame(): Promise<CapturedFrame>`) so the user can send a high-res snapshot of their current 3D view (cropped to the active Viewfinder aspect ratio if enabled, along with camera/lens/time metadata) directly to a Project or Moodboard.

---

## 4. State Management Refactor

[`appStore.ts`](../src/renderer/src/store/appStore.ts) currently holds all application state in one Zustand store. To prevent it from becoming unwieldy as modules grow, split it into cohesive stores or slices:

- **`shellStore.ts`** — `activeModule`, `globeMounted`, `activeProjectId`, `activeMoodboardId`, `modal` state (`paletteOpen`, `settingsOpen`, `shortcutsOpen`, `photoViewer`), `toast`.
- **`appStore.ts` (or `globeStore.ts`)** — Existing 3D globe, camera readouts, panels, alignment, viewshed, horizon, viewfinder, forecast, and `bookmarks`/`profiles` cache.
- **`projectsStore.ts`** — Loaded `projects[]`, filter/sort state, CRUD actions delegating to `window.photoearth.projects.*`.
- **`moodboardStore.ts`** — Board index metadata, currently open board document, selection/tool/viewport state, in-memory undo/redo stack, debounced save to `window.photoearth.moodboards.*`.

All stores remain plain Zustand stores so non-React code (like `Engine` and `commands.ts`) can read/subscribe via `getState()` / `subscribe()` just as `appState()` does today.

---

## 5. Persistence, Assets & Security

### 5.1 `userData` Directory Layout
Extend the existing layout from [`SPEC.md §4.2`](../SPEC.md):

```
<userData>/
├── settings.json          # Add: activeModule, startupModule, lastProjectId, lastMoodboardId
├── secrets.json           # Existing encrypted API keys (unchanged)
├── bookmarks.json         # Existing v2 locations + elevation profiles (unchanged format)
├── projects.json          # NEW (versioned JsonFile): Project records & links
├── moodboards/            # NEW:
│   ├── index.json         #   Lightweight list of boards (id, title, projectId, updatedAt, cover)
│   └── <boardId>.json     #   Full canvas document (items, groups, connectors, viewport)
└── photos/                # Existing PhotoStore, now shared across locations, projects & moodboards
```

### 5.2 Unified Asset / Photo Ownership & Orphan Cleanup
Currently [`BookmarkStore`](../src/main/bookmarks.ts) owns `PhotoStore` and runs `removeOrphans()` on startup using only `bookmarks.json`.

**Critical change when moving to modules:**
- Promote `PhotoStore` to a top-level service in `src/main/` (e.g. `src/main/assetStore.ts` or shared `PhotoStore` instance) passed into `BookmarkStore`, `ProjectStore`, and `MoodboardStore`.
- Run `removeOrphans()` **once at startup** in `src/main/index.ts` after all three stores have loaded—and **only** if none of the three stores reported a corrupt/unreadable or future-version file.
- The `photo://` custom protocol in [`src/main/protocol.ts`](../src/main/protocol.ts) continues serving read-only assets from `photos/` with zero CSP relaxation.

### 5.3 IPC & Preload Structure
Extend [`src/shared/ipc.ts`](../src/shared/ipc.ts) and [`PhotoEarthApi`](../src/shared/types.ts) with namespaced modules matching the existing `bookmarks` and `profiles` pattern:
- `window.photoearth.projects.*` (`list`, `create`, `update`, `remove`, `setCover`, ...)
- `window.photoearth.moodboards.*` (`list`, `get`, `create`, `save`, `updateMeta`, `remove`, `addImage`, ...)
- `window.photoearth.browserDrawer.*` (controls the main-process `WebContentsView` Inspiration Browser: `setBounds`, `setVisible`, `navigate`, `goBack`, `goForward`, `reload`, and `onImageAdded` for right-click *Add to Moodboard* saves). Runs in an isolated `persist:inspiration-browser` session partition with no preload and zero access to app keys or `app://photoearth/`.

---

## 6. Codebase Reorganization

```
src/
├── main/
│   ├── index.ts
│   ├── ipc.ts
│   ├── protocol.ts
│   ├── photos.ts              # Shared PhotoStore (used by bookmarks, projects, moodboards)
│   ├── bookmarks.ts           # Existing BookmarkStore
│   ├── projects.ts            # NEW ProjectStore
│   ├── moodboards.ts          # NEW MoodboardStore
│   └── browserDrawer.ts       # NEW Embedded WebContentsView Inspiration Browser controller
├── preload/
│   └── index.ts
├── shared/
│   ├── types.ts               # Re-exports or split into shared/types/{globe,projects,moodboard}.ts
│   ├── ipc.ts
│   ├── projects.ts            # NEW Project sanitization & migration
│   └── moodboards.ts          # NEW Moodboard sanitization & migration
└── renderer/src/
    ├── App.tsx                # Thin shell orchestrator
    ├── shell/                 # NEW ActivityRail, ModuleViewport, ActiveProjectPill, shellStore
    └── modules/
        ├── globe/             # Existing MapView, MapMode, engine/, globe panels, overlays
        ├── projects/          # NEW ProjectsHub, ProjectWorkspace, ProjectCard, ConceptEditor
        └── moodboard/         # NEW MoodboardIndex, CanvasWorkspace, items/, ColorPalette, BrowserDrawerSlot
```

---

## 7. Phased Migration Plan

1. **Phase 1 — Shell & Globe Extraction (Zero Feature Regression):**
   - Introduce `shellStore`, `ActivityRail`, and `ModuleViewport`.
   - Move existing Globe UI tree from `App.tsx` into `modules/globe/GlobeModule.tsx`.
   - Scope Globe keyboard shortcuts to `activeModule === 'globe'`.
   - Add `engine.setSuspended(boolean)` and keep-alive hiding.
   - Promote `PhotoStore` to a shared main-process service.
   - Verify all existing Vitest unit tests and Playwright E2E smoke tests pass unchanged.
2. **Phase 2 — Projects Hub Module:**
   - Implement `ProjectStore` + IPC + `projectsStore` + Projects Hub UI.
   - Add active-project filtering and "Save to Project" integration inside the Globe module.
3. **Phase 3 — Moodboard Module:**
   - Implement `MoodboardStore` + IPC + infinite canvas + image/note/group/palette/location cards.
   - Add "Capture Viewfinder to Moodboard" bridge from the Globe and the docked `WebContentsView` Inspiration Browser drawer.
