import type { TutorProfile } from '@/lib/studyspace/profile'
import { persona } from './persona'
import { subjectGuidance } from './legacySubjectGuidance'

export function explainMistakePrompt(
  profile: TutorProfile,
  input: {
    questionText: string
    choices: string[]
    correctAnswer: string
    userAnswer: string
    explanation?: string | null
    topicTitle?: string
  },
): string {
  return `${persona(profile)}
The student answered a multiple choice question incorrectly.

Topic: ${input.topicTitle || 'Unknown'}
Question: ${input.questionText}
Choices:
${input.choices.map((c) => `- ${c}`).join('\n')}

Correct Answer: ${input.correctAnswer}
Student's Answer: ${input.userAnswer}

Official Explanation: ${input.explanation || 'None provided.'}

Your task: Gently explain to the student why their answer is incorrect and why the correct answer is right. Use the official explanation if available, but break it down so it's easy to understand. Be encouraging.`
}

export function enrichExercisePrompt(
  profile: TutorProfile,
  input: {
    contextText: string
    exercise: { questionText: string; exerciseType: string; correctAnswer: string }
    choices: string[]
    courseCode?: string | null
  },
): string {
  const g = subjectGuidance(input.courseCode)
  return `${persona(profile)}
We have a question from a course on ${profile.subject} that was extracted directly from a sequential series of exercises.
Because it is played standalone in a flashcard interface, some questions might lack context because they refer to specific research papers, case studies, concrete programs/policies${g.enrichIntroExamples}, figures, or lecture experiments.

Your task is to review the question and decide if it actually needs context, and then re-generate it accordingly.

Lecture Transcripts / Lesson Context:
${input.contextText}

Original Question Text:
${input.exercise.questionText}

Exercise Type: ${input.exercise.exerciseType}
Choices/Options:
${input.choices.map((c) => `- ${c}`).join('\n')}
Correct Answer: ${input.exercise.correctAnswer}

Instructions & Constraints:

1. CRITICAL: AVOID ADDING UNNECESSARY CONTEXT OR CONCEPTUAL THEORY:
   - If the question is a general, purely theoretical, or conceptual question${g.enrichConceptualExamples}, it is already fully self-contained!
   - For general theoretical/conceptual questions, do NOT add generic textbook preambles, and do NOT explain the theory. You must return the original question text exactly as is (do not summarize, explain, or prepend any generic textbook theory).
   - ONLY enrich the question if it refers to a concrete, specific real-world case study, a particular research paper/author, a specific program/policy, a specific dataset, or a particular experiment from the lectures that is missing its setup context.

2. RECONSTRUCT MISSING TABLES & DATA:
   - If the original question refers to a Table (e.g., "Table 1", "Table 2", "according to the table") or a set of regression estimates, and the provided Lesson Context contains those estimates, values, or regression coefficients, you MUST reconstruct that table as a beautiful, clean Markdown table directly inside the enriched question text!
   - Ensure all column headers and values are accurate based on the context. If the exact table isn't in the context, but the values are described, construct a parallel simplified representation.

3. NEUTRALITY & NO HINTS:
   - The re-generated text MUST NOT be biased, leading, or hint at the correct answer in any way! It must remain completely neutral and objective.
   - Do NOT contain, define, explain, or suggest the correct answer, nor rule out any of the incorrect options.

4. CONTEXT INTEGRATION (When needed):
   - When the question refers to a concrete study/paper/case study${g.enrichCaseExamples}, ONLY append the necessary, specific setup details of that program, paper, or research scenario from the lecture transcripts.
   - Do NOT add a generic textbook lecture summary. Only describe the concrete program/paper setup itself.
   - Keep the underlying logic, question, options/choices, and correct answer exactly the same.
   - Remove relative references like "above", "in the video", "in the lecture" and replace them with the concrete name of the program, policy, or dataset being discussed.
   - Ensure the resulting question text is clear, professional, and directly answerable.

Respond with a JSON object that contains the re-generated question text.

JSON Schema:
{
  "enrichedQuestionText": string
}
`
}

/** Bump whenever the text of generateExercisePrompt changes (stored on generated exercises from T14 on). */
export const GENERATE_EXERCISE_PROMPT_VERSION = 'gen-v4'

export function generateExercisePrompt(
  profile: TutorProfile,
  input: {
    topic: { title: string; week: string | null; isQuantitative?: boolean }
    courseCode?: string | null
    bucketContext: string
    /** Final-exam-level example questions from the calibration module. The whole calibration section is omitted when empty. */
    rigorExamples?: string
    styleExamples: string
    alreadyAsked: string
    targetType: string
  },
): string {
  const { topic, targetType } = input
  const g = subjectGuidance(input.courseCode, !!topic.isQuantitative)
  const rigor = (input.rigorExamples ?? '').trim()

  const calibration = rigor
    ? `CRITICAL DIFFICULTY & RIGOR CALIBRATION (Final Exam Level):
The target question you generate must match the high analytical depth, multi-step logical reasoning, and complexity found on the actual final exams of this course.
To calibrate this difficulty, review these "Comprehensive Review" example questions representing the true final-exam-level rigor and question length:
${rigor}

However, do NOT copy their topic. Your generated question MUST test concepts from the Target Topic "${topic.title}", matching the style, formatting, and academic level of these local week style examples:`
    : `Your generated question MUST test concepts from the Target Topic "${topic.title}", matching the style, formatting, and academic level of these local week style examples:`

  return `${persona(profile)}
Your goal is to generate EXACTLY 1 NEW exercise for a course on ${profile.subject}. The question MUST test concepts and terminology specifically from the Target Topic: "${topic.title}" in "${topic.week}".

Here is the primary target content:
${input.bucketContext}

FIRST, JUDGE THE TARGET CONTENT. Decide whether the Target Topic content above is SUBJECT MATTER (concepts, methods, models, evidence, worked examples that a student can be tested on) or COURSE LOGISTICS / ADMINISTRATION (course rules, exam rules or format, schedules, grading policies, platform or website instructions, welcome or introduction notes, honor code, surveys, feedback forms, how to use the course). Judge from the content itself, not from its title. Set "contentKind" to "subject_matter" or "logistics". If it is "logistics", give a one-sentence "logisticsReason", leave "questionText", "correctAnswer" and "explanation" as empty strings and "choices" as an empty list: do NOT invent a question about rules, policies or instructions. If it is "subject_matter", set "logisticsReason" to an empty string and follow all the instructions below.

CRITICAL WEEK & TOPICS INTEGRITY RULE:
The generated question, its choices, correct answer, and explanation MUST be based directly on concepts from "${topic.title}" (in "${topic.week}"). You may use the other topics from "${topic.week}" provided in the content for background enhancement, but you MUST NOT write a question about a different week or general topic.

${calibration}
${input.styleExamples}

CRITICAL: Do NOT copy the specific questions or concepts from the local week style examples listed above. Focus your question entirely on testing the concept of "${topic.title}".

Here are the questions that are ALREADY present in the student's active study session. You MUST NOT repeat, duplicate, or ask about the exact same concepts or scenarios tested in these questions:
${input.alreadyAsked || 'No questions have been asked yet in this session.'}

CRITICAL DEDUPLICATION RULES:
1. Review the "ALREADY present" questions listed above. Your newly generated question MUST NOT test the same concept, use the same core scenario, or ask the same question as any of them. It must be completely distinct and test a different concept or scenario from the Target Topic: "${topic.title}".
2. The new question MUST be about the concepts described in the Target Topic. Do NOT generate questions about other topics in the surrounding context or style examples.
3. Ensure that the question covers a concept or uses a scenario from the Target Topic. Every question MUST be completely self-contained (invent hypothetical scenarios or markdown data tables if a concept requires it).

CRITICAL VARIANT GENERATION RULES (VARIATION & RIGOR):
1. CONCEPTUAL PARALLELISM WITH VARIATION: Use the style examples in the database to generate a conceptually parallel but completely fresh exercise. Do NOT clone existing questions. Instead, adapt their core ${g.principles} into a new, original scenario.
2. VARY SCENARIOS, TITLES, & SETUPS: Change the titles of researchers, names of programs, policies, geographic locations, and experimental setups.${g.scenarioExample}
3. VARY MATHEMATICAL & CALCULATION PARAMETERS: If the exercise requires any calculations (such as ${g.calcExamples}), you MUST change the specific numeric variables, equations, or coefficients. The student should be forced to calculate a completely new result (do not repeat the numerical formulas, values, or options from the examples).
4. VARY THEORETICAL PERSPECTIVES & ANGLES: Look at the topic from another perspective or analytical angle.${g.angleExample}

CRITICAL GROUNDING AND TRUTHFULNESS RULES:
1. STRICT GROUNDING: The generated question, choices, correct answer, and official explanation MUST be 100% strictly grounded in and derived from the provided Target Topic content above.
2. NO EXTERNAL TERMS: You MUST NOT introduce or test any external concepts, acronyms, ${g.termWord}, or advanced terminology that are not explicitly defined, mentioned, or discussed in the provided Target Topic Content.
3. NO EXTRAPOLATIONS: Do not assume the student knows prerequisite or external context that is not directly present in the provided lecture notes/transcript. If a term is not in the provided text, you must not use or refer to it.

CRITICAL SELF-CONTAINEDNESS MANDATE (NO OUTSIDE KNOWLEDGE ASSUMPTION):
1. MANDATORY CONTEXTUAL BACKGROUND: If your generated question mentions, tests, or refers to any specific research paper, author, academic study, historical event, or public policy${g.namedStudies}, you MUST explicitly include a clear, 2-3 sentence introductory background summary of that study directly inside the question text itself.
2. BACKGROUND SETUP SPECIFICS: This summary must explain the study's primary setup (e.g., who/what was studied and where), the methodology used (e.g., differences-in-differences, RCT, or RD design), and any critical parameters.
3. LOGICAL ANSWERABILITY: Every question must be completely self-contained. A student who has never read the referenced paper or memorized its details must be able to understand the scenario and answer the question successfully purely by using logical reasoning, scientific principles, and the contextual details you have provided in the question text.
4. NO TRIVIA OR ROTE MEMORIZATION: Avoid testing rote memorization of paper titles or isolated facts. Instead, test the conceptual ${g.triviaPrinciples} within the paper's framework, which you must explain in the setup.

${g.synthesisBlock}

CRITICAL FORMATTING & STRUCTURE INSTRUCTIONS:
${g.formatRules.map((r, i) => `${i + 1}. ${r}`).join('\n')}
${g.formatRules.length + 1}. MATH AND SYMBOLS: Write every mathematical expression or symbol, in the question, the choices and the explanation, between dollar signs ($...$ inline, $$...$$ on its own line), for example $\\beta > 0$. Never write LaTeX commands (\\beta, \\frac, x_{i}) outside the dollar signs, and never double the backslashes. Write currency with an escaped dollar sign (\\$5), never a bare dollar sign. The options of a "dropdown" question are plain text: no LaTeX, no dollar signs.

CRITICAL FORMAT SELECTION:
You MUST generate an exercise of type: "${targetType}".
Follow these rules strictly based on the target type:
- If "${targetType}" is "single_choice": Create a standard multiple choice question. 'choices' MUST contain exactly 4 options. 'correctAnswer' MUST be the exact matching string of the single correct answer.
- If "${targetType}" is "multiple_choice": Create a multiple-response check-box question (multiple correct answers allowed). 'choices' MUST contain 4 or 5 options. 'correctAnswer' MUST be a JSON array string containing all of the correct option texts (e.g. '["Option A", "Option C"]').
- If "${targetType}" is "numeric": Create a question requiring a numerical response. The 'choices' array MUST be completely empty ([]). The 'correctAnswer' MUST be a clean numeric string (e.g. "0.8" or "-0.07"). The 'questionText' should explicitly tell the student: "Please enter your numeric response rounded to two decimal places (for example, -0.07)".
- If "${targetType}" is "dropdown": Create a fill-in-the-blank sentence. The 'questionText' MUST contain exactly one "[Dropdown 1]" placeholder. The 'choices' array MUST contain 3 to 5 options that could fit in that blank. The 'correctAnswer' MUST be the exact correct literal word/option.`
}
