import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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
    expect(screen.getByText('Official Explanation:')).toBeInTheDocument()
    
    expect(screen.queryByText('Ask Voice Tutor to Explain My Mistake')).not.toBeInTheDocument()
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
})
