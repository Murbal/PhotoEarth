import * as Astronomy from 'astronomy-engine'
import { describe, expect, it } from 'vitest'
import { seasonEvents } from '@renderer/lib/seasons'

describe('equinoxes and solstices', () => {
  it('match the reference within 5 minutes for 2000–2050', () => {
    for (let year = 2000; year <= 2050; year++) {
      const ours = seasonEvents(year).map((e) => e.utc)
      const ref = Astronomy.Seasons(year)
      const refs = [ref.mar_equinox, ref.jun_solstice, ref.sep_equinox, ref.dec_solstice].map((t) => t.date.getTime())
      ours.forEach((t, i) => expect(Math.abs(t - refs[i])).toBeLessThan(5 * 60_000))
    }
  })

  it('labels events in calendar order', () => {
    const events = seasonEvents(2026)
    expect(events.map((e) => e.id)).toEqual(['march-equinox', 'june-solstice', 'september-equinox', 'december-solstice'])
    expect(new Date(events[1].utc).toISOString().slice(0, 10)).toBe('2026-06-21')
  })
})
