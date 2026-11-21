/**
 * The moon's lit shape: `illumination` is the lit fraction (0–1) and `brightLimb` the
 * direction of the lit side, degrees clockwise from up. Drawn lit-on-the-right, then turned.
 */
export function MoonDisc({ illumination, brightLimb, size, label }: { illumination: number; brightLimb: number; size: number; label: string }) {
  const r = 10
  const k = Math.min(1, Math.max(0, illumination))
  // Outer limb down the right half, then back up along the terminator: an ellipse whose
  // half-width is |2k − 1|, bulging left past half lit (gibbous), right before (crescent).
  const rx = (r * Math.abs(2 * k - 1)).toFixed(3)
  const lit = `M 0 ${-r} A ${r} ${r} 0 0 1 0 ${r} A ${rx} ${r} 0 0 ${k > 0.5 ? 1 : 0} 0 ${-r} Z`
  return (
    <svg className="moon-disc" width={size} height={size} viewBox="-11 -11 22 22" role="img" aria-label={label}>
      <circle r={r} className="moon-disc-dark" />
      {k > 0.005 && <path d={lit} className="moon-disc-lit" transform={`rotate(${(brightLimb - 90).toFixed(1)})`} />}
    </svg>
  )
}
