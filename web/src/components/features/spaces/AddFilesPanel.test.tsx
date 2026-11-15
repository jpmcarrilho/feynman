import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { AddFilesPanel, newlyReady } from './AddFilesPanel'
import type { SourceStatusView, SpaceStatus } from '@/services/spaceStatus'

const a = { status: vi.fn(), retry: vi.fn(), remove: vi.fn() }
const dropzone = vi.hoisted(() => ({ props: null as null | { bundle: string; courseId: string; removedSourceIds?: string[]; onUploaded?: (s: unknown) => void } }))
vi.mock('@/app/spaces/actions', () => ({
  getSpaceStatusAction: (...x: unknown[]) => a.status(...x),
  retrySourceAction: (...x: unknown[]) => a.retry(...x),
  removeSourceAction: (...x: unknown[]) => a.remove(...x),
}))
vi.mock('./SourceDropzone', () => ({
  SourceDropzone: (p: { bundle: string; courseId: string; removedSourceIds?: string[]; onUploaded?: (s: unknown) => void }) => {
    dropzone.props = p
    return <div data-testid="dropzone" />
  },
}))

const src = (id: string, status: string, over: Partial<SourceStatusView> = {}): SourceStatusView => ({
  id, originalName: `${id}.pdf`, sizeBytes: 1000, bundle: 'later', status, stage: null, working: status !== 'ready' && status !== 'failed', progressText: `text ${id}`, error: null, failedStage: null, warning: null,
  pageCount: null, charCount: null, usedOcrFallback: false, topicCount: 0, moduleCount: 0, notStudyTopicCount: 0, importedQuestionCount: 0, starterQuestionCount: 0, canRetry: false, createdAt: '', updatedAt: 'u0', ...over,
})
const space = (sources: SourceStatusView[]): SpaceStatus => ({
  courseId: 'c1', title: 'T', sources, initialBundleFinished: true, processing: sources.some((s) => !['ready', 'failed'].includes(s.status)),
  starterStatus: 'done', starterProgress: { topicsWithQuestions: 0, studyTopics: 0 }, hasProfile: true, profileSuggestion: null, updateCheckPending: false, outline: { modules: 0, topics: 0 }, serverTime: '',
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  dropzone.props = null
})
afterEach(() => vi.useRealTimers())
const flush = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

describe('newlyReady', () => {
  it('is true only when a file is ready now and was not ready (or not known) before', () => {
    expect(newlyReady([src('a', 'segmenting')], [src('a', 'ready')])).toBe(true)
    expect(newlyReady([], [src('a', 'ready')])).toBe(true)
    expect(newlyReady([src('a', 'ready')], [src('a', 'ready')])).toBe(false)
    expect(newlyReady([src('a', 'extracting')], [src('a', 'failed')])).toBe(false)
  })
})

describe('AddFilesPanel', () => {
  it('renders nothing while closed when the studyspace has no uploaded file, and shows the dropzone for later files when opened', async () => {
    a.status.mockResolvedValue(space([]))
    const { container, rerender } = render(<AddFilesPanel courseId="c1" open={false} onTopicsChanged={vi.fn()} />)
    await flush()
    expect(container).toBeEmptyDOMElement()
    rerender(<AddFilesPanel courseId="c1" open onTopicsChanged={vi.fn()} />)
    expect(screen.getByTestId('dropzone')).toBeInTheDocument()
    expect(dropzone.props).toMatchObject({ bundle: 'later', courseId: 'c1' })
    expect(screen.getByRole('region', { name: 'Add files' })).toHaveTextContent(/not changed/)
    expect(screen.getByRole('region', { name: 'Add files' })).toHaveTextContent(/open questions with a written model answer \(your written answers are then checked against it\)/)
  })

  it('lists the ready files in a collapsed "Files in this studyspace" list; Remove asks twice, shows the refusal as is, and refreshes the resources after a removal', async () => {
    const onTopicsChanged = vi.fn()
    a.status.mockResolvedValue(space([src('done', 'ready', { topicCount: 4, progressText: 'Ready: 4 topics' })]))
    a.remove.mockResolvedValueOnce({ ok: false, reason: 'Questions from this file were already answered, so it cannot be removed.' }).mockResolvedValue({ ok: true })
    const { container } = render(<AddFilesPanel courseId="c1" open={false} onTopicsChanged={onTopicsChanged} />)
    await flush()
    const details = container.querySelector('details')!
    expect(details).not.toHaveAttribute('open')
    expect(screen.getByText('Files in this studyspace (1)')).toBeInTheDocument()
    expect(screen.getByText('Ready: 4 topics')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove done.pdf' }))
    expect(a.remove).not.toHaveBeenCalled() // first click only asks
    fireEvent.click(screen.getByRole('button', { name: 'Confirm removing done.pdf' }))
    await flush()
    expect(a.remove).toHaveBeenCalledWith('done')
    expect(screen.getByRole('alert')).toHaveTextContent('Questions from this file were already answered, so it cannot be removed.')
    expect(onTopicsChanged).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Remove done.pdf' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm removing done.pdf' }))
    await flush()
    expect(onTopicsChanged).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('done.pdf', { exact: false })).not.toBeInTheDocument()
  })

  it('clears the "Accepted" entry of the dropzone once its file is ready', async () => {
    a.status.mockResolvedValue(space([src('a', 'ready'), src('b', 'segmenting')]))
    render(<AddFilesPanel courseId="c1" open onTopicsChanged={vi.fn()} />)
    await flush()
    expect(dropzone.props!.removedSourceIds).toEqual(['a'])
  })

  it('lists files that are not ready, polls every 2 s without overlap, and calls onTopicsChanged once when a file becomes ready, then stops polling', async () => {
    const onTopicsChanged = vi.fn()
    let release: (v: unknown) => void = () => {}
    a.status
      .mockResolvedValueOnce(space([src('a', 'segmenting', { progressText: 'Splitting into topics…' })]))
      .mockImplementationOnce(() => new Promise((r) => { release = r }))
      .mockResolvedValue(space([src('a', 'ready', { topicCount: 3 })]))
    render(<AddFilesPanel courseId="c1" open={false} onTopicsChanged={onTopicsChanged} />)
    await flush()
    expect(screen.getByText('Splitting into topics…')).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Files not ready yet' })).toBeInTheDocument()
    await flush(2100)
    expect(a.status).toHaveBeenCalledTimes(2)
    await flush(10_000) // the second read is still running: no third one starts
    expect(a.status).toHaveBeenCalledTimes(2)
    expect(onTopicsChanged).not.toHaveBeenCalled()
    release(space([src('a', 'ready', { topicCount: 3 })]))
    await flush()
    expect(onTopicsChanged).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Splitting into topics…')).not.toBeInTheDocument()
    await flush(10_000)
    expect(a.status).toHaveBeenCalledTimes(2) // nothing pending: polling stopped
    expect(onTopicsChanged).toHaveBeenCalledTimes(1)
  })

  it('does not poll again after the first read when the studyspace has no files (an imported studyspace)', async () => {
    a.status.mockResolvedValue(space([]))
    render(<AddFilesPanel courseId="c1" open onTopicsChanged={vi.fn()} />)
    await flush(10_000)
    expect(a.status).toHaveBeenCalledTimes(1)
  })

  it('an upload through the dropzone starts reading the status at once and the new file is listed', async () => {
    a.status.mockResolvedValueOnce(space([])).mockResolvedValue(space([src('new', 'extracting', { progressText: 'Reading the file…' })]))
    render(<AddFilesPanel courseId="c1" open onTopicsChanged={vi.fn()} />)
    await flush()
    expect(a.status).toHaveBeenCalledTimes(1)
    await act(async () => { dropzone.props!.onUploaded?.({ id: 'new' }) })
    await flush()
    expect(a.status).toHaveBeenCalledTimes(2)
    expect(screen.getByText('Reading the file…')).toBeInTheDocument()
    await flush(2100)
    expect(a.status).toHaveBeenCalledTimes(3) // still unfinished: keeps polling
  })

  it('shows a failed file with its reason, Retry and Remove, like the processing step; Retry and Remove call the same actions', async () => {
    a.status.mockResolvedValue(space([src('bad', 'failed', { error: 'This PDF is password-protected.', canRetry: true, failedStage: 'extracting' })]))
    a.retry.mockResolvedValue({ ok: true })
    a.remove.mockResolvedValue({ ok: true })
    render(<AddFilesPanel courseId="c1" open={false} onTopicsChanged={vi.fn()} />)
    await flush()
    expect(screen.getByText(/Failed: This PDF is password-protected\./)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Files that need attention' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry bad.pdf' }))
    await flush()
    expect(a.retry).toHaveBeenCalledWith('bad')
    fireEvent.click(screen.getByRole('button', { name: 'Remove bad.pdf' }))
    await flush()
    expect(a.remove).toHaveBeenCalledWith('bad')
    expect(screen.queryByText('bad.pdf', { exact: false })).not.toBeInTheDocument()
  })

  it('says why when a removal is refused', async () => {
    a.status.mockResolvedValue(space([src('bad', 'failed', { error: 'x', canRetry: false })]))
    a.remove.mockResolvedValue({ ok: false, reason: 'Questions from this file were already answered.' })
    render(<AddFilesPanel courseId="c1" open={false} onTopicsChanged={vi.fn()} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Remove bad.pdf' }))
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent('Questions from this file were already answered.')
  })

  it('pauses while the tab is hidden and resumes on return', async () => {
    a.status.mockResolvedValue(space([src('a', 'segmenting')]))
    render(<AddFilesPanel courseId="c1" open={false} onTopicsChanged={vi.fn()} />)
    await flush()
    expect(a.status).toHaveBeenCalledTimes(1)
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    await flush(2100)
    expect(a.status).toHaveBeenCalledTimes(2) // the poll that was already scheduled; it does not schedule another while hidden
    await flush(10_000)
    expect(a.status).toHaveBeenCalledTimes(2)
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(a.status).toHaveBeenCalledTimes(3)
    delete (document as unknown as Record<string, unknown>).visibilityState
  })
})
