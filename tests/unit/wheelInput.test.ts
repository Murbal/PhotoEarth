import { describe, expect, it } from 'vitest'
import { GESTURE_GAP_MS, WheelClassifier, looksLikeTrackpad, type WheelSample } from '../../src/renderer/src/engine/WheelInput'

const sample = (s: Partial<WheelSample>): WheelSample => ({ deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, timeStamp: 0, ...s })

describe('looksLikeTrackpad', () => {
  it('recognizes mouse wheels', () => {
    // Windows / Linux notch.
    expect(looksLikeTrackpad(sample({ deltaY: 100, wheelDeltaY: -120 }))).toBe(false)
    expect(looksLikeTrackpad(sample({ deltaY: -200, wheelDeltaY: 240 }))).toBe(false)
    // macOS Chromium notch, with and without acceleration.
    expect(looksLikeTrackpad(sample({ deltaY: 4.000244140625, wheelDeltaY: -12 }))).toBe(false)
    expect(looksLikeTrackpad(sample({ deltaY: -36.002197265625, wheelDeltaY: 108 }))).toBe(false)
    // Line mode (Firefox, Linux).
    expect(looksLikeTrackpad(sample({ deltaY: 3, deltaMode: 1 }))).toBe(false)
    // Ctrl + wheel notch.
    expect(looksLikeTrackpad(sample({ deltaY: 100, wheelDeltaY: -120, ctrlKey: true }))).toBe(false)
  })

  it('recognizes trackpads', () => {
    // macOS Chromium: whole pixels, wheelDelta = -3 × delta.
    expect(looksLikeTrackpad(sample({ deltaY: 2, wheelDeltaY: -6 }))).toBe(true)
    expect(looksLikeTrackpad(sample({ deltaX: -7, wheelDeltaY: 0 }))).toBe(true)
    // Diagonal.
    expect(looksLikeTrackpad(sample({ deltaX: 3, deltaY: 1, wheelDeltaY: -3 }))).toBe(true)
    // Pinch.
    expect(looksLikeTrackpad(sample({ deltaY: -1.37, ctrlKey: true, wheelDeltaY: 4 }))).toBe(true)
    // Windows precision touchpad: fractional notches.
    expect(looksLikeTrackpad(sample({ deltaY: 11.5, wheelDeltaY: -13 }))).toBe(true)
  })
})

describe('WheelClassifier', () => {
  it('keeps a gesture that looked like a trackpad, through wheel-like momentum', () => {
    const c = new WheelClassifier()
    expect(c.classify(sample({ deltaY: 3, wheelDeltaY: -9, timeStamp: 0 }))).toBe('trackpad')
    expect(c.classify(sample({ deltaY: 120, wheelDeltaY: -360, timeStamp: 16 }))).toBe('trackpad')
  })

  it('upgrades a gesture to trackpad and starts over after a pause', () => {
    const c = new WheelClassifier()
    expect(c.classify(sample({ deltaY: 100, wheelDeltaY: -120, timeStamp: 0 }))).toBe('mouse')
    expect(c.classify(sample({ deltaY: 5, wheelDeltaY: -15, timeStamp: 16 }))).toBe('trackpad')
    expect(c.classify(sample({ deltaY: 100, wheelDeltaY: -120, timeStamp: 16 + GESTURE_GAP_MS + 1 }))).toBe('mouse')
  })
})
