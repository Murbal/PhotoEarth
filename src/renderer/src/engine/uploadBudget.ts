import type { Scene } from 'cesium'

/**
 * Milliseconds per frame Cesium may spend turning newly loaded tiles into GPU resources, per
 * job type: textures, shader programs, buffers. Cesium's defaults let one frame spend up to
 * 50 ms on uploads when a burst of tiles arrives, which shows as a hitch while the camera
 * moves. Each type still makes progress every frame (Cesium runs at least one job of each).
 */
const MOVING_BUDGETS_MS: readonly [number, number, number] = [2, 2, 2]
const CESIUM_DEFAULT_BUDGETS_MS: readonly [number, number, number] = [10, 10, 30]

interface JobSchedulerInternals {
  _budgets?: Array<{ _total: number }>
  _totalBudget?: number
}

/** Tight upload budgets while the camera moves, Cesium's defaults (fast loading) at rest. */
export function setUploadBudgets(scene: Scene, moving: boolean): void {
  const scheduler = (scene as unknown as { _jobScheduler?: JobSchedulerInternals })._jobScheduler
  const budgets = scheduler?._budgets
  if (!scheduler || !budgets || budgets.length !== 3) return
  const totals = moving ? MOVING_BUDGETS_MS : CESIUM_DEFAULT_BUDGETS_MS
  budgets.forEach((budget, i) => {
    budget._total = totals[i]
  })
  scheduler._totalBudget = totals[0] + totals[1] + totals[2]
}
