import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ConfigureSessionDialog } from './ConfigureSessionDialog'
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

  const renderComponent = () => {
    return render(
      <Dialog open={true}>
        <ConfigureSessionDialog
          topics={mockTopics}
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

  it('renders the course filters correctly', () => {
    renderComponent()
    expect(screen.getByText('Course')).toBeInTheDocument()
    expect(screen.getByText('14.750x')).toBeInTheDocument()
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
