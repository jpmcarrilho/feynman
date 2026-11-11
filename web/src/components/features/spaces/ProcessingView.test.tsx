import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { ProcessingView } from './ProcessingView'
import type { SourceStatusView, SpaceStatus } from '@/services/spaceStatus'

const a = { status: vi.fn(), retry: vi.fn(), remove: vi.fn() }
vi.mock('@/app/spaces/actions', () => ({
  getSpaceStatusAction: (...x: unknown[]) => a.status(...x),
  retrySourceAction: (...x: unknown[]) => a.retry(...x),
  removeSourceAction: (...x: unknown[]) => a.remove(...x),
}))
vi.mock('./SourceDropzone', () => ({ SourceDropzone: () => <div data-testid="dropzone" /> }))

const src = (id: string, status: string, over: Partial<SourceStatusView> = {}): SourceStatusView => ({
  id, originalName: `${id}.pdf`, sizeBytes: 1000, bundle: 'initial', status, stage: null, working: false, progressText: `text ${id}`, error: null, failedStage: null, warning: null,
  pageCount: null, charCount: null, usedOcrFallback: false, topicCount: 0, moduleCount: 0, notStudyTopicCount: 0, importedQuestionCount: 0, starterQuestionCount: 0, canRetry: false, createdAt: '', updatedAt: 'u0', ...over,
})
const space = (sources: SourceStatusView[]): SpaceStatus => ({
  courseId: 'c1', title: 'T', sources, initialBundleFinished: sources.every((s) => ['ready', 'failed'].includes(s.status)), processing: sources.some((s) => !['ready', 'failed'].includes(s.status)),
  starterStatus: null, starterProgress: { topicsWithQuestions: 0, studyTopics: 0 }, hasProfile: false, profileSuggestion: null, outline: { modules: 0, topics: 0 }, serverTime: '',
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
})
afterEach(() => vi.useRealTimers())

const flush = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

describe('ProcessingView', () => {
  it('polls every 2 seconds while a file is unfinished and stops when all are terminal', async () => {
    a.status
      .mockResolvedValueOnce(space([src('a', 'segmenting', { pageCount: 12, progressText: 'Splitting 12 pages into topics…' })]))
      .mockResolvedValueOnce(space([src('a', 'segmenting')]))
      .mockResolvedValue(space([src('a', 'ready', { topicCount: 3 })]))
    render(<ProcessingView courseId="c1" onReview={vi.fn()} />)
    await flush()
    expect(a.status).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Splitting 12 pages into topics…')).toBeInTheDocument()
    expect(screen.getByText(/You can close this page/)).toBeInTheDocument()
    await flush(1900)
    expect(a.status).toHaveBeenCalledTimes(1)
    await flush(200)
    expect(a.status).toHaveBeenCalledTimes(2)
    await flush(2000)
    expect(a.status).toHaveBeenCalledTimes(3)
    await flush(10_000)
    expect(a.status).toHaveBeenCalledTimes(3) // all terminal: no more polls
  })

  it('does not start a poll while the previous one is still running', async () => {
    let release: (v: unknown) => void = () => {}
    a.status.mockImplementationOnce(() => new Promise((r) => { release = r }))
    a.status.mockResolvedValue(space([src('a', 'extracting')]))
    render(<ProcessingView courseId="c1" onReview={vi.fn()} />)
    await flush(10_000)
    expect(a.status).toHaveBeenCalledTimes(1)
    release(space([src('a', 'extracting')]))
    await flush(2100)
    expect(a.status).toHaveBeenCalledTimes(2)
  })

  it('shows Retry only for failed files that can be retried, with the error and Remove', async () => {
    a.status.mockResolvedValue(space([src('ok', 'ready', { topicCount: 2 }), src('bad', 'failed', { error: 'Document too long', canRetry: true, failedStage: 'extracting' }), src('run', 'extracting')]))
    render(<ProcessingView courseId="c1" onReview={vi.fn()} />)
    await flush()
    expect(screen.getAllByRole('button', { name: /^Retry / })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Retry bad.pdf' })).toBeInTheDocument()
    expect(screen.getByText(/Failed: Document too long/)).toBeInTheDocument()
    a.retry.mockResolvedValue({ ok: true })
    fireEvent.click(screen.getByRole('button', { name: 'Retry bad.pdf' }))
    await flush()
    expect(a.retry).toHaveBeenCalledWith('bad')
  })

  it('shows a refusal reason from Remove, and removes a failed file at once', async () => {
    a.status.mockResolvedValue(space([src('bad', 'failed', { error: 'x', canRetry: false })]))
    a.remove.mockResolvedValueOnce({ ok: false, reason: 'It is being processed right now, try again in a minute.' })
    render(<ProcessingView courseId="c1" onReview={vi.fn()} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Remove bad.pdf' }))
    await flush()
    expect(a.remove).toHaveBeenCalledWith('bad')
    expect(screen.getByRole('alert')).toHaveTextContent('being processed right now')
  })

  it('asks once before removing a file that did not fail', async () => {
    a.status.mockResolvedValue(space([src('ok', 'ready')]))
    a.remove.mockResolvedValue({ ok: true })
    render(<ProcessingView courseId="c1" onReview={vi.fn()} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Remove ok.pdf' }))
    expect(a.remove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm removing ok.pdf' }))
    await flush()
    expect(a.remove).toHaveBeenCalledWith('ok')
  })

  it('offers Review outline when all initial files are terminal and one is ready; says so when all failed', async () => {
    const onReview = vi.fn()
    a.status.mockResolvedValue(space([src('ok', 'ready'), src('bad', 'failed', { error: 'x' })]))
    const { unmount } = render(<ProcessingView courseId="c1" onReview={onReview} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Review outline' }))
    expect(onReview).toHaveBeenCalled()
    unmount()

    a.status.mockResolvedValue(space([src('bad', 'failed', { error: 'x', canRetry: true })]))
    render(<ProcessingView courseId="c1" onReview={onReview} />)
    await flush()
    expect(screen.queryByRole('button', { name: 'Review outline' })).toBeNull()
    expect(screen.getByText(/No file could be processed/)).toBeInTheDocument()
    expect(screen.getByTestId('dropzone')).toBeInTheDocument()
  })

  it('does not offer Review outline while a file is still being processed', async () => {
    a.status.mockResolvedValue(space([src('ok', 'ready'), src('run', 'segmenting')]))
    render(<ProcessingView courseId="c1" onReview={vi.fn()} />)
    await flush()
    expect(screen.queryByRole('button', { name: 'Review outline' })).toBeNull()
  })

  it('pauses polling while the tab is hidden and resumes when it is visible', async () => {
    a.status.mockResolvedValue(space([src('run', 'segmenting')]))
    render(<ProcessingView courseId="c1" onReview={vi.fn()} />)
    await flush()
    let state = 'hidden'
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
    await flush(2100) // the pending timer fires one more poll, which sees the hidden tab and does not reschedule
    const calls = a.status.mock.calls.length
    await flush(10_000)
    expect(a.status.mock.calls.length).toBe(calls)
    state = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(a.status.mock.calls.length).toBe(calls + 1)
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  })

  it('shows singular pages, no page count for text files, and KB for small files', async () => {
    a.status.mockResolvedValue(space([
      src('one', 'ready', { pageCount: 1, sizeBytes: 51_200 }),
      src('many', 'ready', { pageCount: 12, sizeBytes: 2 * 1024 * 1024 }),
      src('txt', 'ready', { originalName: 'notes.md', pageCount: 4, sizeBytes: 3000 }),
    ]))
    render(<ProcessingView courseId="c1" onReview={vi.fn()} />)
    await flush()
    expect(screen.getByText('(50 KB, 1 page)')).toBeInTheDocument()
    expect(screen.getByText('(2.0 MB, 12 pages)')).toBeInTheDocument()
    expect(screen.getByText('(3 KB)')).toBeInTheDocument()
  })

  it('shows a busy state after Retry and says so when the file fails again', async () => {
    a.retry.mockResolvedValue({ ok: true })
    const failed = src('bad', 'failed', { error: 'Too long', canRetry: true, failedStage: 'extracting', updatedAt: 'u1' })
    a.status.mockResolvedValue(space([failed]))
    render(<ProcessingView courseId="c1" onReview={vi.fn()} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Retry bad.pdf' }))
    await flush()
    // Status still the old failure: shown as retrying, Retry disabled
    expect(screen.getByText('Retrying…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry bad.pdf' })).toBeDisabled()
    // The row changed and failed again before we saw it running
    a.status.mockResolvedValue(space([{ ...failed, error: 'Too long again', updatedAt: 'u2' }]))
    await flush(2100)
    expect(screen.getByText('Retried and failed again: Too long again')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry bad.pdf' })).toBeEnabled()
  })

  it('follows a retried file while it runs', async () => {
    a.retry.mockResolvedValue({ ok: true })
    const failed = src('bad', 'failed', { error: 'x', canRetry: true, failedStage: 'extracting', updatedAt: 'u1' })
    a.status.mockResolvedValue(space([failed]))
    render(<ProcessingView courseId="c1" onReview={vi.fn()} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Retry bad.pdf' }))
    await flush()
    a.status.mockResolvedValue(space([src('bad', 'extracting', { progressText: 'Reading the file…', updatedAt: 'u2' })]))
    await flush(2100)
    expect(screen.getByText('Reading the file…')).toBeInTheDocument()
    expect(screen.queryByText('Retrying…')).toBeNull()
  })
})
