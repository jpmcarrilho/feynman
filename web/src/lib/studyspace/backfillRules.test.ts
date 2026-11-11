import { describe, it, expect } from 'vitest'
import {
  buildOutlineRanks,
  gradedRulesMatched,
  isQuantitativeWeek,
  legacySurveyFilterExcludes,
  majorityChoice,
  parseIdList,
  sortTopicsForOrder,
  stripEnrichmentMarker,
} from './backfillRules'

const t = (id: string, o: Partial<{ week: string; className: string; unit: string; resourceType: string; title: string }> = {}) => ({
  id,
  week: o.week ?? 'Week_01',
  className: o.className ?? null,
  unit: o.unit ?? null,
  resourceType: o.resourceType ?? null,
  title: o.title ?? id,
})

describe('outline ranking', () => {
  const ranks = buildOutlineRanks([
    { sectionTitle: 'A', links: [{ text: 'first' }, { text: 'second' }] },
    { sectionTitle: 'B', links: [{ text: 'third' }] },
  ])

  it('ranks by section then link index', () => {
    expect(ranks.get('first')).toBe(0)
    expect(ranks.get('second')).toBe(1)
    expect(ranks.get('third')).toBe(1000)
  })

  it('sorts ranked topics first by rank, unranked last, ties by unit number', () => {
    const sorted = sortTopicsForOrder(
      [t('x', { className: 'unknown' }), t('b', { className: 'third' }), t('a2', { className: 'first', unit: '10' }), t('a1', { className: 'first', unit: '2' })],
      ranks,
    )
    expect(sorted.map((s) => s.id)).toEqual(['a1', 'a2', 'b', 'x'])
  })

  it('falls back to week, unit number, title, id without an outline', () => {
    const sorted = sortTopicsForOrder(
      [t('c', { week: 'Week_02' }), t('b', { week: 'Week_01', unit: '10' }), t('a', { week: 'Week_01', unit: '9' })],
      null,
    )
    expect(sorted.map((s) => s.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('isQuantitativeWeek', () => {
  it('matches weeks 3, 6 and 9 only', () => {
    expect(isQuantitativeWeek('Week_06_Sampling_and_Sample_Size')).toBe(true)
    expect(isQuantitativeWeek('Week_09_Week_8__Corruption_I')).toBe(true)
    expect(isQuantitativeWeek('Week_10_Something')).toBe(false)
    expect(isQuantitativeWeek(null)).toBe(false)
  })
})

describe('majorityChoice', () => {
  it('picks the most frequent value and ignores nulls', () => {
    expect(majorityChoice(['a', 'b', 'a', null])).toBe('a')
    expect(majorityChoice([])).toBeNull()
  })
  it('returns null on a tie', () => {
    expect(majorityChoice(['a', 'b'])).toBeNull()
  })
})

describe('parseIdList', () => {
  it('parses a JSON string array and rejects other shapes', () => {
    expect(parseIdList('["a","b"]')).toEqual(['a', 'b'])
    expect(parseIdList('{"a":1}')).toBeNull()
    expect(parseIdList('oops')).toBeNull()
    expect(parseIdList(null)).toBeNull()
  })
})

describe('stripEnrichmentMarker', () => {
  it('removes the marker and the following newline only', () => {
    expect(stripEnrichmentMarker('<!-- enriched -->\nQuestion?\nMore')).toEqual({ text: 'Question?\nMore', hadMarker: true })
    expect(stripEnrichmentMarker('<!-- enriched -->Q')).toEqual({ text: 'Q', hadMarker: true })
  })
  it('leaves other text untouched', () => {
    expect(stripEnrichmentMarker('Q <!-- enriched -->\n')).toEqual({ text: 'Q <!-- enriched -->\n', hadMarker: false })
  })
})

describe('gradedRulesMatched', () => {
  const base = { topicTitle: 'Question 1', exerciseType: 'single_choice', choices: '["a","b"]', correctAnswer: 'a' }

  it('marks hours-spent questions', () => {
    expect(gradedRulesMatched({ ...base, questionText: 'How many hours did you spend on this week?' })).toContain('question-hours')
  })
  it('keeps a real survey-design question graded', () => {
    expect(gradedRulesMatched({ ...base, questionText: 'Which survey design reduces recall bias?' })).toEqual([])
  })
  it('does not flag content topics whose title merely contains "survey"', () => {
    expect(gradedRulesMatched({ ...base, topicTitle: 'Survey I', questionText: 'q' })).toEqual([])
    expect(gradedRulesMatched({ ...base, topicTitle: 'Building the Survey Team', questionText: 'q' })).toEqual([])
  })
  it('flags participation titles and course/entrance/exit surveys', () => {
    expect(gradedRulesMatched({ ...base, topicTitle: 'Course Survey - Required Participation', questionText: 'q' })).toEqual(['title-participation', 'title-survey'])
    expect(gradedRulesMatched({ ...base, topicTitle: 'Entrance Survey', questionText: 'q' })).toEqual(['title-survey'])
    expect(gradedRulesMatched({ ...base, topicTitle: 'SurveyCTO Sign-up', questionText: 'q' })).toEqual(['title-participation'])
  })
  it('flags multi-selects where every choice is correct', () => {
    const multi = { ...base, exerciseType: 'multiple_choice', questionText: 'q' }
    expect(gradedRulesMatched({ ...multi, choices: '["a","b"]', correctAnswer: '["a","b"]' })).toEqual(['multi-all-correct'])
    expect(gradedRulesMatched({ ...multi, choices: '["a","b","c"]', correctAnswer: '["a","b"]' })).toEqual([])
  })
})

describe('legacySurveyFilterExcludes', () => {
  it('mirrors the old text filter', () => {
    expect(legacySurveyFilterExcludes('Which survey design?', 'Q')).toBe(true)
    expect(legacySurveyFilterExcludes('Plain question', 'Survey I')).toBe(true)
    expect(legacySurveyFilterExcludes('Plain question', 'Question 1')).toBe(false)
  })
})
