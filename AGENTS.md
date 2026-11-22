# PhotoEarth — Agent Notes

## Verification Commands
Run after making changes:
```bash
npm run typecheck && npm run lint && npm test && npm run build
```

## Dev Environment & Cesium ion Quota (`PHOTOEARTH_NO_3D_TILES`)
- Photorealistic 3D Tiles are streamed through **Cesium ion** (asset `2275207`), which has a **1,000 root tile requests (sessions) / month** limit on the free Community plan.
- Every Electron launch that opens in Photorealistic 3D mode starts a new session.
- **In git worktrees or UI/non-3D dev sessions**, set `PHOTOEARTH_NO_3D_TILES=1` in the shell environment (or in `.env`, see `.env.example`) before running `npm run dev` so you don't burn Cesium ion sessions unnecessarily.
- 3D Tiles are also lazy-loaded only while the 3D view shows (Map mode closed, Globe module active), so launching in Map mode uses 0 3D Tiles sessions. With `PHOTOEARTH_NO_3D_TILES=1` the 3D view shows the Cesium World Terrain globe instead.
- Note: Do **not** cache `root.json` or session tokens to disk across restarts (prohibited by Google Maps Platform & Cesium ion ToS).

## Architecture Docs
- [docs/modular-architecture.md](docs/modular-architecture.md)
- [docs/projects-hub-module.md](docs/projects-hub-module.md)
- [docs/moodboard-module.md](docs/moodboard-module.md)
