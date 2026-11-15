/**
 * Checks applied to an enriched question text before it replaces the stored one. Pure and client-safe.
 *
 *   - skip rules: which questions are never enriched at session start;
 *   - leak check: the enriched text must not newly contain the correct answer;
 *   - validity check: enrichment must not make the question structurally worse.
 *
 * All answer matching goes through the grading helpers (`gradeAnswer`, `normalize`, `resolveExerciseType`) so "the
 * correct option" means exactly what the grader and the flashcard mean by it, whatever legacy shape was stored.
 */
import { gradeAnswer, normalize, resolveExerciseType } from '@/lib/grading'
import { dropdownAnswerFor, dropdownOption, validateExerciseStructure } from '@/lib/exerciseValidation'

/** Answers shorter than this (after normalization) are not searched for as text: "Yes", "Up" appear in any sentence. */
export const MIN_LEAK_ANSWER_CHARS = 4

export interface EnrichableExercise {
  origin?: string | null
  status?: string | null
  isGraded?: boolean | null
  enrichedAt?: Date | string | null
  topic?: { sourceId?: string | null } | null
}

/**
 * Only imported, graded, active questions of built-in (non-uploaded) topics that were never enriched are enriched at
 * session start. Generated questions are written with their context already; uploaded topics are only enriched by the
 * upload pipeline, which opts in with `forUploadedContent` (off by default there too, see importQuestions.ts).
 */
export function isEnrichmentCandidate(ex: EnrichableExercise, opts: { forUploadedContent?: boolean } = {}): boolean {
  if (ex.enrichedAt) return false
  if (ex.origin === 'generated') return false
  if (ex.status != null && ex.status !== 'active') return false
  if (ex.isGraded === false) return false
  // Only the upload pipeline's explicit opt-in lets uploaded topics through; session-start enrichment never passes it.
  if (ex.topic?.sourceId && !opts.forUploadedContent) return false
  return true
}

export interface ChecksExercise {
  questionText: string
  exerciseType: string
  choices: string[] | string | null | undefined
  correctAnswer: string
  explanation?: string | null
}

function choiceList(choices: ChecksExercise['choices']): string[] {
  if (Array.isArray(choices)) return choices.map(String)
  if (typeof choices === 'string' && choices.trim()) {
    try {
      const parsed = JSON.parse(choices)
      if (Array.isArray(parsed)) return parsed.map(String)
    } catch {
      /* not a list */
    }
  }
  return []
}

function gradable(ex: ChecksExercise) {
  return { exerciseType: ex.exerciseType, choices: choiceList(ex.choices), correctAnswer: ex.correctAnswer, questionText: ex.questionText }
}

/**
 * The text of every correct option of a choice question, found by asking the grader which single selection scores.
 * Falls back to the stored key itself when no choice matches (legacy rows). Survey items (every option is correct)
 * and numeric questions return an empty list.
 */
export function correctOptionTexts(ex: ChecksExercise): string[] {
  const g = gradable(ex)
  const type = resolveExerciseType(g)
  if (type === 'numeric') return []
  const choices = g.choices
  let found: string[]
  if (type === 'dropdown') {
    found = choices.map(dropdownOption).filter((o) => o && gradeAnswer(g, dropdownAnswerFor(o)).isCorrect)
  } else if (type === 'multiple_choice') {
    found = choices.filter((c) => gradeAnswer(g, JSON.stringify([c])).score > 0)
  } else {
    found = choices.filter((c) => gradeAnswer(g, c).isCorrect)
  }
  if (choices.length > 0 && found.length === choices.length) return []
  if (found.length > 0) return found
  // Fallback: the key as stored (a JSON array, a JSON object of blanks, or a plain string)
  try {
    const parsed: unknown = JSON.parse(ex.correctAnswer)
    if (Array.isArray(parsed)) return parsed.map(String)
    if (parsed && typeof parsed === 'object') return Object.values(parsed as Record<string, unknown>).map(String)
  } catch {
    /* plain string */
  }
  return ex.correctAnswer ? [dropdownOption(ex.correctAnswer)] : []
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** True when `needle` occurs in `haystack` as a whole word or phrase (both already normalized). */
function containsPhrase(haystack: string, needle: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(needle)}(?![\\p{L}\\p{N}])`, 'u').test(haystack)
}

// A number glued to one of these words names a table, column, week... and is not a value.
const LABEL_BEFORE_NUMBER =
  /(?:table|tables|column|columns|col\.?|figure|fig\.?|panel|row|rows|step|part|question|week|model|models|equation|eq\.?|exercise|section|page|slide|lecture|video|chapter|group|arm|wave|round|specification|spec\.?|study|experiment|treatment|\(|#)\s*$/i

const NUMBER_TOKEN = /(?<![\w.])[-+−]?\d[\d,]*(?:\.\d+)?%?/g

/** Numbers in `text` that grade as correct for a numeric question (labels such as "Table 2" are not values). */
function numbersMatchingKey(ex: ChecksExercise, text: string): string[] {
  const g = gradable(ex)
  const hits: string[] = []
  for (const m of text.matchAll(NUMBER_TOKEN)) {
    const token = m[0].replace(/,+$/, '')
    if (LABEL_BEFORE_NUMBER.test(text.slice(Math.max(0, m.index - 14), m.index))) continue
    if (gradeAnswer(g, token).isCorrect) hits.push(token)
  }
  return hits
}

/**
 * What the enriched text gives away that the original did not: a correct option (text of at least
 * MIN_LEAK_ANSWER_CHARS normalized characters, matched as a whole phrase) or the numeric key, present in `enriched`
 * but not in `original`. Returns a short description of the leak, or null.
 */
export function findAnswerLeak(ex: ChecksExercise, original: string, enriched: string): string | null {
  const type = resolveExerciseType(gradable(ex))
  if (type === 'numeric') {
    if (numbersMatchingKey(ex, original).length > 0) return null
    const hit = numbersMatchingKey(ex, enriched)[0]
    return hit ? `numeric answer ${hit} appears in the added text` : null
  }
  const originalNorm = normalize(original)
  const enrichedNorm = normalize(enriched)
  for (const option of correctOptionTexts(ex)) {
    const o = normalize(option)
    if (o.length < MIN_LEAK_ANSWER_CHARS) continue
    if (containsPhrase(enrichedNorm, o) && !containsPhrase(originalNorm, o)) return `correct option "${option.slice(0, 60)}" appears in the added text`
  }
  return null
}

/** Choices (at least MIN_LEAK_ANSWER_CHARS normalized characters) that `enriched` contains as a phrase and the original did not. */
function newlyPresentChoices(ex: ChecksExercise, enriched: string): string[] {
  const originalNorm = normalize(ex.questionText)
  const enrichedNorm = normalize(enriched)
  return choiceList(ex.choices)
    .map((c) => normalize(dropdownOption(c)))
    .filter((c) => c.length >= MIN_LEAK_ANSWER_CHARS && containsPhrase(enrichedNorm, c) && !containsPhrase(originalNorm, c))
}

const PLACEHOLDER = /\[(?:dropdown|blank)\s*\d*\s*\]/gi

function countByCode(issues: { code: string }[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const i of issues) counts.set(i.code, (counts.get(i.code) ?? 0) + 1)
  return counts
}

/**
 * Whether enrichment made the question worse than it was. The structural validator is run on the question before and
 * after; legacy imported rows that already fail some rules (choice counts, say) are not held to them: enrichment is
 * rejected only when some rule fails that did not fail before, or fails more often (one more bare-LaTeX span).
 * Also rejected: an empty text, two or more answer options copied into the text (the model sometimes re-prints the
 * option list, so the options show twice), and a changed set of "[Dropdown n]" / "[BLANK]" placeholders (the answer key names them).
 * Returns a short reason, or null when the enriched text is acceptable.
 */
export function findEnrichmentDamage(ex: ChecksExercise, enriched: string): string | null {
  if (!enriched.trim()) return 'enriched text is empty'
  const placeholders = (t: string) => (t.match(PLACEHOLDER) ?? []).map((p) => p.toLowerCase().replace(/\s+/g, '')).sort().join(',')
  if (placeholders(ex.questionText) !== placeholders(enriched)) return 'placeholders changed'
  if (newlyPresentChoices(ex, enriched).length >= 2) return 'answer options copied into the question text'
  const before = countByCode(validateExerciseStructure({ ...ex, choices: choiceList(ex.choices), explanation: ex.explanation ?? 'x' }))
  const after = countByCode(validateExerciseStructure({ ...ex, choices: choiceList(ex.choices), explanation: ex.explanation ?? 'x', questionText: enriched }))
  const worse = [...after].filter(([code, n]) => n > (before.get(code) ?? 0)).map(([code]) => code)
  return worse.length > 0 ? `structure worse: ${worse.join(',')}` : null
}
