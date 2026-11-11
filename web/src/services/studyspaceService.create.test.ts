import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'fs'

const env = vi.hoisted(() => ({ dir: '' }))
vi.mock('@/lib/db', async () => {
  const { createTestPrisma } = await import('@/server/ingest/__fixtures__/testDb')
  const t = await createTestPrisma()
  env.dir = t.dir
  return { prisma: t.prisma }
})

import { slugifyName, makeSpaceCode, createStudyspace } from './studyspaceService'

type Prisma = typeof import('@/lib/db').prisma
let prisma: Prisma
beforeAll(async () => { prisma = (await import('@/lib/db')).prisma })
afterAll(async () => { await prisma.$disconnect(); fs.rmSync(env.dir, { recursive: true, force: true }) })

describe('space codes', () => {
  it('slugifies names', () => {
    expect(slugifyName('Organic Chem II')).toBe('organic-chem-ii')
    expect(slugifyName('Química Orgânica — 2ª parte!')).toBe('quimica-organica-2a-parte')
    expect(slugifyName('日本語')).toBe('space')
    expect(slugifyName('x'.repeat(100))).toHaveLength(40)
  })
  it('appends 6 random characters', () => {
    expect(makeSpaceCode('Organic Chem')).toMatch(/^organic-chem-[a-z0-9]{6}$/)
    expect(makeSpaceCode('A', () => 0)).toBe('a-aaaaaa')
  })
})

describe('createStudyspace', () => {
  it('creates an empty space with the trimmed name and goal', async () => {
    const res = await createStudyspace({ name: '  Organic   Chem ', goal: ' pass the final ' })
    expect(res.ok).toBe(true)
    const row = await prisma.course.findUniqueOrThrow({ where: { id: (res as { id: string }).id } })
    expect(row).toMatchObject({ title: 'Organic Chem', goal: 'pass the final', profile: null, starterStatus: null })
    expect(row.code).toMatch(/^organic-chem-[a-z0-9]{6}$/)
  })
  it('two spaces with the same name get different codes', async () => {
    const a = await createStudyspace({ name: 'Same' })
    const b = await createStudyspace({ name: 'Same' })
    const codes = await prisma.course.findMany({ where: { title: 'Same' }, select: { code: true } })
    expect(a.ok && b.ok).toBe(true)
    expect(new Set(codes.map((c) => c.code)).size).toBe(2)
  })
  it('refuses an empty name, a long name and a long goal', async () => {
    expect(await createStudyspace({ name: '   ' })).toEqual({ ok: false, reason: 'A studyspace needs a name.' })
    expect((await createStudyspace({ name: 'x'.repeat(81) })).ok).toBe(false)
    expect((await createStudyspace({ name: 'ok', goal: 'g'.repeat(301) })).ok).toBe(false)
    expect((await createStudyspace({ name: 42 as unknown as string })).ok).toBe(false)
  })
})
