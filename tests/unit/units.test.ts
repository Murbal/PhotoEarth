import { describe, expect, it } from 'vitest'
import { compassPoint, formatDistance, formatElevation, formatPointForClipboard, niceScale } from '@renderer/lib/units'

describe('units', () => {
  it('formats elevations', () => {
    expect(formatElevation(3967.4, 'metric')).toBe('3,967 m')
    expect(formatElevation(3967.4, 'imperial')).toBe('13,016 ft')
    expect(formatElevation(null, 'metric')).toBe('—')
    expect(formatElevation(3967.4, 'metric', { grouping: false })).toBe('3967 m')
    expect(formatElevation(3967.4, 'imperial', { grouping: false })).toBe('13016 ft')
  })

  it('formats distances', () => {
    expect(formatDistance(850, 'metric')).toBe('850 m')
    expect(formatDistance(12345, 'metric')).toBe('12.3 km')
    expect(formatDistance(100, 'imperial')).toBe('328 ft')
    expect(formatDistance(16093.44, 'imperial')).toBe('10.0 mi')
  })

  it('picks round scale-bar lengths', () => {
    expect(niceScale(130, 'metric')).toEqual({ meters: 100, label: '100 m' })
    expect(niceScale(4200, 'metric')).toEqual({ meters: 2000, label: '2 km' })
    expect(niceScale(30000, 'imperial')?.label).toBe('10 mi')
    expect(niceScale(0, 'metric')).toBeNull()
  })

  it('names compass points', () => {
    expect(compassPoint(0)).toBe('N')
    expect(compassPoint(359)).toBe('N')
    expect(compassPoint(135)).toBe('SE')
    expect(compassPoint(250)).toBe('WSW')
  })
})

describe('formatPointForClipboard', () => {
  it('keeps plain decimal coordinates and uses the chosen units for elevation', () => {
    expect(formatPointForClipboard(46.5577, 7.9586, 3967.4, 'metric')).toBe('46.557700, 7.958600, 3967 m')
    expect(formatPointForClipboard(46.5577, 7.9586, 3967.4, 'imperial')).toBe('46.557700, 7.958600, 13016 ft')
  })

  it('leaves out an unknown elevation and appends extra readouts', () => {
    expect(formatPointForClipboard(-33.9, 18.4, null, 'imperial')).toBe('-33.900000, 18.400000')
    expect(formatPointForClipboard(46.5577, 7.9586, 1234, 'metric', ['21.10 mag/arcsec² (Bortle ≈ 4, estimate)'])).toBe(
      '46.557700, 7.958600, 1234 m, 21.10 mag/arcsec² (Bortle ≈ 4, estimate)'
    )
  })
})
