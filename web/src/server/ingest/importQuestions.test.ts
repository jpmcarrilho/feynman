// Question import: pure rules plus the pipeline stage against a real (temporary) SQLite database.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'

const env = vi.hoisted(() => ({ dir: '' }))
vi.mock('@ai-sdk/google', () => ({ google: vi.fn(() => 'mocked-google-model') }))
// The database is always a throwaway one, whatever the import order
vi.mock('@/lib/db', async () => {
  const { createTestPrisma } = await import('./__fixtures__/testDb')
  const t = await createTestPrisma()
  env.dir = t.dir
  process.env.STORAGE_DIR = `${t.dir}/storage`
  return { prisma: t.prisma }
})
const enrichment = vi.hoisted(() => ({ enrichExercisesByIds: vi.fn(async () => [] as unknown[]) }))
vi.mock('@/services/enrichment', () => ({ enrichExercisesByIds: enrichment.enrichExercisesByIds }))

import { ImportedQuestionsSchema } from './schemas'
import { importQuestionsPrompt } from '@/lib/prompts/ingest'
import { looksLikeQuestions, hasQuestionPattern, hasQuizPattern, hasAnswerCue, acceptCandidate, candidateFromImported, cleanEdxQuestionText, isEdxMarkdown, edxCandidates, isImportEnrichmentEnabled } from './importQuestions'
import { validateExerciseStructure } from '@/lib/exerciseValidation'
import { gradeAnswer } from '@/lib/grading'

type Prisma = typeof import('@/lib/db').prisma
let prisma: Prisma
let importQuestionsForSource: typeof import('./importQuestions').importQuestionsForSource
let writeSourceFile: typeof import('@/server/storage').writeSourceFile

const EDX = `# Question
Question 1.1
0.0/1.0 point (graded)

Which of these is an example of administrative data (Select all that apply)?

## Choices
- [ ] Text from a tweet
- [ ] Information from a birth certificate
- [ ] Income information from tax records

# Question
Question 2.1
0.0/1.0 point (graded)

In addition to the data provider, who should sign the Data Use Agreement (DUA)?

Answers are displayed within the problem
Review

## Choices
- [ ] The study subjects
- [x] An official institutional representative
correct
- [ ] The research assistant(s)
- [ ] The principal investigator(s)

## Explanation/Solution
Explanation

DUAs should be signed by an official institutional representative.

# Question
Question 3.1
1.0/1.0 point (graded)

Researchers can obtain administrative data from public institutions.

## Choices
- [x] True
correct
- [ ] False

## Explanation/Solution
Explanation

True.

# Question
Question 4.1
1.0/1.0 point (graded)

Which are benefits of administrative data? Select all that apply.

## Choices
- [x] Low cost
- [x] Large samples
- [ ] Always perfect quality
- [ ] No privacy concerns

## Explanation/Solution
Explanation

Cheap and large; quality and privacy still need care.
`

let n = 0
async function makeSource(opts: { ext: string; topics: { title: string; content: string; notStudy?: boolean }[]; original?: string }) {
  const courseId = `c${++n}`
  await prisma.course.create({ data: { id: courseId, code: courseId, title: courseId } })
  const id = `s${++n}`
  const key = opts.original != null ? await writeSourceFile(courseId, id, opts.ext, new TextEncoder().encode(opts.original)) : `sources/${courseId}/${id}/original${opts.ext}`
  await prisma.source.create({ data: { id, courseId, originalName: `f${opts.ext}`, mimeType: 'text/plain', sizeBytes: 1, storageKey: key, status: 'importing_questions' } })
  const topicIds: string[] = []
  for (const [i, t] of opts.topics.entries()) {
    const topic = await prisma.topic.create({ data: { courseId, sourceId: id, order: i, title: t.title, content: t.content, week: '01 · M' } })
    topicIds.push(topic.id)
    if (t.notStudy) {
      await prisma.exercise.create({ data: { id: `gen-m${n}-${i}`, topicId: topic.id, questionText: 'marker', choices: '[]', correctAnswer: '', isGraded: false, origin: 'generated', status: 'rejected', reportedReason: 'not_study_material: logistics' } })
    }
  }
  return { id, courseId, topicIds }
}

let calls = 0
const answerKey = 'Answer key: 1. B  2. C'
const MODEL_TEXT = `Problem 1. What is the capital of France?\n(a) Paris\n(b) Rome\n(c) Madrid\nProblem 2. Compute 2+3.\nProblem 3. Is the sky blue?\n${answerKey}\nSolution 2: the sum is 5.`
function generateWith(questions: unknown[]) {
  return (async (args: { schema: unknown }) => {
    calls++
    expect(args.schema).toBe(ImportedQuestionsSchema)
    return { object: { questions }, usage: { inputTokens: 50, outputTokens: 5 } }
  }) as never
}

beforeAll(async () => {
  prisma = (await import('@/lib/db')).prisma
  importQuestionsForSource = (await import('./importQuestions')).importQuestionsForSource
  writeSourceFile = (await import('@/server/storage')).writeSourceFile
})
afterAll(async () => {
  await prisma.$disconnect()
  fs.rmSync(env.dir, { recursive: true, force: true })
})
beforeEach(() => {
  calls = 0
  enrichment.enrichExercisesByIds.mockClear()
})

describe('looksLikeQuestions', () => {
  const questions = 'Problem 1. First?\n(a) one\n(b) two\nProblem 2. Second?\n'
  it('needs at least three question-like marks', () => {
    expect(hasQuestionPattern('A plain paragraph about voting. Another sentence.')).toBe(false)
    expect(hasQuestionPattern('What is X?\nWhat is Y?\n')).toBe(false)
    expect(hasQuestionPattern('What is X?\nWhat is Y?\nWhy Z?\n')).toBe(true)
    expect(hasQuestionPattern('Problem 1 blah\nProblem 2 blah\nExercise 3')).toBe(true)
    expect(hasQuestionPattern('(a) one\n(b) two\n(c) three')).toBe(true)
  })
  it('also needs an answer cue: rhetorical questions of a lecture do not pass', () => {
    expect(looksLikeQuestions('What is X?\nWhat is Y?\nWhy Z?\nSo the answer is that it depends.')).toBe(false)
    expect(looksLikeQuestions(questions)).toBe(false)
  })
  it.each([
    ['Answer key heading', 'Answer key:\n1. B'],
    ['bare heading', 'ANSWER KEY\nsee below'],
    ['solution line', 'Solution 2: the sum is 5.'],
    ['key line', 'Question 3: A, B'],
    ['key line with letter only', '4) c'],
    ['edX mark', '- [x] An official institutional representative'],
    ['phrase', 'Hence the correct answer is Paris.'],
    ['Portuguese heading', 'Gabarito:\n1. B'],
    ['Spanish heading', 'Respuestas: 1-b'],
  ])('passes with %s', (_n, cue) => {
    expect(hasAnswerCue(cue)).toBe(true)
    expect(looksLikeQuestions(`${questions}${cue}`)).toBe(true)
  })
  it.each([
    ['## Answer key', '## Answer key\n1. B'],
    ['### Solutions', '### Solutions\n1. B'],
    ['# Answers', '# Answers\n1. B'],
    ['##Answer key without a space', '##Answer key'],
    ['## Answer key:', '## Answer key: 1. B'],
    ['## Gabarito', '## Gabarito'],
  ])('counts an answer heading behind Markdown marks: %s', (_n, cue) => {
    expect(hasAnswerCue(cue)).toBe(true)
  })
  it('passes the Markdown quiz of the T24 test: numbered open questions followed by an "## Answer key" section', () => {
    const quiz = [
      '## Practice questions', '',
      '1. Why do two candidates in a majority-rule election converge toward the median voter?',
      '2. What happens to the median voter result when a second policy dimension is added?',
      '3. Why do platforms stay apart in practice?',
      '4. Why must preferences be single-peaked?', '',
      '## Answer key', '',
      '1. Each wins by moving toward the position most voters prefer to the rival.',
      '2. A stable majority winner generally fails to exist.',
    ].join('\n')
    expect(hasQuestionPattern(quiz)).toBe(true)
    expect(looksLikeQuestions(quiz)).toBe(true)
  })
  it('does not treat a heading that merely starts with an answer word as a cue', () => {
    expect(hasAnswerCue('## Answering questions in seminars\nBe brief.')).toBe(false)
    expect(hasAnswerCue('## Solutions to market failures are debated\nText.')).toBe(false)
  })
  it('hasQuizPattern wants numbered questions or lettered options, not any line ending in a question mark', () => {
    expect(hasQuizPattern('What is X?\nWhy Y?\nHow Z?')).toBe(false)
    expect(hasQuizPattern('1. What is X?\n2. Why Y?\n3. How Z?')).toBe(true)
    expect(hasQuizPattern('Question 1\nQuestion 2\nQuestion 3')).toBe(true)
    expect(hasQuizPattern('(a) one\n(b) two\n(c) three')).toBe(true)
  })
  it('does not treat running prose as a cue', () => {
    expect(hasAnswerCue('Participant: the answer to that is complicated. Correct. This is more accurate.')).toBe(false)
  })
})

describe('acceptCandidate', () => {
  const base = { questionText: 'Q?', exerciseType: 'single_choice', choices: ['A', 'B', 'C'], correctAnswer: 'B', explanation: 'Because.', answerQuote: 'Answer key: 1. B' }
  it('accepts a valid question whose quote is in the source and whose key grades as correct', () => {
    const r = acceptCandidate(base, 'Intro\nAnswer key:   1. b\nend')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(validateExerciseStructure(r.question, { origin: 'imported' })).toEqual([])
      expect(gradeAnswer(r.question, r.question.correctAnswer).isCorrect).toBe(true)
    }
  })
  it('rejects a quote that is not in the source (an invented answer)', () => {
    expect(acceptCandidate(base, 'Nothing here')).toEqual({ ok: false, reason: 'answer_quote_not_in_source' })
    expect(acceptCandidate({ ...base, answerQuote: '' }, 'x')).toEqual({ ok: false, reason: 'no_answer_quote' })
    expect(acceptCandidate({ ...base, correctAnswer: '' }, 'x')).toEqual({ ok: false, reason: 'no_answer_in_source' })
  })
  it('rejects structurally invalid questions: two choices, answer not among the choices, non-numeric numeric answer', () => {
    const src = 'Answer key: 1. B'
    expect(acceptCandidate({ ...base, choices: ['Only one'], correctAnswer: 'Only one' }, src)).toMatchObject({ ok: false, reason: expect.stringContaining('choice_count') })
    // a true/false item with a stated answer is a legitimate imported question
    expect(acceptCandidate({ ...base, choices: ['True', 'False'], correctAnswer: 'True' }, src).ok).toBe(true)
    expect(acceptCandidate({ ...base, correctAnswer: 'Z' }, src)).toMatchObject({ ok: false, reason: expect.stringContaining('answer_not_in_choices') })
    expect(acceptCandidate({ ...base, exerciseType: 'numeric', choices: [], correctAnswer: 'about 5' }, src)).toMatchObject({ ok: false, reason: expect.stringContaining('answer_not_number') })
  })
  it('accepts numeric, multiple choice and dropdown questions with their own keys', () => {
    const src = 'Answer key: 1. B'
    expect(acceptCandidate({ ...base, exerciseType: 'numeric', choices: [], correctAnswer: '5' }, src).ok).toBe(true)
    expect(acceptCandidate({ ...base, exerciseType: 'multiple_choice', correctAnswer: JSON.stringify(['A', 'C']) }, src).ok).toBe(true)
    expect(acceptCandidate({ ...base, exerciseType: 'dropdown', questionText: 'The capital is [Dropdown 1].', correctAnswer: 'B' }, src).ok).toBe(true)
  })
  it('uses a statement of the source answer when the source gives no explanation, and says so', () => {
    const r = acceptCandidate({ ...base, explanation: '' }, 'Answer key: 1. B')
    expect(r.ok && r.question.explanationFallback).toBe(true)
    expect(r.ok && r.question.explanation).toBe('The source gives this answer: B')
  })
})

describe('edX markdown', () => {
  it('recognises the format and cleans the export decoration', () => {
    expect(isEdxMarkdown(EDX)).toBe(true)
    expect(isEdxMarkdown('# Notes\nplain')).toBe(false)
    expect(cleanEdxQuestionText('Question 8.1\n0.0/1.0 point (graded)\n\nWho signs?\n\nAnswers are displayed within the problem\nReview')).toBe('Who signs?')
    expect(cleanEdxQuestionText('0 points possible (ungraded)\n\nWhich of these is likely?')).toBe('Which of these is likely?')
    const [, second] = edxCandidates(EDX)
    expect(second.questionText).toBe('In addition to the data provider, who should sign the Data Use Agreement (DUA)?')
    expect(second.correctAnswer).toBe('An official institutional representative')
    expect(second.explanation).toBe('DUAs should be signed by an official institutional representative.')
  })
})

describe('importQuestionsForSource: edX markdown', () => {
  it('imports the questions with a marked answer without a model call, rejects the rest with reasons', async () => {
    const { id, topicIds } = await makeSource({ ext: '.md', original: EDX, topics: [{ title: 'Exercises', content: EDX }] })
    const result = await importQuestionsForSource(id, { generate: generateWith([]) })
    expect(calls).toBe(0)
    expect(result.stats.path).toBe('edx_markdown')
    expect(result.stats.candidates).toBe(4)
    expect(result.imported).toBe(3)
    expect(result.stats.rejected).toEqual({ no_answer_in_source: 1 })
    const rows = await prisma.exercise.findMany({ where: { topicId: { in: topicIds } }, orderBy: { id: 'asc' } })
    expect(rows).toHaveLength(3)
    expect(rows.some((r) => JSON.parse(r.choices).length === 2)).toBe(true)
    for (const r of rows) {
      expect(r.id.startsWith('imp-')).toBe(true)
      expect(r).toMatchObject({ origin: 'imported', status: 'active', isGraded: true })
      const ex = { questionText: r.questionText, exerciseType: r.exerciseType, choices: JSON.parse(r.choices), correctAnswer: r.correctAnswer, explanation: r.explanation }
      expect(validateExerciseStructure(ex, { origin: 'imported' })).toEqual([])
      expect(gradeAnswer(ex, r.correctAnswer).isCorrect).toBe(true)
    }
    const multi = rows.find((r) => r.exerciseType === 'multiple_choice')!
    expect(JSON.parse(multi.correctAnswer)).toEqual(['Low cost', 'Large samples'])
    // the source status is left to the runner
    expect((await prisma.source.findUnique({ where: { id } }))!.status).toBe('importing_questions')
  })
})

describe('candidateFromImported', () => {
  const choices = ['$\\frac{a}{b}$', '$\\beta$', '$\\theta$', '$\\nu$']
  const q = { questionText: 'Q?', exerciseType: 'multiple_choice' as const, choices, correctChoiceIndexes: [0, 3], correctAnswer: '', explanation: 'E', answerQuote: 'Answer key: 1. A, D' }
  it('derives the key from the indexes, byte for byte', () => {
    const r = candidateFromImported(q)
    expect(r.ok && JSON.parse(r.candidate.correctAnswer)).toEqual([choices[0], choices[3]])
    const single = candidateFromImported({ ...q, exerciseType: 'single_choice', correctChoiceIndexes: [2] })
    expect(single.ok && single.candidate.correctAnswer).toBe('$\\theta$')
    const accepted = r.ok && acceptCandidate(r.candidate, 'Answer key: 1. A, D')
    expect(accepted && accepted.ok).toBe(true)
  })
  it('rejects bad index lists with a stable code', () => {
    for (const idx of [[], [9], [1, 1]]) expect(candidateFromImported({ ...q, correctChoiceIndexes: idx })).toEqual({ ok: false, reason: 'invalid_correct_choice_indexes' })
    expect(candidateFromImported({ ...q, exerciseType: 'numeric', choices: [], correctChoiceIndexes: [0], correctAnswer: '5' })).toEqual({ ok: false, reason: 'invalid_correct_choice_indexes' })
  })
  it('keeps a numeric answer', () => {
    const r = candidateFromImported({ ...q, exerciseType: 'numeric', choices: [], correctChoiceIndexes: [], correctAnswer: '5' })
    expect(r.ok && r.candidate.correctAnswer).toBe('5')
  })
  it('is required by the schema and asked for by the prompt', () => {
    expect(ImportedQuestionsSchema.safeParse({ questions: [{ ...q, correctChoiceIndexes: undefined }] }).success).toBe(false)
    expect(importQuestionsPrompt({ topicTitle: 'T', text: 'x' })).toContain('correctChoiceIndexes')
  })
})

describe('importQuestionsForSource: model path', () => {
  const q = (over: Record<string, unknown> = {}) => ({ questionText: 'What is the capital of France?', exerciseType: 'single_choice', choices: ['Paris', 'Rome', 'Madrid'], correctChoiceIndexes: [0], correctAnswer: '', explanation: 'The key says B... as written.', answerQuote: 'Answer key: 1. B', ...over })

  it('asks the model only for topics that pass the heuristic and are study material, and keeps only answered, valid questions', async () => {
    const { id, topicIds } = await makeSource({
      ext: '.txt',
      topics: [
        { title: 'Lecture', content: 'A lecture paragraph without questions.' },
        { title: 'Quiz', content: MODEL_TEXT },
        { title: 'Logistics quiz', content: MODEL_TEXT, notStudy: true },
      ],
    })
    const result = await importQuestionsForSource(id, {
      generate: generateWith([
        q(),
        q({ questionText: 'Compute 2+3.', exerciseType: 'numeric', choices: [], correctChoiceIndexes: [], correctAnswer: '5', answerQuote: 'Solution 2: the sum is 5.' }),
        q({ questionText: 'Pick the only option.', choices: ['Only one'], correctChoiceIndexes: [0] }),
        q({ questionText: 'Invented?', answerQuote: 'The answer is obviously Rome.' }),
        q({ questionText: 'What is the capital of France?' }),
      ]),
    })
    expect(calls).toBe(1)
    expect(result.stats).toMatchObject({ path: 'model', topicsTotal: 3, topicsStudyMaterial: 2, topicsPassingHeuristic: 1, candidates: 5, imported: 2 })
    expect(result.stats.rejected.answer_quote_not_in_source).toBe(1)
    expect(result.stats.rejected.duplicate_in_file).toBe(1)
    expect(Object.keys(result.stats.rejected).some((k) => k.includes('choice_count'))).toBe(true)
    const rows = await prisma.exercise.findMany({ where: { id: { startsWith: 'imp-' }, topic: { sourceId: id } } })
    expect(rows.map((r) => r.topicId)).toEqual([topicIds[1], topicIds[1]])
    expect(rows.every((r) => r.promptVersion === 'ingest-v2')).toBe(true)
  })

  it('pairs the questions of one topic with an answer key that segmentation put in another topic of the same source', async () => {
    const quiz = 'Question 1. What is the capital of France?\n(a) Paris\n(b) Rome\n(c) Madrid\nQuestion 2. Compute 2+3.\nQuestion 3. Which is a prime?\n(a) 4\n(b) 7\n(c) 9'
    const key = 'Answer key\n1. A\n2. The sum is 5.\n3. B'
    const lecture = 'Why do voters matter?\nWhat does the median voter want?\nWho decides the platform?\nA lecture paragraph.'
    const prompts: string[] = []
    const generate = (async (args: { prompt: string }) => {
      prompts.push(args.prompt)
      return { object: { questions: [
        q({ answerQuote: 'Answer key\n1. A' }),
        q({ questionText: 'Compute 2+3.', exerciseType: 'numeric', choices: [], correctChoiceIndexes: [], correctAnswer: '5', answerQuote: '2. The sum is 5.' }),
        q({ questionText: 'Which is a prime?', choices: ['4', '7', '9'], correctChoiceIndexes: [1], answerQuote: '3. B' }),
        q({ questionText: 'Invented?', answerQuote: '4. D' }),
      ] }, usage: { inputTokens: 1, outputTokens: 1 } }
    }) as never
    const { id, topicIds } = await makeSource({ ext: '.txt', topics: [{ title: 'Quiz, questions', content: quiz }, { title: 'Quiz, key', content: key }, { title: 'Lecture', content: lecture }] })
    const result = await importQuestionsForSource(id, { generate })
    expect(prompts).toHaveLength(1) // only the quiz topic is asked: the key has no questions and the lecture has no quiz marks
    expect(prompts[0]).toContain('ANSWER KEY TEXT')
    expect(prompts[0]).toContain('1. A\n2. The sum is 5.')
    expect(result.stats).toMatchObject({ path: 'model', answerKeyTopics: 1, topicsPassingHeuristic: 1, candidates: 4, imported: 3 })
    expect(result.stats.rejected.answer_quote_not_in_source).toBe(1)
    const rows = await prisma.exercise.findMany({ where: { id: { startsWith: 'imp-' }, topic: { sourceId: id } } })
    expect(rows.map((r) => r.topicId)).toEqual([topicIds[0], topicIds[0], topicIds[0]])
  })

  it('without a key topic the same quiz is not sent to the model', async () => {
    const quiz = 'Question 1. What is the capital of France?\n(a) Paris\n(b) Rome\n(c) Madrid\nQuestion 2. Compute 2+3.\nQuestion 3. Which is a prime?\n(a) 4\n(b) 7\n(c) 9'
    const { id } = await makeSource({ ext: '.txt', topics: [{ title: 'Quiz, questions', content: quiz }] })
    const result = await importQuestionsForSource(id, { generate: generateWith([]) })
    expect(calls).toBe(0)
    expect(result.stats).toMatchObject({ path: 'none', answerKeyTopics: 0, imported: 0 })
  })

  it('a re-run replaces unanswered imports, keeps answered ones and never duplicates them', async () => {
    const { id, courseId, topicIds } = await makeSource({ ext: '.txt', topics: [{ title: 'Quiz', content: MODEL_TEXT }] })
    const generate = generateWith([q(), q({ questionText: 'Compute 2+3.', exerciseType: 'numeric', choices: [], correctChoiceIndexes: [], correctAnswer: '5', answerQuote: 'Solution 2: the sum is 5.' })])
    await importQuestionsForSource(id, { generate })
    const first = await prisma.exercise.findMany({ where: { topicId: topicIds[0] } })
    expect(first).toHaveLength(2)
    // one of them is answered
    const session = await prisma.studySession.create({ data: { courseId, status: 'completed' } })
    await prisma.exerciseLog.create({ data: { sessionId: session.id, exerciseId: first[0].id, isCorrect: true, duration: 3 } })
    await importQuestionsForSource(id, { generate })
    const second = await prisma.exercise.findMany({ where: { topicId: topicIds[0] } })
    expect(second).toHaveLength(2)
    expect(second.some((r) => r.id === first[0].id)).toBe(true)
    expect(second.some((r) => r.id === first[1].id)).toBe(false)
  })

  it('fails the stage with a readable error after two failed attempts and writes nothing', async () => {
    const { id, topicIds } = await makeSource({ ext: '.txt', topics: [{ title: 'Quiz', content: MODEL_TEXT }] })
    const generate = (async () => {
      throw new Error('provider detail')
    }) as never
    await expect(importQuestionsForSource(id, { generate })).rejects.toThrow(/failed twice/)
    const source = await prisma.source.findUnique({ where: { id } })
    expect(source).toMatchObject({ status: 'failed', failedStage: 'importing_questions' })
    expect(source!.error).toMatch(/Use Retry/)
    expect(source!.error).not.toMatch(/provider detail/)
    expect(await prisma.exercise.count({ where: { topicId: { in: topicIds } } })).toBe(0)
  })

  it('does not enrich by default and opts uploaded content in explicitly when switched on', async () => {
    const { id } = await makeSource({ ext: '.txt', topics: [{ title: 'Quiz', content: MODEL_TEXT }] })
    await importQuestionsForSource(id, { generate: generateWith([q()]) })
    expect(enrichment.enrichExercisesByIds).not.toHaveBeenCalled()
    expect(isImportEnrichmentEnabled()).toBe(false)

    const other = await makeSource({ ext: '.txt', topics: [{ title: 'Quiz', content: MODEL_TEXT }] })
    const result = await importQuestionsForSource(other.id, { generate: generateWith([q()]), enrich: true })
    expect(enrichment.enrichExercisesByIds).toHaveBeenCalledWith(result.exerciseIds, expect.objectContaining({ forUploadedContent: true }))
    expect(result.stats.enrichment.enabled).toBe(true)
  })

  it('is a no-op for a source that is past this stage', async () => {
    const { id } = await makeSource({ ext: '.txt', topics: [{ title: 'Quiz', content: MODEL_TEXT }] })
    await prisma.source.update({ where: { id }, data: { status: 'ready' } })
    const result = await importQuestionsForSource(id, { generate: generateWith([q()]) })
    expect(calls).toBe(0)
    expect(result.stats.path).toBe('skipped')
  })
})
