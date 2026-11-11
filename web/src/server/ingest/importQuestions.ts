// Question import (plan 4.6): find the questions a file itself contains (problem sets, quizzes, exercise exports) and
// store them as `imp-` exercises of the topics they belong to.
//
//   edX markdown (`# Question` blocks with `## Choices`)   parsed with `parseExerciseMarkdown`, no model call
//   anything else                                           a cheap heuristic per topic, then ONE model call per topic
//                                                           that passes it (`looksLikeQuestions`)
//
// A question is imported only when its answer is stated in the source: the edX parser needs a marked option, the model
// must quote the passage that states the answer and code checks that the quote occurs in the topic text. Every question
// must pass `validateExerciseStructure` and be graded as correct by its own key (`gradeAnswer`). Nothing is invented.
// Enrichment of the imported questions is off by default (see `isImportEnrichmentEnabled`).
import crypto from 'crypto'
import { prisma } from '@/lib/db'
import { extensionOf } from '@/lib/ingestLimits'
import { gradeAnswer } from '@/lib/grading'
import { validateExerciseStructure, deriveChoiceAnswer, INVALID_CHOICE_INDEXES, dropdownAnswerFor, dropdownOption, summarizeIssues } from '@/lib/exerciseValidation'
import { importQuestionsPrompt, INGEST_PROMPT_VERSION } from '@/lib/prompts/ingest'
import { parseExerciseMarkdown } from '@/services/ingest'
import { enrichExercisesByIds, type EnrichmentOutcome } from '@/services/enrichment'
import { NOT_STUDY_MATERIAL_PREFIX } from '@/services/exerciseGenerator'
import { readSourceFile } from '@/server/storage'
import { ImportedQuestionsSchema, type ImportedQuestion } from './schemas'
import { structuredCall, newModelStats, StageError, type GenerateObjectFn, type ModelStats } from './modelCall'
import { mapWithConcurrency, STAGE_CONCURRENCY } from './pool'
import { collapseSpace } from './segment'

/** The heuristic needs at least this many question-like marks in a topic before the model is asked. */
export const QUESTION_HEURISTIC_MIN_MATCHES = 3
const QUESTION_HEURISTIC = /\b(question|exercise|problem)\s*\d|\?\s*$|^\s*\(?[a-d]\)\s/gim

/**
 * Evidence that answers are present in the text, the second half of the pre-filter. A question is only importable when
 * its answer is stated, so a topic with question marks but none of these cues (a lecture transcript, a slide deck) is not
 * sent to the model. Case-insensitive, multiline; the one place to extend. Cues were chosen from the real inputs:
 *  - an edX marked option `[x]`;
 *  - a line that starts with an answer heading (optionally behind Markdown `#` marks) and a colon or period: "Answer key:", "Answers:", "Solution 2:",
 *    "Correct answer:", "Explanation:" (also Portuguese resposta/gabarito/solução, Spanish respuesta/solución,
 *    French réponse/corrigé/solution, German Antwort/Lösung);
 *  - a bare heading line "Answer key", "Solutions", "Gabarito", ... (also behind Markdown heading marks: "## Answer key");
 *  - answer-key lines: "1. B", "2) c", "Question 3: A, B", "Q4 - D";
 *  - the phrase "the correct answer/option/choice is".
 * Only these languages are supported; a document in another language never matches the headings and is skipped unless it
 * contains `[x]` marks or letter-key lines, which are language-free.
 */
export const ANSWER_CUES: RegExp[] = [
  /\[x\]/i,
  /^\s*(?:#{1,6}[ \t]*)?(answer key|answers?|solutions?|correct answers?|explanations?|resposta|respostas|gabarito|solu[cç][aã]o|solu[cç][oõ]es|respuestas?|soluci[oó]n|soluciones|r[ée]ponses?|corrig[ée]|antworten?|l[öo]sung(en)?)\s*(\d+\s*)?[:.]/im,
  /^\s*(?:#{1,6}[ \t]*)?(answer key|solutions?|answers|gabarito|respuestas|corrig[ée]|l[öo]sungen)\s*$/im,
  /^\s*(question|problem|exercise|q|quest[aã]o|pregunta|ejercicio)?\s*\d+\s*[:.)\-]\s*\(?[a-h]\)?(\s*[,&]\s*\(?[a-h]\)?)*\s*$/im,
  /\bthe correct (answer|option|choice)s? (is|are)\b/i,
]

/** True when the text carries at least one answer cue. */
export function hasAnswerCue(text: string): boolean {
  return ANSWER_CUES.some((cue) => cue.test(text))
}

/** Characters of answer-key text passed along with one question topic (keys are short; this bounds a huge one). */
export const ANSWER_KEY_MAX_CHARS = 30_000

/** The question-pattern half of the pre-filter alone (at least three question-like marks). */
export function hasQuestionPattern(text: string): boolean {
  const matches = text.match(QUESTION_HEURISTIC)
  return (matches?.length ?? 0) >= QUESTION_HEURISTIC_MIN_MATCHES
}

/** Stricter question marks for a topic whose answers are in another topic: numbered questions and lettered options, not any line ending in "?". */
const QUIZ_PATTERN = /\b(question|exercise|problem|q)\s*\.?\s*\d+|^\s*\d+[.)]\s+\S.*\?\s*$|^\s*\(?[a-d]\)\s/gim

/** True when the text looks like a quiz: at least three numbered questions or lettered options. */
export function hasQuizPattern(text: string): boolean {
  return (text.match(QUIZ_PATTERN)?.length ?? 0) >= QUESTION_HEURISTIC_MIN_MATCHES
}

/**
 * Cheap pre-filter of plan 4.6 plus answer evidence: a topic is worth one model call when it has at least three
 * question-like marks ("Question 3", a line ending in "?", a line starting with "a)") AND an answer cue (`ANSWER_CUES`).
 */
export function looksLikeQuestions(text: string): boolean {
  return hasQuestionPattern(text) && hasAnswerCue(text)
}

/**
 * Off unless the environment variable ENRICH_IMPORTED_QUESTIONS is exactly "1". Measurements (see the T22 notes in
 * enrichment.ts): rewriting rarely helps and sometimes hurts, so the pipeline does not enrich by default.
 */
export function isImportEnrichmentEnabled(): boolean {
  return process.env.ENRICH_IMPORTED_QUESTIONS === '1'
}

// ---------------------------------------------------------------------------------------------------------------------
// Candidates and acceptance
// ---------------------------------------------------------------------------------------------------------------------

export type Candidate = {
  questionText: string
  exerciseType: string
  choices: string[]
  correctAnswer: string
  explanation: string
  /** Passage of the source that states the answer (model path only; the edX parser reads a marked option instead). */
  answerQuote?: string
}

export type AcceptedQuestion = {
  questionText: string
  exerciseType: string
  choices: string[]
  correctAnswer: string
  explanation: string
  explanationFallback: boolean
}

function haystack(text: string): string {
  return collapseSpace(text.normalize('NFKC')).toLowerCase()
}

/** The answer string a student would send for the stored key, per type. */
export function selfAnswerFor(c: { exerciseType: string; correctAnswer: string }): string {
  switch (c.exerciseType) {
    case 'dropdown': return dropdownAnswerFor(dropdownOption(c.correctAnswer))
    default: return c.correctAnswer
  }
}

function displayAnswer(c: { exerciseType: string; correctAnswer: string }): string {
  if (c.exerciseType === 'multiple_choice') {
    try {
      const parsed = JSON.parse(c.correctAnswer)
      if (Array.isArray(parsed)) return parsed.join('; ')
    } catch { /* shown as stored */ }
  }
  return c.correctAnswer
}

/**
 * A model question as a candidate: the stored key is derived from `correctChoiceIndexes` (see `deriveChoiceAnswer`), so
 * the model never retypes option text. A bad index list is rejected with the code `invalid_correct_choice_indexes`.
 */
export function candidateFromImported(q: ImportedQuestion): { ok: true; candidate: Candidate } | { ok: false; reason: string } {
  const choices = (q.choices ?? []).map((x) => String(x).trim())
  const derived = deriveChoiceAnswer(q.exerciseType, choices, q.correctChoiceIndexes, q.correctAnswer ?? '')
  if (!derived.ok) return { ok: false, reason: INVALID_CHOICE_INDEXES }
  return { ok: true, candidate: { ...q, choices, correctAnswer: derived.correctAnswer } }
}

/**
 * Decides whether a candidate becomes an exercise. `sourceText` is given for model candidates: the quoted passage must
 * occur in it. Returns the cleaned question or the reason it was rejected (a short stable code).
 */
export function acceptCandidate(c: Candidate, sourceText: string | null): { ok: true; question: AcceptedQuestion } | { ok: false; reason: string } {
  const questionText = (c.questionText ?? '').trim()
  const choices = (c.choices ?? []).map((x) => String(x).trim())
  const correctAnswer = (c.correctAnswer ?? '').trim()
  if (!questionText) return { ok: false, reason: 'empty_question' }
  if (!correctAnswer || correctAnswer === '[]') return { ok: false, reason: 'no_answer_in_source' }

  if (sourceText !== null) {
    const quote = haystack(c.answerQuote ?? '')
    if (quote.length < 2) return { ok: false, reason: 'no_answer_quote' }
    if (!haystack(sourceText).includes(quote)) return { ok: false, reason: 'answer_quote_not_in_source' }
  }

  let explanation = (c.explanation ?? '').trim()
  let explanationFallback = false
  if (!explanation) {
    explanation = `The source gives this answer: ${displayAnswer({ exerciseType: c.exerciseType, correctAnswer })}`
    explanationFallback = true
  }
  const candidate = { questionText, exerciseType: c.exerciseType, choices, correctAnswer, explanation }
  const issues = validateExerciseStructure(candidate, { origin: 'imported' })
  if (issues.length > 0) return { ok: false, reason: `invalid:${summarizeIssues(issues)}` }
  // Graded as correct by its own key
  const graded = gradeAnswer({ ...candidate }, selfAnswerFor(candidate))
  if (!graded.isCorrect) return { ok: false, reason: 'key_does_not_grade_as_correct' }
  return { ok: true, question: { ...candidate, explanationFallback } }
}

// ---------------------------------------------------------------------------------------------------------------------
// edX markdown
// ---------------------------------------------------------------------------------------------------------------------

/** True for the edX export format (`# Question` blocks that have a `## Choices` section). */
export function isEdxMarkdown(text: string): boolean {
  return /^# Question/m.test(text) && /^## Choices/m.test(text)
}

const POINTS_LINE = /^\s*([\d.]+\s*\/\s*[\d.]+\s+points?|[\d.]+\s+points?\s+possible)\s*(\(graded\)|\(ungraded\))?\s*$/i
const EDX_NOISE_LINE = /^\s*(Answers are displayed within the problem|Review|Submit|Show answer|Save|Hide answer|You have used \d+ of \d+ attempts?)\s*$/i
const QUESTION_NUMBER_LINE = /^\s*Question\s+\d+(\.\d+)*\s*$/i

/** The question text of an edX block without the export's own decoration (question number, points, buttons). */
export function cleanEdxQuestionText(raw: string): string {
  const lines = raw.split('\n').filter((l) => !POINTS_LINE.test(l) && !EDX_NOISE_LINE.test(l) && !QUESTION_NUMBER_LINE.test(l))
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function cleanEdxExplanation(raw: string): string {
  return raw.replace(/^\s*Explanation\s*\n/, '').replace(/\n\s*(Review|Submit)\s*$/i, '').trim()
}

/** Parses an edX markdown file into candidates (no model call). Blocks without a marked answer come back with an empty key. */
export function edxCandidates(text: string): Candidate[] {
  return parseExerciseMarkdown(text).map((p) => ({
    questionText: cleanEdxQuestionText(p.questionText),
    exerciseType: p.exerciseType ?? 'single_choice',
    choices: p.choices,
    correctAnswer: p.correctAnswer,
    explanation: cleanEdxExplanation(p.explanation),
  }))
}

// ---------------------------------------------------------------------------------------------------------------------
// importQuestionsForSource
// ---------------------------------------------------------------------------------------------------------------------

export type ImportStats = {
  path: 'edx_markdown' | 'model' | 'none' | 'skipped'
  topicsTotal: number
  topicsStudyMaterial: number
  /** Topics that passed the heuristic (each costs up to two model attempts). */
  topicsPassingHeuristic: number
  /** Topics with an answer cue but no question pattern (an answer key) whose text was passed along with the question topics. */
  answerKeyTopics: number
  /** Question candidates found: edX blocks, or questions the model returned. */
  candidates: number
  imported: number
  rejected: Record<string, number>
  rejectedExamples: { reason: string; questionText: string }[]
  explanationFallbacks: number
  model: ModelStats
  enrichment: { enabled: boolean; outcomes: EnrichmentOutcome[] }
  ms: number
}

/** One stored question with the passage of the source that states its answer (model path only), for review and audits. */
export type ImportedItem = { exerciseId: string; topicId: string; answerQuote: string | null }
export type ImportResult = { imported: number; exerciseIds: string[]; items: ImportedItem[]; stats: ImportStats }

type TopicRow = { id: string; title: string; content: string | null; order: number; pageStart: number | null; pageEnd: number | null }

/** The topic an edX block belongs to: the one whose text contains the start of the question, else by relative position. */
function topicForEdxBlock(question: string, index: number, total: number, topics: TopicRow[]): TopicRow {
  const probe = haystack(question).slice(0, 60)
  if (probe.length >= 20) {
    const hit = topics.find((t) => haystack(t.content ?? '').includes(probe))
    if (hit) return hit
  }
  return topics[Math.min(topics.length - 1, Math.floor((index / Math.max(1, total)) * topics.length))]
}

function addReject(stats: ImportStats, reason: string, questionText: string): void {
  stats.rejected[reason] = (stats.rejected[reason] ?? 0) + 1
  if (stats.rejectedExamples.length < 12) stats.rejectedExamples.push({ reason, questionText: questionText.slice(0, 160) })
}

/**
 * Imports the questions the source contains. Runs from status `importing_questions` and leaves the status to the runner
 * on success (the next stage depends on the space's profile); on failure sets status `failed`, failedStage
 * `importing_questions` and a readable error, writes nothing, and rethrows.
 *
 * Re-running is idempotent: the `imp-` exercises of this source's topics that have no answers are deleted and created
 * again; an imported question that already has answers stays and is not created a second time. Topics classified as
 * not study material are not searched. Exercises of other sources are untouched. A source past this stage is a no-op.
 *
 * `deps.enrich` (default: `isImportEnrichmentEnabled()`, off) runs the gated enrichment on the new questions with the
 * explicit upload opt-in of `enrichment.ts`.
 */
export async function importQuestionsForSource(
  sourceId: string,
  deps: { generate?: GenerateObjectFn; enrich?: boolean } = {},
): Promise<ImportResult> {
  const started = Date.now()
  const source = await prisma.source.findUnique({ where: { id: sourceId } })
  if (!source) throw new Error(`Source ${sourceId} not found`)
  const stats: ImportStats = {
    path: 'none', topicsTotal: 0, topicsStudyMaterial: 0, topicsPassingHeuristic: 0, answerKeyTopics: 0, candidates: 0, imported: 0, rejected: {},
    rejectedExamples: [], explanationFallbacks: 0, model: newModelStats(), enrichment: { enabled: false, outcomes: [] }, ms: 0,
  }
  if (source.status !== 'importing_questions') {
    if (['generating_exercises', 'ready'].includes(source.status)) {
      const count = await prisma.exercise.count({ where: { id: { startsWith: 'imp-' }, topic: { sourceId } } })
      return { imported: count, exerciseIds: [], items: [], stats: { ...stats, path: 'skipped', imported: count, ms: Date.now() - started } }
    }
    throw new Error(`Source ${sourceId} is ${source.status}; question import runs only from importing_questions`)
  }

  try {
    const topics: TopicRow[] = await prisma.topic.findMany({
      where: { sourceId }, orderBy: { order: 'asc' }, select: { id: true, title: true, content: true, order: true, pageStart: true, pageEnd: true },
    })
    stats.topicsTotal = topics.length
    const markers = await prisma.exercise.findMany({
      where: { topic: { sourceId }, status: 'rejected', reportedReason: { startsWith: NOT_STUDY_MATERIAL_PREFIX } }, select: { topicId: true },
    })
    const notStudy = new Set(markers.map((m) => m.topicId))
    const study = topics.filter((t) => !notStudy.has(t.id) && (t.content ?? '').trim() !== '')
    stats.topicsStudyMaterial = study.length

    const accepted: { topicId: string; q: AcceptedQuestion; fromModel: boolean; quote: string | null }[] = []
    const seen = new Set<string>()
    const take = (topicId: string, c: Candidate, sourceText: string | null) => {
      stats.candidates++
      const result = acceptCandidate(c, sourceText)
      if (!result.ok) return addReject(stats, result.reason, c.questionText ?? '')
      const key = haystack(result.question.questionText)
      if (seen.has(key)) return addReject(stats, 'duplicate_in_file', c.questionText)
      seen.add(key)
      accepted.push({ topicId, q: result.question, fromModel: sourceText !== null, quote: sourceText !== null ? (c.answerQuote ?? null) : null })
    }

    let edx: Candidate[] | null = null
    if (extensionOf(source.storageKey) === '.md' && study.length > 0) {
      const raw = (await readSourceFile(source.storageKey)).toString('utf8').replace(/^﻿/, '')
      if (isEdxMarkdown(raw)) edx = edxCandidates(raw)
    }

    if (edx) {
      stats.path = 'edx_markdown'
      edx.forEach((c, i) => take(topicForEdxBlock(c.questionText, i, edx.length, study).id, c, null))
    } else if (study.length > 0) {
      // A quiz and its key can land in different topics (questions on pages 1-2, key on page 3): a topic with an answer cue but
      // no question pattern is a key, and its text is an extra answer source for the question topics of this source.
      const keyTopics = study.filter((t) => hasAnswerCue(t.content ?? '') && !hasQuestionPattern(t.content ?? ''))
      stats.answerKeyTopics = keyTopics.length
      const candidates = study.filter((t) => looksLikeQuestions(t.content ?? '') || (keyTopics.length > 0 && hasQuizPattern(t.content ?? '')))
      stats.topicsPassingHeuristic = candidates.length
      stats.path = candidates.length > 0 ? 'model' : 'none'
      const keyTextFor = (topicId: string): string =>
        keyTopics.filter((k) => k.id !== topicId).map((k) => (k.content ?? '').trim()).join('\n\n').slice(0, ANSWER_KEY_MAX_CHARS)
      const perTopic = await mapWithConcurrency(candidates, STAGE_CONCURRENCY, async (t) => {
        const answerKeyText = keyTextFor(t.id)
        const object = await structuredCall({
          generate: deps.generate, stats: stats.model, schema: ImportedQuestionsSchema, what: `Reading the questions of "${t.title.slice(0, 60)}"`,
          prompt: importQuestionsPrompt({ topicTitle: t.title, text: t.content ?? '', answerKeyText: answerKeyText || undefined }),
        })
        return object.questions as ImportedQuestion[]
      })
      // The quoted passage may come from the topic itself or from a key topic
      perTopic.forEach((questions, i) => questions.forEach((q) => {
        const made = candidateFromImported(q)
        if (!made.ok) {
          stats.candidates++
          return addReject(stats, made.reason, q.questionText ?? '')
        }
        take(candidates[i].id, made.candidate, [candidates[i].content ?? '', keyTextFor(candidates[i].id)].join('\n\n'))
      }))
    }

    // Write: replace the unanswered imported questions of this source in one transaction
    const exerciseIds: string[] = []
    const items: ImportedItem[] = []
    await prisma.$transaction(async (tx) => {
      await tx.exercise.deleteMany({ where: { id: { startsWith: 'imp-' }, topic: { sourceId }, logs: { none: {} } } })
      const kept = await tx.exercise.findMany({ where: { id: { startsWith: 'imp-' }, topic: { sourceId } }, select: { questionText: true } })
      const keptKeys = new Set(kept.map((k) => haystack(k.questionText)))
      for (const { topicId, q, fromModel, quote } of accepted) {
        if (keptKeys.has(haystack(q.questionText))) continue
        const id = `imp-${crypto.randomUUID()}`
        await tx.exercise.create({
          data: {
            id, topicId, questionText: q.questionText, exerciseType: q.exerciseType, choices: JSON.stringify(q.choices),
            correctAnswer: q.correctAnswer, explanation: q.explanation, isGraded: true, origin: 'imported', status: 'active',
            promptVersion: fromModel ? INGEST_PROMPT_VERSION : null,
          },
        })
        if (q.explanationFallback) stats.explanationFallbacks++
        exerciseIds.push(id)
        items.push({ exerciseId: id, topicId, answerQuote: quote })
      }
    }, { timeout: 60_000, maxWait: 30_000 })
    stats.imported = exerciseIds.length

    const enrich = deps.enrich ?? isImportEnrichmentEnabled()
    stats.enrichment.enabled = enrich
    if (enrich && exerciseIds.length > 0) {
      stats.enrichment.outcomes = await enrichExercisesByIds(exerciseIds, {
        forUploadedContent: true, limit: exerciseIds.length, maxCalls: exerciseIds.length * 3,
      })
    }
    stats.ms = Date.now() - started
    return { imported: exerciseIds.length, exerciseIds, items, stats }
  } catch (error) {
    const message = error instanceof StageError
      ? `${error.message} Use Retry.`
      : 'Something went wrong while reading the questions of this file. Use Retry; if it keeps failing, upload the file again.'
    if (!(error instanceof StageError)) console.error(`[importQuestions] source ${sourceId}:`, error)
    await prisma.source.updateMany({ where: { id: sourceId, status: 'importing_questions' }, data: { status: 'failed', failedStage: 'importing_questions', error: message } })
    throw error
  }
}
