import { Component, type ErrorInfo, type ReactNode } from 'react'
import { appState } from '../store/appStore'

const describe = (error: unknown) => String((error as Error)?.message ?? error).slice(0, 200)

/**
 * Keeps a bug in one part of the UI from taking the whole window down: React unmounts the entire
 * tree on an uncaught render error, which would leave a blank window over a still-running map.
 * The failed part disappears and a banner offers a reload; everything else keeps working.
 */
export class PartBoundary extends Component<
  {
    name: string
    /** Undoes state the failed part leaves behind, such as an open dialog that makes the rest inert. */
    onCrash?: () => void
    children?: ReactNode
  },
  { failed: boolean }
> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`[photoearth] ${this.props.name} crashed:`, error, info.componentStack)
    this.props.onCrash?.()
    appState().postBanner({
      id: `crash-${this.props.name}`,
      level: 'error',
      title: `${this.props.name} stopped working`,
      message: `It hit an error and was closed (${describe(error)}). Reload the window to get it back; the map, your settings and saved locations are unaffected.`,
      actions: [{ label: 'Reload window', command: 'reload-window' }]
    })
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

/** Last resort around the whole app: a message and a reload button instead of a blank window. */
export class RootBoundary extends Component<{ children?: ReactNode }, { error: unknown }> {
  override state: { error: unknown } = { error: null }

  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error: error ?? new Error('Unknown error') }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[photoearth] The app crashed:', error, info.componentStack)
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="scrim center">
        <div className="panel onboarding" role="alertdialog" aria-label="PhotoEarth hit an error">
          <h1>PhotoEarth hit an error</h1>
          <p>Your settings and saved locations are stored separately and are safe. Reloading the window usually fixes this.</p>
          <p className="mono">{describe(this.state.error)}</p>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
            <button className="btn primary" onClick={() => window.location.reload()}>
              Reload window
            </button>
          </div>
        </div>
      </div>
    )
  }
}
