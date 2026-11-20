import type { ApiKeys } from '@shared/types'
import { appState } from '../store/appStore'

/** Persists keys (encrypted in the main process) and hands them to the engine via the store. */
export async function saveKeys(keys: ApiKeys): Promise<void> {
  const secrets = await window.photoearth.keys.set(keys)
  const stored = await window.photoearth.keys.get()
  appState().set({ keys: stored, secrets })
}
