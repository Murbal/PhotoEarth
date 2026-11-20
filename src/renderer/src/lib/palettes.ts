import type { PaletteId } from '@shared/types'

type Stop = [number, string]

/** Color ramps for hypsometric tint, low → high. */
export const PALETTE_STOPS: Record<PaletteId, Stop[]> = {
  terrain: [
    [0, '#1d6b4f'],
    [0.15, '#3f9a52'],
    [0.32, '#a3c763'],
    [0.5, '#e8d98b'],
    [0.66, '#c28a4b'],
    [0.82, '#8c5a3c'],
    [0.93, '#c9c3bd'],
    [1, '#ffffff']
  ],
  viridis: [
    [0, '#440154'],
    [0.25, '#3b528b'],
    [0.5, '#21918c'],
    [0.75, '#5ec962'],
    [1, '#fde725']
  ],
  spectral: [
    [0, '#3288bd'],
    [0.2, '#66c2a5'],
    [0.4, '#abdda4'],
    [0.55, '#fee08b'],
    [0.75, '#f46d43'],
    [1, '#9e0142']
  ],
  magma: [
    [0, '#000004'],
    [0.25, '#51127c'],
    [0.5, '#b73779'],
    [0.75, '#fc8961'],
    [1, '#fcfdbf']
  ],
  grayscale: [
    [0, '#111111'],
    [1, '#f5f5f5']
  ]
}

export const PALETTE_LABELS: Record<PaletteId, string> = {
  terrain: 'Terrain',
  viridis: 'Viridis',
  spectral: 'Spectral',
  magma: 'Magma',
  grayscale: 'Grayscale'
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function paletteColor(id: PaletteId, t: number): [number, number, number] {
  const stops = PALETTE_STOPS[id]
  const x = Math.min(1, Math.max(0, t))
  for (let i = 1; i < stops.length; i++) {
    const [t1, c1] = stops[i]
    if (x <= t1) {
      const [t0, c0] = stops[i - 1]
      const f = t1 === t0 ? 0 : (x - t0) / (t1 - t0)
      const a = hexToRgb(c0)
      const b = hexToRgb(c1)
      return [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * f)) as [number, number, number]
    }
  }
  return hexToRgb(stops[stops.length - 1][1])
}

export function paletteGradientCss(id: PaletteId, direction = 'to right'): string {
  return `linear-gradient(${direction}, ${PALETTE_STOPS[id].map(([t, c]) => `${c} ${(t * 100).toFixed(0)}%`).join(', ')})`
}

/** Slope classes in degrees, shared by the shader and the legend. */
export const SLOPE_CLASSES: Array<{ from: number; color: string }> = [
  { from: 0, color: '#1a9850' },
  { from: 10, color: '#91cf60' },
  { from: 20, color: '#fee08b' },
  { from: 30, color: '#fc8d59' },
  { from: 40, color: '#d73027' },
  { from: 50, color: '#7b3294' }
]
