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
})
