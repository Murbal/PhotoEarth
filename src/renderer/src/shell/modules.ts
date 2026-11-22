import type { ModuleId } from '@shared/types'
import type { IconName } from '../components/Icon'

export interface ModuleDescriptor {
  id: ModuleId
  label: string
  icon: IconName
}

/**
 * Registered workspace modules shown in the Activity Rail, in shortcut order (Mod+1..9).
 * Projects Hub (`Mod+1`), 3D Globe (`Mod+2`), and Moodboards (`Mod+3`).
 */
export const WORKSPACE_MODULES: readonly ModuleDescriptor[] = [
  { id: 'projects', label: 'Projects Hub', icon: 'projects' },
  { id: 'globe', label: '3D Globe', icon: 'globe' },
  { id: 'moodboard', label: 'Moodboards', icon: 'moodboard' }
]
