import { describe, it, expect } from 'vitest'
import { buildSessionTitle, courseLabel } from './sessionTitle'

const imported = (week: string) => ({ week, sourceId: null, course: { code: '14.750x', title: 'Political Economy' } })
const uploaded = (week: string) => ({ week, sourceId: 's1', course: { code: 'thermo-test-imt735', title: 'Thermo test' } })

describe('buildSessionTitle', () => {
  it('keeps the course code and week wording of the imported studyspaces', () => {
    expect(buildSessionTitle('study', [imported('Week_09_Corruption')])).toBe('14.750x - Week 9 (Study)')
    expect(buildSessionTitle('exam', [imported('Week 2'), imported('Week_3')])).toBe('14.750x - Week 2, Week 3 (Exam)')
  })
  it('uses the studyspace title for uploaded studyspaces, not the generated code', () => {
    expect(buildSessionTitle('study', [uploaded('01 · Engines')])).toBe('Thermo test - 01 · Engines (Study)')
    expect(courseLabel(uploaded('x'))).toBe('Thermo test')
    expect(courseLabel(imported('x'))).toBe('14.750x')
  })
  it('falls back to the generic titles', () => {
    expect(buildSessionTitle('study', [])).toBe('Random Study Session')
    expect(buildSessionTitle('exam', [])).toBe('Timed Exam Session')
  })
})
