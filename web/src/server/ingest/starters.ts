// Starter exercises of uploaded material (plan 4.6): up to 2 generated questions per study-material topic, through the same
// generator as live sessions (so the T13 grounding caps and the T14 validation apply to every one of them).
//
// Bounds (src/lib/ingestLimits.ts): STARTERS_PER_TOPIC per topic, STARTERS_PER_SOURCE per source, STARTER_SLOTS_PER_RUN
// generation slots for one studyspace's run, STARTER_MAX_CONSECUTIVE_FAILURES slots in a row failing for infrastructure reasons
// ends the run. A slot makes at most MAX_GENERATION_ATTEMPTS (3) attempts of one generation plus one blind-solve call.
//
// The work is a top-up, not an append: a topic that already has starter questions only gets the missing ones, so a run that
// was interrupted or repeated never produces more than the caps.
import { prisma } from '@/lib/db'
import {
  STARTERS_PER_TOPIC, STARTERS_PER_SOURCE, STARTER_SLOTS_PER_RUN, STARTER_MAX_CONSECUTIVE_FAILURES,
} from '@/lib/ingestLimits'
import { classifyTopics, generateExerciseForTopic, GenerationError, chunkIds } from '@/services/exerciseGenerator'
import { mapWithConcurrency, STAGE_CONCURRENCY } from './pool'

/** Budget shared by every source of one run. Mutated while the run progresses. */
export type StarterBudget = {
  slotsLeft: number
  consecutiveFailures: number
  /** Set when the run must end: the model looks unavailable. */
  broken: boolean
}

export function newStarterBudget(slots: number = STARTER_SLOTS_PER_RUN): StarterBudget {
  return { slotsLeft: slots, consecutiveFailures: 0, broken: false }
}

export type StarterOutcome = {
  /** Starter questions created by this call. */
  created: number
  /** Slots that ended without a question (validation failed three times, or the model failed). */
  failedSlots: number
  /** Study-material topics the source has and slots that were not attempted because a cap was reached. */
  notAttempted: number
  /** Why the call ended early, if it did. */
  stoppedBy: 'cap' | 'budget' | 'breaker' | 'cancelled' | null
}

/** Codes of GenerationError that mean "this topic cannot be used", not "something is wrong with the model". */
const TOPIC_LEVEL = new Set(['not_study_material', 'no_content', 'ungraded_only', 'topic_not_found', 'no_eligible_topic'])

async function countStartersByTopic(topicIds: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>()
  for (const chunk of chunkIds(topicIds)) {
    const rows = await prisma.exercise.groupBy({
      by: ['topicId'], where: { topicId: { in: chunk }, origin: 'starter', status: 'active' }, _count: { _all: true },
    })
    for (const r of rows) result.set(r.topicId, r._count._all)
  }
  return result
}

/** Ids of the topic's questions a new one must differ from (active ones, oldest first): the generator's dedup and type cycling input. */
async function activeExerciseIds(topicId: string): Promise<string[]> {
  const rows = await prisma.exercise.findMany({ where: { topicId, status: 'active' }, orderBy: { createdAt: 'asc' }, select: { id: true } })
  return rows.map((r) => r.id)
}

/**
 * Tops up the starter questions of every study-material topic of a source, breadth first (every eligible topic gets its first
 * starter before any gets a second, so the cap of 60 spreads over the whole outline). Never throws for a model problem: those are
 * counted in the outcome. `shouldStop` is polled between slots (cancellation, lost lease).
 */
export async function generateStartersForSource(
  sourceId: string,
  budget: StarterBudget,
  shouldStop: () => boolean = () => false,
  generate: typeof generateExerciseForTopic = generateExerciseForTopic,
): Promise<StarterOutcome> {
  const outcome: StarterOutcome = { created: 0, failedSlots: 0, notAttempted: 0, stoppedBy: null }
  const topics = await prisma.topic.findMany({ where: { sourceId }, orderBy: { order: 'asc' }, select: { id: true } })
  const allIds = topics.map((t) => t.id)
  const eligibility = await classifyTopics(allIds)
  const eligible = allIds.filter((id) => eligibility.get(id) === 'ok')
  if (eligible.length === 0) return outcome

  const have = await countStartersByTopic(eligible)
  let sourceRoom = STARTERS_PER_SOURCE - [...have.values()].reduce((a, b) => a + b, 0)
  const dropped = new Set<string>()

  for (let round = 1; round <= STARTERS_PER_TOPIC; round++) {
    const todo = eligible.filter((id) => (have.get(id) ?? 0) < round && !dropped.has(id))
    if (todo.length === 0) continue
    const slots: string[] = []
    for (const id of todo) {
      if (sourceRoom <= 0) { outcome.notAttempted++; outcome.stoppedBy ??= 'cap'; continue }
      sourceRoom--
      slots.push(id)
    }
    await mapWithConcurrency(slots, STAGE_CONCURRENCY, async (topicId) => {
      if (shouldStop()) { outcome.stoppedBy ??= 'cancelled'; return }
      if (budget.broken) { outcome.stoppedBy ??= 'breaker'; outcome.notAttempted++; return }
      if (budget.slotsLeft <= 0) { outcome.stoppedBy ??= 'budget'; outcome.notAttempted++; return }
      budget.slotsLeft--
      try {
        const existing = await activeExerciseIds(topicId)
        const made = await generate({ primaryTopicId: topicId, poolTopicIds: eligible, existingExerciseIds: existing })
        await prisma.exercise.update({ where: { id: made.id }, data: { origin: 'starter' } })
        have.set(topicId, (have.get(topicId) ?? 0) + 1)
        outcome.created++
        budget.consecutiveFailures = 0
      } catch (error) {
        if (error instanceof GenerationError && TOPIC_LEVEL.has(error.code)) {
          dropped.add(topicId)
          return
        }
        outcome.failedSlots++
        dropped.add(topicId)
        if (error instanceof GenerationError) {
          // The model answers but nothing passes the checks: bounded by the slot budget, does not end the run
          budget.consecutiveFailures = 0
        } else {
          console.warn(`[starters] topic ${topicId}:`, error instanceof Error ? error.message.slice(0, 300) : error)
          budget.consecutiveFailures++
          if (budget.consecutiveFailures >= STARTER_MAX_CONSECUTIVE_FAILURES) budget.broken = true
        }
      }
    })
    if (budget.broken) { outcome.stoppedBy ??= 'breaker'; break }
    if (shouldStop()) { outcome.stoppedBy ??= 'cancelled'; break }
  }
  return outcome
}

const STARTER_NOTE_RE = /\s*Starter questions: [^.]*\./g

/** Removes an earlier starter sentence from a warning, so a re-run replaces it instead of repeating it. */
export function stripStarterNote(warning: string | null | undefined): string {
  return (warning ?? '').replace(STARTER_NOTE_RE, '').trim()
}

/** The sentence stored in Source.warning after a starter pass (empty when there is nothing to say). */
export function starterNote(outcome: StarterOutcome): string {
  const parts: string[] = []
  if (outcome.failedSlots > 0) parts.push(`${outcome.failedSlots} could not be generated`)
  if (outcome.stoppedBy === 'cap' || outcome.stoppedBy === 'budget') parts.push(`stopped at the limit (${STARTERS_PER_SOURCE} per file, ${STARTER_SLOTS_PER_RUN} per studyspace); sessions generate the rest on the fly`)
  if (outcome.stoppedBy === 'breaker') parts.push('stopped early because the model was not available; sessions generate questions on the fly')
  if (parts.length === 0) return ''
  return `Starter questions: ${outcome.created} created, ${parts.join('; ')}.`
}
