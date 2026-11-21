import { describe, expect, it } from 'vitest'
import {
  coordinateProblem,
  formatLatLon,
  isShortMapsLink,
  parseCoordinatePair,
  parseGoogleMapsUrl,
  parseLocationInput
} from '@shared/coords'

const close = (a: number | undefined, b: number, eps = 1e-4) => expect(Math.abs((a ?? NaN) - b)).toBeLessThan(eps)

describe('decimal degrees', () => {
  it.each([
    ['46.5577, 7.9586', 46.5577, 7.9586],
    ['46.5577 7.9586', 46.5577, 7.9586],
    ['-33.8688, 151.2093', -33.8688, 151.2093],
    ['46.5577° N, 7.9586° E', 46.5577, 7.9586],
    ['46.5577N 7.9586E', 46.5577, 7.9586],
    ['N 46.5577 E 7.9586', 46.5577, 7.9586],
    ['33.86 S 151.21 E', -33.86, 151.21],
    ['37.7456, -119.5936', 37.7456, -119.5936],
    ['7.9586 E, 46.5577 N', 46.5577, 7.9586],
    ['46;7', 46, 7]
  ])('parses %s', (input, lat, lon) => {
    const p = parseCoordinatePair(input)
    close(p?.latitude, lat)
    close(p?.longitude, lon)
    expect(p?.source).toBe('decimal')
  })

  it.each(['91, 0', '0, 181', 'hello', '46.5', '46.5 N 7.9 N', ''])('rejects %s', (input) => {
    expect(parseCoordinatePair(input)).toBeNull()
  })
})

describe('DMS / DDM', () => {
  it.each([
    [`46°33'27.7"N 7°57'31.0"E`, 46.557694, 7.958611],
    [`46° 33' 27.7" N, 7° 57' 31.0" E`, 46.557694, 7.958611],
    ['46°33′27.7″N 7°57′31.0″E', 46.557694, 7.958611],
    ['46 33 27.7 N 7 57 31 E', 46.557694, 7.958611],
    [`N 46° 33.462' E 7° 57.517'`, 46.5577, 7.958617],
    [`33°51'54"S 151°12'35"E`, -33.865, 151.209722],
    [`37°44'44"N 119°35'37"W`, 37.745556, -119.593611]
  ])('parses %s', (input, lat, lon) => {
    const p = parseCoordinatePair(input)
    close(p?.latitude, lat)
    close(p?.longitude, lon)
    expect(p?.source).toBe('dms')
  })

  it('rejects minutes ≥ 60', () => {
    expect(parseCoordinatePair(`46°75'N 7°57'E`)).toBeNull()
  })
})

describe('Google Maps URLs', () => {
  it('parses map views with zoom', () => {
    const p = parseGoogleMapsUrl('https://www.google.com/maps/@46.5577,7.9586,14z')
    close(p?.latitude, 46.5577)
    close(p?.longitude, 7.9586)
    expect(p?.range).toBeGreaterThan(3000)
    expect(p?.range).toBeLessThan(15000)
  })

  it('parses 3D views with altitude, heading and tilt', () => {
    const p = parseGoogleMapsUrl('https://www.google.com/maps/@46.5577,7.9586,2745a,35y,39.5h,76.6t/data=!3m1!1e3')
    expect(p?.altitude).toBe(2745)
    expect(p?.heading).toBe(39.5)
    expect(p?.tilt).toBe(76.6)
  })

  it('prefers the exact place pin', () => {
    const p = parseGoogleMapsUrl(
      'https://www.google.com/maps/place/Eiger/@46.5,7.9,13z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d46.5775!4d8.0053'
    )
    close(p?.latitude, 46.5775)
    close(p?.longitude, 8.0053)
  })

  it('parses query parameters and search paths', () => {
    close(parseGoogleMapsUrl('https://maps.google.com/?q=46.5577,7.9586')?.latitude, 46.5577)
    close(parseGoogleMapsUrl('https://www.google.com/maps/search/?api=1&query=46.5577%2C7.9586')?.longitude, 7.9586)
    close(parseGoogleMapsUrl('https://www.google.com/maps/search/46.5577,+7.9586')?.latitude, 46.5577)
    close(parseGoogleMapsUrl('geo:46.5577,7.9586')?.latitude, 46.5577)
  })

  it('recognises short links, which carry no coordinates themselves', () => {
    expect(isShortMapsLink('https://maps.app.goo.gl/abc123')).toBe(true)
    expect(parseLocationInput('https://maps.app.goo.gl/abc123')).toBeNull()
  })
})

describe('formatting', () => {
  it('formats decimal and DMS', () => {
    expect(formatLatLon(46.557694, 7.958611, 'decimal')).toBe('46.55769° N, 7.95861° E')
    expect(formatLatLon(46.557694, 7.958611, 'dms')).toBe('46°33′27.7″N, 7°57′31.0″E')
    expect(formatLatLon(-33.865, -0.5, 'dms')).toBe('33°51′54.0″S, 0°30′00.0″W')
  })

  it('round-trips formatted DMS through the parser', () => {
    const text = formatLatLon(-50.9423, -73.4068, 'dms')
    const p = parseCoordinatePair(text)
    close(p?.latitude, -50.9423, 1e-4)
    close(p?.longitude, -73.4068, 1e-4)
  })
})

describe('coordinate problems', () => {
  it('explains out-of-range values instead of treating them as an address', () => {
    expect(parseLocationInput('91, 181')).toBeNull()
    expect(coordinateProblem('91, 181')).toBe('Latitude 91° is outside −90° to 90° and longitude 181° is outside −180° to 180°.')
    expect(coordinateProblem('-95.5 100')).toBe('Latitude −95.5° is outside −90° to 90°.')
    expect(coordinateProblem('45, 200')).toBe('Longitude 200° is outside −180° to 180°.')
  })

  it('hints at swapped latitude and longitude', () => {
    expect(coordinateProblem('151.2, -33.8')).toBe('Latitude 151.2° is outside −90° to 90°. Enter latitude first, then longitude.')
  })

  it('explains two values in the same hemisphere axis', () => {
    expect(coordinateProblem('46 N 7 N')).toMatch(/Both values are latitudes/)
  })

  it('is silent for valid coordinates and for text that is not coordinates', () => {
    expect(coordinateProblem('46.5577, 7.9586')).toBeNull()
    expect(coordinateProblem('Vienna')).toBeNull()
    expect(coordinateProblem('Paris 75001')).toBeNull()
    expect(coordinateProblem('')).toBeNull()
  })
})
