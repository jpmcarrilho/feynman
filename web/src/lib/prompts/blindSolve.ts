/** Bump whenever the text of blindSolvePrompt changes (stored in the audit reason of rejected questions). */
export const BLIND_SOLVE_PROMPT_VERSION = 'solve-v1'

/**
 * Prompt of the blind-solve check. The solver gets exactly what the student sees: the question text, the choices and
 * the type. No topic content, no explanation, no correct answer.
 */
export function blindSolvePrompt(input: {
  questionText: string
  exerciseType: string
  choices: string[]
}): string {
  const answerRule: Record<string, string> = {
    single_choice: 'Put exactly one choice in "answer", copied character for character.',
    multiple_choice:
      'Put every choice that is correct in "answer", each copied character for character. Select all and only the correct ones.',
    dropdown:
      'The sentence has a blank written as [Dropdown 1]. Put the one option that correctly fills it in "answer", copied character for character.',
    numeric: 'Put the final number alone in "answer" as a single item, for example ["0.8"] (no units, no words). Round as the question asks.',
  }
  const choiceBlock =
    input.exerciseType === 'numeric'
      ? '(no choices: the student types a number)'
      : input.choices.map((c) => `- ${c}`).join('\n')
  return `You are a student taking a quiz. You see only the question below, exactly as it appears on screen. You have no notes, no course materials and no answer key.

Question type: ${input.exerciseType}

Question:
${input.questionText}

Choices (each line starts with "- ", which is not part of the choice):
${choiceBlock}

Work out the answer using only what is written in the question plus standard, widely known knowledge of the subject (definitions, formulas, textbook results).

Then decide whether the question can be answered as written:
- answerable = true when a knowledgeable student can reach one definite answer from the question text and standard knowledge.
- answerable = false when the correct answer depends on information the question does not give: rules, policies, dates, numbers, tables, figures, passages or findings of a specific document, course or study that are not stated in the question; when two choices are equally defensible; when no choice is correct; or when the question is garbled or contradicts itself. Do not guess in that case.
In "issue" give one short sentence saying what is missing or wrong when answerable is false, and an empty string otherwise.

${answerRule[input.exerciseType] ?? answerRule.single_choice}
If answerable is false, still give your best attempt in "answer" (it may be an empty list).`
}
