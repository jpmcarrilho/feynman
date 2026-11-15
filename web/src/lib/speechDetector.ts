/**
 * Decides from the microphone's PCM16 chunks whether the student is speaking, so a voice conversation with the tutor
 * can count as "asked for help". The microphone is only ever sent to the tutor while it is unmuted and connected, so
 * this runs in the same place. Plain loudness (RMS) over a sliding count of loud chunks: no model, no dependency.
 *
 * A chunk is loud when its RMS (0..1) is above `threshold`. The detector fires when `minLoudMs` of loud audio has been
 * heard with no more than `maxQuietMs` of quiet in a row, so a click or a cough does not count and a pause between
 * words does not reset the count.
 */
export class SpeechDetector {
  private loudMs = 0
  private quietMs = 0

  constructor(
    private readonly opts: { threshold?: number; minLoudMs?: number; maxQuietMs?: number; sampleRate?: number } = {},
  ) {}

  /** Feeds one chunk; returns true each time another `minLoudMs` of speech has been heard. */
  feed(pcm16: Int16Array): boolean {
    if (pcm16.length === 0) return false
    const { threshold = 0.04, minLoudMs = 400, maxQuietMs = 600, sampleRate = 16000 } = this.opts
    let sum = 0
    for (let i = 0; i < pcm16.length; i++) {
      const v = pcm16[i] / 32768
      sum += v * v
    }
    const rms = Math.sqrt(sum / pcm16.length)
    const chunkMs = (pcm16.length / sampleRate) * 1000
    if (rms >= threshold) {
      this.loudMs += chunkMs
      this.quietMs = 0
    } else {
      this.quietMs += chunkMs
      if (this.quietMs > maxQuietMs) this.loudMs = 0
    }
    if (this.loudMs >= minLoudMs) {
      this.loudMs = 0
      return true
    }
    return false
  }

  reset(): void {
    this.loudMs = 0
    this.quietMs = 0
  }
}

export type SpeechSource = 'mic' | 'transcript'

/**
 * How long after the current question changed a speech signal is ignored. Audio spoken on the previous question can
 * still be in the detector's window (mic) or arrive late as a transcript (the transcript of audio is produced seconds
 * after it was spoken), and neither may be credited to the new question. A typed message or a mode switch is an
 * immediate action on the current question and has no window.
 */
export const SPEECH_SETTLE_MS: Record<SpeechSource, number> = { mic: 1000, transcript: 5000 }

/** True when a speech signal of `source` may count for a question that became current `msSinceCardChange` ms ago. */
export function speechCountsForCard(source: SpeechSource, msSinceCardChange: number): boolean {
  return msSinceCardChange >= SPEECH_SETTLE_MS[source]
}
