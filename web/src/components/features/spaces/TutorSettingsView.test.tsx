import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { TutorSettingsView } from './TutorSettingsView'
import { defaultProfile, type ProfileSuggestion, type TutorProfile } from '@/lib/studyspace/profile'
import type { PersonaStep } from '@/server/ingest/persona'

const spaces = vi.hoisted(() => ({ accept: vi.fn(), dismiss: vi.fn(), status: vi.fn(), stored: vi.fn() }))
vi.mock('@/app/spaces/actions', () => ({
  acceptProfileUpdateAction: (...x: unknown[]) => spaces.accept(...x),
  dismissProfileSuggestionAction: (...x: unknown[]) => spaces.dismiss(...x),
  getSpaceStatusAction: (...x: unknown[]) => spaces.status(...x),
  getUpdateSuggestionAction: (...x: unknown[]) => spaces.stored(...x),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
const card = vi.hoisted(() => ({ mounts: 0, subjects: [] as string[] }))
vi.mock('./PersonaCard', async () => {
  const React = await import('react')
  return {
    PersonaCard: ({ initial }: { initial?: PersonaStep }) => {
      React.useEffect(() => { card.mounts++; card.subjects.push(initial?.profile.subject ?? '') }, [initial])
      return <div data-testid="persona-card">{initial?.profile.subject}</div>
    },
  }
})

const current: TutorProfile = { ...defaultProfile({ title: 'Chem' }), subject: 'Organic chemistry' }
const persona: PersonaStep = {
  ok: true, mode: 'accepted', profile: current, rationale: null, excludedSources: [], split: null, modules: [], readOnly: false, starterStatus: 'done', starterProgress: { topicsWithQuestions: 1, studyTopics: 1 },
}
const suggestion: ProfileSuggestion = {
  kind: 'update', createdAt: '2026-11-12T10:00:00.000Z', basedOnSourceIds: ['s'], profile: { ...current, subject: 'Statistical mechanics' }, rationale: 'New subject.', excludedSources: [], split: null,
}
const flush = async () => { await act(async () => { await Promise.resolve() }) }

beforeEach(() => {
  vi.clearAllMocks()
  card.mounts = 0
  card.subjects = []
  spaces.accept.mockResolvedValue({ ok: true })
  spaces.dismiss.mockResolvedValue({ ok: true })
  spaces.status.mockResolvedValue({ sources: [], profileSuggestion: null, updateCheckPending: false })
  spaces.stored.mockResolvedValue(null)
})

describe('TutorSettingsView', () => {
  it('shows the same banner above the form when an update is stored, and nothing otherwise', () => {
    const { unmount } = render(<TutorSettingsView courseId="c1" title="Chem" initialPersona={persona} />)
    expect(screen.queryByRole('region', { name: 'Suggested tutor update' })).not.toBeInTheDocument()
    unmount()
    render(<TutorSettingsView courseId="c1" title="Chem" initialPersona={persona} updateSuggestion={suggestion} />)
    expect(screen.getByRole('region', { name: 'Suggested tutor update' })).toHaveTextContent('Subject: Organic chemistry → Statistical mechanics')
  })

  it('Accept starts the form again from the tutor that was applied; Ignore removes the banner and leaves the form alone', async () => {
    render(<TutorSettingsView courseId="c1" title="Chem" initialPersona={persona} updateSuggestion={suggestion} />)
    expect(screen.getByTestId('persona-card')).toHaveTextContent('Organic chemistry')
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    await flush()
    expect(screen.getByTestId('persona-card')).toHaveTextContent('Statistical mechanics')
    expect(screen.getByRole('status')).toHaveTextContent(/Tutor updated/)
  })

  it('Ignore keeps the form', async () => {
    render(<TutorSettingsView courseId="c1" title="Chem" initialPersona={persona} updateSuggestion={suggestion} />)
    fireEvent.click(screen.getByRole('button', { name: 'Ignore' }))
    await flush()
    expect(screen.queryByRole('region', { name: 'Suggested tutor update' })).not.toBeInTheDocument()
    expect(screen.getByTestId('persona-card')).toHaveTextContent('Organic chemistry')
    expect(card.mounts).toBe(1)
  })
})
