import { MAX_EXAGGERATION, MIN_EXAGGERATION } from '@shared/settings'
import { useAppStore } from '../store/appStore'
import { Icon } from './Icon'
import { LightPollutionSection } from './LightPollution'
import { ViewshedSection } from './ViewshedPanel'

/** Map layers and terrain tools: vertical exaggeration and viewshed (3D view), light pollution (3D view and Map mode). */
export function LayersPanel() {
  const open = useAppStore((s) => s.panels.layers)
  const exaggeration = useAppStore((s) => s.settings.verticalExaggeration)
  const mapOpen = useAppStore((s) => s.settings.map.open)
  const patch = useAppStore((s) => s.patchSettings)
  const togglePanel = useAppStore((s) => s.togglePanel)
  if (!open) return null

  return (
    // on-map: stays visible over Map mode (3D-only panels are hidden there).
    <div className="panel side-panel right on-map">
      <div className="panel-header">
        Layers <span className="spacer" />
        <button className="icon-btn small" title="Close" onClick={() => togglePanel('layers', false)}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="panel-body scroll">
        {!mapOpen && (
          <div className="section">
            <div className="row">
              <span className="grow muted">Vertical exaggeration</span>
              <span className="mono" style={{ color: exaggeration !== 1 ? 'var(--warn)' : undefined }}>
                {exaggeration.toFixed(1)}×
              </span>
            </div>
            <input
              type="range"
              min={MIN_EXAGGERATION}
              max={MAX_EXAGGERATION}
              step={0.1}
              value={exaggeration}
              aria-label="Vertical exaggeration"
              onChange={(ev) => patch((d) => void (d.verticalExaggeration = Number(ev.target.value)))}
            />
          </div>
        )}
        {!mapOpen && <ViewshedSection />}
        <LightPollutionSection />
      </div>
    </div>
  )
}
