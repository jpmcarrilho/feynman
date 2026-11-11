import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/db', () => ({
  prisma: {
    exercise: { findUnique: vi.fn() },
    topic: { findUnique: vi.fn(), findMany: vi.fn() },
  },
}))

import { prisma } from '@/lib/db'
import { buildVoiceContext, formatVoiceContext, PER_TOPIC_CAP, TOTAL_CAP } from './voiceContext'

const t = (title: string, resourceType: string, content = 'body') => ({
  title, resourceType, content, localPath: `/p/${title}`,
})

describe('formatVoiceContext', () => {
  it('excludes exercise/solution topics in exam mode only', () => {
    const topics = [
      t('Lecture', 'Transcript .txt'),
      t('Answers', 'Exercise Content & Solutions', 'ANSWER KEY'),
      t('Slides', 'Slides PDF'),
    ]
    const exam = formatVoiceContext(topics, 'exam')
    expect(exam).toContain('Unit: Lecture')
    expect(exam).toContain('Unit: Slides')
    expect(exam).not.toContain('ANSWER KEY')
    expect(formatVoiceContext(topics, 'practice')).toContain('ANSWER KEY')
  })

  it('caps each topic and the total', () => {
    const big = 'x'.repeat(PER_TOPIC_CAP * 3)
    const one = formatVoiceContext([t('A', 'Reading .txt', big)], 'practice')
    expect(one.length).toBeLessThan(PER_TOPIC_CAP + 200)
    const many = formatVoiceContext(
      Array.from({ length: 10 }, (_, i) => t(`T${i}`, 'Reading .txt', big)),
      'practice'
    )
    expect(many.length).toBeLessThanOrEqual(TOTAL_CAP)
  })

  it('uses a placeholder for empty content', () => {
    expect(formatVoiceContext([{ title: 'E', content: null, localPath: null, resourceType: null }], 'practice'))
      .toContain('No content available.')
  })
})

describe('buildVoiceContext', () => {
  beforeEach(() => vi.clearAllMocks())

  it('loads class siblings ordered by order and applies the exam filter', async () => {
    vi.mocked(prisma.exercise.findUnique).mockResolvedValue({ topicId: 'tp' } as never)
    vi.mocked(prisma.topic.findUnique).mockResolvedValue({ id: 'tp', courseId: 'c', week: 'W1', className: 'K' } as never)
    vi.mocked(prisma.topic.findMany).mockResolvedValue([
      t('Lecture', 'Transcript .txt'),
      t('Sol', 'Exercise Content & Solutions', 'SECRET'),
    ] as never)
    const out = await buildVoiceContext({ exerciseId: 'e', mode: 'exam' })
    expect(out).toContain('Lecture')
    expect(out).not.toContain('SECRET')
    const args = vi.mocked(prisma.topic.findMany).mock.calls[0][0] as { where: unknown; orderBy: unknown[] }
    expect(args.where).toEqual({ courseId: 'c', week: 'W1', className: 'K' })
    expect(args.orderBy[0]).toEqual({ order: 'asc' })
  })

  it('returns empty when the topic has no className', async () => {
    vi.mocked(prisma.exercise.findUnique).mockResolvedValue({ topicId: 'tp' } as never)
    vi.mocked(prisma.topic.findUnique).mockResolvedValue({ id: 'tp', className: null } as never)
    expect(await buildVoiceContext({ exerciseId: 'e', mode: 'practice' })).toBe('')
  })
})
