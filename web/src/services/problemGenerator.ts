import crypto from 'crypto'
import { generateObject } from 'ai'
import { z } from 'zod'
import type { Exercise, ExerciseGroup, Topic } from '@prisma/client'
import { textModel } from '@/lib/ai'
import { prisma } from '@/lib/db'
import { generateProblemPrompt, GENERATE_PROBLEM_PROMPT_VERSION, PROBLEM_MIN_PARTS, PROBLEM_MAX_PARTS } from '@/lib/prompts'
import { deriveChoiceAnswer, latexProblems, type ValidationIssue } from '@/lib/exerciseValidation'
import {
  buildGenerationPrompt, rejectionReason, DEFAULT_CHECKS, GenerationError, ALREADY_ASKED_LIMIT, ALREADY_ASKED_CHARS,
  type GeneratorChecks,
} from '@/services/exerciseGenerator'

/** Real imported problems shown to the model as examples of depth and style. */
export const EXEMPLAR_COUNT = 2
export const EXEMPLAR_MAX_CHARS = 7000
const EXEMPLAR_PART_MAX_CHARS = 450

type ExemplarGroup = { title: string; stem: string; topic: { week: string | null }; exercises: { questionText: string; exerciseType: string; choices: string; correctAnswer: string }[] }

/** A real problem as prompt text: the stem and its first parts with their options and key. */
export function describeExemplar(g: ExemplarGroup): string {
  const parts = g.exercises.map((e, i) => {
    const choices = (() => { try { return (JSON.parse(e.choices) as string[]).join(' | ') } catch { return '' } })()
    return `Part ${i + 1} (${e.exerciseType}): ${e.questionText.slice(0, EXEMPLAR_PART_MAX_CHARS)}${choices ? `\nOptions: ${choices.slice(0, EXEMPLAR_PART_MAX_CHARS)}` : ''}\nAnswer: ${e.correctAnswer.slice(0, 200)}`
  })
  return `PROBLEM "${g.title}"\nStem: ${g.stem.slice(0, 1500)}\n${parts.join('\n')}`
}

/** Up to EXEMPLAR_COUNT imported problems of the course with at least three parts, those of the topic's module first. */
export async function fetchProblemExemplars(courseId: string, week: string | null): Promise<string> {
  const groups = await prisma.exerciseGroup.findMany({
    where: { origin: 'imported', status: 'active', topic: { courseId } },
    include: { topic: { select: { week: true } }, exercises: { where: { status: 'active' }, orderBy: { groupPosition: 'asc' }, take: 4 } },
    take: 40,
  })
  const usable = groups.filter((g) => g.exercises.length >= 3)
  const sameWeek = usable.filter((g) => g.topic.week === week)
  const others = usable.filter((g) => g.topic.week !== week)
  const ordered = [...shuffled(sameWeek), ...shuffled(others)].slice(0, EXEMPLAR_COUNT)
  let text = ordered.map(describeExemplar).join('\n\n')
  if (text.length > EXEMPLAR_MAX_CHARS) text = text.slice(0, EXEMPLAR_MAX_CHARS)
  return text
}

/** Attempts at one problem (a failed attempt stores its rejected parts for audit and starts over). */
export const MAX_PROBLEM_ATTEMPTS = 2
/** A problem is kept when at least this many parts pass the quality gate (the others are stored as rejected). */
export const MIN_PASSING_PARTS = 2
export const STEM_LIMITS = { min: 40, max: 2500 } as const

export const generatedProblemSchema = z.object({
  contentKind: z.enum(['subject_matter', 'logistics']),
  logisticsReason: z.string(),
  title: z.string(),
  stem: z.string(),
  parts: z.array(z.object({
    exerciseType: z.enum(['single_choice', 'multiple_choice', 'numeric', 'dropdown']),
    questionText: z.string(),
    choices: z.array(z.string()),
    correctChoiceIndexes: z.array(z.number().int()),
    correctAnswer: z.string(),
    explanation: z.string(),
  })),
})
export type GeneratedProblem = z.infer<typeof generatedProblemSchema>

export type GeneratedProblemResult = { group: ExerciseGroup; exercises: (Exercise & { topic: Topic })[] }

function shuffled<T>(items: T[]): T[] {
  const a = [...items]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** Problems with the stem itself, or null. */
export function stemProblem(stem: string): string | null {
  const t = stem.trim()
  if (t.length < STEM_LIMITS.min || t.length > STEM_LIMITS.max) return `the stem has ${t.length} characters`
  const latex = latexProblems(t)
  if (latex.length > 0) return `stem: ${latex.join(', ')}`
  if (/\[Dropdown \d+\]|\[BLANK\]/.test(t)) return 'the stem contains an answer placeholder'
  return null
}

/**
 * Generates and stores one multi-part problem for a topic: a shared stem and 3 to 5 sub-questions (one model call), each part
 * checked on its own by the same quality gate as a single question (structure, then a blind solve that sees the stem and the part).
 * Parts that fail are stored as rejected; the problem is kept when at least MIN_PASSING_PARTS pass, else the attempt is repeated.
 * Does not touch sessions. Throws GenerationError like `generateExerciseForTopic` (a topic that looks like logistics
 * throws not_study_material without writing a marker: the single-question path marks it).
 */
export async function generateProblemForTopic(args: {
  primaryTopicId: string
  poolTopicIds: string[]
  existingExerciseIds: string[]
  styleTopicIds?: string[]
}, checks: Partial<GeneratorChecks> = {}): Promise<GeneratedProblemResult> {
  const gate: GeneratorChecks = { ...DEFAULT_CHECKS, ...checks }
  for (let attempt = 1; attempt <= MAX_PROBLEM_ATTEMPTS; attempt++) {
    const { topicData, bucketContext, profile } = await buildGenerationPrompt(args)
    const recentIds = args.existingExerciseIds.slice(-ALREADY_ASKED_LIMIT)
    const recent = recentIds.length > 0 ? await prisma.exercise.findMany({ where: { id: { in: recentIds } }, select: { questionText: true } }) : []
    const alreadyAsked = recent.map((r, i) => `Question ${i + 1}: ${r.questionText.slice(0, ALREADY_ASKED_CHARS)}`).join('\n\n')

    const { object } = await generateObject({
      model: textModel(),
      prompt: generateProblemPrompt(profile, { topic: { title: topicData.title, week: topicData.week }, bucketContext, alreadyAsked, exemplars: await fetchProblemExemplars(topicData.courseId, topicData.week) }),
      schema: generatedProblemSchema,
    })
    if (object.contentKind === 'logistics') {
      throw new GenerationError('not_study_material', 'This topic holds course rules or administration rather than study material, so no question is generated from it.')
    }

    const stem = object.stem.trim()
    const title = object.title.trim() || topicData.title
    const stemIssue = stemProblem(stem)
    const parts = object.parts.slice(0, PROBLEM_MAX_PARTS)
    const rows = parts.map((p) => {
      const derived = deriveChoiceAnswer(p.exerciseType, p.choices, p.correctChoiceIndexes, p.correctAnswer)
      const choices = p.exerciseType === 'numeric' ? [] : shuffled(p.choices)
      return { p, choices, correctAnswer: derived.ok ? derived.correctAnswer : '', issue: derived.ok ? undefined : (derived as { ok: false; issue: ValidationIssue }).issue }
    })
    const verdicts: (string | null)[] = stemIssue || parts.length < PROBLEM_MIN_PARTS
      ? rows.map(() => stemIssue ?? `the problem has ${parts.length} parts`)
      : await Promise.all(rows.map((r) => rejectionReason(
        { questionText: `${stem}\n\n${r.p.questionText}`, exerciseType: r.p.exerciseType, choices: r.choices, correctAnswer: r.correctAnswer, explanation: r.p.explanation },
        r.issue,
        { groundingContext: bucketContext, language: profile.contentLanguage, checks: gate },
      )))

    const passing = rows.filter((_, i) => verdicts[i] === null)
    const keep = !stemIssue && passing.length >= MIN_PASSING_PARTS
    const base = (r: (typeof rows)[number]) => ({
      topicId: topicData.id, questionText: r.p.questionText, exerciseType: r.p.exerciseType, choices: JSON.stringify(r.choices),
      correctAnswer: r.correctAnswer, explanation: r.p.explanation, origin: 'generated', promptVersion: GENERATE_PROBLEM_PROMPT_VERSION,
    })
    // Rejected parts are kept for audit, never selected
    for (const [i, r] of rows.entries()) {
      if (verdicts[i] === null && keep) continue
      await prisma.exercise.create({ data: { ...base(r), id: `gen-${crypto.randomUUID()}`, status: 'rejected', reportedReason: `problem_part: ${(verdicts[i] ?? 'the problem had too few passing parts').slice(0, 500)}` } })
    }
    if (!keep) {
      console.warn(`Generated problem rejected (attempt ${attempt}/${MAX_PROBLEM_ATTEMPTS}): ${stemIssue ?? `${passing.length} of ${rows.length} parts passed`}`)
      continue
    }
    const group = await prisma.exerciseGroup.create({ data: { topicId: topicData.id, title, stem, origin: 'generated', status: 'active' } })
    const exercises: (Exercise & { topic: Topic })[] = []
    for (const [position, r] of passing.entries()) {
      exercises.push(await prisma.exercise.create({
        data: { ...base(r), id: `gen-${crypto.randomUUID()}`, status: 'active', groupId: group.id, groupPosition: position },
        include: { topic: true },
      }))
    }
    return { group, exercises }
  }
  throw new GenerationError('validation_failed', 'A problem was generated but it did not pass the quality checks. Please try again.')
}
