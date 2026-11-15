import type { TutorProfile } from '@/lib/studyspace/profile'
import { persona } from './persona'
import { subjectGuidance } from './legacySubjectGuidance'
import { fileLinkInstructions } from './linkInstructions'
import { parseOpenFeedback, parseKeyPoints, type KeyPointStatus } from '@/lib/openAnswer'

export type WrongAnswerEntry = {
  topicTitle: string
  question: string
  userAnswer: string | null
  correctAnswer: string
  partialScore: number
  explanation?: string | null
  topicId: string
  exerciseType?: string | null
  gradedBy?: string | null
  /** Stored ExerciseLog.feedback (JSON string) of a written answer. */
  feedback?: string | null
  /** Stored Exercise.keyPoints (JSON string) of a written question. */
  keyPoints?: string | null
}

const STATUS_WORD: Record<KeyPointStatus, string> = { covered: 'covered', partly: 'partly covered', missing: 'missing' }

/** One reviewed answer of the exam diagnosis prompt. A written answer carries its type, the model answer and the grader's feedback; a pending one is described as not yet checked. */
export function examWrongAnswerBlock(index: number, w: WrongAnswerEntry): string {
  if (w.exerciseType !== 'open') {
    return `### Question Review ${index}:
Topic: ${w.topicTitle}
Question: ${w.question}
User Answer: "${w.userAnswer || 'Unanswered'}"
Correct Answer: "${w.correctAnswer}"
Your Partial Score: ${w.partialScore.toFixed(2)}/1.00
Official Explanation: ${w.explanation || "No explanation available."}
Topic ID: ${w.topicId || 'none'}`
  }
  const pending = w.gradedBy === 'pending'
  const feedback = parseOpenFeedback(w.feedback)
  const stored = parseKeyPoints(w.keyPoints)
  const lines = [
    `### Question Review ${index}:`,
    `Topic: ${w.topicTitle}`,
    `Question (written answer): ${w.question}`,
    `User Answer (written): "${w.userAnswer || 'Unanswered'}"`,
    `Model Answer: "${w.correctAnswer}"`,
  ]
  if (pending) {
    lines.push('Check: this written answer has not been checked yet; it counts 0 for now. Do not judge it.')
  } else {
    lines.push(`Your Partial Score: ${w.partialScore.toFixed(2)}/1.00${w.gradedBy === 'self' ? ' (the student scored it themselves)' : ''}`)
    if (feedback && feedback.keyPoints.length > 0) {
      lines.push('Key points: ' + feedback.keyPoints.map((k) => `${k.point} [${STATUS_WORD[k.status]}]`).join('; '))
    } else if (stored.length > 0) {
      lines.push('Key points: ' + stored.join('; '))
    }
    if (feedback?.text) lines.push(`Grader feedback: ${feedback.text}`)
  }
  lines.push(`Official Explanation: ${w.explanation || 'No explanation available.'}`, `Topic ID: ${w.topicId || 'none'}`)
  return lines.join('\n')
}

export function examDiagnosisPrompt(
  profile: TutorProfile,
  input: {
    courseCode?: string | null
    scoreSum: number
    totalCount: number
    scorePct: number
    sessionMode: string
    topicSummary: string
    wrongAnswers: string
  },
): string {
  const g = subjectGuidance(input.courseCode)
  return `${persona(profile)}
The student has completed a timed mock exam graded under a proportional partial credit "one wrong cancels one right" scoring protocol. You need to write a deeply professional, encouraging, and detailed analytical diagnostic report.

--- EXAM RESULTS OVERVIEW ---
Overall Proportional Score: ${input.scoreSum.toFixed(2)}/${input.totalCount} (${input.scorePct}%)
Mode: ${input.sessionMode} (Timed Exam)

--- TOPIC BREAKDOWNS ---
${input.topicSummary}

--- DETAILED WRONG ANSWERS & COGNITIVE MISTAKES ---
${input.wrongAnswers || 'No wrong answers! Perfect score!'}

Your output MUST be a gorgeous Markdown document structured exactly as follows:

# Timed Exam Diagnostic Report

## 1. Executive Performance Summary
Provide a 2-3 sentence overview of their performance. Be encouraging but academically rigorous. Highlight their immediate strengths.

## 2. Topic-by-Topic Mastery Breakdown
For each tested topic, assign one of these levels:
- **High Mastery** (Accuracy >= 80%): Short description of what they understand.
- **Developing Mastery** (Accuracy 50% - 79%): Identify small conceptual gaps.
- **Critical Remediation Needed** (Accuracy < 50%): Highlight foundational gaps.

## 3. Deep Error Deconstruction
Review each wrong answer. Explain the *cognitive trap*${g.misinterpretation} they fell into${g.trapExamples}. Explain the underlying ${g.intuition} clearly.

## 4. Tailored Study Plan & Grounding Map
Generate a clear, numbered list of study tasks.
For each task, refer to the exact lecture file (using its Topic ID) with a direct clickable Markdown link so they can click to open and review it in the Visualizer.
${fileLinkInstructions()}

Ensure that ALL topic IDs used in the links are the ones listed in the breakdowns above. If no Topic ID was provided for a task, do not add a link for it. Do NOT invent external domains, IDs or paths.
`
}

export function globalDiagnosisPrompt(
  profile: TutorProfile,
  input: {
    /** Codes of the courses the logs come from; drives legacy examples and the scope sentence. */
    courseCodes: string[]
    topicLines: string
    weakTopicContent: string
  },
): string {
  const g = subjectGuidance(input.courseCodes)
  const scope =
    input.courseCodes.length > 0
      ? `${input.courseCodes.length > 1 ? 'all your courses' : 'your course'} (${input.courseCodes.join(' and ')})`
      : 'your courses'
  return `${persona(profile)} You are acting as a Socratic Academic Advisor.
The student wants a comprehensive **Global Learning Diagnosis & Personalized Study Plan** based on their performance across ALL study and exam sessions.

--- GLOBAL PERFORMANCE METRICS ---
${input.topicLines}

--- RELEVANT CLASS CONTENT TRANSCRIPTIONS / SLIDES FOR WEAKEST AREAS ---
${input.weakTopicContent || 'No weak areas found! Perfect accuracy across all topics!'}

Your output MUST be a beautiful, highly thorough Markdown document structured exactly as follows:

# Global Learning Diagnostic Report

## 1. Executive Learning Profile
Provide a 3-4 sentence comprehensive analysis of their learning journey across ${scope}. Identify high-level patterns${g.patternExamples}. Be encouraging but highly rigorous.

## 2. Global Topic Mastery Heatmap
Categorize their active topics into:
- **High Mastery** (Accuracy >= 75%)
- **Developing Mastery** (Accuracy 60% - 74%)
- **Critical Conceptual Gaps** (Accuracy < 60%)

## 3. Core Conceptual Gaps & Error Deconstructions
Analyze their weakest areas. Ground your explanations directly in the provided lecture transcriptions/slides above!
Detail the *precise theoretical or mathematical mistakes* they are making${g.gapExamples}. Ensure this section is academically rich and deeply informative.

## 4. Tailored Remedial Syllabus & Clickable Grounding Map
Generate a clear, numbered list of study tasks linking directly to their weak areas.
For each task, refer to the exact lecture file (using its Topic ID) with a direct clickable Markdown link so they can click to open and review it in the Visualizer.
${fileLinkInstructions()}

Ensure that ALL topic IDs used in the links are the ones listed in the breakdowns above. Do NOT invent external domains, IDs or paths.
`
}
