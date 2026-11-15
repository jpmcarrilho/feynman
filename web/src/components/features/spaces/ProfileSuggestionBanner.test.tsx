import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { ProfileSuggestionBanner } from './ProfileSuggestionBanner'
import { defaultProfile, type ProfileSuggestion, type TutorProfile } from '@/lib/studyspace/profile'

const a = { accept: vi.fn(), dismiss: vi.fn() }
vi.mock('@/app/spaces/actions', () => ({
  acceptProfileUpdateAction: (...x: unknown[]) => a.accept(...x),
  dismissProfileSuggestionAction: (...x: unknown[]) => a.dismiss(...x),
}))

const current: TutorProfile = { ...defaultProfile({ title: 'Chem' }), subject: 'Organic chemistry', level: 'undergraduate', contentLanguage: 'en', analogyDomains: ['cooking'] }
const next: TutorProfile = { ...current, subject: 'Statistical mechanics', level: 'graduate', contentLanguage: 'pt-BR', analogyDomains: ['cooking', 'lego'] }
const suggestion: ProfileSuggestion = {
  kind: 'update', createdAt: '2026-11-12T10:00:00.000Z', basedOnSourceIds: ['s'], profile: next, rationale: 'The new file is a graduate text in Portuguese.', excludedSources: [], split: null,
}
const flush = async () => { await act(async () => { await Promise.resolve() }) }

beforeEach(() => {
  vi.clearAllMocks()
  a.accept.mockResolvedValue({ ok: true })
  a.dismiss.mockResolvedValue({ ok: true })
})

describe('ProfileSuggestionBanner', () => {
  it('shows the rationale and every changed field as "field: old → new", and nothing for fields that did not change', () => {
    render(<ProfileSuggestionBanner courseId="c1" suggestion={suggestion} current={current} />)
    expect(screen.getByRole('region', { name: 'Suggested tutor update' })).toBeInTheDocument()
    expect(screen.getByText('The new file is a graduate text in Portuguese.')).toBeInTheDocument()
    const items = screen.getAllByRole('listitem').map((li) => li.textContent)
    expect(items).toEqual([
      'Subject: Organic chemistry → Statistical mechanics',
      'Level: Undergraduate → Graduate',
      'Analogy domains: cooking → cooking, lego',
      'Content language: en → pt-BR',
    ])
    expect(screen.getByText(/Nothing changes unless you accept/)).toBeInTheDocument()
  })

  it('renders only for a suggestion of kind update', () => {
    const { container } = render(<ProfileSuggestionBanner courseId="c1" suggestion={{ ...suggestion, kind: 'initial' }} current={current} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('Accept applies the suggestion the owner saw, then shows a short confirmation that names the voice-call caveat', async () => {
    const onResolved = vi.fn()
    render(<ProfileSuggestionBanner courseId="c1" suggestion={suggestion} current={current} onResolved={onResolved} />)
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    await flush()
    expect(a.accept).toHaveBeenCalledWith('c1', '2026-11-12T10:00:00.000Z')
    expect(a.dismiss).not.toHaveBeenCalled()
    expect(onResolved).toHaveBeenCalledWith('accepted', next)
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Suggested tutor update' })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(/Tutor updated\..*voice call that is already open keeps the old tutor/)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss the tutor updated message' }))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('Ignore calls the dismiss action for that suggestion and the banner disappears', async () => {
    const onResolved = vi.fn()
    const { container } = render(<ProfileSuggestionBanner courseId="c1" suggestion={suggestion} current={current} onResolved={onResolved} />)
    fireEvent.click(screen.getByRole('button', { name: 'Ignore' }))
    await flush()
    expect(a.dismiss).toHaveBeenCalledWith('c1', '2026-11-12T10:00:00.000Z')
    expect(a.accept).not.toHaveBeenCalled()
    expect(onResolved).toHaveBeenCalledWith('ignored', current)
    expect(container).toBeEmptyDOMElement()
  })

  it('keeps the banner and says what happened when the server refuses or cannot be reached, with the buttons usable again', async () => {
    const onResolved = vi.fn()
    render(<ProfileSuggestionBanner courseId="c1" suggestion={suggestion} current={current} onResolved={onResolved} />)
    a.accept.mockResolvedValueOnce({ ok: false, reason: 'This suggestion was replaced by a newer one. Reload the page to see it.' })
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent('replaced by a newer one')
    a.dismiss.mockRejectedValueOnce(new Error('offline'))
    fireEvent.click(screen.getByRole('button', { name: 'Ignore' }))
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent('Could not reach the server. Try again.')
    expect(onResolved).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Accept' })).toBeEnabled()
  })

  it('disables both buttons and marks the pressed one busy while a request is running', async () => {
    let release: (v: unknown) => void = () => {}
    a.accept.mockImplementationOnce(() => new Promise((r) => { release = r }))
    render(<ProfileSuggestionBanner courseId="c1" suggestion={suggestion} current={current} />)
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    await flush()
    expect(screen.getByRole('button', { name: 'Applying…' })).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: 'Ignore' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Ignore' }))
    expect(a.dismiss).not.toHaveBeenCalled()
    release({ ok: true })
    await flush()
  })

  it('on the settings page it warns that Accept replaces unsaved changes of the form', () => {
    render(<ProfileSuggestionBanner courseId="c1" suggestion={suggestion} current={current} where="settings" />)
    expect(screen.getByText(/replaces any unsaved change in the form below/)).toBeInTheDocument()
  })
})
