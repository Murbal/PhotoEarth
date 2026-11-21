# Projects Hub Module — Design Specification

> Status: Proposal · Depends on: [Modular Architecture Plan](./modular-architecture.md)

## 1. Purpose & Mental Model

Before this overhaul, PhotoEarth stores saved spots as a flat list of `Bookmark` locations. That works for one-off scouting, but breaks down when planning a multi-day trip, a seasonal series, or a creative concept that spans multiple locations, visual references, and notes.

The **Projects Hub** is the organizational center of PhotoEarth. A **Project** represents a photography endeavor—such as *"Dolomites Autumn 2026"*, *"Urban Fog Night Series"*, or *"Full Moon Behind Transamerica Pyramid"*—and acts as the glue linking:
- **Concept & Creative Brief** (story, visual goals, lighting mood, constraints)
- **Scouting Locations** (references to existing 3D Globe `Bookmark` records)
- **Moodboards** (visual canvases created for or linked to the project)
- **Scratchpad Notes** (free-form ideas, logistics, permits, parking, timing notes)
- *(Future hooks)* Shot Lists, Trip Itineraries, and Gear Packing Lists.

### Key Design Principles
- **Non-destructive linking:** Locations stay in `bookmarks.json` as independent entities. A project stores `locationIds: string[]` (many-to-many). Deleting a project **never** deletes the underlying saved locations; deleting a location cleanly removes its ID from any referencing projects.
- **Active Project context:** Selecting a project can optionally set it as the **Active Project** across the app, so switching to the 3D Globe highlights/filters that project's pins and new bookmarks default to joining it.
- **Zero-friction start:** Creating a project requires only a title; everything else (cover, dates, tags, brief, locations, moodboards) is optional and fills in organically.

---

## 2. Data Model

Stored in `<userData>/projects.json` via the existing `JsonFile` pattern (`version: 1`).

```ts
export type ProjectStatus = 'brainstorming' | 'scouting' | 'ready' | 'shot' | 'archived'

export interface ProjectDateWindow {
  /** ISO calendar date 'YYYY-MM-DD' (date-only, independent of timezone). */
  start: string | null
  end: string | null
  /** Optional free text, e.g. "Late October, first snow" when exact dates aren't fixed yet. */
  label: string
}

export interface ProjectConcept {
  /** Short 1-2 sentence premise or visual goal. */
  summary: string
  /** Lighting / weather mood keywords or prose (e.g. "low-angle fog, blue hour"). */
  lightingMood: string
  /** Optional self-imposed constraints (e.g. "35mm prime only", "square 1:1"). */
  constraints: string
  /** Dominant target hex colors (manually picked or synced from a linked Moodboard). */
  colorStory: string[]
}

export interface ProjectNote {
  id: string
  title: string
  /** Markdown text. */
  body: string
  pinned: boolean
  createdAt: string
  updatedAt: string
}

export interface Project {
  id: string
  title: string
  status: ProjectStatus
  createdAt: string
  updatedAt: string
  /** Optional cover image stored in the shared PhotoStore. */
  coverPhoto: LocationPhoto | null
  /** Lowercase, unique tags (e.g. 'landscape', 'astro', 'italy'). */
  tags: string[]
  dateWindow: ProjectDateWindow
  concept: ProjectConcept
  /** Ordered list of linked Bookmark IDs from bookmarks.json. */
  locationIds: string[]
  /** Ordered list of linked Moodboard IDs from moodboards/index.json. */
  moodboardIds: string[]
  /** Free-form scratchpad / concept cards. */
  notes: ProjectNote[]
}
```

### Referential Integrity Rules (Main Process)
- When `BookmarkStore.remove(locationId)` runs, a coordinator hook calls `ProjectStore.unlinkLocation(locationId)` so no stale IDs remain.
- When `MoodboardStore.remove(boardId)` runs, it calls `ProjectStore.unlinkMoodboard(boardId)`.
- When `ProjectStore.remove(projectId)` runs, linked bookmarks and moodboards remain intact (with an optional UI checkbox: *"Also delete moodboards owned exclusively by this project"*). Its `coverPhoto` is deleted from `PhotoStore` after flushing `projects.json`.

---

## 3. Views & User Experience

### 3.1 Projects Index (Hub Home)
The landing view of the Projects module:
- **Header Bar:**
  - Title + **"New Project"** primary button (`N`).
  - Search input (matches title, tags, concept summary, and linked location names).
  - Status filter pills: *All*, *Brainstorming*, *Scouting*, *Ready*, *Shot*, *Archived* (Archived hidden from *All* by default).
  - Sort dropdown: *Recently updated*, *Target date*, *Name*, *Status*.
- **Project Cards Grid:**
  - 16:9 cover image (uses `coverPhoto`, or falls back to the first linked Moodboard preview / first linked Location photo / subtle gradient).
  - Status badge + target date window chip (e.g. *"Oct 18–24"* or *"Late Autumn"*).
  - Color story strip (if defined—small horizontal swatch bar along the bottom of the cover).
  - Counts footer: `4 spots · 2 boards · 3 notes`.
  - Quick actions on hover: **Set Active**, **Open in Globe**, **Archive**.
- **Empty State:** Friendly onboarding card with 1-click starter templates (*Landscape Trip*, *Astro Alignment*, *Creative Series*, or *Blank Project*).

### 3.2 Project Workspace (Detail View)
Clicking a project opens its dedicated workspace with a persistent top header and sub-navigation tabs:

#### Workspace Header
- Back to Projects breadcrumb.
- Editable title, status dropdown pill, target date window editor, tag editor, and cover photo picker (pick from disk, pick from a linked location's photos, or pick from a linked moodboard).
- Action buttons:
  - **Active Context Toggle** (*"Active Project"* — pins it to the left Activity Rail).
  - **Open in 3D Globe** — switches to the Globe module, enables the project filter, and flies to fit the bounding box of the project's linked locations (or the first location).

#### Sub-Tabs inside a Project

1. **Overview & Brief**
   - Two-column layout:
     - **Left:** Structured **Concept Brief** fields (*Summary / Story*, *Lighting & Atmosphere*, *Creative Constraints*, *Color Story* swatches with "Sync from Moodboard" action) + pinned Scratchpad Notes.
     - **Right:** Quick-access summary cards showing thumbnails of linked **Moodboards** and **Scouting Locations** with `+ Add` shortcuts.
2. **Locations**
   - Grid/list of all `Bookmark` records linked to this project.
   - Each card displays: location thumbnail (or coordinates badge), name, *To Visit / Visited* toggle, `bestTime`, lens/focal length if saved in Viewfinder mode, and tags.
   - Actions per card:
     - **Fly to in Globe** (switches to Globe module and restores camera, mode, time, and viewfinder).
     - **Remove from Project** (unlinks without deleting the bookmark).
   - Top bar actions:
     - **Link Existing Location** (searchable picker of all saved bookmarks).
     - **Scout New Spot** (switches to Globe with this project active so `Ctrl+B` saves straight into it).
3. **Moodboards**
   - Grid of linked moodboard canvases with auto-generated preview thumbnails and item counts.
   - **New Moodboard** creates a board automatically linked to this project and opens it in the Moodboard module.
   - **Link Existing Board** attaches an unlinked or shared board.
4. **Notes & Ideas**
   - Card grid or split-pane list + Markdown editor for concept variations, research links, permit info, or post-shoot reflections.
   - Pin important notes to appear on the **Overview** tab.

---

## 4. Integration with the 3D Globe Module

To make the Projects Hub feel woven into PhotoEarth rather than bolted on:
- **Locations Panel (`LocationsPanel.tsx`):** Add a scope toggle at the top: *All Locations* vs. *Active Project (`<Project Name>`)*. When scoped to a project, both the list and the 3D `LocationMarkers` on the globe filter to that project's spots (with an option to show non-project pins dimmed).
- **Saving a Location (`Ctrl+B`):** When an Active Project is set, the save flow automatically links the new bookmark to the active project (with a one-click toggle to save as unlinked).
- **Command Palette (`Ctrl+K`):** Typing a project name lets you jump straight to its Workspace or fly to its locations in the Globe.

---

## 5. IPC & API Surface

```ts
// Added to PhotoEarthApi in src/shared/types.ts
projects: {
  list(): Promise<Project[]>
  create(input: NewProject): Promise<Project>
  update(id: string, patch: ProjectPatch): Promise<Project | null>
  remove(id: string): Promise<boolean>
  setCoverPhoto(id: string, photo: PhotoUpload): Promise<ProjectPhotoResult>
  clearCoverPhoto(id: string): Promise<Project | null>
  linkLocation(projectId: string, locationId: string): Promise<Project | null>
  unlinkLocation(projectId: string, locationId: string): Promise<Project | null>
  linkMoodboard(projectId: string, moodboardId: string): Promise<Project | null>
  unlinkMoodboard(projectId: string, moodboardId: string): Promise<Project | null>
}
```

All sanitization (string length limits, tag normalization, status enum validation, UUID generation in main process) lives in `src/shared/projects.ts` with full Vitest unit test coverage, mirroring [`src/shared/locations.ts`](../src/shared/locations.ts).

---

## 6. Future Extension Points

The `Project` schema is intentionally designed so later modules attach cleanly without breaking migrations:
- **Shot List tab:** Adds `shots: ShotCard[]` (each referencing a `locationId`, target alignment/viewfinder, and captured photo).
- **Itinerary tab:** Adds `itinerary: ItineraryDay[]` referencing `locationIds` and time windows.
- **Gear Kit tab:** Adds `gearKitId: string | null` referencing the Gear Locker.
- **AI Brainstorming (Optional):** A button in *Overview / Notes* that sends the project's concept brief + tags to a user-configured free-tier Gemini API or local Ollama endpoint to suggest shot ideas or creative constraints.
