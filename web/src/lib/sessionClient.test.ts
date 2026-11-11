import { describe, it, expect } from 'vitest'
import { viewFromState, remainingSeconds, activeSessionHintKey, legacySessionId, stateDiffers } from './sessionClient'
import type { SessionState } from '@/services/sessionService'

const ex = (id: string) => ({ id, topicId: 't', questionText: 'Q', exerciseType: 'single_choice', choices: '[]', correctAnswer: 'A', explanation: null, status: 'active', topic: { id: 't', courseId: 'c', title: 'T', week: null, course: null } })

function state(over: Partial<SessionState['session']> = {}, items: SessionState['items'] = []): SessionState {
  return {
    session: { id: 's', courseId: 'c', title: 'x', mode: 'exam', status: 'active', timeLimit: 600, deadline: '2026-11-11T10:10:00.000Z', targetCount: 3, topicIds: ['t'], currentPosition: 1, sourcingMix: 50, startTime: '2026-11-11T10:00:00.000Z', endTime: null, studyPlanId: null, ...over },
    items,
    missingCount: 1,
    serverNow: '2026-11-11T10:05:00.000Z',
  }
}

describe('viewFromState', () => {
  const items = [
    { position: 0, exercise: ex('a') as never, draftAnswer: 'A', flagged: true, log: null },
    { position: 1, exercise: ex('b') as never, draftAnswer: null, flagged: false, log: { isCorrect: true, score: 1, userAnswer: 'A' } },
  ]
  it('splits items into exercises, drafts, flags and logs, in position order', () => {
    const v = viewFromState(state({}, items), Date.parse('2026-11-11T10:05:00.000Z'))
    expect(v.exercises.map((e) => e.id)).toEqual(['a', 'b'])
    expect(v.draftAnswers).toEqual({ a: 'A' })
    expect(v.flaggedIds).toEqual(['a'])
    expect(v.session.logs).toEqual([{ exerciseId: 'b', isCorrect: true, score: 1, userAnswer: 'A' }])
    expect(v.missingCount).toBe(1)
    expect(v.currentIndex).toBe(1)
  })
  it('clamps the position into the questions that exist', () => {
    expect(viewFromState(state({ currentPosition: 9 }, items)).currentIndex).toBe(1)
    expect(viewFromState(state({ currentPosition: 3 }, [])).currentIndex).toBe(0)
  })
  it('has a deadline only for exams with one, and derives the server clock offset', () => {
    const v = viewFromState(state(), Date.parse('2026-11-11T10:04:00.000Z'))
    expect(v.deadlineMs).toBe(Date.parse('2026-11-11T10:10:00.000Z'))
    expect(v.serverOffsetMs).toBe(60_000)
    expect(viewFromState(state({ mode: 'study', deadline: null })).deadlineMs).toBeNull()
  })
})

describe('remainingSeconds', () => {
  const deadline = Date.parse('2026-11-11T10:10:00.000Z')
  it('uses the server clock, so a client clock that is wrong does not matter', () => {
    // client clock 1 hour behind: server says it is 10:05, the client reads 09:05; offset +1h
    const clientNow = Date.parse('2026-11-11T09:05:00.000Z')
    const offset = Date.parse('2026-11-11T10:05:00.000Z') - clientNow
    expect(remainingSeconds(deadline, clientNow, offset)).toBe(300)
  })
  it('rounds up and never goes negative', () => {
    expect(remainingSeconds(deadline, deadline - 1500, 0)).toBe(2)
    expect(remainingSeconds(deadline, deadline + 5000, 0)).toBe(0)
  })
})

describe('hint helpers', () => {
  it('keys the hint by studyspace', () => {
    expect(activeSessionHintKey()).toBe('feynman_active_session_global')
    expect(activeSessionHintKey('abc')).toBe('feynman_active_session_abc')
  })
  it('reads the session id out of the legacy snapshot, tolerating junk', () => {
    expect(legacySessionId(JSON.stringify({ session: { id: 'x1' }, exercises: [] }))).toBe('x1')
    expect(legacySessionId('not json')).toBeNull()
    expect(legacySessionId(JSON.stringify({ session: {} }))).toBeNull()
    expect(legacySessionId(null)).toBeNull()
  })
  it('detects when the screen is out of date', () => {
    const s = state({}, [])
    expect(stateDiffers({ status: 'active', itemCount: 0, missingCount: 1 }, s)).toBe(false)
    expect(stateDiffers({ status: 'active', itemCount: 0, missingCount: 0 }, s)).toBe(true)
    expect(stateDiffers({ status: 'completed', itemCount: 0, missingCount: 1 }, s)).toBe(true)
  })
})
