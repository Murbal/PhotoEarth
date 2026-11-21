import { describe, expect, it, vi } from 'vitest'
import {
  isGoogleMapsHost,
  MAX_SHORT_LINK_HOPS,
  normalizeShortLink,
  resolveShortLink,
  type ManualRedirectFetch
} from '../../src/main/shortLinks'

const PLACE =
  'https://www.google.com/maps/place/Kleine+Scheidegg/@46.5850,7.9610,15z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d46.5853!4d7.9617'

const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } })

/** A fetch that answers from a table of url → response and records every call. */
function mockFetch(routes: Record<string, () => Response>) {
  return vi.fn<ManualRedirectFetch>(async (url) => {
    const route = routes[url]
    if (!route) throw new Error(`unexpected request to ${url}`)
    return route()
  })
}

describe('normalizeShortLink (input host validation)', () => {
  it.each([
    ['https://maps.app.goo.gl/AbC12_-x', 'https://maps.app.goo.gl/AbC12_-x'],
    ['maps.app.goo.gl/AbC123', 'https://maps.app.goo.gl/AbC123'],
    ['  http://maps.app.goo.gl/AbC123  ', 'https://maps.app.goo.gl/AbC123'],
    ['https://MAPS.APP.GOO.GL/AbC123', 'https://maps.app.goo.gl/AbC123'],
    ['https://maps.app.goo.gl/AbC123?g_st=ic', 'https://maps.app.goo.gl/AbC123?g_st=ic'],
    ['https://maps.app.goo.gl/AbC123#frag', 'https://maps.app.goo.gl/AbC123'],
    ['https://goo.gl/maps/Xyz987/', 'https://goo.gl/maps/Xyz987/'],
    ['goo.gl/maps/Xyz987', 'https://goo.gl/maps/Xyz987']
  ])('accepts %s', (input, expected) => {
    expect(normalizeShortLink(input)).toBe(expected)
  })

  it.each([
    'https://maps.app.goo.gl.evil.com/AbC123',
    'https://evil.com/maps.app.goo.gl/AbC123',
    'https://maps.app.goo.gl@evil.com/AbC123',
    'https://user:pw@maps.app.goo.gl/AbC123',
    'https://maps.app.goo.gl:8443/AbC123',
    'https://maps.app.goo.gl./AbC123',
    'https://app.goo.gl/AbC123',
    'https://www.goo.gl/maps/AbC123',
    'https://goo.gl/AbC123',
    'https://goo.gl/mapsAbC123',
    'https://maps.app.goo.gl/',
    'https://maps.app.goo.gl/a/b',
    'https://maps.app.goo.gl/..%2Fadmin',
    'ftp://maps.app.goo.gl/AbC123',
    'javascript:alert(1)//maps.app.goo.gl/AbC123',
    'https://maps.app.goo.gl/Ab C123',
    `https://maps.app.goo.gl/${'a'.repeat(600)}`,
    'https://www.google.com/maps/@46.5,7.9,15z',
    ''
  ])('rejects %s', (input) => {
    expect(normalizeShortLink(input)).toBeNull()
  })
})

describe('isGoogleMapsHost (redirect target validation)', () => {
  it.each([
    'https://www.google.com/maps/place/X/@1,2,3z',
    'https://google.com/maps?q=1,2',
    'https://www.google.de/maps/@1,2,3z',
    'https://www.google.co.uk/maps',
    'https://www.google.com.au/maps/search/1,2',
    'https://maps.google.com/?q=1,2'
  ])('accepts %s', (url) => {
    expect(isGoogleMapsHost(new URL(url))).toBe(true)
  })

  it.each([
    'http://www.google.com/maps/@1,2,3z',
    'https://www.google.com/search?q=maps',
    'https://www.google.com/mapsfoo',
    'https://consent.google.com/m?continue=https://www.google.com/maps/@1,2,3z',
    'https://google.evil.com/maps/@1,2,3z',
    'https://www.google.com.evil.com/maps/@1,2,3z',
    'https://evilgoogle.com/maps/@1,2,3z',
    'https://www.google.com:8443/maps/@1,2,3z',
    'https://user@www.google.com/maps/@1,2,3z',
    'https://maps.app.goo.gl/AbC123'
  ])('rejects %s', (url) => {
    expect(isGoogleMapsHost(new URL(url))).toBe(false)
  })
})

describe('resolveShortLink', () => {
  it('follows one redirect to a place URL and parses its pin without requesting it', async () => {
    const fetch = mockFetch({ 'https://maps.app.goo.gl/AbC123': () => redirect(PLACE) })
    const res = await resolveShortLink('maps.app.goo.gl/AbC123', { fetch })
    expect(res).toEqual({ ok: true, data: { url: PLACE, location: expect.objectContaining({ latitude: 46.5853, longitude: 7.9617, source: 'url' }) } })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('parses the search-path form that shared pins redirect to', async () => {
    // Shape of a real maps.app.goo.gl answer (November 2026); coordinates and ids made up.
    const target =
      'https://www.google.com/maps/search/46.557700,+7.958600/data=!18m1!1e1?entry=tts&g_ep=EgoyMDI2MTExOC4xIPu8ASoASAFQAw%3D%3D&skid=00000000-0000-4000-8000-000000000000'
    const fetch = mockFetch({ 'https://maps.app.goo.gl/AbC123': () => redirect(target) })
    const res = await resolveShortLink('https://maps.app.goo.gl/AbC123', { fetch })
    expect(res).toEqual({ ok: true, data: { url: target, location: { latitude: 46.5577, longitude: 7.9586, source: 'url' } } })
  })

  it('sends no headers, omits credentials and asks for manual redirects', async () => {
    const fetch = mockFetch({ 'https://maps.app.goo.gl/AbC123': () => redirect(PLACE) })
    await resolveShortLink('https://maps.app.goo.gl/AbC123', { fetch })
    const init = fetch.mock.calls[0][1]
    expect(Object.keys(init).sort()).toEqual(['credentials', 'redirect', 'signal'])
    expect(init).toMatchObject({ redirect: 'manual', credentials: 'omit' })
  })

  it('follows goo.gl/maps through maps.app.goo.gl and keeps the camera parameters', async () => {
    const fetch = mockFetch({
      'https://goo.gl/maps/Xyz987': () => redirect('https://maps.app.goo.gl/Xyz987', 301),
      'https://maps.app.goo.gl/Xyz987': () => redirect('https://www.google.com/maps/@46.5577,7.9586,1200a,35y,90h,70t/data=!3m1!1e3')
    })
    const res = await resolveShortLink('https://goo.gl/maps/Xyz987', { fetch })
    expect(res.ok && res.data.location).toMatchObject({ latitude: 46.5577, longitude: 7.9586, altitude: 1200, heading: 90, tilt: 70 })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('resolves relative redirects against the answering URL', async () => {
    // A maps URL without coordinates is followed further; one with them is final.
    const fetch = mockFetch({
      'https://maps.app.goo.gl/AbC123': () => redirect('https://maps.google.com/?q=Kleine+Scheidegg'),
      'https://maps.google.com/?q=Kleine+Scheidegg': () => redirect('/maps?q=Kleine+Scheidegg'),
      'https://maps.google.com/maps?q=Kleine+Scheidegg': () => redirect('https://www.google.com/maps/@46.585,7.961,15z')
    })
    const res = await resolveShortLink('https://maps.app.goo.gl/AbC123', { fetch })
    expect(res.ok && res.data.location.latitude).toBe(46.585)
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      'https://maps.app.goo.gl/AbC123',
      'https://maps.google.com/?q=Kleine+Scheidegg',
      'https://maps.google.com/maps?q=Kleine+Scheidegg'
    ])
  })

  it('explains a Google Maps URL without coordinates', async () => {
    const fetch = mockFetch({
      'https://maps.app.goo.gl/AbC123': () => redirect('https://maps.google.com/?q=Some+Cafe&ftid=0x1:0x2'),
      'https://maps.google.com/?q=Some+Cafe&ftid=0x1:0x2': () => new Response('<html>', { status: 200 })
    })
    const res = await resolveShortLink('https://maps.app.goo.gl/AbC123', { fetch })
    expect(res).toMatchObject({ ok: false, error: { status: 'error', message: expect.stringMatching(/doesn’t include coordinates/) } })
  })

  it('stops at a consent page instead of requesting it', async () => {
    const fetch = mockFetch({
      'https://maps.app.goo.gl/AbC123': () => redirect('https://www.google.com/maps?q=Some+Cafe'),
      'https://www.google.com/maps?q=Some+Cafe': () => redirect('https://consent.google.com/m?continue=https://www.google.com/maps')
    })
    const res = await resolveShortLink('https://maps.app.goo.gl/AbC123', { fetch })
    expect(res.ok).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([
    'https://evil.example/maps/@46.5,7.9,15z',
    'http://www.google.com/maps/@46.5,7.9,15z',
    'https://www.google.com.evil.example/maps/@46.5,7.9,15z',
    'javascript:alert(1)'
  ])('refuses a redirect to %s without following or parsing it', async (target) => {
    const fetch = mockFetch({ 'https://maps.app.goo.gl/AbC123': () => redirect(target) })
    const res = await resolveShortLink('https://maps.app.goo.gl/AbC123', { fetch })
    expect(res).toMatchObject({ ok: false, error: { message: 'The short link doesn’t lead to Google Maps.' } })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('caps the number of redirects', async () => {
    const fetch = mockFetch({ 'https://maps.app.goo.gl/Loop': () => redirect('https://maps.app.goo.gl/Loop') })
    const res = await resolveShortLink('https://maps.app.goo.gl/Loop', { fetch })
    expect(res).toMatchObject({ ok: false, error: { message: expect.stringMatching(/too many times/) } })
    expect(fetch).toHaveBeenCalledTimes(MAX_SHORT_LINK_HOPS + 1)
  })

  it('caps the length of a redirect location', async () => {
    const fetch = mockFetch({ 'https://maps.app.goo.gl/AbC123': () => redirect(`https://www.google.com/maps/@1,2,3z/${'a'.repeat(5000)}`) })
    const res = await resolveShortLink('https://maps.app.goo.gl/AbC123', { fetch })
    expect(res.ok).toBe(false)
  })

  it('never reads a response body', async () => {
    const cancel = vi.fn(async () => undefined)
    const text = vi.fn()
    const fetch = vi.fn<ManualRedirectFetch>(async () => ({ status: 200, headers: new Headers(), body: { cancel }, text }))
    await resolveShortLink('https://maps.app.goo.gl/AbC123', { fetch })
    expect(cancel).toHaveBeenCalled()
    expect(text).not.toHaveBeenCalled()
  })

  it('reports an unknown or expired link', async () => {
    const fetch = mockFetch({ 'https://maps.app.goo.gl/Gone': () => new Response('', { status: 404 }) })
    const res = await resolveShortLink('https://maps.app.goo.gl/Gone', { fetch })
    expect(res).toMatchObject({ ok: false, error: { status: 'error', message: expect.stringMatching(/doesn’t exist or has expired/) } })
  })

  it('reports being offline when the request fails without a connection', async () => {
    const fetch = vi.fn<ManualRedirectFetch>(async () => {
      throw new Error('net::ERR_INTERNET_DISCONNECTED')
    })
    const offline = await resolveShortLink('https://maps.app.goo.gl/AbC123', { fetch, isOnline: () => false })
    expect(offline).toMatchObject({ ok: false, error: { status: 'offline', message: expect.stringMatching(/offline/) } })
    const online = await resolveShortLink('https://maps.app.goo.gl/AbC123', { fetch, isOnline: () => true })
    expect(online).toMatchObject({ ok: false, error: { status: 'error', message: expect.stringMatching(/Could not reach/) } })
  })

  it('times out the whole chain', async () => {
    const fetch = vi.fn<ManualRedirectFetch>(
      (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
    )
    const res = await resolveShortLink('https://maps.app.goo.gl/AbC123', { fetch, timeoutMs: 20 })
    expect(res).toMatchObject({ ok: false, error: { message: expect.stringMatching(/too long/) } })
  })

  it('makes no request for input that is not a short link', async () => {
    const fetch = vi.fn<ManualRedirectFetch>()
    const res = await resolveShortLink('https://evil.example/maps.app.goo.gl/AbC123', { fetch })
    expect(res.ok).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })
})
