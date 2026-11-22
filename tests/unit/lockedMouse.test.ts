import { describe, expect, it } from 'vitest'
import { LockedMouse } from '@renderer/lib/lockedMouse'

const W = 1440
const H = 900

describe('mouse movement under pointer lock', () => {
  it('passes ordinary movement through and ignores the recentering events', () => {
    const m = new LockedMouse()
    expect(m.movement(-3, 0, W, H)).toEqual({ x: -3, y: 0 })
    expect(m.movement(12, -7, W, H)).toEqual({ x: 12, y: -7 })
    expect(m.movement(0, 0, W, H)).toBeNull()
  })

  it('reads offsets from the center as positions when the recentering does not take (WSLg)', () => {
    const m = new LockedMouse()
    // Measured in WSLg: the cursor sat by the right edge and moved 3 px left per event.
    const events = [[0, 0], [645, 0], [0, 0], [642, 0], [0, 0], [639, 0], [636, 0], [0, 0], [633, 0]]
    const moves = events.map(([x, y]) => m.movement(x, y, W, H)).filter(Boolean)
    // The first offset has nothing to compare with; then each step is the real 3 px left.
    expect(moves).toEqual([{ x: -3, y: 0 }, { x: -3, y: 0 }, { x: -3, y: 0 }, { x: -3, y: 0 }])
    const total = moves.reduce((s, v) => s + v!.x, 0)
    expect(total).toBe(-12)
  })

  it('drops the jump when the lock starts away from the center', () => {
    const m = new LockedMouse()
    // Measured: the first event after locking was the cursor's offset from the center.
    expect(m.movement(149, 292, W, H)).toBeNull()
    expect(m.movement(5, 0, W, H)).toEqual({ x: 5, y: 0 })
  })

  it('starts over after a reset, and skips an offset that jumps', () => {
    const m = new LockedMouse()
    m.movement(600, 0, W, H)
    m.reset()
    expect(m.movement(597, 0, W, H)).toBeNull()
    // Left the window on one side and came back on the other.
    expect(m.movement(-600, 0, W, H)).toBeNull()
    expect(m.movement(-596, 0, W, H)).toEqual({ x: 4, y: 0 })
  })
})
