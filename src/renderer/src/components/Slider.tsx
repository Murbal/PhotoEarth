import { useRef, type CSSProperties, type ReactNode } from 'react'

export interface SliderMarker {
  value: number
  label?: string
  className?: string
  title?: string
}

interface Props {
  min: number
  max: number
  value: number
  step: number
  onChange: (value: number) => void
  background?: string
  markers?: SliderMarker[]
  ariaLabel: string
  valueText?: string
  children?: ReactNode
  style?: CSSProperties
}

/** A track slider with a custom background (day/night shading) and event markers. */
export function TrackSlider({ min, max, value, step, onChange, background, markers = [], ariaLabel, valueText, style }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const pct = (v: number) => `${((v - min) / (max - min)) * 100}%`

  const fromEvent = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect()
    const t = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
    const raw = min + t * (max - min)
    onChange(Math.round(raw / step) * step)
  }

  return (
    <div
      ref={ref}
      className="slider-track"
      role="slider"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={valueText}
      style={style}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        fromEvent(e.clientX)
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) fromEvent(e.clientX)
      }}
      onKeyDown={(e) => {
        const big = e.shiftKey ? 10 : 1
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') onChange(Math.max(min, value - step * big))
        else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') onChange(Math.min(max, value + step * big))
        else return
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <div className="fill" style={{ background }} />
      {markers.map((m, i) => (
        <div key={i} className={`marker ${m.className ?? ''}`} style={{ left: pct(m.value) }} title={m.title}>
          {m.label && <span>{m.label}</span>}
        </div>
      ))}
      <div className="thumb" style={{ left: pct(value) }} />
    </div>
  )
}
