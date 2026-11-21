import { describe, expect, it } from 'vitest'
import { classifyGoogleError, classifyIonError } from '@shared/apiErrors'
import { buildAutocompleteBody, parseAutocomplete, parsePlaceDetails } from '@shared/places'
import { DETAIL_SHADOW_RANGE, defaultSettings, sanitizeSettings } from '@shared/settings'

describe('settings sanitization', () => {
  it('returns defaults for garbage', () => {
    expect(sanitizeSettings(undefined)).toEqual(defaultSettings())
    expect(sanitizeSettings('nope')).toEqual(defaultSettings())
    expect(sanitizeSettings({ quality: 7, navigation: [] })).toEqual(defaultSettings())
  })

  it('keeps valid values and clamps or drops invalid ones', () => {
    const s = sanitizeSettings({
      units: 'imperial',
      theme: 'purple',
      verticalExaggeration: 9,
      navigation: { minClearance: -5, inertia: 0.5, scrollGesture: 'sideways' },
      quality: { preset: 'ultra', overrides: { shadowCascades: 2, msaaSamples: 4 } },
      lastCamera: { longitude: 7, latitude: 46, height: 1000, heading: 10, pitch: -20, roll: 0 },
      elevation: { contours: { color: 'red', interval: 20 } },
      extra: true
    })
    expect(s.units).toBe('imperial')
    expect(s.theme).toBe('dark')
    expect(s.verticalExaggeration).toBe(3)
    expect(s.navigation.minClearance).toBe(0.5)
    expect(s.navigation.inertia).toBe(0.5)
    expect(s.navigation.scrollGesture).toBe('auto')
    expect(s.quality.preset).toBe('ultra')
    expect(s.quality.overrides.shadowCascades).toBeNull()
    expect(s.quality.overrides.msaaSamples).toBe(4)
    expect(s.lastCamera?.latitude).toBe(46)
    expect(s.elevation.contours.color).toBe('#ffffff')
    expect(s.elevation.contours.interval).toBe(20)
    expect('extra' in s).toBe(false)
  })

  it('rejects incomplete camera views', () => {
    expect(sanitizeSettings({ lastCamera: { longitude: 7 } }).lastCamera).toBeNull()
  })

  it('clamps the detail shadow range override and keeps 0 as off', () => {
    const range = (v: unknown) => sanitizeSettings({ quality: { overrides: { detailShadowDistance: v } } }).quality.overrides.detailShadowDistance
    expect(range(undefined)).toBeNull()
    expect(range('600')).toBeNull()
    expect(range(Number.NaN)).toBeNull()
    expect(range(0)).toBe(0)
    expect(range(1200)).toBe(1200)
    expect(range(-50)).toBe(0)
    expect(range(1e6)).toBe(DETAIL_SHADOW_RANGE.max)
  })
})

describe('Google error classification', () => {
  const body = (message: string, reason = '', status = '') =>
    JSON.stringify({ error: { message, status, details: [{ reason }] } })

  it.each([
    [400, body('API key not valid. Please pass a valid API key.', 'API_KEY_INVALID', 'INVALID_ARGUMENT'), 'invalid'],
    [403, body('Map Tiles API has not been used in project 123 before or it is disabled.', 'SERVICE_DISABLED'), 'disabled'],
    [429, body('Quota exceeded', '', 'RESOURCE_EXHAUSTED'), 'quota'],
    [403, body('Requests from referer <empty> are blocked.', 'API_KEY_HTTP_REFERRER_BLOCKED'), 'forbidden'],
    [403, body('Requests to this API are blocked.', 'API_KEY_SERVICE_BLOCKED'), 'forbidden'],
    [500, 'oops', 'error']
  ])('HTTP %i → %s', (status, text, expected) => {
    expect(classifyGoogleError('Map Tiles API', status, text).status).toBe(expected)
  })

  it('distinguishes offline from unreachable', () => {
    expect(classifyGoogleError('Map Tiles API', 0, '', false).status).toBe('offline')
    expect(classifyGoogleError('Map Tiles API', undefined, '', true).status).toBe('error')
  })

  it('classifies Cesium ion errors', () => {
    expect(classifyIonError(401, '{"message":"Invalid access token"}').status).toBe('invalid')
    expect(classifyIonError(429, '').status).toBe('quota')
    expect(classifyIonError(404, '').status).toBe('forbidden')
  })
})

describe('Places API (New) payloads', () => {
  it('builds a biased autocomplete request with a session token', () => {
    const body = buildAutocompleteBody('Eiger', 'tok', { latitude: 46.5, longitude: 7.9 })
    expect(body).toEqual({
      input: 'Eiger',
      sessionToken: 'tok',
      locationBias: { circle: { center: { latitude: 46.5, longitude: 7.9 }, radius: 50000 } }
    })
  })

  it('parses suggestions, skipping query predictions', () => {
    const list = parseAutocomplete({
      suggestions: [
        {
          placePrediction: {
            placeId: 'abc',
            text: { text: 'Eiger, Switzerland' },
            structuredFormat: { mainText: { text: 'Eiger' }, secondaryText: { text: 'Switzerland' } }
          }
        },
        { queryPrediction: { text: { text: 'eiger hotels' } } }
      ]
    })
    expect(list).toEqual([{ placeId: 'abc', mainText: 'Eiger', secondaryText: 'Switzerland' }])
  })

  it('parses place details', () => {
    const d = parsePlaceDetails({
      id: 'abc',
      displayName: { text: 'Eiger' },
      formattedAddress: '3818 Grindelwald, Switzerland',
      location: { latitude: 46.5775, longitude: 8.0053 },
      viewport: { low: { latitude: 46.5, longitude: 7.9 }, high: { latitude: 46.6, longitude: 8.1 } }
    })
    expect(d?.name).toBe('Eiger')
    expect(d?.viewport?.high.latitude).toBe(46.6)
    expect(parsePlaceDetails({ id: 'x' })).toBeNull()
  })
})
