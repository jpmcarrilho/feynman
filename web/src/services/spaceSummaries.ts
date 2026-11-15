import { prisma } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { finalizeOverdueExams } from '@/services/sessionService'

/** What one studyspace card shows. Plain data, safe to send to the browser. */
export type SpaceSummary = {
  id: string
  code: string
  title: string
  /** Free-text goal, else a real description (the auto-generated "Auto-generated course for ..." text is not one), else null. */
  goal: string | null
  createdAt: string
  moduleCount: number
  topicCount: number
  /** Questions a session can draw from: graded and active. */
  questionCount: number
  /** Answers given so far (cancelled sessions and the diagnosis holder row excluded, blank answers excluded). */
  answeredCount: number
  /** 0-100, partial credit counted; null until something has been answered. */
  accuracy: number | null
  /** Start time of the latest session that has answers (ISO), or null. */
  lastStudiedAt: string | null
  /** A session that `getActiveSession` would resume exists. */
  hasActiveSession: boolean
}

const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : Number(v ?? 0) || 0)

const AUTO_DESCRIPTION = /^auto-generated/i

/**
 * Cards for every studyspace with all the numbers, in four queries however many topics there are:
 *  1. Topic grouped by course (topic count, distinct modules),
 *  2. Exercise joined to Topic grouped by course (graded, active questions),
 *  3. ExerciseLog joined to session, exercise and topic grouped by course (answers, partial-credit points, latest session),
 *  4. the handful of running sessions (the same "would resume" rule as getActiveSessionFor).
 * Aggregation happens inside SQLite; nothing per topic or per exercise is loaded into Node.
 * Rules match getAnalyticsData: sessions that are cancelled or are the diagnosis holder do not count, only answers to
 * questions of the session's own course, blank answers skipped, score falls back to isCorrect for old rows.
 */
export async function listSpaceSummaries(now: Date = new Date()): Promise<SpaceSummary[]> {
  // An exam whose deadline passed is no longer "in progress"
  await finalizeOverdueExams({}, now)

  const [courses, topicRows, questionRows, logRows, running] = await Promise.all([
    prisma.course.findMany({
      orderBy: [{ createdAt: 'asc' }, { code: 'asc' }],
      select: { id: true, code: true, title: true, goal: true, description: true, createdAt: true },
    }),
    prisma.$queryRaw<{ courseId: string; topics: unknown; modules: unknown }[]>(
      Prisma.sql`SELECT courseId, COUNT(*) AS topics, COUNT(DISTINCT week) AS modules FROM Topic GROUP BY courseId`,
    ),
    prisma.$queryRaw<{ courseId: string; n: unknown }[]>(
      Prisma.sql`SELECT t.courseId AS courseId, COUNT(*) AS n
                 FROM Exercise e JOIN Topic t ON t.id = e.topicId
                 WHERE e.status = 'active' AND e.isGraded = 1
                 GROUP BY t.courseId`,
    ),
    prisma.$queryRaw<{ courseId: string; n: unknown; points: unknown; lastStart: string | null }[]>(
      Prisma.sql`SELECT s.courseId AS courseId,
                        COUNT(*) AS n,
                        SUM(COALESCE(l.score, CASE WHEN l.isCorrect = 1 THEN 1.0 ELSE 0.0 END)) AS points,
                        MAX(s.startTime) AS lastStart
                 FROM ExerciseLog l
                 JOIN StudySession s ON s.id = l.sessionId
                 JOIN Exercise e ON e.id = l.exerciseId
                 JOIN Topic t ON t.id = e.topicId
                 WHERE s.courseId IS NOT NULL
                   AND t.courseId = s.courseId
                   AND s.status != 'cancelled'
                   AND s.mode != 'global_diagnosis'
                   AND l.userAnswer IS NOT NULL AND l.userAnswer != ''
                 GROUP BY s.courseId`,
    ),
    prisma.studySession.findMany({
      where: { status: 'active', mode: { not: 'global_diagnosis' }, courseId: { not: null } },
      select: {
        courseId: true,
        studyPlanId: true,
        deadline: true,
        currentPosition: true,
        _count: { select: { logs: true } },
        items: { where: { OR: [{ draftAnswer: { not: null } }, { flagged: true }] }, select: { id: true }, take: 1 },
      },
    }),
  ])

  const topicsBy = new Map(topicRows.map((r) => [r.courseId, { topics: num(r.topics), modules: num(r.modules) }]))
  const questionsBy = new Map(questionRows.map((r) => [r.courseId, num(r.n)]))
  const logsBy = new Map(logRows.map((r) => [r.courseId, { n: num(r.n), points: num(r.points), lastStart: r.lastStart }]))
  const resumable = new Set(
    running
      .filter((c) => !c.studyPlanId || c._count.logs > 0 || c.items.length > 0 || c.deadline !== null || c.currentPosition > 0)
      .map((c) => c.courseId as string),
  )

  return courses.map((c) => {
    const t = topicsBy.get(c.id)
    const l = logsBy.get(c.id)
    const description = c.description && !AUTO_DESCRIPTION.test(c.description.trim()) ? c.description.trim() : null
    const lastStudied = l?.lastStart ? new Date(l.lastStart) : null
    return {
      id: c.id,
      code: c.code,
      title: c.title,
      goal: c.goal?.trim() || description,
      createdAt: c.createdAt.toISOString(),
      moduleCount: t?.modules ?? 0,
      topicCount: t?.topics ?? 0,
      questionCount: questionsBy.get(c.id) ?? 0,
      answeredCount: l?.n ?? 0,
      accuracy: l && l.n > 0 ? Math.round((l.points / l.n) * 100) : null,
      lastStudiedAt: lastStudied && !Number.isNaN(lastStudied.getTime()) ? lastStudied.toISOString() : null,
      hasActiveSession: resumable.has(c.id),
    }
  })
}

/** The stored course-less diagnosis row (the owner's report over both original courses), or null. Read-only. */
export async function getOverallDiagnosis(): Promise<string | null> {
  const row = await prisma.studySession.findFirst({
    where: { mode: 'global_diagnosis', courseId: null },
    select: { diagnosis: true },
  })
  return row?.diagnosis?.trim() ? row.diagnosis : null
}

/** Renames a studyspace. Returns false when it does not exist. */
export async function renameCourse(id: string, name: string): Promise<boolean> {
  const res = await prisma.course.updateMany({ where: { id }, data: { title: name } })
  return res.count > 0
}
