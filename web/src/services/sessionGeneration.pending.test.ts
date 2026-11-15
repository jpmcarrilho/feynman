import { describe, it, expect, vi, beforeEach } from 'vitest'
import { prisma } from '@/lib/db'

vi.mock('ai', () => ({ generateText: vi.fn(), generateObject: vi.fn() }))
vi.mock('@ai-sdk/google', () => ({ google: vi.fn(() => 'mocked-google-model') }))
vi.mock('@/lib/db', () => ({ prisma: { exercise: { findMany: vi.fn() } } }))

import { nextPendingGroupMember } from './sessionGeneration'

const member = (id: string, position: number) => ({ id, groupId: 'g1', groupPosition: position, topic: { id: 't1' } })

beforeEach(() => vi.resetAllMocks())

describe('nextPendingGroupMember', () => {
  it('returns the first part of a generated problem that is not in the session yet', async () => {
    vi.mocked(prisma.exercise.findMany).mockImplementation((async (args: { where: { id?: unknown; groupId?: string } }) =>
      args.where.id ? [{ groupId: 'g1' }] : [member('p0', 0), member('p1', 1), member('p2', 2)]) as never)
    expect((await nextPendingGroupMember(['p0', 'other']))?.id).toBe('p1')
    expect((await nextPendingGroupMember(['p0', 'p1']))?.id).toBe('p2')
  })

  it('returns null when the problem is complete or the session has no generated problem', async () => {
    vi.mocked(prisma.exercise.findMany).mockImplementation((async (args: { where: { id?: unknown } }) =>
      args.where.id ? [{ groupId: 'g1' }] : [member('p0', 0), member('p1', 1)]) as never)
    expect(await nextPendingGroupMember(['p0', 'p1'])).toBeNull()
    vi.mocked(prisma.exercise.findMany).mockResolvedValue([] as never)
    expect(await nextPendingGroupMember(['x'])).toBeNull()
  })
})
