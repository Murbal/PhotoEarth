import type { ModuleId } from '@shared/types'
import type { IconName } from '../components/Icon'

export interface ModuleDescriptor {
  id: ModuleId
  label: string
  icon: IconName
}

/**
 * Registered workspace modules shown in the Activity Rail, in shortcut order (Mod+1..9).
 * Phase 1 ships with the 3D Globe; Projects Hub and Moodboards register here in Phases 2 & 3.
 */
export const WORKSPACE_MODULES: readonly ModuleDescriptor[] = [
  { id: 'globe', label: '3D Globe', icon: 'globe' }
]
