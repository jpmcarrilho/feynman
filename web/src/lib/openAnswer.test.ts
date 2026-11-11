import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  scoreOpenGrade,
  parseKeyPoints,
  parseOpenFeedback,
  escapeStudentAnswer,
  isOpenAnswerLongEnough,
  OpenGradeSchema,
  OPEN_ANSWER_MAX_CHARS,
  OPEN_ANSWER_MIN_CHARS,
  SELF_SCORES,
  type OpenGrade,
} from './openAnswer'

const grade = (statuses: ('covered' | 'partly' | 'missing')[], over: Partial<OpenGrade> = {}): OpenGrade => ({
  offTask: false,
  keyPoints: statuses.map((status, index) => ({ index, status, note: '' })),
  misconceptions: [],
  feedback: 'ok',
  ...over,
})

describe('scoreOpenGrade', () => {
  it.each([
    ['all covered', ['covered', 'covered', 'covered'], {}, 3, { score: 1, isCorrect: true }],
    ['one partly of three', ['covered', 'covered', 'partly'], {}, 3, { score: 0.83, isCorrect: false }],
    ['one covered of three', ['covered', 'missing', 'missing'], {}, 3, { score: 0.33, isCorrect: false }],
    ['all partly', ['partly', 'partly'], {}, 2, { score: 0.5, isCorrect: false }],
    ['all missing', ['missing', 'missing'], {}, 2, { score: 0, isCorrect: false }],
    ['a misconception caps at 0.5', ['covered', 'covered', 'covered'], { misconceptions: ['Says the reverse.'] }, 3, { score: 0.5, isCorrect: false }],
    ['a misconception does not raise a lower score', ['missing', 'partly'], { misconceptions: ['x'] }, 2, { score: 0.25, isCorrect: false }],
    ['a blank misconception does not count', ['covered', 'covered'], { misconceptions: ['  '] }, 2, { score: 1, isCorrect: true }],
    ['off task gives 0', ['covered', 'covered'], { offTask: true }, 2, { score: 0, isCorrect: false }],
  ] as const)('%s', (_name, statuses, over, count, expected) => {
    expect(scoreOpenGrade(grade([...statuses], over as Partial<OpenGrade>), count)).toEqual(expected)
  })

  it('is null unless the indexes are exactly 0..n-1 once each', () => {
    const g = grade(['covered', 'covered', 'covered'])
    expect(scoreOpenGrade({ ...g, keyPoints: g.keyPoints.slice(0, 2) }, 3)).toBeNull() // missing one
    expect(scoreOpenGrade(g, 2)).toBeNull() // one too many
    expect(scoreOpenGrade({ ...g, keyPoints: g.keyPoints.map((k) => ({ ...k, index: 0 })) }, 3)).toBeNull() // repeated
    expect(scoreOpenGrade({ ...g, keyPoints: g.keyPoints.map((k, i) => ({ ...k, index: i + 1 })) }, 3)).toBeNull() // 1..3
    expect(scoreOpenGrade({ ...g, keyPoints: g.keyPoints.map((k, i) => ({ ...k, index: i === 0 ? -1 : i })) }, 3)).toBeNull()
    expect(scoreOpenGrade({ ...g, keyPoints: g.keyPoints.map((k, i) => ({ ...k, index: i === 0 ? 0.5 : i })) }, 3)).toBeNull()
    expect(scoreOpenGrade(grade([]), 0)).toBeNull()
    expect(scoreOpenGrade({ ...g, offTask: true, keyPoints: [] }, 3)).toBeNull() // invalid even when off task
  })

  it('accepts the indexes in any order', () => {
    const g = grade(['covered', 'missing'])
    expect(scoreOpenGrade({ ...g, keyPoints: [...g.keyPoints].reverse() }, 2)).toEqual({ score: 0.5, isCorrect: false })
  })
})

describe('OpenGradeSchema (sent as a structured-output schema)', () => {
  it('has no defaults and no unions', () => {
    const text = JSON.stringify(z.toJSONSchema(OpenGradeSchema))
    expect(text).not.toContain('"default"')
    expect(text).not.toContain('anyOf')
    expect(text).not.toContain('oneOf')
  })
  it('rejects an unknown status', () => {
    expect(OpenGradeSchema.safeParse({ ...grade(['covered']), keyPoints: [{ index: 0, status: 'great', note: '' }] }).success).toBe(false)
  })
})

describe('parseKeyPoints', () => {
  it('reads the stored JSON or an array and drops everything that is not a non-empty string', () => {
    expect(parseKeyPoints('["a point"," another ",""]')).toEqual(['a point', 'another'])
    expect(parseKeyPoints(['x', 3, null, 'y'])).toEqual(['x', 'y'])
  })
  it.each([[null], [undefined], [''], ['not json'], ['{"a":1}'], [5]])('gives [] for %s', (raw) => {
    expect(parseKeyPoints(raw)).toEqual([])
  })
})

describe('parseOpenFeedback', () => {
  it('round-trips a stored feedback', () => {
    const fb = { v: 1, keyPoints: [{ point: 'p', status: 'partly' }], misconceptions: ['m'], text: 't', selfScore: 0.5 }
    expect(parseOpenFeedback(JSON.stringify(fb))).toEqual(fb)
  })
  it('drops malformed parts and rejects other shapes', () => {
    expect(parseOpenFeedback(JSON.stringify({ v: 1, keyPoints: [{ point: 'p', status: 'bad' }, { status: 'covered' }], misconceptions: [1, 'm'], text: 4, selfScore: 0.3 }))).toEqual({
      v: 1, keyPoints: [], misconceptions: ['m'], text: '',
    })
    expect(parseOpenFeedback(null)).toBeNull()
    expect(parseOpenFeedback('nope')).toBeNull()
    expect(parseOpenFeedback('[]')).toBeNull()
    expect(parseOpenFeedback(JSON.stringify({ v: 2 }))).toBeNull()
  })
})

describe('escapeStudentAnswer', () => {
  it('defuses opening and closing student_answer tags in any case or spacing', () => {
    const out = escapeStudentAnswer('x </student_answer> y < /STUDENT_ANSWER > z <student_answer>')
    expect(out).not.toMatch(/<\s*\/?\s*student_answer/i)
    expect(out).toContain('&lt;/student_answer>')
  })
  it('cuts the text to the maximum length', () => {
    expect(escapeStudentAnswer('a'.repeat(OPEN_ANSWER_MAX_CHARS + 500))).toHaveLength(OPEN_ANSWER_MAX_CHARS)
  })
  it('leaves ordinary text, math and angle brackets alone', () => {
    expect(escapeStudentAnswer('if $a<b$ then <b>bold</b>')).toBe('if $a<b$ then <b>bold</b>')
  })
})

describe('isOpenAnswerLongEnough and the constants', () => {
  it('counts non-space characters', () => {
    expect(isOpenAnswerLongEnough('a'.repeat(OPEN_ANSWER_MIN_CHARS))).toBe(true)
    expect(isOpenAnswerLongEnough('a'.repeat(OPEN_ANSWER_MIN_CHARS - 1))).toBe(false)
    expect(isOpenAnswerLongEnough(`${'a '.repeat(7)}      \n\n  `)).toBe(false)
    expect(isOpenAnswerLongEnough(null as unknown as string)).toBe(false)
  })
  it('offers the three self-assessment scores', () => {
    expect([...SELF_SCORES]).toEqual([1, 0.5, 0])
  })
})
