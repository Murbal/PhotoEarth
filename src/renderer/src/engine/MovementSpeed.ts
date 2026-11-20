/**
 * Keyboard movement speed scales with the camera's clearance: how far it is from the nearest
 * surface that matters (the ground below, and whatever lies ahead in the direction of travel).
 *
 * Raw clearance is noisy: the ground below jumps at cliff edges, trees and bridges, and is
 * briefly unknown while tiles stream. So the reference distance is smoothed in log space
 * (speed changes by ratios, so a 10× jump eases in like a 2× one does, only longer), falls
 * fast (slow down promptly near an obstacle) and rises slowly (no sudden surge past a cliff
 * edge), and holds its last value while no measurement is available.
 */

/** Time constants (seconds) for the reference distance falling and rising. */
export const FALL_SECONDS = 0.15
export const RISE_SECONDS = 0.6
/** Speed (m/s) per meter of clearance, and its limits. */
export const SPEED_PER_METER = 1.1
export const MIN_SPEED = 4
export const MAX_SPEED = 4.0e6

export class MovementSpeed {
  private reference: number | null = null

  /** Clears the history (a new movement starts from its first measurement). */
  reset(): void {
    this.reference = null
  }

  /**
   * Feeds one measurement (meters; null when unknown) after `dt` seconds and returns the
   * smoothed reference distance, or null while there has been no measurement at all.
   */
  update(clearance: number | null, dt: number): number | null {
    if (clearance === null || !Number.isFinite(clearance)) return this.reference
    const target = Math.max(1, clearance)
    if (this.reference === null) {
      this.reference = target
      return target
    }
    const tau = target < this.reference ? FALL_SECONDS : RISE_SECONDS
    const a = 1 - Math.exp(-Math.max(0, dt) / tau)
    this.reference = Math.exp(Math.log(this.reference) + (Math.log(target) - Math.log(this.reference)) * a)
    return this.reference
  }

  /** Speed (m/s) for a reference distance. */
  static speedFor(reference: number): number {
    return Math.min(MAX_SPEED, Math.max(MIN_SPEED, reference * SPEED_PER_METER))
  }
}
