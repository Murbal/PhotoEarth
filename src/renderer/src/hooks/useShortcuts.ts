import { useEffect } from 'react'
import { runCommand } from '../commands'
import { getEngine } from '../engine/instance'
import { hasPrimaryModifier } from '../lib/platform'
import { WORKSPACE_MODULES } from '../shell/modules'
import { shellState } from '../shell/shellStore'
import { appState } from '../store/appStore'

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable
}

/**
 * Keyboard shortcuts:
 * - Global (Shell): Mod+1..9 (switch module), Mod+K (command palette), Mod+, (settings), ? (shortcuts), Esc (close modal).
 * - Globe module: active only when `activeModule === 'globe'` and no modal/text input is focused.
 *   WASD / arrows are handled by the camera controller.
 */
export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const sh = shellState()
      const s = appState()
      // ⌘ on macOS, Ctrl elsewhere (Ctrl+K on a Mac is a text-editing key).
      const mod = hasPrimaryModifier(e)
      const key = e.key.toLowerCase()
      if (mod && key === 'k') {
        e.preventDefault()
        sh.set({ paletteOpen: !sh.paletteOpen })
        return
      }
      if (mod && key === ',') {
        e.preventDefault()
        sh.set({ settingsOpen: true })
        return
      }
      if (mod && !e.shiftKey && !e.altKey && key >= '1' && key <= '9') {
        const modIndex = Number(key) - 1
        const targetMod = WORKSPACE_MODULES[modIndex]
        if (targetMod) {
          e.preventDefault()
          sh.setActiveModule(targetMod.id)
          return
        }
      }
      const modal = sh.isModalOpen()
      if (e.key === 'Escape') {
        if (sh.photoViewer) sh.set({ photoViewer: null })
        else if (sh.paletteOpen) sh.set({ paletteOpen: false })
        else if (sh.shortcutsOpen) sh.set({ shortcutsOpen: false })
        else if (sh.settingsOpen) sh.set({ settingsOpen: false })
        else if (sh.activeModule === 'globe') {
          if (s.profile.active) getEngine()?.profile.cancelOrFinish()
          else if (s.alignment.open && s.alignment.pickMode !== null) getEngine()?.alignment.setPickMode(null)
          else if (s.viewshed.picking) getEngine()?.viewshed.setPicking(false)
          else if (s.horizon.open) getEngine()?.horizon.close()
          else if (s.alignment.open) getEngine()?.alignment.close()
          else if (s.inspect) getEngine()?.inspector.clear()
          else if (s.destination) getEngine()?.searchMarker.clear()
          else if (s.viewshed.open) getEngine()?.viewshed.clear()
        }
        return
      }
      if (modal || isTyping(e.target)) return
      if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key === '?') {
        sh.set({ shortcutsOpen: true })
        return
      }

      // Module-scoped shortcuts: Globe only.
      if (sh.activeModule !== 'globe') return

      if (mod && key === 'b') {
        e.preventDefault()
        runCommand('save-bookmark')
        return
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (s.profile.active && (e.key === 'Enter' || e.key === 'Backspace')) {
        e.preventDefault()
        if (e.key === 'Enter') getEngine()?.profile.finish()
        else getEngine()?.profile.undo()
        return
      }
      if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
        e.preventDefault()
        const dir = e.code === 'BracketLeft' ? -1 : 1
        if (e.shiftKey) runCommand(dir < 0 ? 'day-back' : 'day-forward')
        else runCommand(dir < 0 ? 'time-back' : 'time-forward')
        return
      }
      // Focal length steps (viewfinder only): , / . through the presets, with Shift ±5 %.
      if ((e.code === 'Comma' || e.code === 'Period') && s.viewfinder && !s.flyMode) {
        e.preventDefault()
        const longer = e.code === 'Period'
        if (e.shiftKey) runCommand(longer ? 'focal-nudge-up' : 'focal-nudge-down')
        else runCommand(longer ? 'focal-longer' : 'focal-shorter')
        return
      }
      if (e.key === ' ' && s.panels.time && !s.settings.map.open) {
        e.preventDefault()
        runCommand('play-pause')
        return
      }
      if (e.repeat) return
      if (e.shiftKey && key === 'v' && !s.flyMode) {
        e.preventDefault()
        runCommand('viewshed-toggle')
        return
      }
      const map: Record<string, string> = {
        '1': 'mode-photorealistic',
        '2': 'mode-map',
        // Map mode's key before Elevation mode was removed.
        '3': 'mode-map',
        f: 'fly-mode',
        n: 'reset-north',
        u: 'reset-tilt',
        r: 'level-horizon',
        g: 'eye-level',
        p: 'profile-start',
        h: 'horizon-panorama',
        x: 'toggle-alignment',
        t: 'toggle-time-panel',
        l: 'toggle-layers-panel',
        m: 'toggle-place-labels',
        k: 'toggle-light-pollution',
        v: 'toggle-viewfinder',
        '+': 'zoom-in',
        '=': 'zoom-in',
        '-': 'zoom-out'
      }
      const id = map[key]
      // WASD/QE are movement; never steal them here.
      if (id && !s.flyMode) {
        e.preventDefault()
        runCommand(id)
      } else if (id === 'fly-mode') {
        runCommand(id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
