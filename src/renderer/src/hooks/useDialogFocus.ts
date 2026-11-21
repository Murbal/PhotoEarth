import { useEffect, type RefObject } from 'react'

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

/** Open dialogs, innermost last; only the innermost one keeps focus. */
const stack: HTMLElement[] = []

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0)
}

/**
 * Keeps keyboard focus inside a modal dialog: Tab and Shift+Tab wrap around its controls,
 * focus that lands outside is pulled back, and focus returns to where it was on close.
 * (The rest of the app is also made `inert` while a dialog is open; see App.)
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = ref.current
    if (!root) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    stack.push(root)
    const top = () => stack[stack.length - 1] === root

    if (!root.contains(document.activeElement)) (focusables(root)[0] ?? root).focus()

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !top()) return
      const items = focusables(root)
      if (items.length === 0) {
        e.preventDefault()
        root.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      const inside = root.contains(active)
      if (e.shiftKey && (!inside || active === first || active === root)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (!inside || active === last)) {
        e.preventDefault()
        first.focus()
      }
    }
    const onFocusIn = (e: FocusEvent) => {
      if (top() && e.target instanceof Node && !root.contains(e.target)) (focusables(root)[0] ?? root).focus()
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('focusin', onFocusIn)
      const i = stack.indexOf(root)
      if (i >= 0) stack.splice(i, 1)
      if (previous && previous.isConnected && stack.length === 0) previous.focus({ preventScroll: true })
    }
  }, [ref])
}
