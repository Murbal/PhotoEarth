/**
 * Mouse movement under pointer lock, repaired where the platform reports positions instead of
 * movement.
 *
 * Chromium's pointer lock on Linux moves the cursor back to the window's center whenever it
 * comes within 15 % of an edge, and reports the next move relative to the center. Where that
 * move doesn't take (WSLg: the Windows cursor stays where it is), every later event is the
 * cursor's offset from the center rather than how far the mouse moved, and the view spins.
 * Those offsets are at least 35 % of the window across; a real mouse moves far less between two
 * events. So a delta beyond OFFSET_FRACTION of the window is read as an offset, and the movement
 * is its change from the previous offset. The first offset after ordinary movement (or the lock
 * starting) has nothing to compare with and is dropped.
 */
export const OFFSET_FRACTION = 0.3

export class LockedMouse {
  private offset: { x: number; y: number } | null = null

  /** Pointer lock started or ended: earlier offsets mean nothing now. */
  reset(): void {
    this.offset = null
  }

  /** Movement for one locked mousemove of a `width` × `height` window, or null to ignore it. */
  movement(movementX: number, movementY: number, width: number, height: number): { x: number; y: number } | null {
    // The event of moving the cursor back to the center.
    if (movementX === 0 && movementY === 0) return null
    const isOffset = Math.abs(movementX) > OFFSET_FRACTION * width || Math.abs(movementY) > OFFSET_FRACTION * height
    if (!isOffset) {
      this.offset = null
      return { x: movementX, y: movementY }
    }
    const previous = this.offset
    this.offset = { x: movementX, y: movementY }
    if (!previous) return null
    const x = movementX - previous.x
    const y = movementY - previous.y
    // Still implausibly far: the cursor jumped (left and re-entered the window); skip it.
    if (Math.abs(x) > OFFSET_FRACTION * width || Math.abs(y) > OFFSET_FRACTION * height) return null
    return { x, y }
  }
}
