import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { LEGACY_VOICE_PROFILE } from '@/lib/studyspace/legacyProfiles'

const calls = vi.hoisted(() => ({ log: [] as string[] }))

vi.mock('@/app/actions', () => {
  const lists = ['getTopicsWithPerformance', 'getSessionHistory', 'getStudyPlans']
  const names = ['startSession', 'checkSessionStartable', 'getActiveSession', 'getSessionState', 'saveDraft', 'setFlagged', 'setCurrentPosition', 'getTopicsWithPerformance', 'getSessionHistory', 'logAnswer', 'recordCardTime', 'submitExam', 'saveChatLog', 'finishStudySession', 'getSessionDetail', 'getVoiceContextForExercise', 'reportExercise', 'deleteStudySession', 'cancelStudySession', 'generateSessionSummary', 'generateExamDiagnosis', 'generateStructuredStudyPlan', 'saveAndDeployStudyPlan', 'getStudyPlans', 'deleteStudyPlan', 'getAnalyticsData', 'generatePlannerResponse']
  return Object.fromEntries(names.map((n) => [n, vi.fn(async () => (lists.includes(n) ? [] : null))]))
})
vi.mock('@/hooks/useLiveAPI', () => ({
  useLiveAPI: () => ({ isConnected: false, isConnecting: false, isMuted: false, error: null, messages: [], connect: vi.fn(), disconnect: vi.fn(), sendText: vi.fn(), sendContext: vi.fn(), setMuted: vi.fn(), setMessages: vi.fn() }),
}))

import { StudyInterface } from './StudyInterface'
import * as actions from '@/app/actions'

const ex = (id: string, type: string) => ({
  id, topicId: 't', questionText: `Question ${id}`, exerciseType: type, choices: '[]', correctAnswer: 'M', explanation: null, status: 'active', keyPoints: type === 'open' ? JSON.stringify(['a', 'b']) : null,
  topic: { id: 't', courseId: 'c1', title: 'T', week: null, course: null },
})
const state = (status = 'active') => ({
  session: { id: 's1', courseId: 'c1', title: null, mode: 'exam', status, timeLimit: 600, deadline: '2099-01-01T00:00:00.000Z', targetCount: 2, topicIds: ['t'], currentPosition: 0, sourcingMix: 50, startTime: '2026-11-11T10:00:00.000Z', endTime: null, studyPlanId: null },
  items: [
    { position: 0, exercise: ex('e1', 'open'), draftAnswer: null, flagged: false, log: null },
    { position: 1, exercise: ex('e2', 'numeric'), draftAnswer: null, flagged: false, log: null },
  ],
  missingCount: 0,
  serverNow: new Date().toISOString(),
})

beforeEach(() => {
  calls.log = []
  vi.clearAllMocks()
  localStorage.clear()
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('confirm', () => true)
  vi.mocked(actions.getActiveSession).mockResolvedValue(state() as never)
  vi.mocked(actions.getSessionState).mockResolvedValue(state('completed') as never)
  vi.mocked(actions.saveDraft).mockImplementation((async (_s: string, id: string, v: string | null | undefined) => {
    if (v !== undefined) calls.log.push(`draft:${id}:${v}`)
    return { ok: true }
  }) as never)
  vi.mocked(actions.submitExam).mockImplementation((async () => { calls.log.push('submit'); return { scoreSum: 0, total: 2, correctCount: 0 } }) as never)
  vi.mocked(actions.generateExamDiagnosis).mockResolvedValue(null as never)
})

const open = () => render(<StudyInterface courseId="c1" courseTitle="Course" profile={LEGACY_VOICE_PROFILE} />)
const draftsBefore = (which: string) => {
  const i = calls.log.indexOf('submit')
  return calls.log.slice(0, i < 0 ? calls.log.length : i).filter((c) => c.startsWith(which))
}

describe('exam drafts are written before the exam is submitted', () => {
  it('a written answer typed inside the debounce window reaches the server first, in full', async () => {
    open()
    const box = (await screen.findByLabelText('Your answer')) as HTMLTextAreaElement
    const text = 'Entropy rises because many more microstates are available to the system.'
    fireEvent.change(box, { target: { value: text } })
    fireEvent.click(await screen.findByRole('button', { name: 'Submit Exam Paper' })) // right away, well inside the 500 ms debounce
    await waitFor(() => expect(calls.log).toContain('submit'))
    expect(draftsBefore('draft:e1')).toEqual([`draft:e1:${text}`])
  })

  it('a number typed inside the debounce window reaches the server first', async () => {
    open()
    fireEvent.click((await screen.findAllByRole('button', { name: 'Next' }))[0])
    const input = await screen.findByLabelText('Your answer')
    fireEvent.change(input, { target: { value: '42' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Submit Exam Paper' }))
    await waitFor(() => expect(calls.log).toContain('submit'))
    expect(draftsBefore('draft:e2')).toEqual(['draft:e2:42'])
  })

  it('moving to another question sends the pending draft right away', async () => {
    open()
    const box = (await screen.findByLabelText('Your answer')) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'half written thought here' } })
    fireEvent.click((await screen.findAllByRole('button', { name: 'Next' }))[0])
    await waitFor(() => expect(calls.log).toContain('draft:e1:half written thought here'))
  })

  it('a draft write that failed is sent again at the flush, and the submit still carries the text', async () => {
    const text = 'a long written answer that must not be lost'
    vi.mocked(actions.saveDraft).mockImplementation((async (_s: string, id: string, v: string | null | undefined) => {
      if (v !== undefined) calls.log.push(`draft:${id}:${v}`)
      throw new Error('network')
    }) as never)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    open()
    fireEvent.change((await screen.findByLabelText('Your answer')) as HTMLTextAreaElement, { target: { value: text } })
    // let the 500 ms debounce fire and fail once
    await new Promise((r) => setTimeout(r, 700))
    fireEvent.click(await screen.findByRole('button', { name: 'Submit Exam Paper' }))
    await waitFor(() => expect(calls.log).toContain('submit'))
    // re-sent at the flush, and handed to the submission as a fallback
    expect(draftsBefore('draft:e1').length).toBeGreaterThanOrEqual(2)
    expect(vi.mocked(actions.submitExam)).toHaveBeenCalledWith('s1', { e1: text })
    errors.mockRestore()
  })

  it('a draft typed while an earlier write is still in flight is written after it, with the full text', async () => {
    const release: (() => void)[] = []
    vi.mocked(actions.saveDraft).mockImplementation((async (_s: string, id: string, v: string | null | undefined) => {
      if (v === undefined) return { ok: true }
      await new Promise<void>((r) => release.push(r))
      calls.log.push(`draft:${id}:${v}`)
      return { ok: true }
    }) as never)
    open()
    const box = (await screen.findByLabelText('Your answer')) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'first part' } })
    await new Promise((r) => setTimeout(r, 700)) // the first write is now in flight
    fireEvent.change(box, { target: { value: 'first part and the rest' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Submit Exam Paper' }))
    await new Promise((r) => setTimeout(r, 50))
    expect(calls.log).not.toContain('submit')
    for (let i = 0; i < 6; i++) { release.splice(0).forEach((r) => r()); await new Promise((r) => setTimeout(r, 20)) }
    await waitFor(() => expect(calls.log).toContain('submit'))
    expect(draftsBefore('draft:e1').pop()).toBe('draft:e1:first part and the rest')
  })
})

describe('stored exam diagnosis', () => {
  it('a completed exam with a stored diagnosis offers it on request, without generating anything', async () => {
    vi.mocked(actions.getActiveSession).mockResolvedValue(state('completed') as never)
    vi.mocked(actions.getSessionDetail).mockResolvedValue({ chatLog: null, diagnosis: '# Stored report\n\nWork on entropy.' } as never)
    open()
    const button = await screen.findByRole('button', { name: 'Show report' })
    fireEvent.click(button)
    expect(await screen.findByRole('heading', { name: 'Stored report' })).toBeInTheDocument()
    expect(actions.generateExamDiagnosis).not.toHaveBeenCalled()
  })
  it('offers nothing when no diagnosis is stored', async () => {
    vi.mocked(actions.getActiveSession).mockResolvedValue(state('completed') as never)
    vi.mocked(actions.getSessionDetail).mockResolvedValue({ chatLog: null, diagnosis: null } as never)
    open()
    await screen.findByText(/Question e1/)
    expect(screen.queryByRole('button', { name: 'Show report' })).not.toBeInTheDocument()
  })
})
