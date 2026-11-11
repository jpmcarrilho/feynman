/**
 * The single grader. Pure and client-safe: the flashcard uses it for instant feedback, the server uses the same
 * function (with the stored exercise) to decide what is written to ExerciseLog.
 *
 * Score definition used everywhere a session total is shown:
 *   - a question's score is 0..1 (partial credit for multi-select and multi-blank questions);
 *   - a session's score is the SUM of its questions' scores, shown as "score / questions";
 *   - "fully correct" counts only questions with isCorrect = true.
 */

export interface GradableExercise {
  exerciseType: string
  /** JSON array string (as stored) or an already parsed array. */
  choices: string | string[] | null | undefined
  correctAnswer: string
  /** Optional: lets "select all that apply" questions that were stored as single_choice be graded as multi-select. */
  questionText?: string | null
}

export interface GradeResult {
  /** 0..1 */
  score: number
  /** True only when the answer is fully correct. */
  isCorrect: boolean
}

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

const CONTROL_ESCAPES: Record<string, string> = { '\b': '\\b', '\f': '\\f', '\r': '\\r', '\t': '\\t' }

/**
 * LaTeX in JSON arrays loses its backslash when the stored text was not escaped ("$\rho$" parses as CR + "ho"; same for
 * \b \f \t and \n before a letter). Put the backslash back so both sides of a comparison read the same.
 */
function restoreLatexBackslashes(s: string): string {
  return s.replace(/[\b\f\r\t]/g, (c) => CONTROL_ESCAPES[c]).replace(/\n(?=[a-z])/gi, '\\n')
}

export function normalize(s: unknown): string {
  return restoreLatexBackslashes(String(s ?? ''))
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/\\+$/, '')
    .trim()
}

function parseChoices(choices: GradableExercise['choices']): string[] {
  if (Array.isArray(choices)) return choices.map(String)
  if (typeof choices === 'string' && choices.trim()) {
    const parsed = tryParseJson(choices)
    if (Array.isArray(parsed)) return parsed.map(String)
  }
  return []
}

/**
 * The exercise type the UI actually renders: choices carrying "[Dropdown n]" prefixes make it a dropdown, and a
 * question that says "select all that apply" is multi-select whatever exerciseType says. Same order as the flashcard
 * always used.
 */
export function resolveExerciseType(ex: Pick<GradableExercise, 'exerciseType' | 'choices' | 'questionText'>): string {
  const choices = parseChoices(ex.choices)
  if (choices.some((c) => /^\[Dropdown \d+\]/.test(c))) return 'dropdown'
  const text = (ex.questionText ?? '').toLowerCase()
  const asksForSeveral =
    text.includes('select all that apply') ||
    text.includes('choose all that apply') ||
    text.includes('select all correct')
  if (asksForSeveral || ex.exerciseType === 'multiple_choice') return 'multiple_choice'
  return ex.exerciseType
}

function isBlankAnswer(userAnswer: string): boolean {
  const t = userAnswer.trim()
  if (!t) return true
  const parsed = tryParseJson(t)
  if (Array.isArray(parsed)) return parsed.every((v) => !String(v ?? '').trim())
  if (parsed && typeof parsed === 'object') {
    return Object.values(parsed as Record<string, unknown>).every((v) => !String(v ?? '').trim())
  }
  return false
}

const ZERO: GradeResult = { score: 0, isCorrect: false }
const result = (score: number, isCorrect: boolean): GradeResult => ({ score, isCorrect })

// --- single choice ---------------------------------------------------------------------------------------------

function gradeSingle(ex: GradableExercise, userAnswer: string): GradeResult {
  const ok = normalize(userAnswer) !== '' && normalize(userAnswer) === normalize(ex.correctAnswer)
  return ok ? result(1, true) : ZERO
}

// --- multiple choice -------------------------------------------------------------------------------------------

function toStringList(parsed: unknown): string[] | null {
  return Array.isArray(parsed) ? parsed.map((v) => String(v ?? '')) : null
}

function gradeMulti(ex: GradableExercise, userAnswer: string): GradeResult {
  const correctList = toStringList(tryParseJson(ex.correctAnswer)) ?? [ex.correctAnswer]
  const correct = new Set(correctList.map(normalize).filter(Boolean))
  if (correct.size === 0) return ZERO

  const userList = toStringList(tryParseJson(userAnswer)) ?? [userAnswer]
  const user = new Set(userList.map(normalize).filter(Boolean))
  if (user.size === 0) return ZERO

  // Survey / discussion items: every choice is listed as correct, so any answer is full credit.
  const choices = parseChoices(ex.choices).map(normalize).filter(Boolean)
  if (choices.length > 0 && choices.every((c) => correct.has(c))) return result(1, true)

  let right = 0
  let wrong = 0
  for (const u of user) {
    if (correct.has(u)) right++
    else wrong++
  }
  const score = Math.max(0, (right - wrong) / correct.size)
  const setsEqual = right === correct.size && wrong === 0
  return result(score, setsEqual)
}

// --- numeric ---------------------------------------------------------------------------------------------------

interface ParsedNumber {
  value: number
  pct: boolean
  /** Digits after the decimal point as written. */
  decimals: number
}

function parseNumeric(raw: string): ParsedNumber | null {
  const pct = raw.includes('%')
  const cleaned = raw.replace(/−/g, '-').replace(/[,\s$%]/g, '')
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(cleaned)) return null
  const value = Number(cleaned)
  if (!Number.isFinite(value)) return null
  const mantissa = cleaned.split(/e/i)[0]
  const dot = mantissa.indexOf('.')
  return { value, pct, decimals: dot === -1 ? 0 : mantissa.length - dot - 1 }
}

/**
 * Correct when the answer equals the key rounded to the key's precision, with at least two decimal places:
 * tolerance = 0.5 * 10^-max(d, 2), where d is the number of decimals written in the key. No relative term.
 * The boundary is inclusive (0.805 vs key 0.80 is correct); a 1e-12 epsilon absorbs floating-point error.
 */
function withinTolerance(user: number, correct: number, correctDecimals: number): boolean {
  const tolerance = Math.max(0.5 * Math.pow(10, -Math.max(correctDecimals, 2)), 1e-9)
  return Math.abs(user - correct) <= tolerance + 1e-12
}

function gradeNumeric(ex: GradableExercise, userAnswer: string): GradeResult {
  const u = parseNumeric(userAnswer)
  const c = parseNumeric(ex.correctAnswer)
  if (!u || !c) return ZERO

  let ok = withinTolerance(u.value, c.value, c.decimals)
  if (!ok && u.pct !== c.pct) {
    // A "%" on one side only: also accept the value read as a percentage (25% vs 0.25).
    ok = u.pct
      ? withinTolerance(u.value / 100, c.value, c.decimals)
      : withinTolerance(u.value, c.value / 100, c.decimals + 2)
  }
  return ok ? result(1, true) : ZERO
}

// --- dropdown / fill-in-the-blank ------------------------------------------------------------------------------

const BLANK_PREFIX = /^\[\s*(?:dropdown|blank)\s*(\d+)\s*\]\s*/i

interface BlankEntry {
  index: number | null
  value: string
}

function toBlankEntry(raw: string, keyIndex: number | null = null): BlankEntry {
  const m = raw.trim().match(BLANK_PREFIX)
  const body = m ? raw.trim().replace(BLANK_PREFIX, '') : raw
  return { index: m ? Number(m[1]) : keyIndex, value: normalize(body) }
}

function keyToIndex(key: string): number | null {
  const m = key.trim().match(/^\[\s*(?:dropdown|blank)\s*(\d+)\s*\]$/i)
  return m ? Number(m[1]) : null
}

function expectedBlanks(correctAnswer: string): BlankEntry[] {
  const parsed = tryParseJson(correctAnswer)
  let parts: string[]
  if (Array.isArray(parsed)) parts = parsed.map((v) => String(v ?? ''))
  else if (parsed !== undefined && parsed !== null && typeof parsed !== 'object') parts = [String(parsed)]
  else if (correctAnswer.includes('|')) parts = correctAnswer.split('|')
  else parts = [correctAnswer]
  return parts.map((p) => toBlankEntry(p)).filter((e) => e.value !== '')
}

function userBlanks(userAnswer: string, expectedCount: number): BlankEntry[] {
  const parsed = tryParseJson(userAnswer)
  let entries: BlankEntry[]
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    entries = Object.entries(parsed as Record<string, unknown>).map(([k, v]) => toBlankEntry(String(v ?? ''), keyToIndex(k)))
  } else if (Array.isArray(parsed)) {
    entries = parsed.map((v) => toBlankEntry(String(v ?? '')))
  } else {
    const pieces = expectedCount > 1 ? userAnswer.split('|') : [userAnswer]
    entries = pieces.map((p) => toBlankEntry(p))
  }
  return entries.filter((e) => e.value !== '')
}

function gradeDropdown(ex: GradableExercise, userAnswer: string): GradeResult {
  const expected = expectedBlanks(ex.correctAnswer)
  if (expected.length === 0) return ZERO
  const user = userBlanks(userAnswer, expected.length)
  if (user.length === 0) return ZERO

  const used = new Array<boolean>(user.length).fill(false)
  let matched = 0
  for (const e of expected) {
    // Same blank number first, then an answer that carries no blank number; never a different blank's answer.
    let at = user.findIndex((u, i) => !used[i] && u.value === e.value && e.index !== null && u.index === e.index)
    if (at === -1) at = user.findIndex((u, i) => !used[i] && u.value === e.value && (e.index === null || u.index === null))
    if (at !== -1) {
      used[at] = true
      matched++
    }
  }
  const all = matched === expected.length && user.length === expected.length
  // Extra answers beyond the expected count cannot earn a full score.
  return result(matched / Math.max(expected.length, user.length), all)
}

// --- entry point -----------------------------------------------------------------------------------------------

export function gradeAnswer(ex: GradableExercise, userAnswer: string | null | undefined): GradeResult {
  const answer = typeof userAnswer === 'string' ? userAnswer : ''
  if (isBlankAnswer(answer)) return ZERO

  let type = resolveExerciseType(ex)
  // Legacy rows: trust the shape of what was stored when the stored type disagrees with it.
  if (type === 'single_choice') {
    const parsed = tryParseJson(answer.trim())
    if (Array.isArray(parsed)) type = 'multiple_choice'
    else if (parsed && typeof parsed === 'object') type = 'dropdown'
  }

  switch (type) {
    case 'multiple_choice':
      return gradeMulti(ex, answer)
    case 'numeric':
      return gradeNumeric(ex, answer)
    case 'dropdown':
      return gradeDropdown(ex, answer)
    default:
      return gradeSingle(ex, answer)
  }
}

// --- session totals (one definition for every display) ---------------------------------------------------------

export interface ScoredLog {
  score?: number | null
  isCorrect: boolean
}

/** Stored score; legacy logs (score null) fall back to the stored isCorrect as 1 or 0. */
export function logScore(log: ScoredLog): number {
  return typeof log.score === 'number' && Number.isFinite(log.score) ? log.score : log.isCorrect ? 1 : 0
}

export function sessionScore(logs: ScoredLog[]): { scoreSum: number; correctCount: number } {
  let scoreSum = 0
  let correctCount = 0
  for (const l of logs) {
    scoreSum += logScore(l)
    if (l.isCorrect) correctCount++
  }
  return { scoreSum, correctCount }
}

/** 3 -> "3", 0.3333 -> "0.33", 2.5 -> "2.5". */
export function formatScore(n: number): string {
  return String(Math.round(n * 100) / 100)
}
