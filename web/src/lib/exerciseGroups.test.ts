import { describe, it, expect } from 'vitest'
import { groupContext, expandGroupSelection, problemSummary, type GroupedExercise, type PartState } from './exerciseGroups'

const g = { id: 'g1', title: 'Tax collector model', stem: 'A citizen pays a bribe $b$.' }
const ex = (id: string, groupId: string | null = null, groupPosition: number | null = null): GroupedExercise =>
  ({ id, groupId, groupPosition, group: groupId ? { ...g, id: groupId } : null })

describe('groupContext', () => {
  it('numbers the parts that are in the session', () => {
    const items = [ex('a'), ex('b', 'g1', 0), ex('c', 'g1', 1), ex('d', 'g1', 2)]
    expect(groupContext(items, 2)).toEqual({ title: g.title, stem: g.stem, part: 2, total: 3 })
  })
  it('is null for a standalone question or a group without a stem', () => {
    expect(groupContext([ex('a')], 0)).toBeNull()
    const noStem = { ...ex('b', 'g1', 0), group: { id: 'g1', title: 't', stem: '  ' } }
    expect(groupContext([noStem], 0)).toBeNull()
  })
})

describe('expandGroupSelection', () => {
  const members = [ex('g1-2', 'g1', 2), ex('g1-0', 'g1', 0), ex('g1-1', 'g1', 1)]
  const siblings = new Map([['g1', members]])
  it('brings the whole group, in order, where its first drawn member was', () => {
    const out = expandGroupSelection([ex('x'), ex('g1-1', 'g1', 1), ex('y')], siblings, 10)
    expect(out.map((e) => e.id)).toEqual(['x', 'g1-0', 'g1-1', 'g1-2', 'y'])
  })
  it('draws a group once even when several of its members were drawn', () => {
    const out = expandGroupSelection([ex('g1-0', 'g1', 0), ex('g1-2', 'g1', 2)], siblings, 10)
    expect(out.map((e) => e.id)).toEqual(['g1-0', 'g1-1', 'g1-2'])
  })
  it('keeps a standalone question that appears twice only once', () => {
    expect(expandGroupSelection([ex('x'), ex('x')], new Map(), 10).map((e) => e.id)).toEqual(['x'])
  })
  it('drops standalone questions from the end first when the group makes the session too long', () => {
    const out = expandGroupSelection([ex('x'), ex('g1-0', 'g1', 0), ex('y'), ex('z')], siblings, 4)
    expect(out.map((e) => e.id)).toEqual(['x', 'g1-0', 'g1-1', 'g1-2'])
  })
  it('never splits a group and always keeps the first slot', () => {
    const out = expandGroupSelection([ex('g1-0', 'g1', 0)], siblings, 1)
    expect(out.map((e) => e.id)).toEqual(['g1-0', 'g1-1', 'g1-2'])
  })
  it('drops whole groups from the end only after the standalone questions', () => {
    const s2 = new Map([['g1', members], ['g2', [ex('g2-0', 'g2', 0), ex('g2-1', 'g2', 1)]]])
    const out = expandGroupSelection([ex('g1-0', 'g1', 0), ex('g2-0', 'g2', 0)], s2, 4)
    expect(out.map((e) => e.id)).toEqual(['g1-0', 'g1-1', 'g1-2'])
  })
  it('leaves a selection without groups unchanged', () => {
    expect(expandGroupSelection([ex('a'), ex('b')], new Map(), 5).map((e) => e.id)).toEqual(['a', 'b'])
  })
})

describe('problemSummary', () => {
  const items = [ex('a'), ex('b', 'g1', 0), ex('c', 'g1', 1), ex('d', 'g1', 2), ex('e')]
  const states: Record<string, PartState> = { b: 'correct', c: 'incorrect', d: 'open' }
  const summarize = (index: number) => problemSummary(items, index, (i) => states[i.id] ?? 'open', (i) => i.id === 'd', (i) => (i.id === 'b' ? 1 : 0))
  it('lists the parts of the problem with their state, number and the current one', () => {
    const s = summarize(2)!
    expect(s.parts.map((p) => [p.index, p.number, p.state, p.current, p.flagged])).toEqual([[1, 1, 'correct', false, false], [2, 2, 'incorrect', true, false], [3, 3, 'open', false, true]])
    expect(s).toMatchObject({ answered: 2, total: 3, points: 1 })
  })
  it('is null for a standalone question and for a group with a single item in the session', () => {
    expect(summarize(0)).toBeNull()
    expect(problemSummary([ex('x', 'g9', 0)], 0, () => 'open', () => false, () => 0)).toBeNull()
  })
})

