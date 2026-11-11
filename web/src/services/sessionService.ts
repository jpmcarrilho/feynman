import { prisma } from '@/lib/db'
import { gradeAnswer, logScore } from '@/lib/grading'

// Visible time per question is measured from T18 on; until then every log keeps the 30 s it has always had.
const DEFAULT_DURATION_SEC = 30
const MAX_ANSWER_LENGTH = 20_000

export interface ExamSubmission {
  /** Sum of per-question scores (partial credit), 0..total. */
  scoreSum: number
  /** Number of questions in the exam, answered or not. */
  total: number
  /** Questions answered fully correctly. */
  correctCount: number
}

const GRADING_SELECT = {
  id: true,
  exerciseType: true,
  choices: true,
  correctAnswer: true,
  questionText: true,
} as const

function parseIds(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

async function submitOnce(sessionId: string, answers: Record<string, string>): Promise<ExamSubmission | null> {
  return prisma.$transaction(async (tx) => {
    const session = await tx.studySession.findUnique({
      where: { id: sessionId },
      select: { id: true, mode: true, status: true, exerciseIds: true },
    })
    if (!session || session.mode !== 'exam' || session.status === 'cancelled') return null

    const ids = parseIds(session.exerciseIds)
    const rows = ids.length > 0 ? await tx.exercise.findMany({ where: { id: { in: ids } }, select: GRADING_SELECT }) : []
    const byId = new Map(rows.map((r) => [r.id, r]))
    const exercises = ids.map((id) => byId.get(id)).filter((e): e is (typeof rows)[number] => !!e)

    const existing = await tx.exerciseLog.findMany({
      where: { sessionId },
      select: { exerciseId: true, score: true, isCorrect: true },
    })
    const have = new Map(existing.map((l) => [l.exerciseId, l]))

    const created: { exerciseId: string; score: number; isCorrect: boolean }[] = []
    const data = []
    for (const ex of exercises) {
      if (have.has(ex.id)) continue
      const raw = Object.prototype.hasOwnProperty.call(answers, ex.id) ? answers[ex.id] : ''
      // Unanswered questions are logged too, with an empty answer (the same value the exam flow has always stored)
      const userAnswer = typeof raw === 'string' ? raw.slice(0, MAX_ANSWER_LENGTH) : ''
      const g = gradeAnswer(ex, userAnswer)
      created.push({ exerciseId: ex.id, score: g.score, isCorrect: g.isCorrect })
      data.push({
        sessionId,
        exerciseId: ex.id,
        isCorrect: g.isCorrect,
        score: g.score,
        userAnswer,
        duration: DEFAULT_DURATION_SEC,
      })
    }
    if (data.length > 0) await tx.exerciseLog.createMany({ data })

    if (session.status !== 'completed') {
      await tx.studySession.update({ where: { id: sessionId }, data: { status: 'completed', endTime: new Date() } })
    }

    const examIds = new Set(exercises.map((e) => e.id))
    const all = [...existing.filter((l) => examIds.has(l.exerciseId)), ...created]
    let scoreSum = 0
    let correctCount = 0
    for (const l of all) {
      scoreSum += logScore(l)
      if (l.isCorrect) correctCount++
    }
    return { scoreSum, total: exercises.length, correctCount }
  })
}

/**
 * Grades every exercise of the exam on the server, creates the logs and completes the session in one transaction.
 * Safe to repeat: existing logs are kept, a completed session stays as it is, and a unique-constraint race between
 * two simultaneous submits is retried once (the second pass finds the rows and only reads).
 * Returns null for an unknown session, a non-exam session or a cancelled exam.
 */
export async function submitExamForSession(sessionId: string, answers: Record<string, string>): Promise<ExamSubmission | null> {
  const safeAnswers = answers && typeof answers === 'object' ? answers : {}
  try {
    return await submitOnce(sessionId, safeAnswers)
  } catch (error) {
    if ((error as { code?: string })?.code === 'P2002') return submitOnce(sessionId, safeAnswers)
    throw error
  }
}
