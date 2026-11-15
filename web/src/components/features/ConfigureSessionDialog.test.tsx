import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { ConfigureSessionDialog, questionCountOptions } from './ConfigureSessionDialog'
import { Dialog } from '@/components/ui/dialog'

describe('ConfigureSessionDialog Component', () => {
  const mockSetSelectedTopics = vi.fn()
  const mockSetSessionDuration = vi.fn()
  const mockSetQuestionCount = vi.fn()
  const mockOnStartSession = vi.fn()

  const mockTopics = [
    {
      id: 'topic-1',
      title: 'Supply and Demand',
      week: 'Week_01_Intro',
      className: 'Class_1_Intro',
      course: { code: '14.750x' }
    },
    {
      id: 'topic-2',
      title: 'Corruption and Leaders',
      week: 'Week_02_Leaders',
      className: 'Class_2_Leaders',
      course: { code: '14.750x' }
    }
  ]

  const renderComponent = (extra: { examPreset?: { label: string; questionCount: number } | null; topics?: typeof mockTopics } = {}) => {
    return render(
      <Dialog open={true}>
        <ConfigureSessionDialog
          topics={extra.topics ?? mockTopics}
          examPreset={extra.examPreset}
          selectedTopics={[]}
          setSelectedTopics={mockSetSelectedTopics}
          sessionDuration={300}
          setSessionDuration={mockSetSessionDuration}
          questionCount={10}
          setQuestionCount={mockSetQuestionCount}
          onStartSession={mockOnStartSession}
          isLoading={false}
        />
      </Dialog>
    )
  }

  it('renders duration and question count select dropdowns', () => {
    renderComponent()
    expect(screen.getByText('Configure Study Session')).toBeInTheDocument()
    expect(screen.getByText('Practice Duration')).toBeInTheDocument()
    expect(screen.getByText('Number of Questions')).toBeInTheDocument()
  })

  it('renders and toggles to Timed Exam mode with specific elements', () => {
    renderComponent()
    
    // Find the Mode select dropdown
    const modeSelect = screen.getByLabelText('Session Mode') as HTMLSelectElement
    expect(modeSelect).toBeInTheDocument()
    expect(modeSelect.value).toBe('study')

    // Toggle mode to Exam Mode
    fireEvent.change(modeSelect, { target: { value: 'exam' } })
    
    // Verify Exam Duration label and Start Timed Exam button appear
    expect(screen.getByText('Exam Duration')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /📋 Start Timed Exam/i })).toBeInTheDocument()
  })

  it('hides the course filter when the topics belong to a single course (a studyspace)', () => {
    renderComponent()
    expect(screen.queryByText('Course')).not.toBeInTheDocument()
  })

  it('shows the course filter when topics of several courses are listed', () => {
    renderComponent({ topics: [...mockTopics, { ...mockTopics[0], id: 'topic-3', course: { code: 'JPAL102x' } }] })
    expect(screen.getByText('Course')).toBeInTheDocument()
    expect(screen.getByText('JPAL102x')).toBeInTheDocument()
  })

  it('labels the grouping "Module", never "Week"', () => {
    renderComponent()
    expect(screen.getByText('Module')).toBeInTheDocument()
    expect(screen.queryByText('Week')).not.toBeInTheDocument()
  })

  it('offers 5, 10, 20, 50 questions and the studyspace exam preset', () => {
    renderComponent({ examPreset: { label: '14.750x Final', questionCount: 32 } })
    const select = screen.getByDisplayValue('10 Questions') as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      '5 Questions',
      '10 Questions',
      '20 Questions',
      '32 Questions (14.750x Final)',
      '50 Questions',
    ])
    expect(screen.queryByText(/JPAL102x Final/)).not.toBeInTheDocument()
  })

  it('shows why a start failed, above the start button', () => {
    render(
      <Dialog open={true}>
        <ConfigureSessionDialog topics={mockTopics} selectedTopics={[]} setSelectedTopics={mockSetSelectedTopics}
          sessionDuration={300} setSessionDuration={mockSetSessionDuration} questionCount={10} setQuestionCount={mockSetQuestionCount}
          onStartSession={mockOnStartSession} isLoading={false} errorMessage="The session could not be started." />
      </Dialog>
    )
    expect(screen.getByRole('alert')).toHaveTextContent('The session could not be started.')
  })

  it('offers only the standard counts without a preset', () => {
    renderComponent({ examPreset: null })
    const select = screen.getByDisplayValue('10 Questions') as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['5', '10', '20', '50'])
  })

  it('does not repeat a count the preset shares with the standard ones', () => {
    expect(questionCountOptions({ label: 'Final', questionCount: 50 })).toEqual([
      { value: 5, label: '5 Questions' },
      { value: 10, label: '10 Questions' },
      { value: 20, label: '20 Questions' },
      { value: 50, label: '50 Questions (Final)' },
    ])
    expect(questionCountOptions({ label: 'Final', questionCount: 53 }).map((o) => o.value)).toEqual([5, 10, 20, 50, 53])
  })

  it('renders topics with correct titles and tags', () => {
    renderComponent()
    expect(screen.getAllByText('Supply and Demand')[0]).toBeInTheDocument()
    expect(screen.getAllByText('Corruption and Leaders')[0]).toBeInTheDocument()
  })

  it('calls start session handler on start button click', () => {
    renderComponent()
    const startButton = screen.getByRole('button', { name: /Start Random Session/i })
    fireEvent.click(startButton)
    expect(mockOnStartSession).toHaveBeenCalled()
  })

  it('with no filter and nothing ticked, says all topics are used and starts with the whole scope', () => {
    renderComponent()
    expect(screen.getByTestId('topic-scope-summary')).toHaveTextContent('All topics of 14.750x will be used.')
    fireEvent.click(screen.getByRole('button', { name: /Start Random Session/i }))
    expect(mockOnStartSession.mock.calls.at(-1)?.[6]).toEqual([])
  })

  it('with a filter set and nothing ticked, starts with exactly the topics the filter matches and says so', () => {
    mockOnStartSession.mockClear()
    renderComponent()
    fireEvent.click(screen.getAllByText('Week 02 Leaders')[0])
    expect(screen.getByTestId('topic-scope-summary')).toHaveTextContent('1 topic matching Week 02 Leaders will be used.')
    fireEvent.click(screen.getByRole('button', { name: /Start Focused Session/i }))
    expect(mockOnStartSession.mock.calls[0][6]).toEqual(['topic-2'])
  })

  it('explicit selections win over filters', () => {
    mockOnStartSession.mockClear()
    render(
      <Dialog open={true}>
        <ConfigureSessionDialog topics={mockTopics} selectedTopics={['topic-1']} setSelectedTopics={mockSetSelectedTopics}
          sessionDuration={300} setSessionDuration={mockSetSessionDuration} questionCount={10} setQuestionCount={mockSetQuestionCount}
          onStartSession={mockOnStartSession} isLoading={false} />
      </Dialog>
    )
    expect(screen.getByTestId('topic-scope-summary')).toHaveTextContent('1 selected topic will be used.')
    fireEvent.click(screen.getByRole('button', { name: /Start Focused Session/i }))
    expect(mockOnStartSession.mock.calls[0][6]).toEqual(['topic-1'])
  })

  it('cannot start when the search matches no topic', () => {
    renderComponent()
    fireEvent.change(screen.getByPlaceholderText(/Search topics/i), { target: { value: 'nothing like this' } })
    expect(screen.getByTestId('topic-scope-summary')).toHaveTextContent('No topic matches')
    expect(screen.getByRole('button', { name: /Start Focused Session/i })).toBeDisabled()
  })

  describe('goals, summary and remembered settings', () => {
    const counted = [
      { id: 'w1a', title: 'A', week: 'Week 01', className: 'C1', course: { id: 'c1', code: 'x' }, totalExercises: 12, uniquelyCompleted: 4, accuracy: 50, groupCount: 0, groupedExercises: 0 },
      { id: 'w1b', title: 'B', week: 'Week 01', className: 'C1', course: { id: 'c1', code: 'x' }, totalExercises: 8, uniquelyCompleted: 0, accuracy: null, groupCount: 1, groupedExercises: 5 },
      { id: 'w2a', title: 'C', week: 'Week 02', className: 'C2', course: { id: 'c1', code: 'x' }, totalExercises: 30, uniquelyCompleted: 30, accuracy: 90, groupCount: 0, groupedExercises: 0 },
    ]
    const renderCounted = (count = 10) => render(
      <Dialog open={true}>
        <ConfigureSessionDialog topics={counted} selectedTopics={[]} setSelectedTopics={mockSetSelectedTopics}
          sessionDuration={300} setSessionDuration={mockSetSessionDuration} questionCount={count} setQuestionCount={mockSetQuestionCount}
          onStartSession={mockOnStartSession} isLoading={false} examPreset={{ label: 'Final', questionCount: 32 }} />
      </Dialog>
    )

    it('says what the selection holds and what the session will draw', () => {
      renderCounted()
      expect(screen.getByTestId('session-summary')).toHaveTextContent('50 course questions in this selection (16 not seen yet), including 1 multi-part problem (5 parts).')
      // 10 questions at the default 50% mix: 5 from the course, 5 written
      expect(screen.getByTestId('session-summary')).toHaveTextContent('10 questions - 5 from the course, 5 written by the AI')
      fireEvent.click(screen.getByText('Week 01'))
      expect(screen.getByTestId('session-summary')).toHaveTextContent('20 course questions in this selection (16 not seen yet)')
    })

    it('warns when the course cannot cover the mix', () => {
      renderCounted(50)
      fireEvent.change(screen.getByDisplayValue('50% Ingested / 50% AI-Generated'), { target: { value: '0' } })
      fireEvent.click(screen.getByText('Week 01'))
      // 20 course questions for 50 asked: the AI writes the other 30
      expect(screen.getByTestId('session-summary')).toHaveTextContent('50 questions - 20 from the course, 30 written by the AI')
      expect(screen.getByTestId('session-summary')).toHaveTextContent('The course has only 20 questions for this selection, so the AI writes the rest.')
    })

    it('a goal sets mode, length and mix; the exam goal uses the studyspace exam size', () => {
      mockSetQuestionCount.mockClear()
      mockSetSessionDuration.mockClear()
      renderCounted()
      fireEvent.click(screen.getByRole('button', { name: 'Exam simulation' }))
      expect(mockSetQuestionCount).toHaveBeenLastCalledWith(32)
      expect((screen.getByLabelText('Session Mode') as HTMLSelectElement).value).toBe('exam')
      expect(screen.getByRole('button', { name: /Start Timed Exam/i })).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Weak spots' }))
      expect(mockSetQuestionCount).toHaveBeenLastCalledWith(20)
      expect(mockSetSessionDuration).toHaveBeenLastCalledWith(1800)
      expect((screen.getByLabelText('Session Mode') as HTMLSelectElement).value).toBe('study')
      expect(screen.getByText(/Current strategy is locked to: 80% Worst Topics/)).toBeInTheDocument()
    })

    it('the Problems goal selects the topics that hold multi-part problems', () => {
      mockSetSelectedTopics.mockClear()
      renderCounted()
      fireEvent.click(screen.getByRole('button', { name: 'Problems' }))
      expect(mockSetSelectedTopics).toHaveBeenLastCalledWith(['w1b'])
    })

    it('keeps the settings of a started session and offers them next time', () => {
      window.localStorage.clear()
      mockOnStartSession.mockClear()
      const first = renderCounted()
      expect(screen.queryByRole('button', { name: 'Same as last time' })).not.toBeInTheDocument()
      fireEvent.click(screen.getByText('Week 02'))
      fireEvent.click(screen.getByRole('button', { name: /Start Focused Session/i }))
      expect(window.localStorage.getItem('feynman:session-config:c1')).toContain('"weeks":["Week 02"]')
      first.unmount()
      renderCounted()
      fireEvent.click(screen.getByRole('button', { name: 'Same as last time' }))
      expect(screen.getByText('Week 02').closest('button')?.getAttribute('aria-pressed')).toBe('true')
      window.localStorage.clear()
    })
  })
  describe('kind filter (homework or finger exercises)', () => {
    const kinds = [
      { id: 'h1', title: 'HW 1', week: 'Week 01', className: 'Homework', course: { id: 'c9', code: 'x' }, totalExercises: 10, uniquelyCompleted: 0, accuracy: null, groupCount: 1, groupedExercises: 4 },
      { id: 'f1', title: 'FE 1', week: 'Week 01', className: 'Finger exercises', course: { id: 'c9', code: 'x' }, totalExercises: 30, uniquelyCompleted: 0, accuracy: null },
      { id: 'f2', title: 'FE 2', week: 'Week 02', className: 'Finger exercises', course: { id: 'c9', code: 'x' }, totalExercises: 20, uniquelyCompleted: 0, accuracy: null },
      { id: 'l1', title: 'Lecture', week: 'Week 01', className: 'Insurance II', course: { id: 'c9', code: 'x' }, totalExercises: 0, uniquelyCompleted: 0, accuracy: null },
    ]
    const renderKinds = (list = kinds) => render(
      <Dialog open={true}>
        <ConfigureSessionDialog topics={list} selectedTopics={[]} setSelectedTopics={mockSetSelectedTopics}
          sessionDuration={300} setSessionDuration={mockSetSessionDuration} questionCount={10} setQuestionCount={mockSetQuestionCount}
          onStartSession={mockOnStartSession} isLoading={false} />
      </Dialog>
    )

    it('is shown when the studyspace has homework or finger exercises, and not otherwise', () => {
      const first = renderKinds()
      expect(screen.getByTestId('kind-filter')).toBeInTheDocument()
      expect(within(screen.getByTestId('kind-filter')).getByRole('button', { name: 'Homework' })).toBeInTheDocument()
      expect(within(screen.getByTestId('kind-filter')).getByRole('button', { name: 'Finger exercises' })).toBeInTheDocument()
      first.unmount()
      renderKinds(mockTopics as never)
      expect(screen.queryByTestId('kind-filter')).not.toBeInTheDocument()
    })

    it('Homework narrows the summary and the session to the homework topics; Both lifts it', () => {
      mockOnStartSession.mockClear()
      renderKinds()
      expect(screen.getByTestId('session-summary')).toHaveTextContent('60 course questions in this selection')
      fireEvent.click(within(screen.getByTestId('kind-filter')).getByRole('button', { name: 'Homework' }))
      expect(screen.getByTestId('session-summary')).toHaveTextContent('10 course questions in this selection')
      expect(screen.getByTestId('session-summary')).toHaveTextContent('including 1 multi-part problem (4 parts)')
      fireEvent.click(screen.getByRole('button', { name: /Start Focused Session/i }))
      expect(mockOnStartSession.mock.calls[0][6]).toEqual(['h1'])
      fireEvent.click(within(screen.getByTestId('kind-filter')).getByRole('button', { name: 'Finger exercises' }))
      expect(screen.getByTestId('session-summary')).toHaveTextContent('50 course questions in this selection')
      fireEvent.click(within(screen.getByTestId('kind-filter')).getByRole('button', { name: 'Both' }))
      expect(screen.getByTestId('session-summary')).toHaveTextContent('60 course questions in this selection')
    })

    it('keeps the kind when the weeks change', () => {
      renderKinds()
      const kindBar = within(screen.getByTestId('kind-filter'))
      fireEvent.click(kindBar.getByRole('button', { name: 'Finger exercises' }))
      fireEvent.click(screen.getByText('Week 01'))
      expect(screen.getByTestId('session-summary')).toHaveTextContent('30 course questions in this selection')
      fireEvent.click(screen.getByText('Week 02'))
      expect(screen.getByTestId('session-summary')).toHaveTextContent('50 course questions in this selection')
      expect(kindBar.getByRole('button', { name: 'Finger exercises' }).getAttribute('aria-pressed')).toBe('true')
    })

    it('works together with the ticked weeks', () => {
      renderKinds()
      fireEvent.click(screen.getByText('Week 02'))
      fireEvent.click(within(screen.getByTestId('kind-filter')).getByRole('button', { name: 'Finger exercises' }))
      expect(screen.getByTestId('session-summary')).toHaveTextContent('20 course questions in this selection')
      // Week 02 has no homework: the Homework chip disappears
      expect(within(screen.getByTestId('kind-filter')).queryByRole('button', { name: 'Homework' })).not.toBeInTheDocument()
    })
  })
})

