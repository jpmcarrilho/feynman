import { describe, it, expect } from 'vitest'
import { resolveTopicScope } from './topicScope'

const base = { selectedIds: [], matchedIds: [], filterLabels: [], shownCourseCodes: ['14.750x', 'JPAL102x'] }

describe('resolveTopicScope', () => {
  it('uses exactly the ticked topics, whatever the filters match', () => {
    const s = resolveTopicScope({ ...base, selectedIds: ['a', 'b'], matchedIds: ['a', 'b', 'c'], filterLabels: ['Week 04'] })
    expect(s).toMatchObject({ kind: 'selected', topicIds: ['a', 'b'], canStart: true })
    expect(s.summary).toContain('2 selected topics')
  })

  it('with nothing ticked and a filter set, uses the topics the filter matches (the reported bug: never every topic)', () => {
    const ids = Array.from({ length: 97 }, (_, i) => `t${i}`)
    const s = resolveTopicScope({ ...base, matchedIds: ids, filterLabels: ['JPAL102x', 'Week 04 Randomized Evaluation Design'] })
    expect(s.kind).toBe('filtered')
    expect(s.topicIds).toEqual(ids)
    expect(s.summary).toBe('97 topics matching JPAL102x, Week 04 Randomized Evaluation Design will be used.')
  })

  it('a filter that matches nothing cannot start', () => {
    const s = resolveTopicScope({ ...base, filterLabels: ['"zzz"'] })
    expect(s).toMatchObject({ kind: 'none', topicIds: [], canStart: false })
  })

  it('no filter and nothing ticked: all topics shown, sent as an empty list, and the text says so', () => {
    const s = resolveTopicScope({ ...base, matchedIds: ['a'] })
    expect(s).toMatchObject({ kind: 'all', topicIds: [], canStart: true })
    expect(s.summary).toBe('All topics of 14.750x, JPAL102x will be used.')
  })

  it('uses singular wording for one topic', () => {
    expect(resolveTopicScope({ ...base, matchedIds: ['a'], filterLabels: ['x'] }).summary).toContain('1 topic matching')
  })
})
