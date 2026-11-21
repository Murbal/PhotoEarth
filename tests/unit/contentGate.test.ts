import { Event, type Scene } from 'cesium'
import { describe, expect, it } from 'vitest'
import { ContentGate } from '@renderer/engine/ContentGate'

function fakeScene(): { scene: Scene; frame: () => void } {
  const postRender = new Event()
  return { scene: { postRender } as unknown as Scene, frame: () => postRender.raiseEvent() }
}

const settled = () => new Promise((r) => setTimeout(r, 0))

describe('tile content turns', () => {
  it('lets everything through at once while the camera rests', async () => {
    const { scene } = fakeScene()
    const gate = new ContentGate(scene)
    let done = 0
    for (let i = 0; i < 5; i++) void gate.acquire().then(() => done++)
    await settled()
    expect(done).toBe(5)
  })

  it('hands out one turn per rendered frame while the camera moves, then the rest on stopping', async () => {
    const { scene, frame } = fakeScene()
    const gate = new ContentGate(scene)
    gate.setMoving(true)
    let done = 0
    for (let i = 0; i < 4; i++) void gate.acquire().then(() => done++)
    await settled()
    expect(done).toBe(0)
    frame()
    await settled()
    expect(done).toBe(1)
    frame()
    await settled()
    expect(done).toBe(2)
    gate.setMoving(false)
    await settled()
    expect(done).toBe(4)
  })
})
