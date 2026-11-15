import type { TutorProfile } from '@/lib/studyspace/profile'
import { persona, languageName } from './persona'

/** Bump whenever the text of generateProblemPrompt changes (stored on generated problem parts). */
export const GENERATE_PROBLEM_PROMPT_VERSION = 'problem-v2'

export const PROBLEM_MIN_PARTS = 3
export const PROBLEM_MAX_PARTS = 5

/**
 * Prompt for a multi-part problem: one shared stem and 3 to 5 sub-questions, the way a course exam builds a problem on one
 * setup. Every part must be answerable from the stem alone (the parts are shown in order but each is graded on its own).
 */
export function generateProblemPrompt(
  profile: TutorProfile,
  input: {
    topic: { title: string; week: string | null }
    bucketContext: string
    alreadyAsked: string
    /** Real problems of this course (a stem and its parts) that show the depth, length and style to match. Omitted when there are none. */
    exemplars?: string
  },
): string {
  const lang = languageName(profile.contentLanguage)
  return `${persona(profile)}
Your goal is to write ONE multi-part PROBLEM for a course on ${profile.subject}: a shared setup (the "stem") followed by ${PROBLEM_MIN_PARTS} to ${PROBLEM_MAX_PARTS} sub-questions about it, like a problem on a university exam. It must test concepts from the Target Topic "${input.topic.title}" in "${input.topic.week ?? 'the course'}". Write in ${lang}, pitched at ${profile.level} level.

TARGET TOPIC AND GROUNDING CONTEXT (everything in the problem must be grounded in it):
${input.bucketContext}

${input.exemplars?.trim() ? `REAL PROBLEMS FROM THIS COURSE (match their depth, length and style; do NOT copy their scenario or topic):\n${input.exemplars.trim()}\n\n` : ''}ALREADY ASKED IN THIS SESSION (do not repeat these):
${input.alreadyAsked || '(none)'}

FIRST, JUDGE THE TARGET CONTENT. If it is course logistics or administration (rules, schedules, grading, platform instructions) and not subject matter, set "contentKind" to "logistics", give a one-sentence "logisticsReason" and leave everything else empty. Otherwise set "contentKind" to "subject_matter" and "logisticsReason" to "".

THE STEM:
- A realistic setup taken from the grounding context: a scenario, a model with its notation, the numbers or a regression output, or a short description of a study. Give every value the parts need (parameters, estimates, standard errors) in the stem, with units.
- It contains NO question, NO option and NO answer, and it never hints at an answer.
- 60 to 200 words, Markdown allowed. A small table is fine as a Markdown table.

THE PARTS (${PROBLEM_MIN_PARTS} to ${PROBLEM_MAX_PARTS}, in the order a student should work them, from setup to deeper interpretation):
- Each part is a neutral exam item (no greeting, no persona voice) and must be answerable from the stem and the course knowledge alone. A part may NOT depend on the answer to another part: if a later part needs an earlier result, give that value in the stem or in the part itself.
- Mix the types: use "numeric" for a calculation with one plain-number answer, "single_choice" (3 to 5 options), "multiple_choice" (3 to 6 options, at least one but not all correct) or "dropdown" (exactly one "[Dropdown 1]" in the text, 3 to 5 plain-text options). Do not use written-answer questions.
- "correctChoiceIndexes" lists the 0-based indexes of the correct options (one for single_choice and dropdown, one or more for multiple_choice, none for numeric). For numeric parts "correctAnswer" is the plain number (no units, no commas) and "choices" is [].
- Exactly one defensible answer per part, verified by working it out step by step. "explanation" is 1 to 3 sentences showing the key step.
- Do not repeat the stem in a part, and do not reveal any answer in another part.
- DEPTH: a part must need more than one step of reasoning. No part may be answered by one arithmetic operation on numbers the part or the stem hands over (a lone subtraction, ratio or substitution): a calculation part has to combine at least two ideas (for example derive a quantity from the model, then use it), or ask the student to compare, sign or interpret a result. At least one part is a calculation and at least one part tests interpretation or the logic of the model or the identification strategy.

FORMAT RULES:
- Write every mathematical expression or symbol, in the stem, the parts, the options and the explanations, between dollar signs ($...$ inline, $$...$$ on its own line). Never write LaTeX commands outside the dollar signs and never double the backslashes. Write currency with an escaped dollar sign (\\$5). The options of a "dropdown" part are plain text.
- Write options without list letters or numbers ("a.", "b)"), and never refer to an option by letter or position in the explanation: the options are shuffled.
- "title" is a short name for the problem, 2 to 8 words.`
}
