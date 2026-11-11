import { prisma } from '@/lib/db'

export const PER_TOPIC_CAP = 6000
export const TOTAL_CAP = 24000

/** Topics whose resourceType matches this hold exercise statements and marked answer keys. */
const SOLUTION_TYPE = /exercise|solution/i

export type VoiceContextTopic = {
  title: string
  content: string | null
  localPath: string | null
  resourceType: string | null
}

/** Pure formatter: filters (exam mode), caps and joins the unit blocks. Input must already be ordered. */
export function formatVoiceContext(topics: VoiceContextTopic[], mode: string): string {
  let out = ''
  for (const t of topics) {
    if (mode === 'exam' && t.resourceType && SOLUTION_TYPE.test(t.resourceType)) continue
    const remaining = TOTAL_CAP - out.length
    if (remaining <= 0) break
    let content = t.content ? t.content : 'No content available.'
    if (content.length > PER_TOPIC_CAP) content = content.slice(0, PER_TOPIC_CAP)
    let block = `\n--- Unit: ${t.title} (File: ${t.localPath || 'Unknown'}) ---\n${content}\n`
    if (block.length > remaining) block = block.slice(0, remaining)
    out += block
  }
  return out
}

/** Unit blocks of the exercise's topic and its class siblings (same course, week, className). */
export async function buildVoiceContext({ exerciseId, mode }: { exerciseId: string; mode: string }): Promise<string> {
  const exercise = await prisma.exercise.findUnique({
    where: { id: exerciseId },
    select: { topicId: true },
  })
  if (!exercise) return ''
  const topic = await prisma.topic.findUnique({ where: { id: exercise.topicId } })
  if (!topic || !topic.className) return ''

  const classTopics = await prisma.topic.findMany({
    where: { courseId: topic.courseId, week: topic.week, className: topic.className },
    orderBy: [{ order: 'asc' }, { unit: 'asc' }],
    select: { title: true, content: true, localPath: true, resourceType: true },
  })
  return formatVoiceContext(classTopics, mode)
}
