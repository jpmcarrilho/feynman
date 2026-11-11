import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Flashcard } from './Flashcard'

const props = {
  questionText: 'Explain why entropy rises.',
  exerciseType: 'open',
  choices: [] as string[],
  correctAnswer: 'MODEL ANSWER TEXT',
  explanation: null,
  onAnswer: vi.fn(),
  openProps: { sessionId: 's1', exerciseId: 'e1', keyPoints: ['KP one', 'KP two'], onCheck: vi.fn() },
}

describe('Flashcard with a written question', () => {
  it('renders the text area and a Check button in the confirm bar, no choices', () => {
    render(<Flashcard {...props} />)
    expect(screen.getByLabelText('Your answer')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check answer' })).toBeDisabled()
    expect(document.body.textContent).not.toContain('MODEL ANSWER TEXT')
  })
  it('exam mode: draft changes reach onAnswer, no Check button and no model answer', () => {
    const onAnswer = vi.fn()
    render(<Flashcard {...props} isExamMode onAnswer={onAnswer} />)
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'my draft' } })
    expect(onAnswer).toHaveBeenCalledWith(false, 'my draft')
    expect(screen.queryByRole('button', { name: /check/i })).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain('MODEL ANSWER TEXT')
    expect(document.body.textContent).not.toContain('KP one')
  })
  it('report reason is worded for a written question', () => {
    render(<Flashcard {...props} onReport={async () => true} />)
    fireEvent.click(screen.getByText('Report question'))
    expect(screen.getByText('The model answer or the check is wrong')).toBeInTheDocument()
  })
  it('a stored log shows the result, and the tutor button asks with the written answer', () => {
    const onRequestExplanation = vi.fn()
    render(<Flashcard {...props} hasBeenAnswered initialSelectedChoice="my words" onRequestExplanation={onRequestExplanation}
      openProps={{ ...props.openProps, log: { userAnswer: 'my words', score: 0.5, isCorrect: false, gradedBy: 'model', feedback: null } }} />)
    expect(screen.getByTestId('answer-result')).toHaveTextContent('Partially correct')
    fireEvent.click(screen.getByRole('button', { name: 'Discuss my answer with the tutor' }))
    expect(onRequestExplanation).toHaveBeenCalledWith('my words')
  })
})
