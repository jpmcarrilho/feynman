import { generateObject } from 'ai'
import { z } from 'zod'
import type { Exercise, Topic } from '@prisma/client'
import { textModel } from '@/lib/ai'
import { prisma } from '@/lib/db'
import { generateExercisePrompt } from '@/lib/prompts'
import { pickQuestionType, type TutorProfile } from '@/lib/studyspace/profile'
import { getCourseWithProfile } from '@/services/studyspaceService'
import { LEGACY_VOICE_PROFILE } from '@/lib/studyspace/legacyProfiles'
import { Prisma } from '@prisma/client'
import { searchTopics, formatSearchResults, isCrawlErrorResourceType } from '@/services/contextSearch'

/** Ids per `in (...)` list. The SQLite driver rejects queries with too many parameters (P2029). */
export const ID_CHUNK_SIZE = 300

/** Splits a list into pieces of at most `size`, for queries that take an id list. */
export function chunkIds<T>(items: T[], size: number = ID_CHUNK_SIZE): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}

function describeExercise(ex: { exerciseType: string; questionText: string; choices: string; correctAnswer: string }): string {
  return `Type: ${ex.exerciseType}\nQuestion: ${ex.questionText}\nChoices: ${ex.choices}\nCorrect Answer: ${ex.correctAnswer}`
}

/** Final-exam-level example questions of the profile's calibration module. '' when the profile has none. */
export async function fetchRigorExamples(courseId: string, profile: TutorProfile): Promise<string> {
  if (!profile.calibrationModule) return ''
  const calibrationTopics = await prisma.topic.findMany({
    where: { courseId, week: profile.calibrationModule },
    select: { id: true },
  })
  const ids = calibrationTopics.map((t) => t.id)
  if (ids.length === 0) return ''
  const rigorExercises: Awaited<ReturnType<typeof prisma.exercise.findMany>> = []
  for (const chunk of chunkIds(ids)) {
    if (rigorExercises.length >= 3) break
    rigorExercises.push(...(await prisma.exercise.findMany({ where: { topicId: { in: chunk } }, take: 3 - rigorExercises.length })))
  }
  return rigorExercises.map(describeExercise).join('\n\n')
}

/** How many topics the style-example fallback queries at a time (nearest first). */
const STYLE_FALLBACK_TOPICS_PER_QUERY = 20
const STYLE_EXAMPLES_WANTED = 5

/**
 * Up to 5 example exercises: from the target's module first, then, when the module has fewer than 3, from the
 * session's topics nearest to the target in course order. Never builds an id list from the session: the existing
 * ids are filtered in memory and the fallback walks the nearest topics a few at a time until it has enough.
 */
export async function fetchLocalStyleExamples(
  topicData: Pick<Topic, 'week' | 'courseId' | 'order'>,
  topicIds: string[],
  existingIds: string[],
) {
  const existing = new Set(existingIds)

  // Exercises from the same module (generated ones included)
  let exercises = (
    await prisma.exercise.findMany({
      where: { topic: { week: topicData.week, courseId: topicData.courseId } },
      take: STYLE_EXAMPLES_WANTED + existing.size,
      include: { topic: true },
    })
  )
    .filter((e) => !existing.has(e.id))
    .slice(0, STYLE_EXAMPLES_WANTED)

  // Fall back to the selected topics of the same course, nearest to the target first, when the module has too few
  if (exercises.length < 3) {
    const wanted = new Set(topicIds)
    const courseTopics = await prisma.topic.findMany({ where: { courseId: topicData.courseId }, select: { id: true, order: true } })
    const nearest = courseTopics
      .filter((t) => wanted.has(t.id))
      .sort((a, b) => Math.abs(a.order - topicData.order) - Math.abs(b.order - topicData.order) || a.order - b.order)
      .map((t) => t.id)
    for (const chunk of chunkIds(nearest, STYLE_FALLBACK_TOPICS_PER_QUERY)) {
      if (exercises.length >= STYLE_EXAMPLES_WANTED) break
      const found = await prisma.exercise.findMany({
        where: { topicId: { in: chunk } },
        take: STYLE_EXAMPLES_WANTED + existing.size,
        include: { topic: true },
      })
      const have = new Set(exercises.map((e) => e.id))
      exercises = [...exercises, ...found.filter((e) => !existing.has(e.id) && !have.has(e.id))].slice(0, STYLE_EXAMPLES_WANTED)
    }
  }

  return exercises
}

// Grounding limits (characters). Enforced in buildBucketContext (target and siblings) and compileGroundingContext (calibration).
export const TARGET_CONTENT_CAP = 24_000
export const SIBLING_LIMIT = 8
/** A sibling with a summary contributes title + this much of the summary. */
export const SIBLING_SUMMARY_CAP = 1_000
/** A sibling without a summary contributes title + the first this many characters of its content. */
export const SIBLING_EXCERPT_CHARS = 600
export const CALIBRATION_CONTEXT_CAP = 15_000

/** Thrown for failures whose cause is known; `userMessage` is a plain sentence that is safe to show to the student. */
export class GenerationError extends Error {
  constructor(
    readonly code: 'topic_not_found' | 'no_content' | 'ungraded_only' | 'no_eligible_topic',
    readonly userMessage: string,
  ) {
    super(`${code}: ${userMessage}`)
    this.name = 'GenerationError'
  }
}

type TopicEligibility = 'ok' | 'missing' | 'empty' | 'ungraded_only'

/** Bytes of a topic's content that are inspected to tell text from binary. */
export const CONTENT_PREFIX_BYTES = 1000
/** A prefix with a larger share of NUL bytes than this is not text (stray NULs in extracted math slides stay far below). */
export const MAX_NUL_SHARE = 0.02

/**
 * True when the start of a content looks like binary data (many NUL bytes, e.g. the NUL-interleaved output of a failed
 * PDF extraction). `prefixHex` is the hex of the first bytes: the SQLite driver cannot return blobs, so SQL returns hex().
 */
export function looksLikeBinary(prefixHex: string | null | undefined): boolean {
  if (!prefixHex) return false
  const bytes = Math.floor(prefixHex.length / 2)
  if (bytes === 0) return false
  let nul = 0
  for (let i = 0; i + 1 < prefixHex.length; i += 2) if (prefixHex[i] === '0' && prefixHex[i + 1] === '0') nul++
  return nul / bytes > MAX_NUL_SHARE
}

/**
 * Which of the topics can be generated from. A topic needs usable content: non-empty, not left by a failed extraction
 * (resourceType contains "Error", the same test the search uses) and not binary. It must not hold only ungraded material
 * (it has exercises and none of them is graded: surveys, participation items). A topic without any exercise is fine.
 * Only the first CONTENT_PREFIX_BYTES of the content are read to test for binary data; the rest is never loaded.
 * 'missing' = no such topic; 'empty' = no usable content.
 */
export async function classifyTopics(topicIds: string[]): Promise<Map<string, TopicEligibility>> {
  const result = new Map<string, TopicEligibility>()
  if (topicIds.length === 0) return result
  // The driver limits the number of query parameters, and a session can cover the whole course
  const existing = new Map<string, string | null>()
  const hasContent = new Set<string>()
  const binary = new Set<string>()
  const exerciseRows: { topicId: string; isGraded: boolean }[] = []
  for (const chunk of chunkIds(topicIds)) {
    for (const t of await prisma.topic.findMany({ where: { id: { in: chunk } }, select: { id: true, resourceType: true } })) {
      existing.set(t.id, t.resourceType)
    }
    const withContent = await prisma.topic.findMany({
      where: { id: { in: chunk }, AND: [{ content: { not: null } }, { content: { not: '' } }] },
      select: { id: true },
    })
    for (const t of withContent) hasContent.add(t.id)
    const toInspect = withContent.map((t) => t.id).filter((id) => !isCrawlErrorResourceType(existing.get(id)))
    if (toInspect.length > 0) {
      const prefixes = await prisma.$queryRaw<{ id: string; prefix: string | null }[]>(
        Prisma.sql`SELECT id, hex(substr(CAST(content AS BLOB), 1, ${CONTENT_PREFIX_BYTES})) AS prefix FROM Topic WHERE id IN (${Prisma.join(toInspect)})`,
      )
      for (const r of prefixes ?? []) if (looksLikeBinary(r.prefix)) binary.add(r.id)
    }
    exerciseRows.push(...(await prisma.exercise.findMany({ where: { topicId: { in: chunk } }, select: { topicId: true, isGraded: true } })))
  }
  const hasExercises = new Set<string>()
  const hasGraded = new Set<string>()
  for (const r of exerciseRows) {
    hasExercises.add(r.topicId)
    if (r.isGraded) hasGraded.add(r.topicId)
  }
  for (const id of topicIds) {
    if (!existing.has(id)) result.set(id, 'missing')
    else if (!hasContent.has(id) || isCrawlErrorResourceType(existing.get(id)) || binary.has(id)) result.set(id, 'empty')
    else if (hasExercises.has(id) && !hasGraded.has(id)) result.set(id, 'ungraded_only')
    else result.set(id, 'ok')
  }
  return result
}

/** The ids (input order kept) that generation may use as primary or sibling topic. */
export async function filterGeneratableTopicIds(topicIds: string[]): Promise<string[]> {
  const eligibility = await classifyTopics(topicIds)
  return topicIds.filter((id) => eligibility.get(id) === 'ok')
}

/**
 * At most `cap` characters of `content`. Longer content is split into ceil(length / cap) consecutive windows
 * and `rotation` (e.g. how many exercises the topic already has) picks window `rotation mod count`, so repeated
 * generations cover different parts. The last window is aligned to the end of the content. Edges move to the nearest
 * line break or space when there is one close by, so the text does not start or end mid-word.
 */
export function selectContentWindow(
  content: string,
  cap: number = TARGET_CONTENT_CAP,
  rotation: number = 0,
): { text: string; start: number; end: number; total: number } {
  const total = content.length
  if (total <= cap) return { text: content, start: 0, end: total, total }
  const windows = Math.ceil(total / cap)
  const index = ((Math.trunc(rotation) % windows) + windows) % windows
  let start = Math.min(index * cap, total - cap)
  let end = start + cap
  const SNAP = 300
  if (start > 0) {
    const nl = content.indexOf('\n', start)
    const sp = content.indexOf(' ', start)
    const found = [nl, sp].filter((i) => i !== -1 && i - start <= SNAP)
    if (found.length > 0) start = Math.min(...found) + 1
  }
  if (end < total) {
    const cut = Math.max(content.lastIndexOf('\n', end), content.lastIndexOf(' ', end))
    if (cut > end - SNAP && cut > start) end = cut
  }
  return { text: content.slice(start, end), start, end, total }
}

export type SiblingSource = { title: string; summary?: string | null; content?: string | null }

/** One line per sibling: its summary, or when it has none the start of its content. '' when there is nothing to say. */
export function describeSibling(s: SiblingSource): string {
  const summary = (s.summary ?? '').trim()
  const body = summary
    ? summary.slice(0, SIBLING_SUMMARY_CAP)
    : (s.content ?? '').trim().slice(0, SIBLING_EXCERPT_CHARS).replace(/\s+/g, ' ')
  return body ? `- ${s.title}: ${body}` : ''
}

/**
 * Grounding text of a generation call: the target topic's content (one window of at most TARGET_CONTENT_CAP characters)
 * followed by short descriptions of up to SIBLING_LIMIT sibling topics of the same module.
 */
export function buildBucketContext(
  target: { title: string; content: string | null },
  siblings: SiblingSource[],
  rotation: number,
  moduleLabel?: string | null,
): string {
  const win = selectContentWindow(target.content ?? '', TARGET_CONTENT_CAP, rotation)
  const partial = win.text.length < win.total
  let context = `Unit/Topic: ${target.title}\n${
    partial ? `Content (an excerpt: characters ${win.start + 1}-${win.end} of ${win.total}):\n` : 'Content:\n'
  }${win.text}`
  const lines = siblings.slice(0, SIBLING_LIMIT).map(describeSibling).filter(Boolean)
  if (lines.length > 0) {
    context += `\n\nOther topics in ${moduleLabel ? `"${moduleLabel}"` : 'the same module'} (short descriptions, for background only):\n${lines.join('\n')}`
  }
  return context
}

/** Grounding text for a generation call; for the calibration module also the search context matching the style examples. */
export async function compileGroundingContext(
  topicData: Pick<Topic, 'week' | 'courseId' | 'title' | 'content'>,
  siblings: SiblingSource[],
  rotation: number,
  localStyleExercises: { questionText: string }[],
  profile: TutorProfile,
): Promise<string> {
  let context = buildBucketContext(topicData, siblings, rotation, topicData.week)

  if (profile.calibrationModule && topicData.week === profile.calibrationModule) {
    const combinedText = localStyleExercises.map((ex) => ex.questionText).join(' ')
    const results = await searchTopics(topicData.courseId, combinedText, {
      excludeWeeks: [profile.calibrationModule],
      maxCharsPerTopic: CALIBRATION_CONTEXT_CAP,
    })
    const globalContext = formatSearchResults(results, CALIBRATION_CONTEXT_CAP)
    if (globalContext) {
      context = `${context}\n\n=========================================\n\nADDITIONAL GROUNDING CONTEXT FROM PRECEDING LECTURES/SLIDES:\n\n${globalContext}`
    }
  }

  return context
}

/** The prompt of a generation call and what it was built from. No model call. Throws GenerationError. */
export async function buildGenerationPrompt(args: {
  primaryTopicId: string
  poolTopicIds: string[]
  existingExerciseIds: string[]
  styleTopicIds?: string[]
}) {
  const { primaryTopicId, poolTopicIds, existingExerciseIds } = args
  // Classify before loading the topic: a failed extraction can leave tens of MB of binary in `content`
  const eligibility = (await classifyTopics([primaryTopicId])).get(primaryTopicId)
  if (eligibility === 'missing' || eligibility === undefined) {
    throw new GenerationError('topic_not_found', 'The topic for this question could not be found.')
  }
  if (eligibility === 'ungraded_only') {
    throw new GenerationError('ungraded_only', 'This topic only has ungraded material, so no question can be generated from it.')
  }
  if (eligibility === 'empty') {
    throw new GenerationError('no_content', 'This topic has no study material to generate a question from.')
  }
  const topicData = await prisma.topic.findUnique({ where: { id: primaryTopicId } })
  if (!topicData) throw new GenerationError('topic_not_found', 'The topic for this question could not be found.')
  if (!(topicData.content ?? '').trim()) {
    throw new GenerationError('no_content', 'This topic has no study material to generate a question from.')
  }

  const existingExercisesInSession: { topicId: string; questionText: string }[] = []
  for (const chunk of chunkIds(existingExerciseIds)) {
    existingExercisesInSession.push(...(await prisma.exercise.findMany({ where: { id: { in: chunk } }, select: { topicId: true, questionText: true } })))
  }

  const course = await getCourseWithProfile(topicData.courseId)
  const profile = course?.profile ?? LEGACY_VOICE_PROFILE

  // Style examples from the target topic's module (previously generated ones included)
  const existingExercises = await fetchLocalStyleExamples(topicData, args.styleTopicIds ?? poolTopicIds, existingExerciseIds)
  const existingExercisesContext = existingExercises.map(describeExercise).join('\n\n')

  const targetType = pickQuestionType(profile, topicData.isQuantitative, existingExerciseIds.length)

  // Siblings: pool topics of the target's module that can be generated from, nearest in course order first
  const poolIdSet = new Set(poolTopicIds)
  const moduleTopics = (
    await prisma.topic.findMany({
      where: { courseId: topicData.courseId, week: topicData.week },
      select: { id: true, title: true, summary: true, order: true },
    })
  ).filter((t) => t.id !== primaryTopicId && poolIdSet.has(t.id))
  const usable = new Set(await filterGeneratableTopicIds(moduleTopics.map((t) => t.id)))
  const siblingMeta = moduleTopics
    .filter((t) => usable.has(t.id))
    .sort((a, b) => Math.abs(a.order - topicData.order) - Math.abs(b.order - topicData.order) || a.order - b.order)
    .slice(0, SIBLING_LIMIT)
  // Only siblings without a summary need (the start of) their content
  const needExcerpt = siblingMeta.filter((t) => !(t.summary ?? '').trim()).map((t) => t.id)
  const excerpts = new Map<string, string | null>()
  if (needExcerpt.length > 0) {
    const rows = await prisma.topic.findMany({ where: { id: { in: needExcerpt } }, select: { id: true, content: true } })
    for (const r of rows) excerpts.set(r.id, (r.content ?? '').slice(0, SIBLING_EXCERPT_CHARS))
  }
  const siblings: SiblingSource[] = siblingMeta.map((t) => ({ title: t.title, summary: t.summary, content: excerpts.get(t.id) ?? null }))

  // Different windows of a long topic for each new exercise
  const rotation = await prisma.exercise.count({ where: { topicId: primaryTopicId } })
  const bucketContext = await compileGroundingContext(topicData, siblings, rotation, existingExercises, profile)
  const rigorExercisesContext = await fetchRigorExamples(topicData.courseId, profile)

  const alreadyAskedQuestionsText = existingExercisesInSession
    .map((ex, idx) => `Question ${idx + 1}: ${ex.questionText}`)
    .join('\n\n')

  const prompt = generateExercisePrompt(profile, {
    topic: { title: topicData.title, week: topicData.week, isQuantitative: topicData.isQuantitative },
    courseCode: course?.code,
    bucketContext,
    rigorExamples: rigorExercisesContext,
    styleExamples: existingExercisesContext,
    alreadyAsked: alreadyAskedQuestionsText,
    targetType,
  })
  return { prompt, bucketContext, topicData }
}

/**
 * Generates and stores one exercise for a topic. Does not touch sessions.
 * Throws GenerationError when the topic cannot be generated from (missing, no content, only ungraded material);
 * model and database errors propagate.
 *
 * `styleTopicIds` (default `poolTopicIds`) is the fallback list for style examples; the study interface passes
 * the whole session topic list there while the grounding pool may be narrower.
 */
export async function generateExerciseForTopic(args: {
  primaryTopicId: string
  poolTopicIds: string[]
  existingExerciseIds: string[]
  styleTopicIds?: string[]
}): Promise<Exercise & { topic: Topic }> {
  const { prompt, topicData } = await buildGenerationPrompt(args)

  const { object } = await generateObject({
    model: textModel(),
    prompt,
    schema: z.object({
      newExercise: z.object({
        questionText: z.string(),
        exerciseType: z.enum(['single_choice', 'multiple_choice', 'numeric', 'dropdown']),
        choices: z.array(z.string()),
        correctAnswer: z.string(),
        explanation: z.string(),
      }),
    }),
  })

  const genEx = object.newExercise

  // Randomize choices to remove the model's position bias
  let finalChoices = genEx.choices
  if (genEx.exerciseType === 'single_choice' || genEx.exerciseType === 'multiple_choice' || genEx.exerciseType === 'dropdown') {
    finalChoices = shuffleArray(genEx.choices)
  }

  return prisma.exercise.create({
    data: {
      id: `gen-${crypto.randomUUID()}`,
      topicId: topicData.id,
      questionText: genEx.questionText,
      exerciseType: genEx.exerciseType,
      choices: JSON.stringify(finalChoices),
      correctAnswer: genEx.correctAnswer,
      explanation: genEx.explanation,
    },
    include: { topic: true },
  })
}
