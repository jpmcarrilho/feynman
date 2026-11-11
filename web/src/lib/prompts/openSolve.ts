import { languageName } from './persona'

/** Bump whenever the text of openSolvePrompt changes (stored in the audit reason of rejected written-answer questions). */
export const OPEN_SOLVE_PROMPT_VERSION = 'open-solve-v1'

/**
 * Prompt of the quality check of a generated written-answer question. The solver gets what the generator was given as
 * grounding (the topic content window) and the question text, and nothing of the model answer or the key points. Its answer
 * is graded against them afterwards: a question passes only when a student who has this material can answer it fully.
 */
export function openSolvePrompt(input: {
  questionText: string
  /** The grounding text the question was generated from. */
  groundingContext: string
  /** BCP-47 code of the language the answer is written in (the tutor profile's content language). */
  language: string
}): string {
  return `You are a careful student who has just studied the course material below. You answer one written exam question using that material.

Course material:
${input.groundingContext}

Question:
${input.questionText}

Answer the question in ${languageName(input.language)}, in your own words, in 2 to 6 sentences, as a good student would in a written exam. Use the material above and standard, widely known knowledge of the subject. Do not mention the material or "the text". Write any mathematics between dollar signs.

Then decide whether the question can be answered as written:
- answerable = true when the question asks for one clear thing, and the material together with the question text gives enough to answer it fully and correctly.
- answerable = false when the answer depends on something the material and the question do not provide (a table, figure, passage or study that is not given; course rules or logistics); when the question has several unrelated parts; when it can be answered with yes or no only or by listing names; or when it is garbled or contradicts itself. Do not guess in that case.
In "issue" give one short sentence saying what is missing or wrong when answerable is false, and an empty string otherwise.
If answerable is false, still give your best attempt in "answer" (it may be empty).`
}
