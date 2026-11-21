# Moodboard Module — Design Specification

> Status: Proposal · Depends on: [Modular Architecture Plan](./modular-architecture.md)

## 1. Purpose & Mental Model

Photography brainstorming is inherently visual: you gather references for lighting direction, color grading, framing, foreground textures, and atmosphere, then arrange them until a cohesive look clicks.

The **Moodboard Module** brings a **PureRef-meets-Milanote infinite 2D canvas** directly into PhotoEarth, with photography-specific superpowers that generic whiteboard apps don't have:
- **One-click 3D Globe captures:** Snap your current Cesium Viewfinder view straight onto a moodboard, preserving its focal length, compass bearing, simulated sun/moon time, and a live link back to that 3D spot.
- **Automatic color palette extraction:** Pull dominant color stories directly from reference images (100% locally) and sync them to a Project's color story.
- **Offline-first local storage:** Every dropped, pasted, or saved web image is copied into PhotoEarth's `PhotoStore`, so boards never suffer from broken external URLs and work completely offline.
- **Embedded Inspiration Browser:** A docked `WebContentsView` side panel lets you browse Google Images, Pinterest, Flickr, 500px, Behance, ShotDeck, or any website right beside your canvas and right-click any image → *Add to Moodboard*.

---

## 2. Canvas Architecture & Interactions

### 2.1 Rendering Approach
Use a **hybrid DOM + SVG infinite canvas** inside the React module viewport:
- **Transform World Layer:** A single container transformed with `translate3d(panX, panY, 0) scale(zoom)` (GPU-composited) holds all cards (images, notes, swatches, location pins, groups). Using DOM elements gives crisp typography, native image decoding (`photo://`), accessible text editing, and smooth CSS styling.
- **SVG Overlay Layer:** Shares the same world transform to render crisp **connectors/arrows**, selection marquees, and alignment snap guides.
- **Viewport Culling:** For boards with many items (e.g. 100+ images), compute the visible world bounding box and render only items intersecting the viewport (plus a margin), using thumbnails (`<id>.thumb.jpg`) when zoomed far out and full-resolution images when zoomed in.

### 2.2 Navigation & Editing Controls
Designed to feel natural alongside PhotoEarth's existing camera controls:
- **Pan:** `Space + Left-drag`, `Middle-drag`, or two-finger trackpad scroll.
- **Zoom:** Scroll wheel / pinch zooms smoothly toward the cursor (`0.1×` to `4.0×`).
- **Fit View:** `F` fits the current selection (or entire board if nothing is selected); `0` resets to `100%` zoom.
- **Selection:** Click to select, `Shift+Click` to toggle, drag on empty canvas for marquee box select, `Ctrl+A` select all.
- **Transform:** Drag to move, corner handles to resize (aspect-ratio locked by default for images; hold `Shift` to free-crop/stretch if needed), subtle snap guides to align edges/centers with neighboring items.
- **Z-Order:** Bring to front (`]`), send to back (`[`).
- **Undo / Redo:** In-memory command history stack (up to 100 steps) per open board (`Ctrl+Z` / `Ctrl+Shift+Z`).
- **Presentation Mode:** `Tab` hides all chrome (toolbar, inspector, rail) for a pure PureRef-style full-screen reference view.

---

## 3. Canvas Item Types

Every item on a board shares base geometry (`id`, `x`, `y`, `width`, `height`, `zIndex`, `locked`, `groupId?`) plus a discriminated `kind`:

### 3.1 Image Card (`kind: 'image'`)
- **Sources:**
  - Drag-and-drop image files from OS file explorer.
  - Clipboard paste (`Ctrl+V`) from browser or screenshot tools.
  - Native file picker (reusing PhotoEarth's existing `photoPicker` token flow).
  - **Globe Viewfinder Snapshot** (captures the Cesium canvas + optional viewfinder crop).
  - **Embedded Inspiration Browser** (right-click → *Add to Moodboard* or *Copy Image* + `Ctrl+V`).
- **Features:**
  - Optional caption below the image and subtle borderless mode (PureRef style).
  - Optional **source metadata** (`sourceTitle`, `sourceUrl`) captured from the embedded browser's `pageURL` so you can always click back to the original page/photographer.
  - Optional **globe metadata** (`camera`, `mode`, `time`, `viewfinder`, `locationId`) when captured from the 3D Globe—clicking a small globe badge on the card jumps straight back to that exact 3D view.
  - Right-click → *"Extract Color Palette"* creates a linked Palette Card right beside the image.

### 3.2 Color Palette Card (`kind: 'palette'`)
- Displays 3–8 color swatches with hex codes (click any swatch to copy hex).
- **Local Color Extraction:** Runs purely in the renderer using an offscreen `<canvas>` (downscaled to ~128×128) + median-cut / k-means clustering—zero external dependencies or network calls.
- Can be generated from a single Image Card, a selected group of images, or manually edited.
- Action: **"Send to Project Color Story"** pushes the swatches into the linked Project's `concept.colorStory`.

### 3.3 Note / Text Card (`kind: 'note'`)
- Lightweight sticky note or clean typographic header (toggleable background tint: neutral, amber, blue, rose, emerald, or transparent heading).
- Supports basic Markdown (headings, bold, italic, bullet lists, checklists).

### 3.4 Group / Section Frame (`kind: 'group'`)
- A titled, low-opacity background container (e.g., *"Lighting References"*, *"Foregrounds"*, *"Color Grading"*).
- Dragging a group's header moves all items contained within it; collapsing/locking a group helps keep large boards tidy.

### 3.5 Location Reference Card (`kind: 'location'`)
- A live card linked to a saved `Bookmark` ID from the 3D Globe.
- Shows the location's name, thumbnail, coordinates, `bestTime`, and status badge.
- Double-click (or click its action button) switches to the **3D Globe** and flies directly to that location.

### 3.6 Connectors (`connectors[]`)
- Directed or undirected curved bezier arrows connecting any two items (anchor auto-picks nearest edge), with an optional short text label (e.g., *"same lighting as"*).

---

## 4. Embedded Inspiration Browser (`WebContentsView`)

Instead of relying on limited stock-photo APIs, the Moodboard workspace includes a toggleable right-side **Inspiration Browser** powered by Electron's `WebContentsView` (a real Chromium view managed by the main process).

### 4.1 User Experience
- **Compact Chrome Bar** (rendered in React above the `WebContentsView` slot):
  - Back / Forward / Reload buttons and a URL / search bar (plain search text opens `https://www.google.com/search?udm=2&q=<query>`).
  - Quick-launch presets: **Google Images**, **Pinterest**, **Flickr**, **500px**, **Behance**, **Are.na**, **ShotDeck** (or any custom URL).
- **One-Click Capture to Canvas:**
  - Right-clicking any image inside the browser opens a native context menu with **"Add image to Moodboard"** (alongside *Copy image* and *Open link in external browser*).
  - Electron's `webContents.on('context-menu', (_, params) => ...)` provides `params.srcURL` and `params.pageURL` directly.
  - The main process downloads `params.srcURL` using the embedded view's session (preserving referer/cookies for hotlink-protected sites), validates the image bytes via `PhotoStore.save()`, generates a thumbnail, and notifies the renderer via IPC to spawn an Image Card on the active board (recording `pageURL` as `sourceUrl`).
  - Standard *Copy Image* + `Ctrl+V` on the canvas also works seamlessly.

### 4.2 Security, Isolation & ToS Hygiene
- **Isolated Session Partition:** Uses `session.fromPartition('persist:inspiration-browser')`—completely separated from PhotoEarth's main session, `app://photoearth/` origin, Google Maps API keys, and `photoearth.local` referrer headers. Using a persistent partition remembers cookie/consent banners (and optional logins like Pinterest or ShotDeck) across restarts.
- **Strict Sandbox:** `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, with **no preload script** exposing `window.photoearth` to external web pages.
- **Unmodified, Human-Driven Browsing:** No DOM scraping, no automated querying, and no JS/CSS injection to hide ads, branding, or consent dialogs. Every save is an explicit user action (identical to *Save image as...* in a normal browser).

### 4.3 Window Layering & Layout
Because Electron's `WebContentsView` always renders above renderer DOM elements:
- The Moodboard layout reserves a **docked right pane** (resizable, e.g. 380–640 px wide) rather than floating the browser over the canvas; a `ResizeObserver` on the placeholder slot syncs exact DIP bounds to the main process (`browserDrawer.setBounds`).
- The main process automatically hides the `WebContentsView` whenever:
  - The user switches away from the Moodboard module,
  - Any global modal opens (`CommandPalette`, `SettingsDialog`, `ShortcutsOverlay`, `PhotoViewer`), or
  - Presentation Mode (`Tab`) is active.

---

## 5. Data Model & Persistence

To keep large boards snappy and avoid rewriting every board on every drag, moodboards use an **index + per-board file** layout under `<userData>/moodboards/`:

```
<userData>/moodboards/
├── index.json           # Array of MoodboardSummary (fast list load at startup)
└── <boardId>.json       # Full MoodboardDocument (loaded lazily when opened)
```

```ts
export interface MoodboardSummary {
  id: string
  title: string
  /** Optional primary project link (projects can also link boards via moodboardIds). */
  projectId: string | null
  createdAt: string
  updatedAt: string
  itemCount: number
  /** Up to 4 photo file names from the board, used to render a 2×2 preview collage in lists. */
  previewFiles: string[]
}

export interface MoodboardViewport {
  x: number
  y: number
  zoom: number
}

export interface MoodboardDocument {
  version: 1
  id: string
  title: string
  viewport: MoodboardViewport
  items: MoodboardItem[]
  connectors: MoodboardConnector[]
}
```

### Saving & Performance
- Canvas edits update Zustand state immediately (60 fps dragging/resizing).
- Persistence to `moodboards/<id>.json` is **debounced (500 ms)** and flushed synchronously on window close / board switch (mirroring `settings.flush` in [`App.tsx`](../src/renderer/src/App.tsx)).
- Images are written to `PhotoStore` immediately on drop/paste; removing an Image Card marks the photo for cleanup once the board saves (and startup orphan cleanup checks all `moodboards/*.json` files alongside `bookmarks.json` and `projects.json`).

---

## 6. Bridge with the 3D Globe Module

Two-way integration makes the Moodboard uniquely valuable for PhotoEarth:
1. **Globe → Moodboard ("Snap to Moodboard"):**
   - Button in the Globe's Viewfinder panel (and Command Palette action): captures the current WebGL frame (cropped to the active Viewfinder aspect ratio if Viewfinder is open, or full viewport otherwise) via `canvas.toBlob` after a forced `scene.render()`.
   - Lets you pick the target Moodboard (defaults to the Active Project's primary board, or creates a new one).
   - Attaches camera pose, simulated UTC time, lens/focal length, and heading so the snapshot is not just a flat picture—it's a live 3D bookmark on your canvas.
2. **Moodboard → Globe ("Open in 3D Globe"):**
   - Any **Location Card** or **Globe Snapshot Image Card** has a one-click jump action that switches to the Globe module and restores that exact view and time.

---

## 7. Export & Polish

- **Export Board as PNG/JPG:** Renders the bounding box of all items (or current selection) to an offscreen canvas and saves via Electron's native Save dialog—useful for sharing a lookbook or saving a reference sheet to your phone.
- **Templates:** Optional starter layouts when creating a board (*Blank Canvas*, *3-Column: Lighting / Color / Composition*, *Shot Study*).
- **Keyboard-First Toolbar:** Compact floating bottom toolbar (Select `V`, Note `T`, Group `G`, Connector `C`, Add Image `I`, Fit `F`, Inspiration Browser `B`) matching PhotoEarth's existing dark/light glassmorphic UI aesthetic.
