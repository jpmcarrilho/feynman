import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { useSuggestionWatch } from './useSuggestionWatch'
import { ProfileSuggestionBanner } from './ProfileSuggestionBanner'
import { defaultProfile, type ProfileSuggestion } from '@/lib/studyspace/profile'

const a = { status: vi.fn(), stored: vi.fn(), accept: vi.fn(), dismiss: vi.fn() }
vi.mock('@/app/spaces/actions', () => ({
  getSpaceStatusAction: (...x: unknown[]) => a.status(...x),
  getUpdateSuggestionAction: (...x: unknown[]) => a.stored(...x),
  acceptProfileUpdateAction: (...x: unknown[]) => a.accept(...x),
  dismissProfileSuggestionAction: (...x: unknown[]) => a.dismiss(...x),
}))

const current = { ...defaultProfile({ title: 'T' }), subject: 'Chemistry' }
const suggestion = (createdAt: string, subject: string): ProfileSuggestion => ({
  kind: 'update', createdAt, basedOnSourceIds: [], profile: { ...current, subject }, rationale: `Because ${subject}.`, excludedSources: [], split: null,
})
const status = (over: Record<string, unknown> = {}) => ({ sources: [{ status: 'ready' }], profileSuggestion: null, updateCheckPending: false, ...over })

const holder = { kick: () => {} }
const kicker = () => holder.kick()
function Page({ initial = null }: { initial?: ProfileSuggestion | null }) {
  const [s, setS] = useState<ProfileSuggestion | null>(initial)
  const { kick } = useSuggestionWatch('c1', s?.createdAt ?? null, setS)
  useEffect(() => { holder.kick = kick })
  return s ? <ProfileSuggestionBanner key={s.createdAt} courseId="c1" suggestion={s} current={current} /> : <p>No suggestion</p>
}
const flush = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
})
afterEach(() => vi.useRealTimers())

describe('useSuggestionWatch', () => {
  it('reads once when nothing is pending and does not poll again', async () => {
    a.status.mockResolvedValue(status())
    render(<Page />)
    await flush(20_000)
    expect(a.status).toHaveBeenCalledTimes(1)
    expect(screen.getByText('No suggestion')).toBeInTheDocument()
  })

  it('shows the banner when the suggestion is stored after the page was opened, then stops once the check has settled', async () => {
    a.status.mockResolvedValue(status())
    render(<Page />)
    await flush()
    kicker() // a file was uploaded
    a.status.mockResolvedValue(status({ updateCheckPending: true }))
    await flush(2100)
    expect(screen.getByText('No suggestion')).toBeInTheDocument()
    a.status.mockResolvedValue(status({ profileSuggestion: { kind: 'update', createdAt: 'c1' }, updateCheckPending: false }))
    a.stored.mockResolvedValue(suggestion('c1', 'Physics'))
    await flush(2100)
    expect(screen.getByRole('region', { name: 'Suggested tutor update' })).toHaveTextContent('Because Physics.')
    const reads = a.status.mock.calls.length
    await flush(20_000)
    expect(a.status.mock.calls.length).toBeLessThanOrEqual(reads + 2) // the settled reads, then nothing
    const after = a.status.mock.calls.length
    await flush(20_000)
    expect(a.status).toHaveBeenCalledTimes(after)
  })

  it('replaces the banner content when a newer suggestion (other createdAt) is stored', async () => {
    a.status.mockResolvedValue(status({ profileSuggestion: { kind: 'update', createdAt: 'c1' } }))
    a.stored.mockResolvedValue(suggestion('c1', 'Physics'))
    render(<Page initial={suggestion('c1', 'Physics')} />)
    await flush()
    expect(screen.getByText('Because Physics.')).toBeInTheDocument()
    kicker()
    a.status.mockResolvedValue(status({ profileSuggestion: { kind: 'update', createdAt: 'c2' } }))
    a.stored.mockResolvedValue(suggestion('c2', 'Biology'))
    await flush(2100)
    expect(screen.getByText('Because Biology.')).toBeInTheDocument()
    expect(screen.queryByText('Because Physics.')).not.toBeInTheDocument()
  })

  it('drops the banner when the stored update is gone (its file was removed)', async () => {
    a.status.mockResolvedValue(status({ profileSuggestion: { kind: 'update', createdAt: 'c1' } }))
    render(<Page initial={suggestion('c1', 'Physics')} />)
    await flush()
    expect(screen.getByText('Because Physics.')).toBeInTheDocument()
    a.status.mockResolvedValue(status({ profileSuggestion: null }))
    kicker()
    await flush(100)
    expect(screen.getByText('No suggestion')).toBeInTheDocument()
  })

  it('keeps reading while a file is unfinished', async () => {
    a.status.mockResolvedValue(status({ sources: [{ status: 'segmenting' }] }))
    render(<Page />)
    await flush(6100)
    expect(a.status.mock.calls.length).toBeGreaterThanOrEqual(3)
  })
})
