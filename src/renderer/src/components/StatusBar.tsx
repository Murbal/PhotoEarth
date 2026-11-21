import { formatLatitude, formatLongitude } from '@shared/coords'
import { formatAltitude, formatElevation } from '../lib/units'
import { useAppStore } from '../store/appStore'

export function StatusBar({ creditRef }: { creditRef: (el: HTMLDivElement | null) => void }) {
  const cursor = useAppStore((s) => s.cursor)
  const camera = useAppStore((s) => s.camera)
  const scale = useAppStore((s) => s.scale)
  const units = useAppStore((s) => s.settings.units)
  const format = useAppStore((s) => s.settings.coordFormat)
  const patchSettings = useAppStore((s) => s.patchSettings)
  // Map mode (§5.5): no 3D camera on screen, and no elevation under the cursor.
  const mapOpen = useAppStore((s) => s.settings.map.open)
  const toggleFormat = () => patchSettings((d) => void (d.coordFormat = d.coordFormat === 'decimal' ? 'dms' : 'decimal'))
  const toggleUnits = () => patchSettings((d) => void (d.units = d.units === 'metric' ? 'imperial' : 'metric'))

  return (
    <div className="panel statusbar" role="status">
      <span className="item clickable mono" title="Cursor position — click to switch decimal / DMS" onClick={toggleFormat} style={{ minWidth: 230 }}>
        {cursor ? `${formatLatitude(cursor.latitude, format)}  ${formatLongitude(cursor.longitude, format)}` : <span className="faint">—</span>}
      </span>
      {!mapOpen && <span className="item clickable" title="Elevation under the cursor (above sea level) — click to switch units" onClick={toggleUnits}>
        <span className="k">Elev</span>
        <span className="mono">{formatElevation(cursor?.elevation, units)}</span>
      </span>}
      {!mapOpen && <>
      <span className="item" title="Camera altitude above sea level / above ground">
        <span className="k">Cam</span>
        <span className="mono">{formatAltitude(camera?.heightMsl, units)}</span>
        <span className="k">AGL</span>
        <span className="mono">{formatAltitude(camera?.heightAgl, units)}</span>
      </span>
      <span className="item" title="Heading / pitch">
        <span className="k">Hdg</span>
        <span className="mono">{camera ? `${Math.round(camera.heading)}°` : '—'}</span>
        <span className="k">Pitch</span>
        <span className="mono">{camera ? `${Math.round(camera.pitch)}°` : '—'}</span>
      </span>
      </>}
      {scale && (
        <span className="scalebar" title={mapOpen ? 'Scale at the map’s center' : 'Scale at the bottom of the view'}>
          <span>{scale.label}</span>
          <span className="bar" style={{ width: Math.round(scale.pixels) }} />
        </span>
      )}
      <div className="credits" ref={creditRef} />
    </div>
  )
}
