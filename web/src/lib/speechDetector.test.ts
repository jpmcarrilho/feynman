import { describe, it, expect } from 'vitest'
import { SpeechDetector, speechCountsForCard, SPEECH_SETTLE_MS } from './speechDetector'

const chunk = (amp: number, n = 1600) => new Int16Array(n).fill(Math.round(amp * 32767)) // 100 ms at 16 kHz

describe('SpeechDetector', () => {
  it('stays quiet for silence and low noise', () => {
    const d = new SpeechDetector()
    for (let i = 0; i < 100; i++) expect(d.feed(chunk(0.005))).toBe(false)
  })

  it('fires after enough loud audio, once per stretch of speech', () => {
    const d = new SpeechDetector()
    const fired = Array.from({ length: 4 }, () => d.feed(chunk(0.2)))
    expect(fired).toEqual([false, false, false, true])
    expect(d.feed(chunk(0.2))).toBe(false)
  })

  it('a short click does not count and a pause between words does not reset the count', () => {
    const d = new SpeechDetector()
    expect(d.feed(chunk(0.5))).toBe(false)
    for (let i = 0; i < 10; i++) d.feed(chunk(0)) // long silence resets
    expect(d.feed(chunk(0.5))).toBe(false)
    const e = new SpeechDetector()
    e.feed(chunk(0.2)); e.feed(chunk(0.2)); e.feed(chunk(0))
    e.feed(chunk(0.2))
    expect(e.feed(chunk(0.2))).toBe(true)
  })

  it('ignores an empty chunk', () => {
    expect(new SpeechDetector().feed(new Int16Array(0))).toBe(false)
  })
})

describe('speechCountsForCard (attribution to the right question)', () => {
  it('ignores speech signals right after the question changed, so audio from the previous question is not credited', () => {
    expect(speechCountsForCard('mic', 0)).toBe(false)
    expect(speechCountsForCard('mic', SPEECH_SETTLE_MS.mic - 1)).toBe(false)
    expect(speechCountsForCard('mic', SPEECH_SETTLE_MS.mic)).toBe(true)
  })
  it('gives a late transcript a longer window than the live microphone', () => {
    expect(SPEECH_SETTLE_MS.transcript).toBeGreaterThan(SPEECH_SETTLE_MS.mic)
    expect(speechCountsForCard('transcript', 2000)).toBe(false)
    expect(speechCountsForCard('transcript', SPEECH_SETTLE_MS.transcript)).toBe(true)
  })
})
