import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { OpenAnswer, type OpenAnswerProps } from './OpenAnswer'
import type { OpenCheckOutcome } from '@/lib/openAnswerClient'

const LONG = 'Entropy rises because there are more microstates available.'
const base: OpenAnswerProps = {
  sessionId: 's1',
  exerciseId: 'e1',
  mode: 'study',
  modelAnswer: 'The model answer has $x^2$ in it.',
  keyPoints: ['First point', 'Second point'],
  explanation: null,
}
const box = () => screen.getByLabelText('Your answer') as HTMLTextAreaElement
const type = (v: string) => fireEvent.change(box(), { target: { value: v } })
const draftKey = 'feynman_open_draft_s1_e1'

beforeEach(() => {
  localStorage.clear()
})

describe('OpenAnswer: writing', () => {
  it('has an accessible label, a counter, and Check is enabled from 15 non-space characters', () => {
    render(<OpenAnswer {...base} onCheck={vi.fn()} />)
    const check = screen.getByRole('button', { name: 'Check answer' })
    expect(box()).toHaveAttribute('maxlength', '2000')
    expect(screen.getByText('0 / 2000')).toBeInTheDocument()
    type('abc def ghi jkl mn') // 14 non-space chars
    expect(screen.getByText(/not counting spaces/)).toBeInTheDocument()
    expect(check).toBeDisabled()
    type('abc def ghi jkl mno') // 15
    expect(check).toBeEnabled()
    expect(screen.getByText('19 / 2000')).toBeInTheDocument()
  })

  it('caps the text at 2000 characters', () => {
    render(<OpenAnswer {...base} onCheck={vi.fn()} />)
    type('a'.repeat(2500))
    expect(box().value).toHaveLength(2000)
  })

  it('shows a result with label, feedback, key point statuses as text, the model answer and (self-assessed) never for a model grade', async () => {
    const onCheck = vi.fn().mockResolvedValue({
      status: 'stored', score: 0.5, isCorrect: false, gradedBy: 'model',
      feedback: { v: 1, keyPoints: [{ point: 'First point', status: 'covered' }, { point: 'Second point', status: 'missing' }], misconceptions: [], text: 'You had the first idea but not the second.' },
    } satisfies OpenCheckOutcome)
    render(<OpenAnswer {...base} onCheck={onCheck} explanation="Common slip." />)
    type(LONG)
    fireEvent.click(screen.getByRole('button', { name: 'Check answer' }))
    await waitFor(() => expect(screen.getByTestId('answer-result')).toHaveTextContent('Partially correct: 0.5 of 1'))
    expect(onCheck).toHaveBeenCalledWith(LONG, undefined)
    expect(screen.getByText('You had the first idea but not the second.')).toBeInTheDocument()
    expect(screen.getByTestId('open-key-points')).toHaveTextContent('Covered:')
    expect(screen.getByTestId('open-key-points')).toHaveTextContent('Missing:')
    expect(screen.getByText('Model answer')).toBeInTheDocument()
    expect(document.querySelector('.katex')).not.toBeNull()
    expect(screen.getByText('Common slip.')).toBeInTheDocument()
    expect(screen.queryByText(/self-assessed/)).not.toBeInTheDocument()
    // draft removed once committed
    expect(localStorage.getItem(draftKey)).toBeNull()
  })

  it('shows the student text as plain text, not Markdown', async () => {
    const onCheck = vi.fn().mockResolvedValue({ status: 'stored', score: 1, isCorrect: true, gradedBy: 'model', feedback: null })
    render(<OpenAnswer {...base} onCheck={onCheck} />)
    const md = '**bold words** and $x^2$ here'
    type(md)
    fireEvent.click(screen.getByRole('button', { name: 'Check answer' }))
    const el = await screen.findByTestId('open-student-answer')
    expect(el.textContent).toBe(md)
    expect(el.querySelector('strong')).toBeNull()
    expect(el.querySelector('.katex')).toBeNull()
  })

  it('disables Check and makes the text read-only while checking, and sends only one request on a double click', async () => {
    let resolve!: (o: OpenCheckOutcome) => void
    const onCheck = vi.fn(() => new Promise<OpenCheckOutcome>((r) => { resolve = r }))
    render(<OpenAnswer {...base} onCheck={onCheck} />)
    type(LONG)
    const check = screen.getByRole('button', { name: 'Check answer' })
    fireEvent.click(check)
    fireEvent.click(check)
    expect(onCheck).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: /Checking your answer/ })).toBeDisabled()
    expect(box()).toHaveAttribute('readonly')
    await act(async () => { resolve({ status: 'stored', score: 1, isCorrect: true, gradedBy: 'model', feedback: null }) })
    await waitFor(() => expect(screen.getByTestId('answer-result')).toHaveTextContent('Correct'))
    expect(onCheck).toHaveBeenCalledTimes(1)
  })

  it('unchecked: shows the model answer and three self-assessment buttons; choosing one stores (self-assessed)', async () => {
    const onCheck = vi.fn()
      .mockResolvedValueOnce({ status: 'unchecked' })
      .mockResolvedValueOnce({ status: 'stored', score: 0.5, isCorrect: false, gradedBy: 'self', feedback: { v: 1, keyPoints: [], misconceptions: [], text: '', selfScore: 0.5 } })
    render(<OpenAnswer {...base} onCheck={onCheck} />)
    type(LONG)
    fireEvent.click(screen.getByRole('button', { name: 'Check answer' }))
    const panel = await screen.findByTestId('open-unchecked')
    expect(panel).toHaveTextContent('not available right now')
    expect(panel).toHaveTextContent('Model answer')
    for (const n of ['I had all of it', 'Some of it', 'Not really']) expect(screen.getByRole('button', { name: n })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Some of it' }))
    await waitFor(() => expect(screen.getByTestId('answer-result')).toHaveTextContent('(self-assessed)'))
    expect(onCheck).toHaveBeenLastCalledWith(LONG, 0.5)
  })

  it('keeps the answer and says so when the check call fails', async () => {
    render(<OpenAnswer {...base} onCheck={vi.fn().mockRejectedValue(new Error('x'))} />)
    type(LONG)
    fireEvent.click(screen.getByRole('button', { name: 'Check answer' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('try again')
    expect(box().value).toBe(LONG)
    expect(screen.getByRole('button', { name: 'Check answer' })).toBeEnabled()
  })
})

describe('OpenAnswer: study draft', () => {
  it('saves the draft in localStorage, restores it on mount and removes it when emptied', () => {
    const { unmount } = render(<OpenAnswer {...base} onCheck={vi.fn()} />)
    type(LONG)
    expect(localStorage.getItem(draftKey)).toBe(LONG)
    unmount()
    render(<OpenAnswer {...base} onCheck={vi.fn()} />)
    expect(box().value).toBe(LONG)
    type('')
    expect(localStorage.getItem(draftKey)).toBeNull()
  })
  it('works when storage throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('no') })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('no') })
    render(<OpenAnswer {...base} onCheck={vi.fn()} />)
    expect(() => type(LONG)).not.toThrow()
    expect(box().value).toBe(LONG)
    spy.mockRestore(); set.mockRestore()
  })
})

describe('OpenAnswer: exam mode', () => {
  it('has no Check button, reports drafts only and shows nothing of the model answer', () => {
    const onDraft = vi.fn()
    const onCheck = vi.fn()
    render(<OpenAnswer {...base} mode="exam" initialAnswer="saved draft" onDraft={onDraft} onCheck={onCheck} />)
    expect(box().value).toBe('saved draft')
    expect(screen.queryByRole('button', { name: /check/i })).not.toBeInTheDocument()
    type('new text')
    expect(onDraft).toHaveBeenCalledWith('new text')
    expect(onCheck).not.toHaveBeenCalled()
    expect(localStorage.length).toBe(0)
    expect(screen.queryByText('Model answer')).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain('The model answer has')
    expect(document.body.textContent).not.toContain('First point')
  })
})

describe('OpenAnswer: stored results', () => {
  it('a pending exam answer reads Not checked yet and shows the model answer', () => {
    render(<OpenAnswer {...base} mode="study" reviewing log={{ userAnswer: 'my words here', score: 0, isCorrect: false, gradedBy: 'pending', feedback: null }} />)
    expect(screen.getByTestId('answer-result')).toHaveTextContent('Not checked yet')
    expect(screen.getByText('Model answer')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Discuss/ })).not.toBeInTheDocument()
  })
  it('an empty submitted answer reads Not answered', () => {
    render(<OpenAnswer {...base} reviewing log={{ userAnswer: '', score: 0, isCorrect: false, gradedBy: null }} />)
    expect(screen.getByTestId('answer-result')).toHaveTextContent('Not answered')
  })
  it('offers the tutor button below a full score only', () => {
    const onDiscuss = vi.fn()
    const { rerender } = render(<OpenAnswer {...base} onDiscuss={onDiscuss} log={{ userAnswer: 'my words here', score: 0.5, isCorrect: false, gradedBy: 'model', feedback: null }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Discuss my answer with the tutor' }))
    expect(onDiscuss).toHaveBeenCalledTimes(1)
    rerender(<OpenAnswer {...base} onDiscuss={onDiscuss} log={{ userAnswer: 'my words here', score: 1, isCorrect: true, gradedBy: 'model', feedback: null }} />)
    expect(screen.queryByRole('button', { name: /Discuss/ })).not.toBeInTheDocument()
  })
})
