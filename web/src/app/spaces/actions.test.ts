import { describe, it, expect, vi, beforeEach } from 'vitest'

const { prismaMock, summaries, authed } = vi.hoisted(() => ({
  prismaMock: { course: { findUnique: vi.fn() } },
  summaries: { listSpaceSummaries: vi.fn(), renameCourse: vi.fn() },
  authed: { value: true },
}))
vi.mock('@/lib/db', () => ({ prisma: prismaMock }))
vi.mock('@/server/auth', () => ({ requireAuth: async () => { if (!authed.value) throw new Error('Unauthorized') } }))
vi.mock('@/services/spaceSummaries', () => summaries)

import { getProfileAction, renameStudyspaceAction, listStudyspacesAction } from './actions'

beforeEach(() => {
  vi.clearAllMocks()
  authed.value = true
})

describe('spaces actions', () => {
  it('rename trims the name, collapses spaces and stores it', async () => {
    summaries.renameCourse.mockResolvedValue(true)
    await renameStudyspaceAction('c1', '   My   new  space ')
    expect(summaries.renameCourse).toHaveBeenCalledWith('c1', 'My new space')
  })

  it('rename rejects an empty name, a name over 120 characters and an unknown studyspace', async () => {
    await expect(renameStudyspaceAction('c1', '   ')).rejects.toThrow()
    await expect(renameStudyspaceAction('c1', 'x'.repeat(121))).rejects.toThrow()
    expect(summaries.renameCourse).not.toHaveBeenCalled()
    summaries.renameCourse.mockResolvedValue(false)
    await expect(renameStudyspaceAction('nope', 'Name')).rejects.toThrow('Studyspace not found.')
  })

  it('getProfileAction returns the legacy profile of a known MIT course without a stored one, and fails for an unknown id', async () => {
    prismaMock.course.findUnique.mockResolvedValueOnce({ id: 'c1', code: '14.750x', title: 'T', profile: null, goal: null })
    const profile = await getProfileAction('c1')
    expect(profile.examPreset).toEqual({ label: '14.750x Final', questionCount: 32 })
    prismaMock.course.findUnique.mockResolvedValueOnce(null)
    await expect(getProfileAction('zzz')).rejects.toThrow('Studyspace not found.')
  })

  it('list requires authentication', async () => {
    authed.value = false
    await expect(listStudyspacesAction()).rejects.toThrow('Unauthorized')
    expect(summaries.listSpaceSummaries).not.toHaveBeenCalled()
  })
})
