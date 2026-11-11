// The study flow reads Course.profile of its own studyspace: the default before acceptance, the accepted profile after.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'fs'

const env = vi.hoisted(() => ({ dir: '' }))
vi.mock('@ai-sdk/google', () => ({ google: vi.fn(() => 'mocked-google-model') }))
vi.mock('@/lib/db', async () => {
  const { createTestPrisma } = await import('@/server/ingest/__fixtures__/testDb')
  const t = await createTestPrisma()
  env.dir = t.dir
  return { prisma: t.prisma }
})

import { defaultProfile } from '@/lib/studyspace/profile'

type Prisma = typeof import('@/lib/db').prisma
let prisma: Prisma
let svc: typeof import('./studyspaceService')
beforeAll(async () => {
  prisma = (await import('@/lib/db')).prisma
  svc = await import('./studyspaceService')
})
afterAll(async () => {
  await prisma.$disconnect()
  fs.rmSync(env.dir, { recursive: true, force: true })
})

describe('profile used by the study flow', () => {
  it('uses defaultProfile before a tutor is accepted and the accepted profile afterwards, per studyspace', async () => {
    await prisma.course.create({ data: { id: 'pf-1', code: 'pf-1', title: 'First space' } })
    await prisma.course.create({ data: { id: 'pf-2', code: 'pf-2', title: 'Second space' } })
    await prisma.topic.create({ data: { id: 'pf-1-t', courseId: 'pf-1', title: 'T', week: '01 · A', order: 0 } })

    expect((await svc.getCourseWithProfile('pf-1'))!.profile).toEqual(defaultProfile({ title: 'First space', goal: null }))
    expect(await svc.getProfileForCourse('pf-1')).toEqual(defaultProfile({ title: 'First space', goal: null }))

    const accepted = { ...defaultProfile({ title: 'First space' }), subject: 'Accepted subject', tutorIdentity: 'a chemistry professor', defaultChatMode: 'guide' as const }
    await prisma.course.update({ where: { id: 'pf-1' }, data: { profile: JSON.stringify(accepted) } })
    expect((await svc.getCourseWithProfile('pf-1'))!.profile).toMatchObject({ subject: 'Accepted subject', defaultChatMode: 'guide' })
    expect((await svc.getProfileForTopic('pf-1-t')).tutorIdentity).toBe('a chemistry professor')
    // another studyspace is unaffected
    expect((await svc.getCourseWithProfile('pf-2'))!.profile.subject).toBe('Second space')
  })
})
