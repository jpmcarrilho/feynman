import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { LEGACY_VOICE_PROFILE } from '@/lib/studyspace/legacyProfiles'
import type { ProfileSuggestion } from '@/lib/studyspace/profile'

vi.mock('@/app/actions', () => {
  const lists = ['getTopicsWithPerformance', 'getSessionHistory', 'getStudyPlans']
  const names = ['startSession', 'checkSessionStartable', 'getActiveSession', 'getSessionState', 'saveDraft', 'setFlagged', 'setCurrentPosition', 'getTopicsWithPerformance', 'getSessionHistory', 'logAnswer', 'recordCardTime', 'submitExam', 'saveChatLog', 'finishStudySession', 'getSessionDetail', 'getVoiceContextForExercise', 'reportExercise', 'deleteStudySession', 'cancelStudySession', 'generateSessionSummary', 'generateExamDiagnosis', 'generateStructuredStudyPlan', 'saveAndDeployStudyPlan', 'getStudyPlans', 'deleteStudyPlan', 'getAnalyticsData', 'generatePlannerResponse']
  return Object.fromEntries(names.map((n) => [n, vi.fn(async () => (lists.includes(n) ? [] : null))]))
})
const spaces = vi.hoisted(() => ({ accept: vi.fn(), dismiss: vi.fn(), status: vi.fn(), stored: vi.fn() }))
vi.mock('@/app/spaces/actions', () => ({
  acceptProfileUpdateAction: (...x: unknown[]) => spaces.accept(...x),
  dismissProfileSuggestionAction: (...x: unknown[]) => spaces.dismiss(...x),
  getSpaceStatusAction: (...x: unknown[]) => spaces.status(...x),
  getUpdateSuggestionAction: (...x: unknown[]) => spaces.stored(...x),
}))
const resources = vi.hoisted(() => ({ props: null as null | { allowAddFiles?: boolean; courseId: string; onFilesActivity?: () => void } }))
vi.mock('./ResourcesDashboard', () => ({
  ResourcesDashboard: (p: { allowAddFiles?: boolean; courseId: string; onFilesActivity?: () => void }) => {
    resources.props = p
    return <div data-testid="resources" />
  },
}))
vi.mock('@/hooks/useLiveAPI', () => ({
  useLiveAPI: () => ({ isConnected: false, isConnecting: false, isMuted: false, error: null, messages: [], connect: vi.fn(), disconnect: vi.fn(), sendText: vi.fn(), sendContext: vi.fn(), setMuted: vi.fn(), setMessages: vi.fn() }),
}))

import { StudyInterface } from './StudyInterface'
import * as actions from '@/app/actions'

const suggestion: ProfileSuggestion = {
  kind: 'update', createdAt: '2026-11-12T10:00:00.000Z', basedOnSourceIds: ['s'], profile: { ...LEGACY_VOICE_PROFILE, subject: 'Statistical mechanics' }, rationale: 'The new file is about statistical mechanics.',
  excludedSources: [], split: null,
}
const flush = async () => { await act(async () => { await Promise.resolve() }) }

beforeEach(() => {
  vi.clearAllMocks()
  resources.props = null
  spaces.accept.mockResolvedValue({ ok: true })
  spaces.dismiss.mockResolvedValue({ ok: true })
  spaces.status.mockResolvedValue({ sources: [], profileSuggestion: { kind: 'update', createdAt: '2026-11-12T10:00:00.000Z' }, updateCheckPending: false })
  spaces.stored.mockResolvedValue(null)
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }))
})

describe('StudyInterface: suggested tutor update and Add files', () => {
  it('shows no banner without a stored update suggestion', () => {
    render(<StudyInterface courseId="c1" courseTitle="Course" profile={LEGACY_VOICE_PROFILE} />)
    expect(screen.queryByRole('region', { name: 'Suggested tutor update' })).not.toBeInTheDocument()
  })

  it('shows the banner for a stored update; Ignore removes it without a reload', async () => {
    render(<StudyInterface courseId="c1" courseTitle="Course" profile={LEGACY_VOICE_PROFILE} updateSuggestion={suggestion} />)
    expect(screen.getByRole('region', { name: 'Suggested tutor update' })).toHaveTextContent('The new file is about statistical mechanics.')
    expect(screen.getByRole('region', { name: 'Suggested tutor update' })).toHaveTextContent(/Subject:.*→ Statistical mechanics/)
    fireEvent.click(screen.getByRole('button', { name: 'Ignore' }))
    await flush()
    expect(spaces.dismiss).toHaveBeenCalledWith('c1', suggestion.createdAt)
    expect(screen.queryByRole('region', { name: 'Suggested tutor update' })).not.toBeInTheDocument()
  })

  it('Accept applies the suggestion and replaces the banner with a short confirmation', async () => {
    render(<StudyInterface courseId="c1" courseTitle="Course" profile={LEGACY_VOICE_PROFILE} updateSuggestion={suggestion} />)
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    await flush()
    expect(spaces.accept).toHaveBeenCalledWith('c1', suggestion.createdAt)
    expect(screen.queryByRole('region', { name: 'Suggested tutor update' })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(/Tutor updated/)
  })

  it('the Resources tab allows adding files', async () => {
    render(<StudyInterface courseId="c1" courseTitle="Course" profile={LEGACY_VOICE_PROFILE} />)
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Resources' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Resources' }))
    await flush()
    expect(resources.props).toMatchObject({ courseId: 'c1', allowAddFiles: true })
  })

  it('reads the topics of the studyspace again on file activity, so the Create Session dialog lists new topics without a reload', async () => {
    const read = vi.mocked(actions.getTopicsWithPerformance)
    render(<StudyInterface courseId="c1" courseTitle="Course" profile={LEGACY_VOICE_PROFILE} />)
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Resources' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Resources' }))
    await flush()
    const before = read.mock.calls.length
    read.mockResolvedValueOnce([{ id: 't-new', title: 'New topic' }] as never)
    await act(async () => { resources.props!.onFilesActivity!() })
    await flush()
    expect(read.mock.calls.length).toBe(before + 1)
    expect(read).toHaveBeenLastCalledWith('c1')
  })
})
