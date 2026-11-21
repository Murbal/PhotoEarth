import { useEffect } from 'react'
import { runCommand } from '../commands'
import { getEngine } from '../engine/instance'
import { hasPrimaryModifier } from '../lib/platform'
import { appState } from '../store/appStore'

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable
}

/** App-wide keyboard shortcuts (§6.2). WASD / arrows are handled by the camera controller. */
export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = appState()
      // ⌘ on macOS, Ctrl elsewhere (Ctrl+K on a Mac is a text-editing key).
      const mod = hasPrimaryModifier(e)
      const key = e.key.toLowerCase()
      if (mod && key === 'k') {
        e.preventDefault()
        s.set({ paletteOpen: !s.paletteOpen })
        return
      }
      if (mod && key === ',') {
        e.preventDefault()
        s.set({ settingsOpen: true })
        return
      }
      const modal = s.paletteOpen || s.settingsOpen || s.onboardingOpen || s.shortcutsOpen
      if (e.key === 'Escape') {
        if (s.paletteOpen) s.set({ paletteOpen: false })
        else if (s.shortcutsOpen) s.set({ shortcutsOpen: false })
        else if (s.settingsOpen) s.set({ settingsOpen: false })
        else if (s.profile.active) getEngine()?.profile.cancelOrFinish()
        else if (s.horizon.open) getEngine()?.horizon.close()
        else if (s.inspect) getEngine()?.inspector.clear()
        else if (s.destination) getEngine()?.searchMarker.clear()
        return
      }
      if (modal || isTyping(e.target)) return
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
      if (e.key === '?') {
        s.set({ shortcutsOpen: true })
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
      if (e.key === ' ' && s.panels.time) {
        e.preventDefault()
        runCommand('play-pause')
        return
      }
      if (e.repeat) return
      const map: Record<string, string> = {
        '1': 'mode-photorealistic',
        '2': 'mode-elevation',
        f: 'fly-mode',
        n: 'reset-north',
        u: 'reset-tilt',
        r: 'level-horizon',
        g: 'eye-level',
        p: 'profile-start',
        h: 'horizon-panorama',
        t: 'toggle-time-panel',
        l: 'toggle-elevation-panel',
        m: 'toggle-place-labels',
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
