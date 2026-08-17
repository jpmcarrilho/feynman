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
})
