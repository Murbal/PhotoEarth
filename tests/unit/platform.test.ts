import { describe, expect, it } from 'vitest'
import { hasPrimaryModifier, shortcutLabel } from '@renderer/lib/platform'

describe('platform shortcuts', () => {
  it('labels shortcuts with macOS symbols', () => {
    expect(shortcutLabel('Mod+K', true)).toBe('⌘K')
    expect(shortcutLabel('Mod+,', true)).toBe('⌘,')
    expect(shortcutLabel('Shift+[', true)).toBe('⇧[')
    expect(shortcutLabel('Shift+[ / ]', true)).toBe('⇧[ / ]')
  })

  it('labels shortcuts with Ctrl elsewhere', () => {
    expect(shortcutLabel('Mod+K', false)).toBe('Ctrl+K')
    expect(shortcutLabel('Mod+,', false)).toBe('Ctrl+,')
    expect(shortcutLabel('Shift+]', false)).toBe('Shift+]')
  })

  it('uses ⌘ as the primary modifier on macOS and Ctrl elsewhere', () => {
    expect(hasPrimaryModifier({ metaKey: true, ctrlKey: false }, true)).toBe(true)
    expect(hasPrimaryModifier({ metaKey: false, ctrlKey: true }, true)).toBe(false)
    expect(hasPrimaryModifier({ metaKey: false, ctrlKey: true }, false)).toBe(true)
    expect(hasPrimaryModifier({ metaKey: true, ctrlKey: false }, false)).toBe(false)
  })
})
