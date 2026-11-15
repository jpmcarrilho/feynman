import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { Dialog } from '@/components/ui/dialog'
import { SessionResultsDialog } from './SessionResultsDialog'
import { SessionHistoryList } from './SessionHistoryList'
import { sessionHeadline, formatScore } from '@/lib/grading'

const actions = vi.hoisted(() => ({ getSessionDetail: vi.fn(), getSessionResults: vi.fn() }))
vi.mock('@/app/actions', () => actions)

const item = (position: number, answered: boolean) => ({
  position,
  exerciseId: `e${position}`,
  questionText: `Question text ${position + 1}`,
  correctAnswer: 'A',
  log: answered ? { isCorrect: true, score: 1, userAnswer: 'A' } : null,
})

// 10 questions, the 9th (position 8) never answered: the case that showed Q1..Q8 and Q10
const items = Array.from({ length: 10 }, (_, i) => item(i, i !== 8))
const history = {
  id: 's1',
  mode: 'study',
  startTime: '2026-11-11T10:00:00.000Z',
  exerciseCount: 10,
  logs: items.filter((i) => i.log).map((i) => ({ id: `l${i.position}`, exerciseId: i.exerciseId, isCorrect: true, score: 1, userAnswer: 'A', position: i.position })),
}

beforeEach(() => {
  vi.clearAllMocks()
  actions.getSessionDetail.mockResolvedValue({ chatLog: null })
  actions.getSessionResults.mockResolvedValue(items)
})

describe('SessionResultsDialog', () => {
  it('lists every question in position order, with unanswered ones marked and no gap in the numbering', async () => {
    render(<Dialog open><SessionResultsDialog selectedHistory={history} onLoadSession={() => {}} isLoading={false} /></Dialog>)
    await waitFor(() => expect(screen.getByText(/Q9: Question text 9/)).toBeInTheDocument())
    const labels = screen.getAllByText(/^Q\d+:/).map((el) => el.textContent?.match(/^Q(\d+):/)?.[1])
    expect(labels).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])
    expect(screen.getAllByText('Not answered')).toHaveLength(1)
    expect(actions.getSessionResults).toHaveBeenCalledWith('s1')
  })

  it('the headline equals the history list\'s value for the same data, with the unanswered question as a note', async () => {
    const { scoreSum, total } = sessionHeadline(history)
    const listValue = `${formatScore(scoreSum)}/${total}` // what SessionHistoryList renders
    expect(listValue).toBe('9/9')
    render(<Dialog open><SessionResultsDialog selectedHistory={history} onLoadSession={() => {}} isLoading={false} /></Dialog>)
    await waitFor(() => expect(screen.getByText(/Score:/).parentElement).toHaveTextContent('9 / 9 (9 fully correct, 1 not answered)'))
  })

  it.each([
    ['study with an unanswered question', history, '9/9'],
    ['exam with unanswered questions', {
      id: 'x1', mode: 'exam', status: 'completed', startTime: '2026-11-11T10:00:00.000Z', exerciseCount: 4,
      logs: [
        { id: 'a', exerciseId: 'e0', isCorrect: true, score: 1, userAnswer: 'A', position: 0 },
        { id: 'b', exerciseId: 'e1', isCorrect: false, score: 0.5, userAnswer: 'B', position: 1 },
        { id: 'c', exerciseId: 'e2', isCorrect: false, score: 0, userAnswer: '', position: 2 },
        { id: 'd', exerciseId: 'e3', isCorrect: false, score: 0, userAnswer: '', position: 3 },
      ],
    }, '1.5/4'],
  ])('list row and dialog show the same headline: %s', async (_name, data, expected) => {
    actions.getSessionResults.mockResolvedValue([])
    const list = render(<SessionHistoryList histories={[data]} session={null} setSelectedHistory={() => {}} onDeleteSession={() => {}} />)
    expect(list.container).toHaveTextContent(`Score: ${expected}`)
    list.unmount()
    render(<Dialog open><SessionResultsDialog selectedHistory={data} onLoadSession={() => {}} isLoading={false} /></Dialog>)
    expect(screen.getByText(/Score:/).parentElement).toHaveTextContent(`${expected.replace('/', ' / ')} (`)
  })

  it('shows multi-select and dropdown answers as readable lines, never as raw JSON', async () => {
    actions.getSessionResults.mockResolvedValue([
      { position: 0, exerciseId: 'm', questionText: 'Pick primes', exerciseType: 'multiple_choice', choices: '["2","3","4"]', correctAnswer: '["2","3"]', log: { isCorrect: false, score: 0.5, userAnswer: '["2","4"]' } },
      { position: 1, exerciseId: 'd', questionText: 'Fill in', exerciseType: 'dropdown', choices: '["[Dropdown 1] hot","[Dropdown 2] cold"]', correctAnswer: '["[Dropdown 1] hot","[Dropdown 2] cold"]', log: { isCorrect: false, score: 0, userAnswer: '{"[Dropdown 1]":"warm"}' } },
    ])
    render(<Dialog open><SessionResultsDialog selectedHistory={{ ...history, logs: [] }} onLoadSession={() => {}} isLoading={false} /></Dialog>)
    await waitFor(() => expect(screen.getByText(/Q1: Pick primes/)).toBeInTheDocument())
    const body = document.body.textContent || ''
    expect(body).not.toMatch(/\[\s*"|\{\s*"|\[Dropdown/)
    expect(screen.getAllByTestId('answer-list').length).toBeGreaterThanOrEqual(2)
    expect(body).toContain('Blank 1: hot')
    expect(body).toContain('Blank 2: cold')
  })
})

describe('SessionResultsDialog: written answers not checked yet', () => {
  it('a pending written answer reads "Not checked yet", counts 0 and is named in the headline', async () => {
    const pendingItem = { position: 1, exerciseId: 'e1', questionText: 'Explain it', exerciseType: 'open', choices: '[]', correctAnswer: 'Model', log: { isCorrect: false, score: 0, userAnswer: 'my **words**', gradedBy: 'pending' } }
    const hist = {
      id: 'x2', mode: 'exam', status: 'completed', startTime: '2026-11-11T10:00:00.000Z', exerciseCount: 2,
      logs: [
        { id: 'a', exerciseId: 'e0', isCorrect: true, score: 1, userAnswer: 'A', position: 0 },
        { id: 'b', exerciseId: 'e1', isCorrect: false, score: 0, userAnswer: 'my **words**', gradedBy: 'pending', position: 1 },
      ],
    }
    actions.getSessionResults.mockResolvedValue([item(0, true), pendingItem])
    render(<Dialog open><SessionResultsDialog selectedHistory={hist} onLoadSession={() => {}} isLoading={false} /></Dialog>)
    await waitFor(() => expect(screen.getByText(/Score:/).parentElement).toHaveTextContent('1 / 2 (1 fully correct, 1 not checked yet)'))
    await waitFor(() => expect(screen.getAllByText('Not checked yet').length).toBeGreaterThan(0))
    expect(screen.getByText('my **words**')).toBeInTheDocument() // plain text
  })
  it('written answers: feedback under the answer, "Model answer:" label, points always, pending once', async () => {
    const open = (position: number, log: object | null) => ({ position, exerciseId: `o${position}`, questionText: `Open ${position}`, exerciseType: 'open', choices: '[]', correctAnswer: 'MODELTEXT', log })
    const hist = { id: 'x3', mode: 'exam', status: 'completed', startTime: '2026-11-11T10:00:00.000Z', exerciseCount: 3, logs: [] }
    const fb = (text: string) => ({ v: 1, keyPoints: [], misconceptions: [], text })
    actions.getSessionResults.mockResolvedValue([
      open(0, { isCorrect: false, score: 0, userAnswer: 'a', gradedBy: 'model', feedback: fb('FEEDBACK ZERO') }),
      open(1, { isCorrect: true, score: 1, userAnswer: 'b', gradedBy: 'model', feedback: fb('FEEDBACK FULL') }),
      open(2, { isCorrect: false, score: 0, userAnswer: 'c', gradedBy: 'pending', feedback: null }),
    ])
    render(<Dialog open><SessionResultsDialog selectedHistory={hist} onLoadSession={() => {}} isLoading={false} /></Dialog>)
    await waitFor(() => expect(screen.getByText('FEEDBACK ZERO')).toBeInTheDocument())
    expect(screen.getByText('0 pt')).toBeInTheDocument()
    expect(screen.getByText('1 pt')).toBeInTheDocument()
    expect(screen.getByText('FEEDBACK FULL')).toBeInTheDocument()
    expect(screen.getAllByText('Model answer:')).toHaveLength(2) // zero-score and pending; not the fully correct one
    expect(screen.queryByText('Correct Answer:')).not.toBeInTheDocument()
    expect(screen.getAllByText('Not checked yet')).toHaveLength(1)
  })
  it('tutor turns are rendered as Markdown, student turns stay plain', async () => {
    actions.getSessionDetail.mockResolvedValue({ chatLog: JSON.stringify([{ role: 'model', text: 'You should *do* it' }, { role: 'user', text: 'I will *not*' }]) })
    render(<Dialog open><SessionResultsDialog selectedHistory={history} onLoadSession={() => {}} isLoading={false} /></Dialog>)
    await waitFor(() => expect(screen.getByText('do').tagName).toBe('EM'))
    expect(screen.getByText('I will *not*')).toBeInTheDocument()
  })
  it('the history row names the unchecked answers', () => {
    render(<SessionHistoryList histories={[{ id: 'h', mode: 'exam', status: 'completed', startTime: '2026-11-11T10:00:00.000Z', exerciseCount: 2, logs: [{ isCorrect: true, score: 1, userAnswer: 'A' }, { isCorrect: false, score: 0, userAnswer: 'x', gradedBy: 'pending' }] }]} session={null} setSelectedHistory={() => {}} onDeleteSession={() => {}} />)
    expect(screen.getByText('1 not checked yet')).toBeInTheDocument()
    expect(screen.getByText('Score: 1/2')).toBeInTheDocument()
  })
})
