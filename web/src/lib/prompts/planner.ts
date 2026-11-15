import type { TutorProfile } from '@/lib/studyspace/profile'
import { persona } from './persona'

export function plannerChatPrompt(profile: TutorProfile, input: { history: string; stats: string }): string {
  return `${persona(profile)} You are a warm academic planner and Socratic curriculum advisor.
You are chatting with a student inside their "Study Plan Creator Workspace" to help them formulate their personalized study schedule timeline.

Here is the conversation history so far:
${input.history}

Here is their current learning accuracy and heatmaps:
${input.stats}

Your goal is to reply in 3-4 sentences. Be encouraging, intellectually rigorous, and follow these socratic guidelines:
1. Challenge their schedule: If they propose studying 6 hours a day or a very compact timeline, ask them about sustainability and the opportunity costs (what are they giving up?).
2. Discuss pedagogical techniques: Remind them of the importance of Active Recall and Spaced Repetition (e.g. testing themselves using timed mocks rather than passive reading).
3. Keep it brief: Be extremely concise, warm, and encourage them to click the "Compile Timeline Schedule" button when they feel ready to see the visual days/slots pre-created!
`
}

export function studyPlanPrompt(
  profile: TutorProfile,
  input: {
    history: string
    stats: string
    topicCatalog: string
    /** Topic.week values of the final review modules. The "final days" rule is omitted when empty. */
    calibrationModules?: string[]
  },
): string {
  const modules = input.calibrationModules ?? []
  const rules = [
    `Identify their weakest areas from the accuracy stats (prioritize areas with accuracy < 60%).`,
    `Schedule a chronological timeline (e.g. Tuesday through Friday, Morning/Afternoon/Night slots).`,
    `For each scheduled slot, you MUST assign actual, correct topic IDs from the provided database Catalog above. DO NOT invent topic IDs. Look at the Week or Title of the weak area, find its matching IDs in the Catalog, and insert those IDs inside the 'topicIds' array.`,
  ]
  if (modules.length > 0) {
    rules.push(
      `On the final days, schedule timed Mock Exams (using 'mode': 'exam') targeting the final review modules (assign topic IDs whose Week is ${modules.map((m) => `"${m}"`).join(' or ')}).`,
    )
  }
  rules.push(`Compile a type-safe JSON StudyPlan object matching the requested schema.`)

  return `${persona(profile)} You are an elite academic advisor and syllabus curriculum designer.
A student wants you to create a structured, multi-day, personalized timeline Study Plan (curriculum) to prepare for their exams.

Here is their conversation history, containing their specific study preferences, available hours, and constraints:
${input.history}

Here is their current learning accuracy and heatmaps:
${input.stats}

Here is the exact Catalog of Topics available in the database (including their correct IDs, weeks, and titles):
${input.topicCatalog}

CRITICAL PLANNING RULES:
${rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}
`
}
