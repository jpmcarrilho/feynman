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
import { looksLikeQuestions, hasQuestionPattern, hasQuizPattern, hasAnswerCue, acceptCandidate, candidateFromImported, stripAnswerLabel, keyPointInAnswer, OPEN_ITEM_PATTERN, cleanEdxQuestionText, isEdxMarkdown, edxCandidates, isImportEnrichmentEnabled } from './importQuestions'
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
    expect(rows.every((r) => r.promptVersion === 'ingest-v3')).toBe(true)
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

// ---------------------------------------------------------------------------------------------------------------------
// Open questions with a written model answer (O4)
// ---------------------------------------------------------------------------------------------------------------------

const EN_OPEN = [
  '## Practice questions', '',
  '1. Explain why two candidates converge toward the median voter.',
  '2. Describe what happens to the median voter result when a second policy dimension is added.',
  '3. Why do platforms stay apart in practice?',
  '4. Compare majority rule with proportional representation.', '',
  '## Model answers', '',
  '1. Each candidate wins more votes by moving toward the position most voters prefer than the rival does.',
  '2. A stable majority winner generally fails to exist, because every platform can be beaten by another.',
  '3. Candidates answer to their parties and to donors, not only to the median voter.',
  '4. Majority rule rewards the winner of each district while proportional representation mirrors vote shares.',
].join('\n')

const PT_OPEN = [
  '## Questões', '',
  '1. Explique por que a oferta de moeda afeta os preços.',
  '2. Descreva o papel do banco central na política monetária.',
  '3. Por que a inflação reduz o poder de compra?', '',
  '## Gabarito', '',
  '1. Mais moeda em circulação sem mais produção eleva os preços de forma geral.',
  '2. O banco central controla a taxa de juros e a quantidade de moeda na economia.',
  '3. Os mesmos reais compram menos bens quando os preços sobem.',
].join('\n')

const oq = (over: Record<string, unknown> = {}) => ({
  questionText: 'Explain why two candidates converge toward the median voter.', exerciseType: 'open' as const, choices: [] as string[], correctChoiceIndexes: [] as number[],
  correctAnswer: 'Each candidate wins more votes by moving toward the position most voters prefer than the rival does.',
  explanation: '', answerQuote: 'Each candidate wins more votes by moving toward the position most voters prefer',
  keyPoints: ['Candidates move toward the position most voters prefer', 'Moving toward it wins more votes than the rival'], ...over,
})

describe('open items in the question heuristics', () => {
  it('counts numbered imperative and question-word items in five languages, as items, toward the pattern', () => {
    expect(hasQuestionPattern('1. Explain the model.\n2. Describe the data.\n3. Why does it matter.')).toBe(true)
    expect(hasQuestionPattern('1. Explique o modelo.\n2. Descreva os dados.\n3. Por que importa.')).toBe(true)
    expect(hasQuestionPattern('1) Explica el modelo.\n2) Describe los datos.\n3) Por qué importa.')).toBe(true)
    expect(hasQuestionPattern('1. Expliquez le modèle.\n2. Décrivez les données.\n3. Pourquoi cela compte.')).toBe(true)
    expect(hasQuestionPattern('1. Erklären Sie das Modell.\n2. Beschreiben Sie die Daten.\n3. Warum ist das wichtig.')).toBe(true)
    expect(hasQuestionPattern('Q1: Define the term.\nQ2. Compare the cases.\nQ3) Justify the choice.')).toBe(true)
    expect(hasQuestionPattern('a) Show that it holds.\nb) Prove it.\nc) Derive the bound.')).toBe(true)
  })
  it('counts an item once when another mark already counts its line', () => {
    expect(hasQuestionPattern('1. Why is this?\n2. How is that?')).toBe(false) // two lines: "?" and the open item are one mark each
    expect(hasQuestionPattern('1. Why is this?\n2. How is that?\n3. What follows.')).toBe(true)
  })
  it('does not match running prose, lists of nouns or an item that starts with another word', () => {
    expect(OPEN_ITEM_PATTERN.test('The 1. Explain would not start a line')).toBe(false)
    OPEN_ITEM_PATTERN.lastIndex = 0
    expect(hasQuestionPattern('1. The median voter\n2. The platform\n3. The turnout')).toBe(false)
    expect(hasQuestionPattern('We explain why. We describe how. Then we compare.')).toBe(false)
  })
  it('a lecture paragraph with one numbered "Describe" item and no cue does not look like questions', () => {
    const lecture = 'Voters differ in their preferences.\n1. Describe the setup: two candidates and one dimension.\nThe median voter decides the outcome.'
    expect(hasQuestionPattern(lecture)).toBe(false)
    expect(looksLikeQuestions(lecture)).toBe(false)
  })
  it('three imperative items without an answer cue still do not look like questions', () => {
    const items = '1. Explain the model.\n2. Describe the data.\n3. Why does it matter.'
    expect(hasQuestionPattern(items)).toBe(true)
    expect(looksLikeQuestions(items)).toBe(false)
    expect(hasQuizPattern(items)).toBe(true)
  })
  it('a quiz of imperative items with a model-answer section looks like questions', () => {
    expect(looksLikeQuestions(EN_OPEN)).toBe(true)
    expect(looksLikeQuestions(PT_OPEN)).toBe(true)
  })
})

describe('written-answer cues', () => {
  it.each([
    'Model answer: Prices rise.', '## Model answers', 'Sample answer 2: x', 'Suggested answer:\nx', 'Expected answer.', 'Marking scheme', '### Marking scheme:',
    'Resposta modelo: x', '## Resposta esperada', 'Respuesta modelo: x', '## Respuestas esperadas', 'Réponse type : x', 'Corrigé type', 'Musterlösung:', '## Musterlösung', '## Respostas', '## Réponses',
  ])('is a cue: %s', (cue) => {
    expect(hasAnswerCue(cue)).toBe(true)
  })
  it('does not match prose that mentions them', () => {
    expect(hasAnswerCue('A good model answer is concise and complete.')).toBe(false)
    expect(hasAnswerCue('We discuss the marking scheme of the course in week two.')).toBe(false)
  })
})

describe('stripAnswerLabel and keyPointInAnswer', () => {
  it('removes labels and numbers at the start of a model answer only', () => {
    expect(stripAnswerLabel('Answer: Prices rise.')).toBe('Prices rise.')
    expect(stripAnswerLabel('Model answer 2 - Prices rise.')).toBe('Prices rise.')
    expect(stripAnswerLabel('**Resposta:** Os preços sobem.')).toBe('Os preços sobem.')
    expect(stripAnswerLabel('3. Prices rise.')).toBe('Prices rise.')
    expect(stripAnswerLabel('Answer 1: 2. Prices rise.')).toBe('Prices rise.')
    expect(stripAnswerLabel('Prices rise because answer: none.')).toBe('Prices rise because answer: none.')
  })
  it('accepts a key point made of the answer words (inflections, accents) and rejects a new fact', () => {
    const answer = 'Mais moeda em circulação sem mais produção eleva os preços de forma geral.'
    expect(keyPointInAnswer('Mais moeda sem produção eleva preços', answer)).toBe(true)
    expect(keyPointInAnswer('Moeda e circulacao elevam os precos', answer)).toBe(true)
    expect(keyPointInAnswer('O banco central define a taxa de juros', answer)).toBe(false)
    expect(keyPointInAnswer('2.5%', 'Growth was 2.5% per year.')).toBe(true)
    expect(keyPointInAnswer('7%', 'Growth was 2.5% per year.')).toBe(false)
  })
})

describe('acceptCandidate: open', () => {
  const src = EN_OPEN
  const base = { questionText: oq().questionText, exerciseType: 'open', choices: [] as string[], correctAnswer: oq().correctAnswer, explanation: '', keyPoints: oq().keyPoints }

  it('accepts a verbatim model answer with key points built from it, as an imported question with a fallback explanation', () => {
    const r = acceptCandidate(base, src)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.question).toMatchObject({ exerciseType: 'open', choices: [], keyPoints: base.keyPoints, explanation: '', explanationFallback: false })
      expect(validateExerciseStructure(r.question, { origin: 'imported' })).toEqual([])
    }
  })
  it('never stores an explanation that repeats the model answer, but keeps a different one', () => {
    const same = acceptCandidate({ ...base, explanation: `Answer: ${base.correctAnswer.toUpperCase()}` }, src)
    expect(same.ok && same.question.explanation).toBe('')
    const other = acceptCandidate({ ...base, explanation: 'Candidates are vote maximisers.' }, src)
    expect(other.ok && other.question.explanation).toBe('Candidates are vote maximisers.')
  })
  it('still requires an explanation (or the fallback) for the choice types and for generated open questions', () => {
    expect(validateExerciseStructure({ questionText: 'Q?', exerciseType: 'single_choice', choices: ['a', 'b', 'c'], correctAnswer: 'a', explanation: '' }, { origin: 'imported' }).map((i) => i.code)).toContain('empty_explanation')
  })
  it('strips a label, tolerates spacing, case and Markdown emphasis, and stores the answer without the label', () => {
    const r = acceptCandidate({ ...base, correctAnswer: 'Model answer: Each candidate WINS more votes by moving toward the **position** most voters prefer than the rival does.' }, src)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.question.correctAnswer.startsWith('Each candidate')).toBe(true)
  })
  it('rejects a paraphrased model answer', () => {
    expect(acceptCandidate({ ...base, correctAnswer: 'Candidates drift to the centre because that is where the voters are found.' }, src)).toEqual({ ok: false, reason: 'model_answer_not_in_source' })
  })
  it('rejects an answer that is not in a source given as null (edX path has no open questions)', () => {
    expect(acceptCandidate(base, null)).toEqual({ ok: false, reason: 'model_answer_not_in_source' })
  })
  it('rejects an invented key point', () => {
    expect(acceptCandidate({ ...base, keyPoints: [...base.keyPoints, 'Turnout falls when candidates look alike'] }, src)).toEqual({ ok: false, reason: 'key_point_not_in_answer' })
  })
  it('rejects an open candidate that has choices', () => {
    expect(acceptCandidate({ ...base, choices: ['A', 'B', 'C'] }, src)).toEqual({ ok: false, reason: 'open_has_choices' })
  })
  it('rejects an empty answer and a model answer over the limit without cutting it', () => {
    expect(acceptCandidate({ ...base, correctAnswer: '' }, src)).toEqual({ ok: false, reason: 'no_answer_in_source' })
    expect(acceptCandidate({ ...base, correctAnswer: 'Answer:' }, src)).toEqual({ ok: false, reason: 'no_answer_in_source' })
    const long = 'Votes move toward the middle. '.repeat(60)
    expect(long.length).toBeGreaterThan(1500)
    expect(acceptCandidate({ ...base, correctAnswer: long }, long)).toEqual({ ok: false, reason: 'model_answer_too_long' })
  })
  it('rejects a bad key point count through structural validation', () => {
    const r = acceptCandidate({ ...base, keyPoints: [] }, src)
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('key_point_count') })
    expect(acceptCandidate({ ...base, keyPoints: ['Votes', 'More votes', 'Prefer position', 'Moving toward', 'The rival does'] }, src)).toMatchObject({ ok: false, reason: expect.stringContaining('key_point_count') })
  })
  it('handles a one-sentence model answer from 15 characters with a single key point', () => {
    const file = 'Define inflation.\n\nAnswer: A general rise in prices.'
    const ok = acceptCandidate({ questionText: 'Define inflation.', exerciseType: 'open', choices: [], correctAnswer: 'A general rise in prices.', explanation: '', keyPoints: ['General rise in prices'] }, file)
    expect(ok.ok).toBe(true)
    // under 15 characters: left out
    const tiny = acceptCandidate({ questionText: 'Define inflation.', exerciseType: 'open', choices: [], correctAnswer: 'Rising prices', explanation: '', keyPoints: ['Rising prices'] }, 'Answer: Rising prices')
    expect(tiny).toMatchObject({ ok: false, reason: expect.stringContaining('model_answer_length') })
    // two sentences with one key point: needs two
    const two = acceptCandidate({ questionText: 'Define inflation.', exerciseType: 'open', choices: [], correctAnswer: 'A general rise in prices. It lowers purchasing power.', explanation: '', keyPoints: ['General rise in prices'] }, 'A general rise in prices. It lowers purchasing power.')
    expect(two).toMatchObject({ ok: false, reason: expect.stringContaining('key_point_count') })
  })
  it('does not apply the generated-question single-task rules to the file\'s own wording', () => {
    const q = 'Explain X, and explain Y. In your answer, discuss Z.'
    const a = 'X and Y both follow from Z in the usual way here.'
    const r = acceptCandidate({ questionText: q, exerciseType: 'open', choices: [], correctAnswer: a, explanation: '', keyPoints: ['X and Y follow from Z', 'The usual way'] }, `${q}\nAnswer: ${a}`)
    expect(r.ok).toBe(true)
  })
  it('candidateFromImported keeps key points, rejects open with correct indexes, and tolerates a missing list', () => {
    const made = candidateFromImported(oq())
    expect(made).toMatchObject({ ok: true, candidate: { exerciseType: 'open', keyPoints: oq().keyPoints } })
    expect(candidateFromImported(oq({ correctChoiceIndexes: [0] }))).toEqual({ ok: false, reason: 'invalid_correct_choice_indexes' })
    const { keyPoints: _drop, ...noPoints } = oq()
    void _drop
    expect(candidateFromImported(noPoints)).toMatchObject({ ok: true, candidate: { keyPoints: [] } })
  })
  it('the import prompt names the open type, the verbatim rule, the limit and the single-sentence case', () => {
    const prompt = importQuestionsPrompt({ topicTitle: 'T', text: 'x', answerKeyText: 'k' })
    expect(prompt).toContain('"open"')
    expect(prompt).toContain('COPIED VERBATIM')
    expect(prompt).toContain('1500')
    expect(prompt).toContain('exactly 1 point')
    expect(ImportedQuestionsSchema.safeParse({ questions: [oq()] }).success).toBe(true)
  })
})

describe('importQuestionsForSource: open questions', () => {
  it('imports the six numbered open questions of the T24 fixture with their key points (questions and key in one topic)', async () => {
    const qs = [
      ['Why do two candidates in a majority-rule election converge toward the median voter?', 'Each wins by moving toward the position most voters prefer to the rival.', ['Each candidate moves toward the position most voters prefer', 'Moving beats the rival']],
      ['What happens to the median voter result when a second policy dimension is added?', 'A stable majority winner generally fails to exist.', ['A stable majority winner generally fails to exist']],
      ['Why do platforms stay apart in practice?', 'Parties and donors pull candidates away from the median voter.', ['Parties and donors pull candidates away', 'Away from the median voter']],
      ['Why must preferences be single-peaked?', 'Without a single peak the majority ordering can cycle.', ['Without single peaks the majority ordering can cycle', 'The majority ordering can cycle']],
      ['Explain what a Condorcet winner is.', 'An option that beats every other option in a pairwise majority vote.', ['Beats every other option', 'In pairwise majority votes']],
      ['How does turnout change the median voter?', 'Lower turnout shifts the median toward the voters who still vote.', ['Lower turnout shifts the median', 'Toward the voters who still vote']],
    ]
    const text = ['## Practice questions', '', ...qs.map((q, i) => `${i + 1}. ${q[0]}`), '', '## Answer key', '', ...qs.map((q, i) => `${i + 1}. ${q[1]}`)].join('\n')
    const { id } = await makeSource({ ext: '.txt', topics: [{ title: 'Practice', content: text }] })
    const result = await importQuestionsForSource(id, {
      generate: generateWith(qs.map((q) => oq({ questionText: q[0], correctAnswer: q[1], answerQuote: q[1], keyPoints: q[2] }))),
    })
    expect(result.stats).toMatchObject({ path: 'model', candidates: 6, imported: 6 })
    const rows = await prisma.exercise.findMany({ where: { id: { startsWith: 'imp-' }, topic: { sourceId: id } } })
    expect(rows).toHaveLength(6)
    for (const r of rows) {
      expect(r).toMatchObject({ exerciseType: 'open', choices: '[]', origin: 'imported', status: 'active', isGraded: true, promptVersion: 'ingest-v3' })
      expect(JSON.parse(r.keyPoints!).length).toBeGreaterThanOrEqual(1)
      expect(validateExerciseStructure(r, { origin: 'imported' })).toEqual([])
    }
    expect(rows.find((r) => r.questionText.startsWith('Why must'))!.correctAnswer).toBe('Without a single peak the majority ordering can cycle.')
  })

  it('recognises and imports a Portuguese quiz of "Explique" items with a "## Gabarito" of written answers', async () => {
    const prompts: string[] = []
    const generate = (async (args: { prompt: string }) => {
      prompts.push(args.prompt)
      return { object: { questions: [
        oq({ questionText: 'Explique por que a oferta de moeda afeta os preços.', correctAnswer: 'Mais moeda em circulação sem mais produção eleva os preços de forma geral.', keyPoints: ['Mais moeda sem mais produção', 'Eleva os preços de forma geral'] }),
        oq({ questionText: 'Descreva o papel do banco central na política monetária.', correctAnswer: 'O banco central controla a taxa de juros e a quantidade de moeda na economia.', keyPoints: ['Controla a taxa de juros', 'Controla a quantidade de moeda'] }),
        oq({ questionText: 'Por que a inflação reduz o poder de compra?', correctAnswer: 'Os mesmos reais compram menos bens quando os preços sobem.', keyPoints: ['Os mesmos reais compram menos bens'] }),
      ] }, usage: { inputTokens: 1, outputTokens: 1 } }
    }) as never
    const { id } = await makeSource({ ext: '.txt', topics: [{ title: 'Moeda', content: PT_OPEN }] })
    const result = await importQuestionsForSource(id, { generate })
    expect(prompts).toHaveLength(1)
    expect(result.stats).toMatchObject({ path: 'model', topicsPassingHeuristic: 1, imported: 3 })
    const rows = await prisma.exercise.findMany({ where: { id: { startsWith: 'imp-' }, topic: { sourceId: id } } })
    expect(rows.map((r) => r.exerciseType)).toEqual(['open', 'open', 'open'])
  })

  it('pairs open questions with a written-answer section that segmentation put in another topic', async () => {
    const [qPart, aPart] = EN_OPEN.split('## Model answers')
    const prompts: string[] = []
    const generate = (async (args: { prompt: string }) => {
      prompts.push(args.prompt)
      return { object: { questions: [oq()] }, usage: { inputTokens: 1, outputTokens: 1 } }
    }) as never
    const { id } = await makeSource({ ext: '.txt', topics: [{ title: 'Questions', content: qPart }, { title: 'Answers', content: `## Model answers${aPart}` }] })
    const result = await importQuestionsForSource(id, { generate })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('ANSWER KEY TEXT')
    expect(result.stats).toMatchObject({ answerKeyTopics: 1, imported: 1 })
  })

  it('imports both kinds from a mixed file, each by its own rule', async () => {
    const mixed = [
      '## Questions', '',
      '1. Explain why two candidates converge toward the median voter.',
      '2. Describe what happens when a second policy dimension is added.',
      '3. Which of these is a prime?', '(a) 4', '(b) 7', '(c) 9',
      '4. Compute 2+3.', '',
      '## Model answers', '',
      '1. Each candidate wins more votes by moving toward the position most voters prefer than the rival does.',
      '2. A stable majority winner generally fails to exist, because every platform can be beaten by another.', '',
      '## Answer key', '', '3. B', '4. The sum is 5.',
    ].join('\n')
    const { id } = await makeSource({ ext: '.txt', topics: [{ title: 'Mixed', content: mixed }] })
    const result = await importQuestionsForSource(id, {
      generate: generateWith([
        oq(),
        oq({ questionText: 'Describe what happens when a second policy dimension is added.', correctAnswer: 'A stable majority winner generally fails to exist, because every platform can be beaten by another.', keyPoints: ['A stable majority winner generally fails to exist', 'Every platform can be beaten by another'] }),
        { questionText: 'Which of these is a prime?', exerciseType: 'single_choice', choices: ['4', '7', '9'], correctChoiceIndexes: [1], correctAnswer: '', explanation: '', answerQuote: '3. B', keyPoints: [] },
        { questionText: 'Compute 2+3.', exerciseType: 'numeric', choices: [], correctChoiceIndexes: [], correctAnswer: '5', explanation: '', answerQuote: '4. The sum is 5.', keyPoints: [] },
      ]),
    })
    expect(result.stats).toMatchObject({ candidates: 4, imported: 4 })
    const rows = await prisma.exercise.findMany({ where: { id: { startsWith: 'imp-' }, topic: { sourceId: id } } })
    expect(rows.map((r) => r.exerciseType).sort()).toEqual(['numeric', 'open', 'open', 'single_choice'])
    expect(rows.filter((r) => r.exerciseType !== 'open').every((r) => r.keyPoints === null)).toBe(true)
  })

  it('leaves out a paraphrased answer, an invented key point, an over-limit answer, an open candidate with choices and a question without an answer', async () => {
    const long = 'Votes move toward the middle of the distribution. '.repeat(40)
    const text = `${EN_OPEN}\n\n5. Explain the limits of the model.\n6. Compare the two systems.\n\n## Sample answer 6\n\n${long}`
    const { id } = await makeSource({ ext: '.txt', topics: [{ title: 'Quiz', content: text }] })
    const result = await importQuestionsForSource(id, {
      generate: generateWith([
        oq({ questionText: 'Paraphrased?', correctAnswer: 'Candidates drift to the centre because that is where voters are.' }),
        oq({ questionText: 'Invented point?', keyPoints: ['Each candidate moves toward the position', 'Turnout falls when candidates look alike'] }),
        oq({ questionText: 'Too long?', correctAnswer: long.trim(), keyPoints: ['Votes move toward the middle', 'Of the distribution'] }),
        oq({ questionText: 'With choices?', choices: ['A', 'B', 'C'] }),
        oq({ questionText: 'Explain the limits of the model.', correctAnswer: '' }),
        oq({ questionText: 'Good one?' }),
      ]),
    })
    expect(result.stats.imported).toBe(1)
    expect(result.stats.rejected).toMatchObject({ model_answer_not_in_source: 1, key_point_not_in_answer: 1, model_answer_too_long: 1, open_has_choices: 1, no_answer_in_source: 1 })
    expect(await prisma.exercise.count({ where: { id: { startsWith: 'imp-' }, topic: { sourceId: id } } })).toBe(1)
  })

  it('imports a one-sentence written answer with one key point', async () => {
    const file = '1. Define inflation.\n2. Explain money supply.\n3. Describe the central bank.\n\n## Answers\n\n1. A general rise in prices.\n2. The total money in circulation.\n3. The institution that sets interest rates.'
    const { id } = await makeSource({ ext: '.txt', topics: [{ title: 'Quiz', content: file }] })
    const result = await importQuestionsForSource(id, {
      generate: generateWith([oq({ questionText: 'Define inflation.', correctAnswer: 'A general rise in prices.', keyPoints: ['General rise in prices'] })]),
    })
    expect(result.stats.imported).toBe(1)
    const row = await prisma.exercise.findFirstOrThrow({ where: { id: { startsWith: 'imp-' }, topic: { sourceId: id } } })
    expect(JSON.parse(row.keyPoints!)).toEqual(['General rise in prices'])
  })

  it('does not send open questions to enrichment even when it is switched on', async () => {
    const { id } = await makeSource({ ext: '.txt', topics: [{ title: 'Quiz', content: EN_OPEN }] })
    const result = await importQuestionsForSource(id, { generate: generateWith([oq()]), enrich: true })
    expect(result.imported).toBe(1)
    expect(enrichment.enrichExercisesByIds).not.toHaveBeenCalled()
  })
})

describe('files with only one or two questions', () => {
  const twoOpen = ['## Questions', '', '1. Explain why prices rise.', '2. Describe the role of the central bank.', '', '## Model answers', '',
    '1. More money chasing the same goods raises prices in general.', '2. The central bank sets interest rates and controls the money supply.'].join('\n')
  it('an answer heading makes one question-like mark enough; weak cues and no cue keep three', () => {
    expect(looksLikeQuestions(twoOpen)).toBe(true)
    expect(looksLikeQuestions('1. Explain why prices rise.\n\n## Model answers\n\nMore money.')).toBe(true)
    expect(looksLikeQuestions('1. Which is prime?\n\n## Answer key\n\n1. B')).toBe(true)
    expect(looksLikeQuestions('## Gabarito\n\n1. Explique por que.')).toBe(true)
    // weak cues only
    expect(looksLikeQuestions('Why is this so?\nHence the correct answer is Paris.')).toBe(false)
    expect(looksLikeQuestions('Why is this so?\n- [x] Paris')).toBe(false)
    // no cue
    expect(looksLikeQuestions('1. Explain why prices rise.\n2. Describe the bank.')).toBe(false)
    // a lecture with a rhetorical question and no answer heading
    expect(looksLikeQuestions('Why do prices rise? Because money is plentiful. The correct answer is not obvious.')).toBe(false)
  })
  it('a topic whose heading is in the paired key text also qualifies', () => {
    expect(looksLikeQuestions('1. Explain why prices rise.', '## Model answers\n\n1. Money.')).toBe(true)
    expect(looksLikeQuestions('1. Explain why prices rise.', 'Hence the correct answer is 4.')).toBe(false)
  })
  it('imports two open items with a model-answers section', async () => {
    const { id } = await makeSource({ ext: '.txt', topics: [{ title: 'Quiz', content: twoOpen }] })
    const result = await importQuestionsForSource(id, {
      generate: generateWith([
        oq({ questionText: 'Explain why prices rise.', correctAnswer: 'More money chasing the same goods raises prices in general.', keyPoints: ['More money chasing the same goods', 'Raises prices in general'] }),
        oq({ questionText: 'Describe the role of the central bank.', correctAnswer: 'The central bank sets interest rates and controls the money supply.', keyPoints: ['Sets interest rates', 'Controls the money supply'] }),
      ]),
    })
    expect(calls).toBe(1)
    expect(result.stats.imported).toBe(2)
    const rows = await prisma.exercise.findMany({ where: { id: { startsWith: 'imp-' }, topic: { sourceId: id } } })
    expect(rows.every((r) => r.explanation === '')).toBe(true)
  })
  it('imports one multiple-choice question with an answer key', async () => {
    const { id } = await makeSource({ ext: '.txt', topics: [{ title: 'Quiz', content: '1. Which is prime?\n\n## Answer key\n\n1. B' }] })
    const result = await importQuestionsForSource(id, {
      generate: generateWith([{ questionText: 'Which is prime?', exerciseType: 'single_choice', choices: ['4', '7', '9'], correctChoiceIndexes: [1], correctAnswer: '', explanation: '', answerQuote: '1. B', keyPoints: [] }]),
    })
    expect(calls).toBe(1)
    expect(result.stats.imported).toBe(1)
  })
  it('pairs one question in a quiz topic with a key topic that has an answer heading', async () => {
    const { id } = await makeSource({ ext: '.txt', topics: [{ title: 'Quiz', content: '1. Explain why prices rise.' }, { title: 'Key', content: '## Model answers\n\n1. More money chasing the same goods raises prices in general.' }] })
    const result = await importQuestionsForSource(id, {
      generate: generateWith([oq({ questionText: 'Explain why prices rise.', correctAnswer: 'More money chasing the same goods raises prices in general.', keyPoints: ['More money chasing the same goods', 'Raises prices'] })]),
    })
    expect(calls).toBe(1)
    expect(result.stats).toMatchObject({ answerKeyTopics: 1, imported: 1 })
  })
  it('does not send a lecture topic with one question to the model when no key has a heading', async () => {
    const { id } = await makeSource({ ext: '.txt', topics: [{ title: 'Lecture', content: '1. Why do prices rise?\nBecause of money.' }, { title: 'Notes', content: 'The correct answer is 4.' }] })
    await importQuestionsForSource(id, { generate: generateWith([]) })
    expect(calls).toBe(0)
  })
})
