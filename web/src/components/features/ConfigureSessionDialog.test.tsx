import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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
})
