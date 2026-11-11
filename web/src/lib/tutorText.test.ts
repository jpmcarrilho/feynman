import { describe, it, expect } from 'vitest'
import { stripDirectiveEcho } from './tutorText'

describe('stripDirectiveEcho', () => {
  const table: [string, string, string][] = [
    ['leaked label without punctuation', "mode:guide No problem. Let's focus on the first step.", "No problem. Let's focus on the first step."],
    [
      'label, directive sentences and a transliterated fragment',
      'Mode: Explain. Follow the Explain rules from your instructions. Go straight to the substance. डिस्कस द करेक्ट आंसर ओपनली। CDFs are advantageous because they show the whole distribution.',
      'CDFs are advantageous because they show the whole distribution.',
    ],
    ['label then content', 'Mode: Probe. What do you think happens next?', 'What do you think happens next?'],
    ['upper case label', 'MODE: EXAM The question asks about timing.', 'The question asks about timing.'],
    ['system message echo', '[SYSTEM MESSAGE: The student switched the tutor to guide mode.] Start with the first term.', 'Start with the first term.'],
    ['system message still streaming', '[SYSTEM MESSAGE: The student sw', ''],
    ['bare label still streaming', 'Mode:', ''],
    ['directive sentence after label only', 'Mode: Guide. Do not greet or welcome the student: go straight to the substance. Compare the two groups.', 'Compare the two groups.'],
  ]
  for (const [name, input, expected] of table) {
    it(`strips: ${name}`, () => expect(stripDirectiveEcho(input)).toBe(expected))
  }

  const untouched = [
    'Mode choice matters here because the estimator changes with it.',
    'The mode: the most frequent value in the sample, is 3.',
    'Mode: the value that appears most often.',
    'Go straight to the substance of the proof: start with the definition.',
    'Follow the three rules from your instructions to build the table.',
    'डिस्कस द करेक्ट आंसर। Next sentence in Latin.',
    'यह एक सामान्य उत्तर है। यह हिंदी में है।',
    'Right, so the median is the middle value.',
    '',
  ]
  for (const t of untouched) {
    it(`keeps: ${t.slice(0, 40) || '(empty)'}`, () => expect(stripDirectiveEcho(t)).toBe(t))
  }

  it('keeps a non-Latin reply that follows an echo when nothing Latin comes after it', () => {
    expect(stripDirectiveEcho('Mode: Guide. यह हिंदी में है।')).toBe('यह हिंदी में है।')
  })
})

import { tutorSpeaksOnContext } from './tutorText'
describe('tutorSpeaksOnContext', () => {
  it('speaks only in a live voice call with nothing typed waiting', () => {
    expect(tutorSpeaksOnContext({ isMuted: false, pendingTypedMessage: false })).toBe(true)
    expect(tutorSpeaksOnContext({ isMuted: true, pendingTypedMessage: false })).toBe(false) // muted, text-only, or the student typed
    expect(tutorSpeaksOnContext({ isMuted: false, pendingTypedMessage: true })).toBe(false)
    expect(tutorSpeaksOnContext({ isMuted: true, pendingTypedMessage: true })).toBe(false)
  })
})

import { transcriptForSave } from './tutorText'
describe('transcriptForSave', () => {
  it('drops system turns and empty model messages, keeps id/role/text only', () => {
    const out = transcriptForSave([
      { id: '1', role: 'user', text: '[SYSTEM MESSAGE: ctx]' },
      { id: '2', role: 'user', text: 'Why?' },
      { id: '3', role: 'model', text: 'Because.', raw: 'Mode: Guide. Because.' },
      { id: '4', role: 'model', text: '', raw: 'Mode: Guide.' },
      null,
    ])
    expect(out).toEqual([{ id: '2', role: 'user', text: 'Why?' }, { id: '3', role: 'model', text: 'Because.' }])
  })
})
