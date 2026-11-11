import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { Flashcard } from './Flashcard'

describe('Flashcard Component', () => {
  const defaultProps = {
    questionText: 'What is the capital of France?',
    choices: ['London', 'Berlin', 'Paris', 'Madrid'],
    correctAnswer: 'Paris',
    explanation: 'Paris is the capital of France.',
    onAnswer: vi.fn(),
    onRequestExplanation: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders question and choices', () => {
    render(<Flashcard {...defaultProps} />)
    expect(screen.getByText('What is the capital of France?')).toBeInTheDocument()
    expect(screen.getByText('Paris')).toBeInTheDocument()
  })

  it('handles correct answer selection', () => {
    render(<Flashcard {...defaultProps} />)
    const correctChoice = screen.getByText('Paris')
    fireEvent.click(correctChoice)
    
    expect(defaultProps.onAnswer).toHaveBeenCalledWith(true, 'Paris')
    expect(screen.getByText("Professor's Explanation:")).toBeInTheDocument()
    })

  it('handles incorrect answer selection and triggers callback', () => {
    render(<Flashcard {...defaultProps} />)
    const wrongChoice = screen.getByText('London')
    fireEvent.click(wrongChoice)
    
    expect(defaultProps.onAnswer).toHaveBeenCalledWith(false, 'London')
    
    const explainButton = screen.getByText('Ask Voice Tutor to Explain My Mistake')
    expect(explainButton).toBeInTheDocument()

    fireEvent.click(explainButton)

    expect(defaultProps.onRequestExplanation).toHaveBeenCalledWith('London')
    expect(screen.getByText('Asking Tutor... Check the chat sidebar.')).toBeInTheDocument()
  })

  it('handles standard pipe-separated dropdown questions', () => {
    const dropdownProps = {
      questionText: 'Controlling for weapon type is crucial because weapon choice is correlated with assassination [Dropdown 1] and might also directly affect [Dropdown 2].',
      exerciseType: 'dropdown',
      choices: [
        '[Dropdown 1] success',
        '[Dropdown 1] timing',
        '[Dropdown 2] institutional outcomes',
        '[Dropdown 2] country size'
      ],
      correctAnswer: '[Dropdown 1] success | [Dropdown 2] institutional outcomes',
      explanation: 'Guns are systematically more successful than bombs.',
      onAnswer: vi.fn(),
      onRequestExplanation: vi.fn(),
    }

    render(<Flashcard {...dropdownProps} />)
    
    const dropdowns = screen.getAllByRole('combobox')
    expect(dropdowns).toHaveLength(2)

    fireEvent.change(dropdowns[0], { target: { value: 'success' } })
    fireEvent.change(dropdowns[1], { target: { value: 'institutional outcomes' } })

    const submitBtn = screen.getByRole('button', { name: 'Submit Answer' })
    fireEvent.click(submitBtn)

    expect(dropdownProps.onAnswer).toHaveBeenCalledWith(true, JSON.stringify({
      '[Dropdown 1]': 'success',
      '[Dropdown 2]': 'institutional outcomes'
    }))
  })

  it('handles JSON array dropdown questions', () => {
    const dropdownProps = {
      questionText: 'Fill in the blanks: Since 1870, countries have been [Dropdown 1] in constant GDP per capita and [Dropdown 2].',
      exerciseType: 'dropdown',
      choices: [
        '[Dropdown 1] converging',
        '[Dropdown 1] diverging',
        '[Dropdown 2] increasing',
        '[Dropdown 2] decreasing'
      ],
      correctAnswer: '["[Dropdown 1] diverging","[Dropdown 2] increasing"]',
      explanation: 'Since 1870, GDP has been diverging.',
      onAnswer: vi.fn(),
      onRequestExplanation: vi.fn(),
    }

    render(<Flashcard {...dropdownProps} />)
    
    const dropdowns = screen.getAllByRole('combobox')
    expect(dropdowns).toHaveLength(2)

    fireEvent.change(dropdowns[0], { target: { value: 'diverging' } })
    fireEvent.change(dropdowns[1], { target: { value: 'increasing' } })

    const submitBtn = screen.getByRole('button', { name: 'Submit Answer' })
    fireEvent.click(submitBtn)

    expect(dropdownProps.onAnswer).toHaveBeenCalledWith(true, JSON.stringify({
      '[Dropdown 1]': 'diverging',
      '[Dropdown 2]': 'increasing'
    }))
  })

  describe('report control', () => {
    it('is absent without onReport', () => {
      render(<Flashcard {...defaultProps} />)
      expect(screen.queryByText('Report question')).not.toBeInTheDocument()
    })

    it('reports nothing on a single tap: it takes opening the form, choosing a reason and pressing Send', async () => {
      const onReport = vi.fn().mockResolvedValue(true)
      render(<Flashcard {...defaultProps} onReport={onReport} />)
      fireEvent.click(screen.getByText('Report question'))
      expect(onReport).not.toHaveBeenCalled()
      // No reason is preselected and Send is disabled
      expect(screen.getByText('Send report').closest('button')).toBeDisabled()
      fireEvent.click(screen.getByLabelText('The marked answer is wrong'))
      expect(onReport).not.toHaveBeenCalled()
      fireEvent.click(screen.getByText('Send report'))
      await waitFor(() => expect(onReport).toHaveBeenCalledWith('wrong_answer'))
      expect(await screen.findByText(/it won.t be shown again/)).toBeInTheDocument()
    })

    it('Cancel closes the form without reporting; a failed report can be retried', async () => {
      const onReport = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
      render(<Flashcard {...defaultProps} onReport={onReport} />)
      fireEvent.click(screen.getByText('Report question'))
      fireEvent.click(screen.getByText('Cancel'))
      expect(onReport).not.toHaveBeenCalled()
      expect(screen.getByText('Report question')).toBeInTheDocument()

      fireEvent.click(screen.getByText('Report question'))
      fireEvent.click(screen.getByLabelText('The question is unclear'))
      fireEvent.click(screen.getByText('Send report'))
      expect(await screen.findByText(/could not be saved/)).toBeInTheDocument()
      fireEvent.click(screen.getByText('Send report'))
      expect(await screen.findByText(/it won.t be shown again/)).toBeInTheDocument()
      expect(onReport).toHaveBeenCalledTimes(2)
    })

    it('shows the notice instead of the control for an already reported question', () => {
      render(<Flashcard {...defaultProps} onReport={vi.fn()} reported />)
      expect(screen.getByText(/it won.t be shown again/)).toBeInTheDocument()
      expect(screen.queryByText('Report question')).not.toBeInTheDocument()
    })
  })
})
