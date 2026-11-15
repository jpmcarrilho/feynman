// Finds the multi-part problems of a homework unit and writes them as `# Problem set:` sections (the format
// `edxCandidates` reads). The shared setup of such a problem lives in the unit's handout (a PDF next to the questions) or in the
// first question; the model only decides which questions belong together and copies the setup, and code checks that the
// copied setup really comes from those sources.
import { z } from 'zod'
import { PROBLEM_SET_END } from './importQuestions'
import { structuredCall, newModelStats, type GenerateObjectFn, type ModelStats } from './modelCall'

export const ProblemSetsSchema = z.object({
  groups: z.array(z.object({
    title: z.string(),
    stem: z.string(),
    questionNumbers: z.array(z.number().int()),
  })),
})
export type ProblemSets = z.infer<typeof ProblemSetsSchema>
export type ProposedGroup = ProblemSets['groups'][number]

export const STEM_MIN_CHARS = 40
export const STEM_MAX_CHARS = 5000
/** Share of the stem's four-word runs (math removed) that must occur in the handout or the question texts. */
export const STEM_MIN_COVERAGE = 0.5
export const HANDOUT_MAX_CHARS = 250_000

const MATH_SPAN = /\$\$[\s\S]+?\$\$|\$[^$\n]+\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]/g

function words(text: string): string[] {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean)
}

function shingles(ws: string[], n = 4): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i + n <= ws.length; i++) out.add(ws.slice(i, i + n).join(' '))
  return out
}

/** Share of the stem's prose (math spans removed) that occurs, four words at a time, in `source`. 1 for a stem with no prose to check. */
export function stemCoverage(stem: string, source: string): number {
  const mine = shingles(words(stem.replace(MATH_SPAN, ' ')))
  if (mine.size === 0) return 1
  const theirs = shingles(words(source.replace(MATH_SPAN, ' ')))
  let found = 0
  for (const s of mine) if (theirs.has(s)) found++
  return found / mine.size
}

/** Why a proposal cannot be used, or null. `questions` are the texts of the unit's questions, 1-based in the proposal. */
export function checkProposal(proposal: ProblemSets, questions: string[], handout: string): string | null {
  const used = new Set<number>()
  const source = `${handout}\n${questions.join('\n')}`
  for (const g of proposal.groups) {
    const nums = g.questionNumbers
    if (nums.length < 2) return `group "${g.title}" has fewer than two questions`
    if (nums.some((n) => n < 1 || n > questions.length)) return `group "${g.title}" names a question that does not exist`
    if (new Set(nums).size !== nums.length) return `group "${g.title}" lists a question twice`
    if (nums.some((n) => used.has(n))) return `a question is in two groups`
    nums.forEach((n) => used.add(n))
    const stem = g.stem.trim()
    if (stem.length < STEM_MIN_CHARS || stem.length > STEM_MAX_CHARS) return `the stem of "${g.title}" has ${stem.length} characters`
    if (!g.title.trim()) return 'a group has no title'
    const cov = stemCoverage(stem, source)
    if (cov < STEM_MIN_COVERAGE) return `the stem of "${g.title}" is not taken from the handout or the questions (coverage ${Math.round(cov * 100)}%)`
  }
  return null
}

/** Every `$$...$$` display equation in its own paragraph: two on adjacent lines would run together on one line. */
export function normalizeDisplayMath(stem: string): string {
  return stem.replace(/[ \t]*(\$\$[\s\S]+?\$\$)[ \t]*/g, '\n\n$1\n\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function problemSetsPrompt(input: { unitTitle: string; handout: string; questions: string[] }): string {
  const numbered = input.questions.map((q, i) => `### Question ${i + 1}\n${q.trim()}`).join('\n\n')
  return `You prepare the exercises of a university course for a study app. The questions below belong to one unit ("${input.unitTitle}") of a homework or problem set. Some questions are parts of ONE larger problem: they only make sense with a shared setup (a model, a scenario, a dataset description, a figure) and often build on each other ("answer questions 10-12", "call your answer x", "using the model above"). Other questions are self-contained.

TASK: decide which questions form multi-part problems and write the shared setup of each.

Rules:
- A group has at least two questions that need the SAME setup to be answerable. A question that can be answered on its own stays out of every group. When unsure, leave the question out.
- "questionNumbers" are the numbers of the questions in the group, in the order a student should answer them. A question belongs to at most one group.
- "stem" is the shared setup ONLY: the scenario, the definitions, the model and its notation, the description of the data or figure. Copy it from the HANDOUT (and from the question texts when the setup is written there). You may fix text-extraction damage and write mathematics as LaTeX between dollar signs ($...$ inline, $$...$$ on its own line), and you may use Markdown. Do NOT add facts, numbers or steps that are not in the sources. Do NOT include any question, option or answer in the stem. Do not write "see question 1".
- "title" is a short name for the problem, 2 to 8 words.
- If no question needs a shared setup, return {"groups": []}.

HANDOUT (text of the unit's PDF; may be empty and may contain extraction artifacts):
"""
${input.handout.slice(0, HANDOUT_MAX_CHARS) || '(none)'}
"""

QUESTIONS:
${numbered}`
}

/** One model call per unit. Returns the checked groups (an empty list when the unit has none). */
export async function proposeProblemSets(
  input: { unitTitle: string; handout: string; questions: string[] },
  deps: { generate?: GenerateObjectFn; stats?: ModelStats } = {},
): Promise<ProposedGroup[]> {
  if (input.questions.length < 2) return []
  const result = await structuredCall({
    generate: deps.generate,
    stats: deps.stats ?? newModelStats(),
    schema: ProblemSetsSchema,
    what: `Grouping the questions of "${input.unitTitle.slice(0, 60)}"`,
    prompt: problemSetsPrompt(input),
    check: (object) => checkProposal(object, input.questions, input.handout),
  })
  return result.groups.map((g) => ({ ...g, title: g.title.trim(), stem: normalizeDisplayMath(g.stem) }))
}

/**
 * The unit as edX markdown: standalone questions as they were, each group as a `# Problem set:` section placed where its first
 * question was, sub-questions in the group's order. `blocks` are the raw `# Question ...` texts in unit order.
 */
export function renderUnit(blocks: string[], groups: ProposedGroup[]): string {
  const inGroup = new Map<number, ProposedGroup>()
  for (const g of groups) for (const n of g.questionNumbers) inGroup.set(n, g)
  const out: string[] = []
  const written = new Set<ProposedGroup>()
  blocks.forEach((block, i) => {
    const g = inGroup.get(i + 1)
    if (!g) {
      out.push(block.trim())
      return
    }
    if (written.has(g)) return
    written.add(g)
    const parts = g.questionNumbers.map((n) => blocks[n - 1].trim())
    out.push([`# Problem set: ${g.title}`, '## Shared context', g.stem, '', ...parts, PROBLEM_SET_END].join('\n\n'))
  })
  return out.join('\n\n')
}
