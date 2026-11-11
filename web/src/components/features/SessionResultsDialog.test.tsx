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
})
