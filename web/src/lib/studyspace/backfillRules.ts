// Pure rules used by src/scripts/backfill-studyspaces.ts (no database access here).

export const ENRICHED_MARKER = '<!-- enriched -->'

export interface OutlineSection {
  sectionTitle: string
  links: { text: string; href?: string }[]
}

/** Remove the marker and the newline that follows it. Only a leading marker is stripped. */
export function stripEnrichmentMarker(text: string): { text: string; hadMarker: boolean } {
  if (!text.startsWith(ENRICHED_MARKER)) return { text, hadMarker: false }
  let rest = text.slice(ENRICHED_MARKER.length)
  if (rest.startsWith('\n')) rest = rest.slice(1)
  return { text: rest, hadMarker: true }
}

const QUANT_WEEK_FRAGMENTS = ['week_03', 'week 3', 'week_06', 'week 6', 'week_09', 'week 9']

/** Same predicate as the old determineTargetQuestionType. */
export function isQuantitativeWeek(week: string | null | undefined): boolean {
  const w = (week ?? '').toLowerCase()
  return QUANT_WEEK_FRAGMENTS.some((f) => w.includes(f))
}

/** className -> sectionIndex * 1000 + linkIndex (first occurrence wins). */
export function buildOutlineRanks(outline: OutlineSection[]): Map<string, number> {
  const ranks = new Map<string, number>()
  outline.forEach((section, si) => {
    ;(section.links ?? []).forEach((link, li) => {
      if (!ranks.has(link.text)) ranks.set(link.text, si * 1000 + li)
    })
  })
  return ranks
}

export interface OrderableTopic {
  id: string
  week: string | null
  className: string | null
  unit: string | null
  resourceType: string | null
  title: string
}

export function unitNumeric(unit: string | null | undefined): number {
  const m = /^\s*(\d+(?:\.\d+)?)/.exec(unit ?? '')
  return m ? parseFloat(m[1]) : Infinity
}

function cmpStr(a: string | null | undefined, b: string | null | undefined): number {
  const x = a ?? ''
  const y = b ?? ''
  return x < y ? -1 : x > y ? 1 : 0
}

function cmpNum(a: number, b: number): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * Sort by (rank ?? Infinity, week, unitNumeric, unit, resourceType, title, id).
 * Without ranks (outline file missing): (week, unitNumeric, title, id).
 */
export function sortTopicsForOrder<T extends OrderableTopic>(topics: T[], ranks: Map<string, number> | null): T[] {
  const rankOf = (t: T) => (ranks && t.className != null && ranks.has(t.className) ? ranks.get(t.className)! : Infinity)
  return [...topics].sort((a, b) => {
    if (ranks) {
      return (
        cmpNum(rankOf(a), rankOf(b)) ||
        cmpStr(a.week, b.week) ||
        cmpNum(unitNumeric(a.unit), unitNumeric(b.unit)) ||
        cmpStr(a.unit, b.unit) ||
        cmpStr(a.resourceType, b.resourceType) ||
        cmpStr(a.title, b.title) ||
        cmpStr(a.id, b.id)
      )
    }
    return (
      cmpStr(a.week, b.week) ||
      cmpNum(unitNumeric(a.unit), unitNumeric(b.unit)) ||
      cmpStr(a.title, b.title) ||
      cmpStr(a.id, b.id)
    )
  })
}

/** The most frequent non-null value; null when empty or when the top count is tied. */
export function majorityChoice(values: (string | null | undefined)[]): string | null {
  const counts = new Map<string, number>()
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1)
  let best: string | null = null
  let bestCount = 0
  let tie = false
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v
      bestCount = c
      tie = false
    } else if (c === bestCount) {
      tie = true
    }
  }
  return tie ? null : best
}

/** Parse the legacy exerciseIds column (JSON string[]) defensively. */
export function parseIdList(raw: string | null | undefined): string[] | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : null
  } catch {
    return null
  }
}

export const GRADED_RULES = ['title-participation', 'title-survey', 'question-hours', 'multi-all-correct'] as const
export type GradedRule = (typeof GRADED_RULES)[number]

export interface GradedCandidateInput {
  topicTitle: string | null | undefined
  questionText: string
  exerciseType: string
  choices: string
  correctAnswer: string
}

/** Conservative rule for "probably not a graded question". Returns every rule that matches. */
export function gradedRulesMatched(ex: GradedCandidateInput): GradedRule[] {
  const rules: GradedRule[] = []
  const title = ex.topicTitle ?? ''
  if (/required participation|ungraded|feedback|sign-?up/i.test(title)) rules.push('title-participation')
  if (/\b(entrance|exit|course) survey\b/i.test(title)) rules.push('title-survey')
  if (/how many hours did you spend|hours per week|time spent/i.test(ex.questionText)) rules.push('question-hours')
  if (ex.exerciseType === 'multiple_choice') {
    try {
      const choices = JSON.parse(ex.choices)
      const correct = JSON.parse(ex.correctAnswer)
      if (
        Array.isArray(choices) &&
        Array.isArray(correct) &&
        choices.length > 1 &&
        choices.every((c) => correct.includes(c))
      ) {
        rules.push('multi-all-correct')
      }
    } catch {
      // not JSON: no match
    }
  }
  return rules
}

/** The text filter that createStudySession applies today (for comparison only). */
export function legacySurveyFilterExcludes(questionText: string, topicTitle: string | null | undefined): boolean {
  const q = questionText.toLowerCase()
  const t = (topicTitle ?? '').toLowerCase()
  return (
    q.includes('survey') ||
    q.includes('ungraded') ||
    q.includes('feedback') ||
    q.includes('time spent') ||
    q.includes('hours per week') ||
    q.includes('how many hours did you spend') ||
    t.includes('survey') ||
    t.includes('ungraded') ||
    t.includes('required participation') ||
    t.includes('feedback')
  )
}
