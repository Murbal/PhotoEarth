import type { Engine } from './Engine'

let current: Engine | null = null

export function setEngine(engine: Engine | null): void {
  current = engine
}

export function getEngine(): Engine | null {
  return current
}
