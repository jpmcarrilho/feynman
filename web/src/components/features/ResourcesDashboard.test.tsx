import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { ResourcesDashboard } from './ResourcesDashboard'

const a = { artifacts: vi.fn(), summary: vi.fn() }
const panel = vi.hoisted(() => ({ props: null as null | { open: boolean; onTopicsChanged: () => void; courseId: string } }))
vi.mock('@/app/actions', () => ({
  getCourseArtifacts: (...x: unknown[]) => a.artifacts(...x),
  generateWeekSummaryAction: (...x: unknown[]) => a.summary(...x),
}))
vi.mock('./spaces/AddFilesPanel', () => ({
  AddFilesPanel: (p: { open: boolean; onTopicsChanged: () => void; courseId: string }) => {
    panel.props = p
    return <div data-testid="add-files-panel" data-open={String(p.open)} />
  },
}))

const resource = (id: string, title: string) => ({ id, title, unit: '1', className: 'c', resourceType: 'Uploaded text', detail: 'notes.md', link: `/api/files/topic/${id}` })
const course = (weeks: { weekName: string; topics: string[] }[]) => [{
  courseId: 'c1', courseCode: 'code', courseTitle: 'T',
  weeks: weeks.map((w) => ({ weekName: w.weekName, weekSlug: w.weekName, summaryExists: false, summaryLink: null, slides: [], transcriptions: w.topics.map((t) => resource(t, t)), exercisesCount: 0, topicIds: w.topics })),
}]
const flush = async () => { await act(async () => { await Promise.resolve() }) }

beforeEach(() => {
  vi.clearAllMocks()
  panel.props = null
})

describe('ResourcesDashboard: Add files', () => {
  it('has no Add files button unless the studyspace allows it', async () => {
    a.artifacts.mockResolvedValue(course([{ weekName: '01 · One', topics: ['Topic A'] }]))
    render(<ResourcesDashboard courseId="c1" onViewFile={vi.fn()} onStartWeekSession={vi.fn()} />)
    await flush()
    expect(screen.queryByRole('button', { name: 'Add files' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('add-files-panel')).not.toBeInTheDocument()
  })

  it('opens and closes the panel from the header button (aria-expanded) and reloads the list in place when a file is ready', async () => {
    a.artifacts.mockResolvedValueOnce(course([{ weekName: '01 · One', topics: ['Topic A'] }]))
    render(<ResourcesDashboard courseId="c1" onViewFile={vi.fn()} onStartWeekSession={vi.fn()} allowAddFiles />)
    await flush()
    const button = screen.getByRole('button', { name: 'Add files' })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByTestId('add-files-panel')).toHaveAttribute('data-open', 'false')
    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('add-files-panel')).toHaveAttribute('data-open', 'true')
    expect(panel.props!.courseId).toBe('c1')

    // a file became ready: the new module is read in, without a loading screen and without closing the panel
    a.artifacts.mockResolvedValueOnce(course([{ weekName: '01 · One', topics: ['Topic A'] }, { weekName: '02 · Added', topics: ['Topic B', 'Topic C'] }]))
    expect(screen.queryByText('Topic B')).not.toBeInTheDocument()
    await act(async () => { panel.props!.onTopicsChanged() })
    await flush()
    expect(a.artifacts).toHaveBeenCalledTimes(2)
    expect(screen.getByText('Topic B')).toBeInTheDocument()
    expect(screen.getByText('02 · Added')).toBeInTheDocument()
    expect(screen.queryByText(/Retrieving Course Materials/)).not.toBeInTheDocument()
    expect(screen.getByTestId('add-files-panel')).toHaveAttribute('data-open', 'true')
  })

  it('opens an uploaded topic through its file link', async () => {
    a.artifacts.mockResolvedValue(course([{ weekName: '01 · One', topics: ['Topic A'] }]))
    const onViewFile = vi.fn()
    render(<ResourcesDashboard courseId="c1" onViewFile={onViewFile} onStartWeekSession={vi.fn()} allowAddFiles />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Open Topic A' }))
    expect(onViewFile).toHaveBeenCalledWith('/api/files/topic/Topic A', 'Topic A')
    fireEvent.keyDown(screen.getByRole('button', { name: 'Open Topic A' }), { key: 'Enter' })
    expect(onViewFile).toHaveBeenCalledTimes(2)
  })
})
