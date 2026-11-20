// Equinoxes and solstices (Meeus, "Astronomical Algorithms", ch. 27).
// Accurate to about a minute for years 1000–3000, far better than a date slider needs.

export interface SeasonEvent {
  id: 'march-equinox' | 'june-solstice' | 'september-equinox' | 'december-solstice'
  label: string
  utc: number
}

const TERMS: Array<[number, number, number]> = [
  [485, 324.96, 1934.136],
  [203, 337.23, 32964.467],
  [199, 342.08, 20.186],
  [182, 27.85, 445112.111],
  [156, 73.14, 45036.886],
  [136, 171.52, 22518.443],
  [77, 222.54, 65928.934],
  [74, 296.72, 3034.906],
  [70, 243.58, 9037.513],
  [58, 119.81, 33718.147],
  [52, 297.17, 150.678],
  [50, 21.02, 2281.226],
  [45, 247.54, 29929.562],
  [44, 325.15, 31555.956],
  [29, 60.93, 4443.417],
  [18, 155.12, 67555.328],
  [17, 288.79, 4562.452],
  [16, 198.04, 62894.029],
  [14, 199.76, 31436.921],
  [12, 95.39, 14577.848],
  [12, 287.11, 31931.756],
  [12, 320.81, 34777.259],
  [9, 227.73, 1222.114],
  [8, 15.45, 16859.074]
]

const DEG = Math.PI / 180

function meanJde(index: number, year: number): number {
  const Y = (year - 2000) / 1000
  const Y2 = Y * Y
  const Y3 = Y2 * Y
  const Y4 = Y3 * Y
  switch (index) {
    case 0:
      return 2451623.80984 + 365242.37404 * Y + 0.05169 * Y2 - 0.00411 * Y3 - 0.00057 * Y4
    case 1:
      return 2451716.56767 + 365241.62603 * Y + 0.00325 * Y2 + 0.00888 * Y3 - 0.0003 * Y4
    case 2:
      return 2451810.21715 + 365242.01767 * Y - 0.11575 * Y2 + 0.00337 * Y3 + 0.00078 * Y4
    default:
      return 2451900.05952 + 365242.74049 * Y - 0.06223 * Y2 - 0.00823 * Y3 + 0.00032 * Y4
  }
}

/** Approximate ΔT (TT − UT) in seconds, Espenak & Meeus polynomial for 2005–2050, else a coarse fit. */
function deltaT(year: number): number {
  if (year >= 2005 && year < 2050) {
    const t = year - 2000
    return 62.92 + 0.32217 * t + 0.005589 * t * t
  }
  const u = (year - 1820) / 100
  return -20 + 32 * u * u
}

function seasonUtc(index: number, year: number): number {
  const jde0 = meanJde(index, year)
  const T = (jde0 - 2451545.0) / 36525
  const W = (35999.373 * T - 2.47) * DEG
  const dL = 1 + 0.0334 * Math.cos(W) + 0.0007 * Math.cos(2 * W)
  let S = 0
  for (const [A, B, C] of TERMS) S += A * Math.cos((B + C * T) * DEG)
  const jde = jde0 + (0.00001 * S) / dL
  const msTT = (jde - 2440587.5) * 86400000
  return msTT - deltaT(year) * 1000
}

const LABELS: Array<[SeasonEvent['id'], string]> = [
  ['march-equinox', 'March equinox'],
  ['june-solstice', 'June solstice'],
  ['september-equinox', 'September equinox'],
  ['december-solstice', 'December solstice']
]

export function seasonEvents(year: number): SeasonEvent[] {
  return LABELS.map(([id, label], i) => ({ id, label, utc: seasonUtc(i, year) }))
}
