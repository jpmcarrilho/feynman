import { describe, it, expect } from 'vitest'
import { topicSourceLabel, moduleLabel, formatDisplayName } from './topicLabel'

describe('topicSourceLabel', () => {
  it('shows the week number and the class instead of "Question 6"', () => {
    expect(topicSourceLabel({
      week: 'Week_01_Week_1__Introduction_to_Politi',
      className: 'Introduction to Political Economy and Economic Development (14 Questions)',
      title: 'Question 6',
    })).toBe('Week 1 · Introduction to Political Economy and Economic Development')
  })

  it('handles the one-number legacy form and drops leading zeros', () => {
    expect(topicSourceLabel({ week: 'Week_06_Sampling_and_Sample_Size', className: 'Data Entry: Lecture (10 Questions)', title: 'Question 2' }))
      .toBe('Week 6 · Data Entry: Lecture')
  })

  it('keeps the "NN · Module title" form of uploaded content and drops the file extension', () => {
    expect(topicSourceLabel({ week: '03 · Cell biology', className: 'lecture3.pdf', title: 'Mitosis' })).toBe('03 · Cell biology · lecture3')
  })

  it('falls back to the module, the class, then the title', () => {
    expect(topicSourceLabel({ week: 'Week_13_Comprehensive_Review', className: null, title: 'Q' })).toBe('Week 13')
    expect(topicSourceLabel({ week: null, className: 'Readings & Resources', title: 'Q' })).toBe('Readings & Resources')
    expect(topicSourceLabel({ week: null, className: null, title: 'Some_Title' })).toBe('Some Title')
    expect(topicSourceLabel(null)).toBe('')
  })
})

describe('moduleLabel', () => {
  it('reads legacy and uploaded modules', () => {
    expect(moduleLabel('Week_06_Sampling_and_Sample_Size')).toBe('Week 6 · Sampling and Sample Size')
    expect(moduleLabel('Week_02_Week_2__The_Role_of_Leaders_an')).toBe('Week 2 · The Role of Leaders an')
    expect(moduleLabel('01 · Intro')).toBe('01 · Intro')
    expect(moduleLabel('Free text_module')).toBe('Free text module')
    expect(moduleLabel(null)).toBe('')
  })
  it('formatDisplayName only replaces underscores', () => {
    expect(formatDisplayName('a__b_c ')).toBe('a b c')
  })
})
