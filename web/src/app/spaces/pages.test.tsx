import { describe, it, expect, vi, beforeEach } from 'vitest'

// The pages are server components: they are called as async functions. redirect/notFound throw in Next, so they throw here.
const { auth, getCourse, list, overall } = vi.hoisted(() => ({
  auth: { value: true },
  getCourse: vi.fn(),
  list: vi.fn(),
  overall: vi.fn(),
}))
vi.mock('next/navigation', () => ({
  redirect: (url: string) => { throw new Error(`REDIRECT:${url}`) },
  notFound: () => { throw new Error('NOT_FOUND') },
}))
vi.mock('@/app/auth-actions', () => ({ checkIsAuthenticated: async () => auth.value }))
vi.mock('@/services/studyspaceService', () => ({ getCourseWithProfile: getCourse }))
vi.mock('@/app/spaces/actions', () => ({ listStudyspacesAction: list }))
vi.mock('@/services/spaceSummaries', () => ({ getOverallDiagnosis: overall }))
vi.mock('@/components/features/StudyInterface', () => ({ StudyInterface: () => null }))
vi.mock('@/components/features/LoginForm', () => ({ LoginForm: () => null }))
vi.mock('@/components/features/spaces/SpaceCard', () => ({ SpaceCard: () => null }))
vi.mock('@/components/features/spaces/OverallDiagnosis', () => ({ OverallDiagnosis: () => null }))
vi.mock('@/components/features/FeynmanLogo', () => ({ FeynmanLogo: () => null }))

import Home from '../page'
import StudyPage from '../study/page'
import SpacesPage from './page'
import SpacePage from './[id]/page'

beforeEach(() => {
  vi.clearAllMocks()
  auth.value = true
  list.mockResolvedValue([])
  overall.mockResolvedValue(null)
})

describe('routing and authentication', () => {
  it('/ shows the login when logged out and redirects to /spaces when logged in', async () => {
    auth.value = false
    await expect(Home()).resolves.toBeTruthy()
    auth.value = true
    await expect(Home()).rejects.toThrow('REDIRECT:/spaces')
  })

  it('/study redirects to /spaces when logged in and to the login when not', async () => {
    await expect(StudyPage()).rejects.toThrow('REDIRECT:/spaces')
    auth.value = false
    await expect(StudyPage()).rejects.toThrow('REDIRECT:/')
  })

  it('/spaces checks authentication before reading anything', async () => {
    auth.value = false
    await expect(SpacesPage()).rejects.toThrow('REDIRECT:/')
    expect(list).not.toHaveBeenCalled()
    expect(overall).not.toHaveBeenCalled()
    auth.value = true
    await expect(SpacesPage()).resolves.toBeTruthy()
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('/spaces/[id] checks authentication before looking the studyspace up', async () => {
    auth.value = false
    await expect(SpacePage({ params: Promise.resolve({ id: 'x' }) })).rejects.toThrow('REDIRECT:/')
    expect(getCourse).not.toHaveBeenCalled()
  })

  it('/spaces/[id] shows not-found for an unknown id', async () => {
    getCourse.mockResolvedValue(null)
    await expect(SpacePage({ params: Promise.resolve({ id: 'unknown' }) })).rejects.toThrow('NOT_FOUND')
    expect(getCourse).toHaveBeenCalledWith('unknown')
  })

  it('/spaces/[id] mounts the study interface with the studyspace id, title and profile, keyed by the id', async () => {
    const profile = { examPreset: { label: 'Final', questionCount: 32 } }
    getCourse.mockResolvedValue({ id: 'c1', code: 'X', title: 'My space', profile })
    const el = (await SpacePage({ params: Promise.resolve({ id: 'c1' }) })) as { key: string | null; props: Record<string, unknown> }
    expect(el.key).toBe('c1')
    expect(el.props).toMatchObject({ courseId: 'c1', courseTitle: 'My space', profile })
  })
})
