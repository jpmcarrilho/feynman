import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { LEGACY_VOICE_PROFILE } from '@/lib/studyspace/legacyProfiles'

// Every server action the screen imports resolves to an empty value: the study screen is shown with no session
vi.mock('@/app/actions', () => {
  const lists = ['getTopicsWithPerformance', 'getSessionHistory', 'getStudyPlans']
  const names = ['startSession', 'checkSessionStartable', 'getActiveSession', 'getSessionState', 'saveDraft', 'setFlagged', 'setCurrentPosition', 'getTopicsWithPerformance', 'getSessionHistory', 'logAnswer', 'recordCardTime', 'submitExam', 'saveChatLog', 'finishStudySession', 'getSessionDetail', 'getVoiceContextForExercise', 'reportExercise', 'deleteStudySession', 'cancelStudySession', 'generateSessionSummary', 'generateExamDiagnosis', 'generateStructuredStudyPlan', 'saveAndDeployStudyPlan', 'getStudyPlans', 'deleteStudyPlan', 'getAnalyticsData', 'generatePlannerResponse']
  return Object.fromEntries(names.map((n) => [n, vi.fn(async () => (lists.includes(n) ? [] : null))]))
})

const live = vi.hoisted(() => ({
  api: {
    isConnected: false,
    isConnecting: false,
    isMuted: false,
    error: null as string | null,
    messages: [] as unknown[],
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(),
    sendText: vi.fn(),
    sendContext: vi.fn(),
    setMuted: vi.fn(),
    setMessages: vi.fn(),
  },
}))
vi.mock('@/hooks/useLiveAPI', () => ({ useLiveAPI: () => live.api }))

import { StudyInterface } from './StudyInterface'
import * as actions from '@/app/actions'

type Listener = () => void
let wide = false
const listeners = new Set<Listener>()
function setWide(next: boolean) {
  wide = next
  act(() => listeners.forEach((l) => l()))
}

beforeEach(() => {
  wide = false
  listeners.clear()
  live.api.isConnected = false
  live.api.isConnecting = false
  live.api.disconnect.mockClear()
  live.api.sendText.mockClear()
  live.api.connect.mockReset()
  live.api.connect.mockImplementation(async () => {})
  live.api.connect.mockClear()
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() { return query.includes('1280') ? wide : false },
    media: query,
    addEventListener: (_: string, cb: Listener) => listeners.add(cb),
    removeEventListener: (_: string, cb: Listener) => listeners.delete(cb),
  }))
})

const renderStudy = () => render(<StudyInterface courseId="c1" courseTitle="Course" profile={LEGACY_VOICE_PROFILE} />)

describe('StudyInterface layout', () => {
  it('below xl: no Tutor tab, a floating Tutor button that shows the connection state, and no tutor panel until it is opened', async () => {
    renderStudy()
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent)
    expect(tabs).toEqual(['Study', 'Study Plan', 'Resources', 'History', 'Analytics'])
    expect(screen.getByRole('button', { name: 'Tutor, not connected' })).toBeInTheDocument()
    expect(screen.queryByText('Talk to the Professor')).not.toBeInTheDocument()
    expect(screen.queryByTestId('tutor-connection-dot')).not.toBeInTheDocument()
  })

  it('shows "connected" on the button while the sheet is closed', async () => {
    live.api.isConnected = true
    renderStudy()
    expect(screen.getByRole('button', { name: 'Tutor, connected' })).toBeInTheDocument()
    expect(screen.getByTestId('tutor-connection-dot')).toHaveClass('bg-green-500')
  })

  it('opening and closing the sheet never disconnects, and there is exactly one VoiceHub', async () => {
    live.api.isConnected = true
    renderStudy()
    fireEvent.click(screen.getByRole('button', { name: 'Tutor, connected' }))
    const dialog = await screen.findByRole('dialog', { name: 'Tutor' })
    expect(screen.getAllByText('Talk to the Professor')).toHaveLength(1)
    expect(dialog).toContainElement(screen.getByText('Talk to the Professor'))
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(live.api.disconnect).not.toHaveBeenCalled()
  })

  it('crossing the breakpoint keeps one VoiceHub, the connection and the half-typed message', async () => {
    live.api.isConnected = true
    renderStudy()
    fireEvent.click(screen.getByRole('button', { name: 'Tutor, connected' }))
    const input = await screen.findByPlaceholderText('Type a message to start chatting...')
    fireEvent.change(input, { target: { value: 'half a thought' } })

    setWide(true)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /^Tutor,/ })).not.toBeInTheDocument()
    expect(screen.getAllByText('Talk to the Professor')).toHaveLength(1)
    expect((screen.getByPlaceholderText('Type a message to start chatting...') as HTMLInputElement).value).toBe('half a thought')

    setWide(false)
    expect(screen.queryAllByText('Talk to the Professor')).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Tutor, connected' })).toBeInTheDocument()
    expect(live.api.disconnect).not.toHaveBeenCalled()
    expect(live.api.connect).not.toHaveBeenCalled()
  })

  it('wide layout: tutor sidebar only, no floating button', () => {
    wide = true
    renderStudy()
    expect(screen.queryByRole('button', { name: /^Tutor,/ })).not.toBeInTheDocument()
    expect(screen.getAllByText('Talk to the Professor')).toHaveLength(1)
  })

  it('the tab strip never shrinks below its labels at the wide layout (the title gives way first)', () => {
    wide = true
    renderStudy()
    const list = screen.getAllByRole('tab')[0].parentElement!
    expect(list.className).toContain('xl:overflow-visible')
    expect(list.parentElement!.className).toContain('sm:shrink-0')
  })

  it('suggests no planner prompts without modules (nothing course-specific is hard-coded)', async () => {
    renderStudy()
    fireEvent.click(screen.getByRole('tab', { name: 'Study Plan' }))
    await screen.findByText('AI Curriculum Planner')
    expect(screen.queryByText('Suggested Pre-Ideas:')).not.toBeInTheDocument()
  })

  it('a message typed while the tutor is connecting is sent exactly once, after the connection is up', async () => {
    wide = true
    const view = renderStudy()
    const input = screen.getByPlaceholderText('Type a message to start chatting...')
    live.api.connect.mockImplementation(async () => { live.api.isConnecting = true })
    fireEvent.change(input, { target: { value: 'hello' } })
    fireEvent.submit(input.closest('form')!)
    // Enter again while "connecting": the second message joins the first, nothing is sent yet
    view.rerender(<StudyInterface courseId="c1" courseTitle="Course" profile={LEGACY_VOICE_PROFILE} />)
    expect(live.api.sendText).not.toHaveBeenCalled()

    live.api.isConnecting = false
    live.api.isConnected = true
    view.rerender(<StudyInterface courseId="c1" courseTitle="Course" profile={LEGACY_VOICE_PROFILE} />)
    await waitFor(() => expect(live.api.sendText).toHaveBeenCalledTimes(1))
    expect(live.api.sendText).toHaveBeenCalledWith('hello')
    view.rerender(<StudyInterface courseId="c1" courseTitle="Course" profile={LEGACY_VOICE_PROFILE} />)
    expect(live.api.sendText).toHaveBeenCalledTimes(1)
  })

  it('reserves a bottom band for the floating Tutor button on the tabs root, so panels that do not scroll shrink instead of sitting under it; not at xl', () => {
    renderStudy()
    const root = screen.getByRole('tablist').closest('[data-slot="tabs"]') as HTMLElement
    expect(root.className).toContain('max-xl:pb-[calc(4.5rem+env(safe-area-inset-bottom))]')
    // the band (72 px) is taller than the button (48 px) plus its 16 px margin (64 px)
    // and every panel lives inside this root, so none can reach under the button
    for (const panel of screen.getAllByRole('tabpanel', { hidden: true })) expect(root).toContainElement(panel)
  })

  describe('an active exam', () => {
    const exercise = (id: string) => ({
      id, topicId: 't1', questionText: `Question body ${id}`, exerciseType: 'single_choice', choices: '["A","B"]', correctAnswer: 'A', explanation: null,
      status: 'active',
      topic: { id: 't1', courseId: 'c1', title: 'Question 6', week: 'Week_01_Week_1__Introduction_to_Politi', className: 'Introduction to Political Economy (14 Questions)', unit: '7', course: { id: 'c1', code: '14.750x', title: 'X' } },
    })
    const examState = {
      session: { id: 's1', courseId: 'c1', title: null, mode: 'exam', status: 'active', timeLimit: 3600, deadline: new Date(Date.now() + 3_600_000).toISOString(), targetCount: 3, topicIds: [], currentPosition: 0, sourcingMix: 50, startTime: new Date().toISOString(), endTime: null, studyPlanId: null },
      items: ['e1', 'e2', 'e3'].map((id, position) => ({ position, exercise: exercise(id), draftAnswer: id === 'e2' ? 'A' : null, flagged: false, log: null })),
      missingCount: 0,
      serverNow: new Date().toISOString(),
    }

    it('below xl the question map and secondary actions are collapsed behind one toggle, with time and progress in the first row; the card names module and class', async () => {
      vi.mocked(actions.getActiveSession).mockResolvedValueOnce(examState as never)
      renderStudy()
      expect(await screen.findByText('1 of 3 answered')).toBeInTheDocument()
      expect(screen.getByText('Week 1 · Introduction to Political Economy')).toBeInTheDocument()
      expect(screen.queryByText(/Question 6/)).not.toBeInTheDocument()

      const toggle = screen.getByRole('button', { name: 'Question map & actions' })
      expect(toggle).toHaveAttribute('aria-expanded', 'false')
      const panel = document.getElementById('exam-panel')!
      expect(panel.className).toContain('max-xl:hidden')
      const cancel = screen.getByRole('button', { name: 'Cancel Exam' })
      expect(cancel.parentElement!.className).toContain('max-xl:hidden')

      fireEvent.click(toggle)
      expect(toggle).toHaveAttribute('aria-expanded', 'true')
      expect(panel.className).not.toContain('max-xl:hidden')
      expect(cancel.parentElement!.className).not.toContain('max-xl:hidden')
      // Submit stays in the always-visible row
      expect(screen.getByRole('button', { name: 'Submit Exam Paper' })).toBeInTheDocument()
    })
  })

  describe('an active study session', () => {
    const exercise = (id: string) => ({
      id, topicId: 't1', questionText: `Body ${id}`, exerciseType: 'single_choice', choices: '["A","B"]', correctAnswer: 'A', explanation: null, status: 'active',
      topic: { id: 't1', courseId: 'c1', title: 'Question 6', week: 'Week_01_Week_1__Introduction_to_Politi', className: 'Introduction to Political Economy (14 Questions)', unit: '7', course: { id: 'c1', code: '14.750x', title: 'X' } },
    })
    const studyState = {
      session: { id: 's2', courseId: 'c1', title: null, mode: 'study', status: 'active', timeLimit: null, deadline: null, targetCount: 3, topicIds: [], currentPosition: 0, sourcingMix: 50, startTime: new Date().toISOString(), endTime: null, studyPlanId: null },
      items: ['e1', 'e2', 'e3'].map((id, position) => ({ position, exercise: exercise(id), draftAnswer: null, flagged: false, log: null })),
      missingCount: 0,
      serverNow: new Date().toISOString(),
    }

    it('below xl: one compact row first, the actions/timer/top navigation behind its toggle, Previous/Next only once (bottom pair)', async () => {
      vi.mocked(actions.getActiveSession).mockResolvedValueOnce(studyState as never)
      renderStudy()
      const row = await screen.findByTestId('study-compact-row')
      // first thing in the session column, so the question starts right under it
      expect(row.parentElement!.firstElementChild).toBe(row)
      expect(row).toHaveTextContent('Question 1 of 3')
      expect(row).toHaveTextContent('Week 1 · Introduction to Political Economy')
      expect(row).toHaveTextContent(/Elapsed: \d+:\d\d/)

      const endSession = screen.getByRole('button', { name: 'End Session' })
      const actionsRow = endSession.parentElement!
      expect(actionsRow.className).toContain('max-xl:hidden')
      expect(screen.getByTestId('top-nav').className).toContain('max-xl:hidden')
      // the full timer (target + bar) is hidden too
      expect(screen.getByText(/Target:/).closest('.max-xl\\:hidden')).not.toBeNull()
      // only the bottom Previous / Next are visible below xl
      expect(screen.getByRole('button', { name: /^Previous$/ }).className).not.toContain('max-xl:hidden')

      const toggle = screen.getByRole('button', { name: 'Session options' })
      expect(toggle).toHaveAttribute('aria-expanded', 'false')
      fireEvent.click(toggle)
      expect(toggle).toHaveAttribute('aria-expanded', 'true')
      expect(actionsRow.className).not.toContain('max-xl:hidden')
      expect(screen.getByText(/Target:/).closest('.max-xl\\:hidden')).toBeNull()
      expect(document.getElementById('study-panel')).toHaveTextContent('Question 1 of 3')
    })
  })
})
