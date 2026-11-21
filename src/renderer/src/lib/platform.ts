// Platform-specific shortcut handling and labels. macOS uses ⌘ where other platforms use Ctrl.

function detectMac(): boolean {
  if (typeof navigator === 'undefined') return false
  const uaPlatform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
  return /mac/i.test(uaPlatform || navigator.platform || navigator.userAgent)
}

export const isMac = detectMac()

/** The platform's primary shortcut modifier is held (⌘ on macOS, Ctrl elsewhere). */
export function hasPrimaryModifier(e: { ctrlKey: boolean; metaKey: boolean }, mac = isMac): boolean {
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
}

const MAC_SYMBOLS: Record<string, string> = { Mod: '⌘', Ctrl: '⌃', Shift: '⇧', Alt: '⌥' }

/**
 * Display form of a shortcut written as "Mod+K", "Shift+[" or "Mod+,": "⌘K" / "⇧[" on macOS,
 * "Ctrl+K" / "Shift+[" elsewhere.
 */
export function shortcutLabel(keys: string, mac = isMac): string {
  const parts = keys.split(/\+(?=.)/)
  if (mac) return parts.map((p) => MAC_SYMBOLS[p] ?? p).join('')
  return parts.map((p) => (p === 'Mod' ? 'Ctrl' : p)).join('+')
}
