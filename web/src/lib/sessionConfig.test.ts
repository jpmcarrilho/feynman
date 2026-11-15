import { describe, it, expect } from 'vitest'
import {
  moduleStats, weakestModules, moduleRange, selectionStats, planSession, minutesPerQuestion, applyPreset, loadConfig, saveConfig,
  DEFAULT_CONFIG, PRESETS, type ConfigTopic, type SessionConfig,
} from './sessionConfig'

const topics: ConfigTopic[] = [
  { id: 'a1', week: 'Week 01', totalExercises: 10, uniquelyCompleted: 5, accuracy: 80, groupCount: 0, groupedExercises: 0 },
  { id: 'a2', week: 'Week 01', totalExercises: 10, uniquelyCompleted: 5, accuracy: 40, groupCount: 1, groupedExercises: 4 },
  { id: 'b1', week: 'Week 02', totalExercises: 20, uniquelyCompleted: 0, accuracy: null },
  { id: 'c1', week: 'Week 03', totalExercises: 0, uniquelyCompleted: 0, accuracy: null },
  { id: 'd1', week: 'Week 04', totalExercises: 8, uniquelyCompleted: 8, accuracy: 25, groupCount: 2, groupedExercises: 7 },
  { id: 'n1', week: null, totalExercises: 3 },
]

describe('moduleStats', () => {
  const stats = moduleStats(topics)
  it('lists modules in first-appearance order and leaves out topics without one', () => {
    expect(stats.map((s) => s.key)).toEqual(['Week 01', 'Week 02', 'Week 03', 'Week 04'])
  })
  it('totals questions, coverage, problems and a weighted accuracy', () => {
    expect(stats[0]).toMatchObject({ topicIds: ['a1', 'a2'], questions: 20, completed: 10, coverage: 50, accuracy: 60, problems: 1, problemParts: 4 })
    expect(stats[1]).toMatchObject({ questions: 20, completed: 0, coverage: 0, accuracy: null })
    expect(stats[2]).toMatchObject({ questions: 0, coverage: 0, accuracy: null })
    expect(stats[3]).toMatchObject({ accuracy: 25, problems: 2, problemParts: 7 })
  })
  it('copes with missing counts', () => {
    expect(moduleStats([{ id: 'x', week: 'W' }])[0]).toMatchObject({ questions: 0, completed: 0, coverage: 0, accuracy: null, problems: 0 })
  })
})

describe('weakestModules and moduleRange', () => {
  const stats = moduleStats(topics)
  it('puts low accuracy first, then unseen modules, and skips empty ones', () => {
    expect(weakestModules(stats, 3)).toEqual(['Week 04', 'Week 01', 'Week 02'])
    expect(weakestModules(stats, 1)).toEqual(['Week 04'])
  })
  it('gives the modules between two keys in display order, either direction', () => {
    expect(moduleRange(stats, 'Week 01', 'Week 03')).toEqual(['Week 01', 'Week 02', 'Week 03'])
    expect(moduleRange(stats, 'Week 04', 'Week 02')).toEqual(['Week 02', 'Week 03', 'Week 04'])
    expect(moduleRange(stats, 'Week 01', 'Nope')).toEqual(['Nope'])
  })
})

describe('selectionStats', () => {
  it('counts what the scope holds; empty scope means every topic', () => {
    expect(selectionStats(topics, ['a1', 'a2'])).toEqual({ topics: 2, questions: 20, unseen: 10, problems: 1, problemParts: 4 })
    expect(selectionStats(topics, []).questions).toBe(51)
    expect(selectionStats(topics, ['b1'])).toMatchObject({ questions: 20, unseen: 20 })
  })
})

describe('planSession', () => {
  it('splits a session between course questions and AI-written ones by the mix', () => {
    expect(planSession(20, 0, 100)).toEqual({ count: 20, fromCourse: 20, fromAi: 0, shortOfCourse: false })
    expect(planSession(20, 50, 100)).toEqual({ count: 20, fromCourse: 10, fromAi: 10, shortOfCourse: false })
    expect(planSession(10, 100, 100)).toMatchObject({ fromCourse: 0, fromAi: 10 })
  })
  it('lets the AI cover what the course questions cannot', () => {
    expect(planSession(20, 0, 8)).toEqual({ count: 20, fromCourse: 8, fromAi: 12, shortOfCourse: true })
    expect(planSession(20, 0, 0)).toMatchObject({ fromCourse: 0, fromAi: 20, shortOfCourse: true })
  })
})

describe('minutesPerQuestion', () => {
  it('rounds to a tenth and is null without a limit', () => {
    expect(minutesPerQuestion(600, 20)).toBe(0.5)
    expect(minutesPerQuestion(300, 7)).toBe(0.7)
    expect(minutesPerQuestion(null, 10)).toBeNull()
    expect(minutesPerQuestion(600, 0)).toBeNull()
  })
})

describe('presets', () => {
  it('all use course questions and clear the module picker', () => {
    for (const p of PRESETS) {
      const { config } = applyPreset(p.id, topics)
      expect(config.sourcingMix).toBe(0)
      expect(config.weeks).toEqual([])
    }
  })
  it('sets the goal of each preset', () => {
    expect(applyPreset('quick', topics).config).toMatchObject({ count: 10, focus: 'balanced', mode: 'study' })
    expect(applyPreset('weak', topics).config).toMatchObject({ count: 20, focus: 'remedial' })
    expect(applyPreset('new', topics).config).toMatchObject({ focus: 'unstudied' })
    expect(applyPreset('exam', topics, { questionCount: 32 }).config).toMatchObject({ mode: 'exam', count: 32, examMinutes: 75 })
    expect(applyPreset('exam', topics).config.count).toBe(20)
  })
  it('the problems preset selects the topics that hold multi-part problems', () => {
    expect(applyPreset('problems', topics).topicIds).toEqual(['a2', 'd1'])
  })
})

describe('remembered configuration', () => {
  const saved: SessionConfig = { ...DEFAULT_CONFIG, count: 20, weeks: ['Week 02'], focus: 'remedial' }
  const memory = () => {
    const data = new Map<string, string>()
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }
  }
  it('saves and loads per studyspace', () => {
    const s = memory()
    saveConfig('space-1', saved, s)
    expect(loadConfig('space-1', s)).toEqual(saved)
    expect(loadConfig('space-2', s)).toBeNull()
  })
  it('ignores a broken or old value and never throws on blocked storage', () => {
    const s = memory()
    s.setItem('feynman:session-config:x', '{"mode":"study"}')
    expect(loadConfig('x', s)).toBeNull()
    s.setItem('feynman:session-config:y', 'not json')
    expect(loadConfig('y', s)).toBeNull()
    const blocked = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    expect(loadConfig('z', blocked)).toBeNull()
    expect(() => saveConfig('z', saved, blocked)).not.toThrow()
    expect(loadConfig('z', null)).toBeNull()
  })
})
