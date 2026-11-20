import type { ApiCheck } from './types'

/** Extracts the useful bits from a Google API error body (JSON or text). */
function parseGoogleError(body: string): { message: string; reasons: string[]; status: string } {
  try {
    const json = JSON.parse(body) as {
      error?: { message?: string; status?: string; details?: Array<{ reason?: string }> }
    }
    const err = json.error ?? {}
    return {
      message: err.message ?? '',
      status: err.status ?? '',
      reasons: (err.details ?? []).map((d) => d.reason ?? '').filter(Boolean)
    }
  } catch {
    return { message: body.slice(0, 300), reasons: [], status: '' }
  }
}

/**
 * Turns a failed Google Maps Platform response into a user-facing check result.
 * `httpStatus` 0 / undefined means the request never reached the server.
 */
export function classifyGoogleError(
  api: string,
  httpStatus: number | undefined,
  body: string,
  online = true
): ApiCheck {
  if (!httpStatus) {
    return online
      ? { status: 'error', message: `Could not reach the ${api}. Check your connection or firewall.` }
      : { status: 'offline', message: `You appear to be offline. The ${api} can't be reached.` }
  }
  const { message, reasons, status } = parseGoogleError(body)
  const text = `${message} ${reasons.join(' ')} ${status}`
  if (httpStatus === 429 || /RESOURCE_EXHAUSTED|RATE_LIMIT|quota/i.test(text)) {
    return { status: 'quota', message: `${api} quota exceeded. Try again later or raise the quota in Google Cloud Console.` }
  }
  if (/API_KEY_INVALID|API key not valid|API key expired/i.test(text)) {
    return { status: 'invalid', message: 'The Google API key is not valid.' }
  }
  if (/SERVICE_DISABLED|has not been used|is disabled|not enabled/i.test(text)) {
    return { status: 'disabled', message: `The ${api} is not enabled for this key's project. Enable it in Google Cloud Console.` }
  }
  if (/BILLING/i.test(text)) {
    return { status: 'forbidden', message: `Billing is not enabled for this key's project, which the ${api} requires.` }
  }
  if (/REFERRER|referer/i.test(text)) {
    return {
      status: 'forbidden',
      message: 'The key rejects this app’s referrer. Restrict the key by API instead, or allow PhotoEarth’s referrer.'
    }
  }
  if (/API_KEY_SERVICE_BLOCKED|blocked/i.test(text)) {
    return { status: 'forbidden', message: `This key is restricted and may not call the ${api}. Add it to the key's API restrictions.` }
  }
  if (httpStatus === 400) return { status: 'invalid', message: message || `The ${api} rejected the request.` }
  if (httpStatus === 401 || httpStatus === 403) {
    return { status: 'forbidden', message: message || `Access to the ${api} was denied.` }
  }
  return { status: 'error', message: message || `The ${api} returned HTTP ${httpStatus}.` }
}

export function classifyIonError(httpStatus: number | undefined, body: string, online = true): ApiCheck {
  if (!httpStatus) {
    return online
      ? { status: 'error', message: 'Could not reach Cesium ion. Check your connection or firewall.' }
      : { status: 'offline', message: 'You appear to be offline. Cesium ion can’t be reached.' }
  }
  let message: string
  try {
    message = (JSON.parse(body) as { message?: string }).message ?? ''
  } catch {
    message = body.slice(0, 200)
  }
  if (httpStatus === 401) return { status: 'invalid', message: 'The Cesium ion access token is not valid.' }
  if (httpStatus === 429 || /quota|limit|exceeded/i.test(message)) {
    return { status: 'quota', message: 'Cesium ion usage limit reached for this account. Terrain is unavailable until it resets.' }
  }
  if (httpStatus === 403 || httpStatus === 404) {
    return {
      status: 'forbidden',
      message: 'This Cesium ion token can’t access Cesium World Terrain (asset 1). Add the asset to your account or use a token with access.'
    }
  }
  return { status: 'error', message: message || `Cesium ion returned HTTP ${httpStatus}.` }
}

export const OK: ApiCheck = { status: 'ok', message: 'Working' }
export const MISSING: ApiCheck = { status: 'missing', message: 'No key provided' }
