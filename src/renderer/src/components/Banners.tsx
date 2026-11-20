import { runCommand } from '../commands'
import { useAppStore } from '../store/appStore'
import { Icon } from './Icon'

export function Banners() {
  const banners = useAppStore((s) => s.banners)
  const dismiss = useAppStore((s) => s.dismissBanner)
  if (banners.length === 0) return null
  return (
    <div className="banners" aria-live="polite">
      {banners.map((b) => (
        <div key={b.id} className={`panel banner ${b.level}`} role={b.level === 'error' ? 'alert' : 'status'}>
          <Icon name={b.level === 'info' ? 'info' : 'warning'} size={18} style={{ marginTop: 1, flex: 'none' }} />
          <div style={{ flex: 1 }}>
            <div className="title">{b.title}</div>
            <div className="msg">{b.message}</div>
            {b.actions && (
              <div className="actions">
                {b.actions.map((a) => (
                  <button key={a.command} className="btn" onClick={() => runCommand(a.command)}>
                    {a.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="icon-btn small" title="Dismiss" onClick={() => dismiss(b.id)}>
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
