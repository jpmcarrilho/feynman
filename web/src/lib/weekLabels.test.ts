import { describe, it, expect } from 'vitest'
import { parseWeekFile, weekLabel, classNameFor, sequentialOf, KIND_RANK, HOMEWORK_CLASS, FINGER_CLASS } from './weekLabels'

describe('parseWeekFile', () => {
  it('reads the week and kind from the file name', () => {
    expect(parseWeekFile('Week_05_Insurance_lectures.md')).toEqual({ week: 5, kind: 'lectures' })
    expect(parseWeekFile('Exercises_week_09.md')).toEqual({ week: 9, kind: 'exercises' })
    expect(parseWeekFile('Exercises_week_09_homework.md')).toEqual({ week: 9, kind: 'exercises', exerciseKind: 'homework' })
    expect(parseWeekFile('Exercises_week_03_finger.md')).toEqual({ week: 3, kind: 'exercises', exerciseKind: 'finger' })
    expect(parseWeekFile('Week_10_Slides_10_PoliticalEconomy_Part1.pdf')).toEqual({ week: 10, kind: 'file' })
    expect(parseWeekFile('Week_06_Prospects_and_Strategies_for_Land_Reform.PDF')).toEqual({ week: 6, kind: 'file' })
  })
  it('returns null for a name without a week', () => {
    expect(parseWeekFile('notes.pdf')).toBeNull()
    expect(parseWeekFile('Exercises_weeks_01-02.md')).toBeNull()
  })
})

describe('labels', () => {
  it('pads the week so labels sort in course order', () => {
    expect(weekLabel(5, ' Insurance ')).toBe('Week 05 · Insurance')
    expect([weekLabel(10, 'B'), weekLabel(2, 'A')].sort()).toEqual(['Week 02 · A', 'Week 10 · B'])
  })
  it('orders the kinds inside a week: lectures, exercises, then files', () => {
    expect(KIND_RANK.lectures).toBeLessThan(KIND_RANK.exercises)
    expect(KIND_RANK.exercises).toBeLessThan(KIND_RANK.file)
  })
})

describe('classNameFor', () => {
  it('uses the sequential of a lecture topic, "Exercises" for exercises and the file name for the rest', () => {
    const text = '# Week 05: Insurance\n\n## Insurance II Mutual Insurance in the Village Economy - Basic mutual insurance\n\nSo this is'
    expect(sequentialOf(text)).toBe('Insurance II Mutual Insurance in the Village Economy')
    expect(classNameFor('lectures', 'Week_05_Insurance_lectures.md', text)).toBe('Insurance II Mutual Insurance in the Village Economy')
    expect(classNameFor('lectures', 'x.md', 'no heading')).toBe('Lectures')
    expect(classNameFor('exercises', 'Exercises_week_05.md', null)).toBe('Exercises')
    expect(classNameFor('exercises', 'Exercises_week_05_homework.md', null)).toBe(HOMEWORK_CLASS)
    expect(classNameFor('exercises', 'Exercises_week_05_finger.md', null)).toBe(FINGER_CLASS)
    expect(classNameFor('file', 'Week_05_Slides_05_Insurance_Part1.pdf', null)).toBe('Slides 05 Insurance Part1')
  })
})
