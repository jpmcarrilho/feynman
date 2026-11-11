// What the wizard polls every 2 seconds (getSpaceStatusAction). Five small indexed reads, no topic content, no work.
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { NOT_STUDY_MATERIAL_PREFIX } from '@/services/exerciseGenerator'

export const SOURCE_STAGES = ['uploaded', 'extracting', 'segmenting', 'importing_questions', 'generating_exercises'] as const

export type SourceStatusView = {
  id: string
  originalName: string
  sizeBytes: number
  bundle: string
  status: string
  /** 1-based position among the 5 stages while the source is unfinished, else null. */
  stage: { index: number; total: number } | null
  /** A worker holds the lease right now. False for a queued source and for one waiting to be picked up again. */
  working: boolean
  /** Text to show next to the file ("Splitting into topics…"). */
  progressText: string
  error: string | null
  failedStage: string | null
  warning: string | null
  pageCount: number | null
  charCount: number | null
  usedOcrFallback: boolean
  topicCount: number
  moduleCount: number
  /** Topics the segmentation marked as front matter or logistics (no questions are generated from them). */
  notStudyTopicCount: number
  importedQuestionCount: number
  starterQuestionCount: number
  canRetry: boolean
  createdAt: string
  /** Last change of the file's row: lets the wizard see that a retry ran again. */
  updatedAt: string
}

export type SpaceStatus = {
  courseId: string
  title: string
  sources: SourceStatusView[]
  /** At least one initial file, and every initial file is ready or failed. */
  initialBundleFinished: boolean
  /** Some file is not ready or failed yet. */
  processing: boolean
  starterStatus: string | null
  /** Study-material topics that have at least one question, and all study-material topics (for "Preparing starter questions… 12/40"). */
  starterProgress: { topicsWithQuestions: number; studyTopics: number }
  hasProfile: boolean
  profileSuggestion: { kind: 'initial' | 'update'; createdAt: string } | null
  outline: { modules: number; topics: number }
  serverTime: string
}

const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : Number(v ?? 0) || 0)

type Counts = { topics: number; modules: number; notStudy: number; imported: number; starters: number }

/** Plain text for the status of a file. Pure. */
export function progressText(s: { status: string; working: boolean; pageCount: number | null; error: string | null; isPdf?: boolean }, c: Pick<Counts, 'topics' | 'imported' | 'starters'>): string {
  switch (s.status) {
    case 'uploaded':
      return s.working ? 'Starting…' : 'Waiting in line…'
    case 'extracting':
      return s.working ? 'Reading the file…' : 'Waiting to continue reading the file…'
    case 'segmenting':
      return s.working ? (s.pageCount && s.isPdf !== false ? `Splitting ${s.pageCount} page${s.pageCount === 1 ? '' : 's'} into topics…` : 'Splitting into topics…') : 'Waiting to continue splitting into topics…'
    case 'importing_questions':
      return s.working ? 'Looking for questions in the file…' : 'Waiting to continue looking for questions…'
    case 'generating_exercises':
      return s.working ? `Preparing starter questions… (${c.starters} so far)` : 'Waiting to prepare starter questions…'
    case 'ready': {
      const parts = [`${c.topics} topic${c.topics === 1 ? '' : 's'}`]
      if (c.imported > 0) parts.push(`${c.imported} question${c.imported === 1 ? '' : 's'} from the file`)
      return `Ready: ${parts.join(', ')}`
    }
    case 'failed':
      return s.error ?? 'This file could not be processed.'
    default:
      return s.status
  }
}

export async function getSpaceStatus(courseId: string, now: Date = new Date()): Promise<SpaceStatus | null> {
  const course = await prisma.course.findUnique({
    where: { id: courseId },
    select: { id: true, title: true, profile: true, profileSuggestion: true, starterStatus: true },
  })
  if (!course) return null

  const [sources, topicRows, exerciseRows, markerRows, progressRows, moduleRow] = await Promise.all([
    prisma.source.findMany({
      where: { courseId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true, originalName: true, sizeBytes: true, bundle: true, status: true, failedStage: true, error: true, warning: true, pageCount: true,
        charCount: true, usedOcrFallback: true, leaseExpiresAt: true, createdAt: true, updatedAt: true,
      },
    }),
    prisma.$queryRaw<{ sourceId: string | null; topics: unknown; modules: unknown }[]>(
      Prisma.sql`SELECT sourceId, COUNT(*) AS topics, COUNT(DISTINCT week) AS modules FROM Topic WHERE courseId = ${courseId} GROUP BY sourceId`,
    ),
    prisma.$queryRaw<{ sourceId: string | null; origin: string; n: unknown }[]>(
      Prisma.sql`SELECT t.sourceId AS sourceId, e.origin AS origin, COUNT(*) AS n
                 FROM Exercise e JOIN Topic t ON t.id = e.topicId
                 WHERE t.courseId = ${courseId} AND e.status = 'active' GROUP BY t.sourceId, e.origin`,
    ),
    prisma.$queryRaw<{ sourceId: string | null; n: unknown }[]>(
      Prisma.sql`SELECT t.sourceId AS sourceId, COUNT(DISTINCT t.id) AS n
                 FROM Exercise e JOIN Topic t ON t.id = e.topicId
                 WHERE t.courseId = ${courseId} AND e.status = 'rejected' AND e.reportedReason LIKE ${NOT_STUDY_MATERIAL_PREFIX + '%'}
                 GROUP BY t.sourceId`,
    ),
    prisma.$queryRaw<{ studyTopics: unknown; withQuestions: unknown }[]>(
      Prisma.sql`SELECT
                   (SELECT COUNT(*) FROM Topic t WHERE t.courseId = ${courseId}
                      AND NOT EXISTS (SELECT 1 FROM Exercise m WHERE m.topicId = t.id AND m.status = 'rejected' AND m.reportedReason LIKE ${NOT_STUDY_MATERIAL_PREFIX + '%'})) AS studyTopics,
                   (SELECT COUNT(DISTINCT t.id) FROM Topic t JOIN Exercise e ON e.topicId = t.id
                      WHERE t.courseId = ${courseId} AND e.status = 'active') AS withQuestions`,
    ),
    // Distinct modules of the whole course, not a sum per source
    prisma.$queryRaw<{ n: unknown }[]>(Prisma.sql`SELECT COUNT(DISTINCT week) AS n FROM Topic WHERE courseId = ${courseId}`),
  ])

  const counts = new Map<string, Counts>()
  const at = (id: string | null) => {
    const key = id ?? ''
    let c = counts.get(key)
    if (!c) counts.set(key, (c = { topics: 0, modules: 0, notStudy: 0, imported: 0, starters: 0 }))
    return c
  }
  let totalTopics = 0
  for (const r of topicRows) {
    at(r.sourceId).topics = num(r.topics)
    at(r.sourceId).modules = num(r.modules)
    totalTopics += num(r.topics)
  }
  const totalModules = num(moduleRow[0]?.n)
  for (const r of exerciseRows) {
    if (r.origin === 'imported') at(r.sourceId).imported += num(r.n)
    else if (r.origin === 'starter') at(r.sourceId).starters += num(r.n)
  }
  for (const r of markerRows) at(r.sourceId).notStudy = num(r.n)

  const views: SourceStatusView[] = sources.map((s) => {
    const c = counts.get(s.id) ?? { topics: 0, modules: 0, notStudy: 0, imported: 0, starters: 0 }
    const working = s.leaseExpiresAt !== null && s.leaseExpiresAt.getTime() > now.getTime() && !['ready', 'failed'].includes(s.status)
    const stageIndex = SOURCE_STAGES.indexOf(s.status as (typeof SOURCE_STAGES)[number])
    return {
      id: s.id, originalName: s.originalName, sizeBytes: s.sizeBytes, bundle: s.bundle, status: s.status,
      stage: stageIndex >= 0 ? { index: stageIndex + 1, total: SOURCE_STAGES.length } : null,
      working,
      progressText: progressText({ status: s.status, working, pageCount: s.pageCount, error: s.error, isPdf: /\.pdf$/i.test(s.originalName) }, c),
      error: s.error, failedStage: s.failedStage, warning: s.warning, pageCount: s.pageCount, charCount: s.charCount,
      usedOcrFallback: s.usedOcrFallback, topicCount: c.topics, moduleCount: c.modules, notStudyTopicCount: c.notStudy,
      importedQuestionCount: c.imported, starterQuestionCount: c.starters, canRetry: s.status === 'failed' && !!s.failedStage,
      createdAt: s.createdAt.toISOString(), updatedAt: s.updatedAt.toISOString(),
    }
  })

  const initial = views.filter((v) => v.bundle === 'initial')
  let suggestion: SpaceStatus['profileSuggestion'] = null
  if (course.profileSuggestion) {
    try {
      const parsed = JSON.parse(course.profileSuggestion) as { kind?: unknown; createdAt?: unknown }
      suggestion = { kind: parsed.kind === 'update' ? 'update' : 'initial', createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '' }
    } catch {
      suggestion = null
    }
  }
  return {
    courseId: course.id,
    title: course.title,
    sources: views,
    initialBundleFinished: initial.length > 0 && initial.every((v) => v.status === 'ready' || v.status === 'failed'),
    processing: views.some((v) => v.status !== 'ready' && v.status !== 'failed'),
    starterStatus: course.starterStatus,
    starterProgress: { studyTopics: num(progressRows[0]?.studyTopics), topicsWithQuestions: num(progressRows[0]?.withQuestions) },
    hasProfile: !!course.profile,
    profileSuggestion: suggestion,
    outline: { modules: totalModules, topics: totalTopics },
    serverTime: now.toISOString(),
  }
}
