import { useState } from 'react'
import type { ApiCheck, ApiKeys, ValidationResult } from '@shared/types'

const STATUS: Record<ApiCheck['status'], { label: string; cls: string }> = {
  ok: { label: 'Working', cls: 'ok' },
  missing: { label: 'No key', cls: '' },
  invalid: { label: 'Invalid', cls: 'error' },
  disabled: { label: 'Not enabled', cls: 'error' },
  quota: { label: 'Quota exceeded', cls: 'warn' },
  offline: { label: 'Offline', cls: 'warn' },
  forbidden: { label: 'Blocked', cls: 'error' },
  error: { label: 'Error', cls: 'error' }
}

function Check({ name, check }: { name: string; check?: ApiCheck }) {
  if (!check) return <span className="badge">{name}</span>
  const s = STATUS[check.status]
  return (
    <span className={`badge ${s.cls}`} title={check.message}>
      {check.status === 'ok' ? '✓' : check.status === 'missing' ? '–' : '!'} {name}: {s.label}
    </span>
  )
}

function Secret({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder: string }) {
  const [reveal, setReveal] = useState(false)
  return (
    <div className="row">
      <input
        className="input grow mono"
        type={reveal ? 'text' : 'password'}
        value={value}
        placeholder={placeholder}
        aria-label={label}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
      <button type="button" className="btn ghost" onClick={() => setReveal((r) => !r)}>
        {reveal ? 'Hide' : 'Show'}
      </button>
    </div>
  )
}

export interface KeyFieldsState {
  keys: ApiKeys
  result: ValidationResult | null
  validating: boolean
}

export function useKeyFields(initial: ApiKeys) {
  const [keys, setKeys] = useState<ApiKeys>({ ...initial })
  const [result, setResult] = useState<ValidationResult | null>(null)
  const [validating, setValidating] = useState(false)
  const validate = async (): Promise<ValidationResult> => {
    setValidating(true)
    try {
      const r = await window.photoearth.keys.validate(keys)
      setResult(r)
      return r
    } finally {
      setValidating(false)
    }
  }
  return { keys, setKeys, result, setResult, validating, validate }
}

export function KeyFields({
  keys,
  setKeys,
  result,
  referer
}: {
  keys: ApiKeys
  setKeys: (k: ApiKeys) => void
  result: ValidationResult | null
  referer: string
}) {
  return (
    <div>
      <div className="key-field">
        <div className="row" style={{ minHeight: 0 }}>
          <strong className="grow">Google Maps Platform API key</strong>
          <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">
            Get a key
          </a>
        </div>
        <Secret
          label="Google Maps Platform API key"
          value={keys.googleApiKey ?? ''}
          placeholder="AIza…"
          onChange={(v) => setKeys({ ...keys, googleApiKey: v || null })}
        />
        <div className="checks">
          <Check name="Map Tiles API" check={result?.mapTiles} />
          <Check name="Places API (New)" check={result?.places} />
        </div>
        {result && result.mapTiles.status !== 'ok' && result.mapTiles.status !== 'missing' && (
          <div className="small muted">{result.mapTiles.message}</div>
        )}
        {result && result.places.status !== 'ok' && result.places.status !== 'missing' && (
          <div className="small muted">{result.places.message}</div>
        )}
        <div className="small faint">
          Enable{' '}
          <a href="https://console.cloud.google.com/apis/library/tile.googleapis.com" target="_blank" rel="noreferrer">
            Map Tiles API
          </a>{' '}
          and{' '}
          <a href="https://console.cloud.google.com/apis/library/places.googleapis.com" target="_blank" rel="noreferrer">
            Places API (New)
          </a>
          . Tile requests carry the key, so restrict it <em>by API</em> to those two. If you restrict by HTTP referrer
          instead, allow <span className="mono">{referer}*</span>.
        </div>
      </div>
      <div className="key-field">
        <div className="row" style={{ minHeight: 0 }}>
          <strong className="grow">Cesium ion access token</strong>
          <a href="https://ion.cesium.com/tokens" target="_blank" rel="noreferrer">
            Get a token
          </a>
        </div>
        <Secret
          label="Cesium ion access token"
          value={keys.cesiumIonToken ?? ''}
          placeholder="eyJhbGciOi…"
          onChange={(v) => setKeys({ ...keys, cesiumIonToken: v || null })}
        />
        <div className="checks">
          <Check name="Cesium World Terrain" check={result?.ion} />
        </div>
        {result && result.ion.status !== 'ok' && result.ion.status !== 'missing' && <div className="small muted">{result.ion.message}</div>}
        <div className="small faint">Powers Elevation mode (contours, tint, slope, hillshade), profiles and the terrain shadow overlay. The free tier has usage limits.</div>
      </div>
    </div>
  )
}
