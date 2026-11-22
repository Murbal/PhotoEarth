import { useRef } from 'react'
import type { ApiKeys, ValidationResult } from '@shared/types'
import { useAppInfo } from '../hooks/useAppInfo'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { saveKeys } from '../lib/keys'
import { useShellStore } from '../shell/shellStore'
import { useAppStore } from '../store/appStore'
import { KeyFields, useKeyFields } from './KeyFields'

export function Onboarding() {
  const open = useShellStore((s) => s.onboardingOpen)
  return open ? <OnboardingDialog /> : null
}

function OnboardingDialog() {
  const initial = useAppStore((s) => s.keys)
  const secrets = useAppStore((s) => s.secrets)
  const setShell = useShellStore((s) => s.set)
  const patchSettings = useAppStore((s) => s.patchSettings)
  const info = useAppInfo()
  const { keys, setKeys, result, validating, validate } = useKeyFields(initial)
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef)

  const finish = async () => {
    await saveKeys(keys)
    patchSettings((d) => void (d.onboardingComplete = true))
    setShell({ onboardingOpen: false })
  }

  // Stays open when a check fails, so the reason under the field can be read and the key fixed.
  const validateAndStart = async () => {
    if (!keysFailed(await validate(), keys)) await finish()
  }
  const failed = result !== null && keysFailed(result, keys)

  return (
    <div className="scrim center">
      <div ref={dialogRef} tabIndex={-1} className="panel onboarding" role="dialog" aria-modal="true" aria-label="Welcome to PhotoEarth">
        <h1>Welcome to PhotoEarth</h1>
        <p>
          Scout photo locations on a photorealistic 3D globe: read the terrain, then simulate the sun for any date and time to see
          where light and shadow fall.
        </p>
        <p>
          PhotoEarth uses your own keys. <strong>Google Maps Platform</strong> provides the 2D maps and place search.{' '}
          <strong>Cesium ion</strong> streams the photorealistic 3D tiles and provides the elevation data for profiles, the horizon
          panorama and viewshed. Both have free tiers.
        </p>
        {secrets?.memoryOnly && (
          <div className="notice">
            No system keyring is available ({secrets.backend}), so keys can’t be stored encrypted. They’ll be kept for this session
            only, never written to disk in plaintext.
          </div>
        )}
        <KeyFields keys={keys} setKeys={setKeys} result={result} referer={info?.googleReferer ?? ''} />
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
          <button className="btn ghost" onClick={() => void finish()}>
            {failed ? 'Start anyway' : keys.googleApiKey || keys.cesiumIonToken ? 'Continue without checking' : 'Skip for now'}
          </button>
          <button className="btn" disabled={validating || (!keys.googleApiKey && !keys.cesiumIonToken)} onClick={() => void validate()}>
            {validating ? 'Checking…' : 'Validate'}
          </button>
          <button
            className="btn primary"
            disabled={validating || (!keys.googleApiKey && !keys.cesiumIonToken)}
            onClick={() => void validateAndStart()}
          >
            Validate & start
          </button>
        </div>
      </div>
    </div>
  )
}

/** Whether any entered key failed its check (a key left empty is skipped, not failed). */
function keysFailed(result: ValidationResult, keys: ApiKeys): boolean {
  const google = !!keys.googleApiKey?.trim()
  const ion = !!keys.cesiumIonToken?.trim()
  return (google && (result.mapTiles.status !== 'ok' || result.places.status !== 'ok')) || (ion && result.ion.status !== 'ok')
}
