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

  it('handles correct answer selection: tapping only selects, "Check answer" commits', () => {
    render(<Flashcard {...defaultProps} />)
    const checkButton = screen.getByRole('button', { name: 'Check answer' })
    expect(checkButton).toBeDisabled()

    fireEvent.click(screen.getByText('Paris'))
    expect(defaultProps.onAnswer).not.toHaveBeenCalled()
    expect(screen.queryByText("Professor's Explanation:")).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Paris' })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(checkButton)
    expect(defaultProps.onAnswer).toHaveBeenCalledTimes(1)
    expect(defaultProps.onAnswer).toHaveBeenCalledWith(true, 'Paris')
    expect(screen.getByText("Professor's Explanation:")).toBeInTheDocument()
    expect(screen.getByTestId('answer-result')).toHaveTextContent('Correct')
  })

  it('lets the student change the selection before confirming', () => {
    render(<Flashcard {...defaultProps} />)
    fireEvent.click(screen.getByText('London'))
    fireEvent.click(screen.getByText('Berlin'))
    expect(screen.getByRole('button', { name: 'London' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Berlin' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Check answer' }))
    expect(defaultProps.onAnswer).toHaveBeenCalledTimes(1)
    expect(defaultProps.onAnswer).toHaveBeenCalledWith(false, 'Berlin')
    expect(screen.getByTestId('answer-result')).toHaveTextContent('Incorrect')
  })

  it('handles incorrect answer selection and triggers callback', () => {
    render(<Flashcard {...defaultProps} />)
    const wrongChoice = screen.getByText('London')
    fireEvent.click(wrongChoice)
    fireEvent.click(screen.getByRole('button', { name: 'Check answer' }))
    
    expect(defaultProps.onAnswer).toHaveBeenCalledWith(false, 'London')
    
    const explainButton = screen.getByText('Ask Voice Tutor to Explain My Mistake')
    expect(explainButton).toBeInTheDocument()

    fireEvent.click(explainButton)

    expect(defaultProps.onRequestExplanation).toHaveBeenCalledWith('London')
    expect(screen.getByText('Asking Tutor... See the tutor panel.')).toBeInTheDocument()
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

    const submitBtn = screen.getByRole('button', { name: 'Check answer' })
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

    const submitBtn = screen.getByRole('button', { name: 'Check answer' })
    fireEvent.click(submitBtn)

    expect(dropdownProps.onAnswer).toHaveBeenCalledWith(true, JSON.stringify({
      '[Dropdown 1]': 'diverging',
      '[Dropdown 2]': 'increasing'
    }))
  })

  describe('partial credit and the server result', () => {
    const multiProps = {
      questionText: 'Which are prime?',
      exerciseType: 'multiple_choice',
      choices: ['2', '3', '4', '5'],
      correctAnswer: JSON.stringify(['2', '3', '5']),
      onAnswer: vi.fn(),
    }

    it('shows "Partially correct" with the score for a partly right multi-select', () => {
      render(<Flashcard {...multiProps} />)
      fireEvent.click(screen.getAllByLabelText('2')[0])
      fireEvent.click(screen.getByRole('button', { name: 'Check answer' }))
      const [isCorrect, answer] = multiProps.onAnswer.mock.calls[0]
      expect(isCorrect).toBe(false)
      expect(answer).toBe(JSON.stringify(['2']))
      expect(screen.getByTestId('answer-result').textContent).toMatch(/^Partially correct: 0\.\d+ of 1$/)
    })

    it('switches to the score the server stored when it differs from the immediate result', () => {
      const { rerender } = render(<Flashcard {...defaultProps} />)
      fireEvent.click(screen.getByText('London'))
      fireEvent.click(screen.getByRole('button', { name: 'Check answer' }))
      expect(screen.getByTestId('answer-result')).toHaveTextContent('Incorrect')
      rerender(<Flashcard {...defaultProps} result={{ score: 0.5, isCorrect: false }} />)
      expect(screen.getByTestId('answer-result')).toHaveTextContent('Partially correct: 0.5 of 1')
    })

    it('exposes the result in a polite live region that exists before the answer', () => {
      render(<Flashcard {...defaultProps} />)
      const region = screen.getByTestId('answer-result')
      expect(region).toHaveAttribute('aria-live', 'polite')
      expect(region).toBeEmptyDOMElement()
    })
  })

  describe('explain-my-mistake offer and answer display', () => {
    it('is not offered after a correct answer, but is after a partly right or wrong one', () => {
      const { unmount } = render(<Flashcard {...defaultProps} />)
      fireEvent.click(screen.getByText('Paris'))
      fireEvent.click(screen.getByRole('button', { name: 'Check answer' }))
      expect(screen.queryByText('Ask Voice Tutor to Explain My Mistake')).not.toBeInTheDocument()
      unmount()

      const multi = { questionText: 'Which are prime?', exerciseType: 'multiple_choice', choices: ['2', '3', '4'], correctAnswer: JSON.stringify(['2', '3']), onAnswer: vi.fn(), onRequestExplanation: vi.fn() }
      render(<Flashcard {...multi} />)
      fireEvent.click(screen.getAllByLabelText('2')[0])
      fireEvent.click(screen.getByRole('button', { name: 'Check answer' }))
      expect(screen.getByText('Ask Voice Tutor to Explain My Mistake')).toBeInTheDocument()
    })

    it('shows a dropdown answer key as readable lines without [Dropdown n]', () => {
      const props = {
        questionText: 'A [Dropdown 1] and B [Dropdown 2].',
        exerciseType: 'dropdown',
        choices: ['[Dropdown 1] x', '[Dropdown 1] y', '[Dropdown 2] p', '[Dropdown 2] q'],
        correctAnswer: JSON.stringify(['[Dropdown 1] x', '[Dropdown 2] p']),
        onAnswer: vi.fn(),
      }
      render(<Flashcard {...props} hasBeenAnswered initialSelectedChoice={JSON.stringify({ '[Dropdown 1]': 'y' })} />)
      const text = screen.getByText(/Correct Answer:/).parentElement!.textContent
      expect(text).toContain('Blank 1: x')
      expect(text).toContain('Blank 2: p')
      expect(text).not.toMatch(/\[Dropdown|"/)
    })
  })

  describe('a stored "Select an option" choice', () => {
    it('is not offered as an option: each select shows the one placeholder entry', () => {
      render(<Flashcard
        questionText="It is [Dropdown 1] and [Dropdown 2]."
        exerciseType="dropdown"
        choices={['[Dropdown 1] Select an option', '[Dropdown 1] hot', '[Dropdown 2] Select an option', '[Dropdown 2] cold']}
        correctAnswer={JSON.stringify(['[Dropdown 1] hot', '[Dropdown 2] cold'])}
        onAnswer={vi.fn()}
      />)
      for (const select of screen.getAllByRole('combobox')) {
        expect(Array.from((select as HTMLSelectElement).options).filter((o) => /select an option/i.test(o.textContent || ''))).toHaveLength(1)
      }
      expect(screen.getAllByRole('combobox')[0]).toHaveTextContent(/Select an option\s*hot/)
    })
  })

  describe('exam mode saves drafts without a button', () => {
    it('single choice: every tap is a draft and there is no confirm or save button', () => {
      render(<Flashcard {...defaultProps} isExamMode />)
      expect(screen.queryByRole('button', { name: /check answer|save answer|submit answer/i })).not.toBeInTheDocument()
      fireEvent.click(screen.getByText('London'))
      fireEvent.click(screen.getByText('Paris'))
      expect(defaultProps.onAnswer).toHaveBeenNthCalledWith(1, false, 'London')
      expect(defaultProps.onAnswer).toHaveBeenNthCalledWith(2, true, 'Paris')
      expect(screen.queryByTestId('answer-result')).toBeEmptyDOMElement()
    })

    it('multi-select: each toggle saves the draft and clearing everything saves an empty answer', () => {
      const onAnswer = vi.fn()
      render(<Flashcard questionText="Which are prime?" exerciseType="multiple_choice" choices={['2', '3', '4']} correctAnswer={JSON.stringify(['2', '3'])} isExamMode onAnswer={onAnswer} />)
      fireEvent.click(screen.getAllByLabelText('2')[0])
      fireEvent.click(screen.getAllByLabelText('3')[0])
      expect(onAnswer).toHaveBeenLastCalledWith(true, JSON.stringify(['2', '3']))
      fireEvent.click(screen.getAllByLabelText('2')[0])
      fireEvent.click(screen.getAllByLabelText('3')[0])
      expect(onAnswer).toHaveBeenLastCalledWith(false, '')
      expect(onAnswer).toHaveBeenCalledTimes(4)
    })

    it('numeric: typing saves the draft and emptying the field clears it', () => {
      const onAnswer = vi.fn()
      render(<Flashcard questionText="2+2?" exerciseType="numeric" choices={[]} correctAnswer="4" isExamMode onAnswer={onAnswer} />)
      const input = screen.getByLabelText('Your answer')
      fireEvent.change(input, { target: { value: '4' } })
      expect(onAnswer).toHaveBeenLastCalledWith(true, '4')
      fireEvent.change(input, { target: { value: '' } })
      expect(onAnswer).toHaveBeenLastCalledWith(false, '')
    })

    it('dropdown: choosing saves the draft', () => {
      const onAnswer = vi.fn()
      render(<Flashcard questionText="It is [Dropdown 1]." exerciseType="dropdown" choices={['[Dropdown 1] hot', '[Dropdown 1] cold']} correctAnswer="[Dropdown 1] hot" isExamMode onAnswer={onAnswer} />)
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'hot' } })
      expect(onAnswer).toHaveBeenLastCalledWith(true, JSON.stringify({ '[Dropdown 1]': 'hot' }))
    })
  })

  describe('numeric answers in study mode', () => {
    it('Enter in the number field confirms; the answer is not committed while typing', () => {
      const onAnswer = vi.fn()
      render(<Flashcard questionText="2+2?" exerciseType="numeric" choices={[]} correctAnswer="4" onAnswer={onAnswer} />)
      const input = screen.getByLabelText('Your answer')
      fireEvent.change(input, { target: { value: '4' } })
      expect(onAnswer).not.toHaveBeenCalled()
      fireEvent.submit(input.closest('form')!)
      expect(onAnswer).toHaveBeenCalledWith(true, '4')
    })
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
