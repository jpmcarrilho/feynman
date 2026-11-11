import { describe, it, expect, vi, beforeEach } from 'vitest'

const { prismaMock, summaries, authed, pipeline, outlineMock } = vi.hoisted(() => ({
  outlineMock: { getOutline: vi.fn(), renameTopic: vi.fn(), renameModule: vi.fn(), mergeTopics: vi.fn(), reorderTopics: vi.fn(), moveTopicToModule: vi.fn() },
  prismaMock: { course: { findUnique: vi.fn() } },
  summaries: { listSpaceSummaries: vi.fn(), renameCourse: vi.fn() },
  authed: { value: true },
  pipeline: { getSpaceStatus: vi.fn(), wakeIfIdle: vi.fn(), createStudyspace: vi.fn(), retrySource: vi.fn(), removeSource: vi.fn(), deleteStudyspace: vi.fn() },
}))
vi.mock('@/lib/db', () => ({ prisma: prismaMock }))
vi.mock('@/server/auth', () => ({ requireAuth: async () => { if (!authed.value) throw new Error('Unauthorized') } }))
vi.mock('@/services/spaceSummaries', () => summaries)
vi.mock('@/services/outlineService', () => outlineMock)
vi.mock('@/services/spaceStatus', () => ({ getSpaceStatus: pipeline.getSpaceStatus }))
vi.mock('@/services/studyspaceService', () => ({ createStudyspace: pipeline.createStudyspace }))
vi.mock('@/server/ingest/runner', () => ({ wakeIfIdle: pipeline.wakeIfIdle }))
vi.mock('@/server/ingest/admin', () => ({ retrySource: pipeline.retrySource, removeSource: pipeline.removeSource, deleteStudyspace: pipeline.deleteStudyspace }))

import {
  getProfileAction, renameStudyspaceAction, listStudyspacesAction, createStudyspaceAction, getSpaceStatusAction, retrySourceAction, removeSourceAction,
  deleteStudyspaceAction,
} from './actions'

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

describe('pipeline actions', () => {
  it('create passes the input on and returns the result; every pipeline action needs a session first', async () => {
    pipeline.createStudyspace.mockResolvedValue({ ok: true, id: 'new' })
    expect(await createStudyspaceAction({ name: 'N', goal: 'g' })).toEqual({ ok: true, id: 'new' })
    expect(pipeline.createStudyspace).toHaveBeenCalledWith({ name: 'N', goal: 'g' })
    authed.value = false
    await expect(createStudyspaceAction({ name: 'N' })).rejects.toThrow('Unauthorized')
    await expect(getSpaceStatusAction('c1')).rejects.toThrow('Unauthorized')
    await expect(retrySourceAction('s1')).rejects.toThrow('Unauthorized')
    await expect(removeSourceAction('s1')).rejects.toThrow('Unauthorized')
    await expect(deleteStudyspaceAction('c1', 'T')).rejects.toThrow('Unauthorized')
    expect(pipeline.getSpaceStatus).not.toHaveBeenCalled()
    expect(pipeline.removeSource).not.toHaveBeenCalled()
    expect(pipeline.deleteStudyspace).not.toHaveBeenCalled()
  })

  it('status wakes the runner only while work is unfinished and returns null for an unknown studyspace', async () => {
    pipeline.getSpaceStatus.mockResolvedValueOnce(null)
    expect(await getSpaceStatusAction('x')).toBeNull()
    pipeline.getSpaceStatus.mockResolvedValueOnce({ processing: false, starterStatus: 'done', sources: [] })
    await getSpaceStatusAction('c1')
    expect(pipeline.wakeIfIdle).not.toHaveBeenCalled()
    pipeline.wakeIfIdle.mockResolvedValue(true)
    pipeline.getSpaceStatus.mockResolvedValueOnce({ processing: true, starterStatus: null, sources: [] })
    await getSpaceStatusAction('c1')
    expect(pipeline.wakeIfIdle).toHaveBeenCalledWith('c1')
    pipeline.getSpaceStatus.mockResolvedValueOnce({ processing: false, starterStatus: 'running', sources: [] })
    await getSpaceStatusAction('c1')
    expect(pipeline.wakeIfIdle).toHaveBeenCalledTimes(2)
  })

  it('retry, remove and delete forward to the admin functions with the typed title', async () => {
    pipeline.retrySource.mockResolvedValue({ ok: true })
    pipeline.removeSource.mockResolvedValue({ ok: false, reason: 'answered' })
    pipeline.deleteStudyspace.mockResolvedValue({ ok: true })
    expect(await retrySourceAction('s1')).toEqual({ ok: true })
    expect(await removeSourceAction('s1')).toEqual({ ok: false, reason: 'answered' })
    expect(await deleteStudyspaceAction('c1', 'Title')).toEqual({ ok: true })
    expect(pipeline.deleteStudyspace).toHaveBeenCalledWith('c1', 'Title')
    expect(await deleteStudyspaceAction('', 'Title')).toEqual({ ok: false, reason: 'Studyspace not found.' })
  })
})

describe('outline actions', () => {
  it('forward to the outline service with the studyspace id, and need a session first', async () => {
    const { getOutlineAction, renameTopicAction, renameModuleAction, mergeTopicsAction, reorderAction, moveTopicToModuleAction } = await import('./actions')
    outlineMock.getOutline.mockResolvedValue({ ok: true, modules: [] })
    outlineMock.mergeTopics.mockResolvedValue({ ok: true, id: 't1' })
    outlineMock.renameTopic.mockResolvedValue({ ok: true })
    expect(await getOutlineAction('c1')).toEqual({ ok: true, modules: [] })
    expect(await getOutlineAction('')).toEqual({ ok: false, reason: 'Studyspace not found.' })
    expect(await mergeTopicsAction('c1', ['a', 'b'])).toEqual({ ok: true, id: 't1' })
    expect(outlineMock.mergeTopics).toHaveBeenCalledWith('c1', ['a', 'b'])
    await renameTopicAction('c1', 't1', 'New')
    expect(outlineMock.renameTopic).toHaveBeenCalledWith('c1', 't1', 'New')
    await renameModuleAction('c1', '01 · A', 'B')
    expect(outlineMock.renameModule).toHaveBeenCalledWith('c1', '01 · A', 'B')
    await reorderAction('c1', ['a'])
    expect(outlineMock.reorderTopics).toHaveBeenCalledWith('c1', ['a'])
    await moveTopicToModuleAction('c1', 't1', '02 · B')
    expect(outlineMock.moveTopicToModule).toHaveBeenCalledWith('c1', 't1', '02 · B')

    authed.value = false
    vi.clearAllMocks()
    for (const call of [
      () => getOutlineAction('c1'), () => renameTopicAction('c1', 't', 'x'), () => renameModuleAction('c1', 'a', 'b'),
      () => mergeTopicsAction('c1', ['a', 'b']), () => reorderAction('c1', []), () => moveTopicToModuleAction('c1', 't', 'm'),
    ]) await expect(call()).rejects.toThrow('Unauthorized')
    for (const fn of Object.values(outlineMock)) expect(fn).not.toHaveBeenCalled()
  })
})
