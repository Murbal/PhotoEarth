import { formatLatLon } from '@shared/coords'
import { photoUrl, thumbFile } from '@shared/locations'
import type { Bookmark } from '@shared/types'
import { Icon } from '../../../components/Icon'
import { formatFocal } from '../../../lib/lens'
import { flyToProjectLocation } from '../../../lib/projects'
import { useAppStore } from '../../../store/appStore'

export function LocationCard({
  bookmark
}: {
  bookmark: Bookmark | undefined
}) {
  const coordFormat = useAppStore((s) => s.settings.coordFormat)

  if (!bookmark) {
    return (
      <div className="mb-location-card missing">
        <div className="mb-location-missing">
          <Icon name="pin" size={18} />
          <strong>Location removed</strong>
          <span className="small muted">This saved spot no longer exists in Saved Locations.</span>
        </div>
      </div>
    )
  }

  const photo = bookmark.photos[0]
  const jumpToGlobe = () => void flyToProjectLocation(bookmark)

  return (
    <div
      className="mb-location-card"
      onDoubleClick={(e) => {
        e.stopPropagation()
        jumpToGlobe()
      }}
    >
      <div className="mb-location-thumb">
        {photo ? (
          <img src={photoUrl(thumbFile(photo))} alt={bookmark.name} draggable={false} decoding="async" />
        ) : (
          <div className="mb-location-thumb-empty">
            <Icon name="pin" size={22} />
          </div>
        )}
        <span className={`mb-loc-status ${bookmark.status}`}>
          <span className={`status-dot ${bookmark.status}`} />
          {bookmark.status === 'visited' ? 'Visited' : 'To visit'}
        </span>
        {bookmark.viewfinder && (
          <span className="mb-loc-lens mono">{formatFocal(bookmark.viewfinder.focalLength)}</span>
        )}
      </div>

      <div className="mb-location-body">
        <div className="mb-location-name truncate" title={bookmark.name}>
          {bookmark.name}
        </div>
        <div className="mb-location-coords mono">
          {formatLatLon(bookmark.position.latitude, bookmark.position.longitude, coordFormat)}
        </div>
        {bookmark.bestTime && (
          <div className="mb-location-best small muted truncate" title={bookmark.bestTime}>
            <Icon name="sun" size={11} /> {bookmark.bestTime}
          </div>
        )}
        <button
          type="button"
          className="btn small mb-location-fly"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={jumpToGlobe}
        >
          <Icon name="globe" size={12} /> Open in 3D Globe
        </button>
      </div>
    </div>
  )
}
