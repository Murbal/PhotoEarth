import { MAX_EXAGGERATION, MIN_EXAGGERATION } from '@shared/settings'
import { useAppStore } from '../store/appStore'
import { Icon } from './Icon'
import { LightPollutionSection } from './LightPollution'
import { ViewshedSection } from './ViewshedPanel'

/** Map layers and terrain tools: vertical exaggeration, viewshed and light pollution. */
export function LayersPanel() {
  const open = useAppStore((s) => s.panels.layers)
  const exaggeration = useAppStore((s) => s.settings.verticalExaggeration)
  const patch = useAppStore((s) => s.patchSettings)
  const togglePanel = useAppStore((s) => s.togglePanel)
  if (!open) return null

  return (
    <div className="panel side-panel right">
      <div className="panel-header">
        Layers <span className="spacer" />
        <button className="icon-btn small" title="Close" onClick={() => togglePanel('layers', false)}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="panel-body scroll">
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
        <ViewshedSection />
        <LightPollutionSection />
      </div>
    </div>
  )
}
