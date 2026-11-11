import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SpaceCard } from './SpaceCard'
import type { SpaceSummary } from '@/services/spaceSummaries'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }))
const renameStudyspaceAction = vi.fn()
vi.mock('@/app/spaces/actions', () => ({ renameStudyspaceAction: (...args: unknown[]) => renameStudyspaceAction(...args) }))

const space: SpaceSummary = {
  id: 'space-1',
  code: '14.750x',
  title: '14.750x Political Economy',
  goal: 'Pass the final exam',
  createdAt: '2026-08-01T00:00:00.000Z',
  moduleCount: 16,
  topicCount: 376,
  questionCount: 1234,
  answeredCount: 40,
  accuracy: 72,
  lastStudiedAt: '2026-11-10T12:00:00.000Z',
  hasActiveSession: false,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('SpaceCard', () => {
  it('shows the title, goal, counts, accuracy and an Open link to the studyspace', () => {
    render(<SpaceCard space={space} />)
    expect(screen.getByText('14.750x Political Economy')).toBeInTheDocument()
    expect(screen.getByText('Pass the final exam')).toBeInTheDocument()
    expect(screen.getByTestId('stat-modules')).toHaveTextContent('16')
    expect(screen.getByTestId('stat-topics')).toHaveTextContent('376')
    expect(screen.getByTestId('stat-questions')).toHaveTextContent('1,234')
    expect(screen.getByTestId('accuracy')).toHaveTextContent('72%')
    expect(screen.getByTestId('last-studied').textContent).not.toBe('Not studied yet')
    expect(screen.getByRole('link', { name: /open/i })).toHaveAttribute('href', '/spaces/space-1')
    expect(screen.queryByText(/session in progress/i)).not.toBeInTheDocument()
  })

  it('says "Not studied yet" and has no accuracy before anything was answered', () => {
    render(<SpaceCard space={{ ...space, lastStudiedAt: null, accuracy: null, answeredCount: 0, goal: null }} />)
    expect(screen.getByTestId('last-studied')).toHaveTextContent('Not studied yet')
    expect(screen.getByTestId('accuracy')).toHaveTextContent('No answers yet')
    expect(screen.queryByText('Pass the final exam')).not.toBeInTheDocument()
  })

  it('marks a studyspace with a running session', () => {
    render(<SpaceCard space={{ ...space, hasActiveSession: true }} />)
    expect(screen.getByText(/session in progress/i)).toBeInTheDocument()
  })

  it('renames the studyspace and refreshes the list', async () => {
    renameStudyspaceAction.mockResolvedValueOnce(undefined)
    render(<SpaceCard space={space} />)
    fireEvent.click(screen.getByRole('button', { name: /rename 14.750x/i }))
    fireEvent.change(screen.getByLabelText('Studyspace name'), { target: { value: '  Political Economy  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(renameStudyspaceAction).toHaveBeenCalledWith('space-1', 'Political Economy'))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it('shows a plain message when the rename fails and keeps the editor open', async () => {
    renameStudyspaceAction.mockRejectedValueOnce(new Error('boom'))
    render(<SpaceCard space={space} />)
    fireEvent.click(screen.getByRole('button', { name: /rename 14.750x/i }))
    fireEvent.change(screen.getByLabelText('Studyspace name'), { target: { value: 'New name' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not rename/i)
    expect(screen.getByLabelText('Studyspace name')).toBeInTheDocument()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('cancel restores the old name without calling the server', () => {
    render(<SpaceCard space={space} />)
    fireEvent.click(screen.getByRole('button', { name: /rename 14.750x/i }))
    fireEvent.change(screen.getByLabelText('Studyspace name'), { target: { value: 'Other' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('14.750x Political Economy')).toBeInTheDocument()
    expect(renameStudyspaceAction).not.toHaveBeenCalled()
  })

  it('links a studyspace without topics to its setup instead of Open', () => {
    render(<SpaceCard space={{ ...space, topicCount: 0, moduleCount: 0, questionCount: 0 }} />)
    expect(screen.getByRole('link', { name: /continue setup/i })).toHaveAttribute('href', '/spaces/space-1/setup')
    expect(screen.queryByRole('link', { name: /^open$/i })).toBeNull()
  })
})
