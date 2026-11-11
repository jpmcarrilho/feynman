// Starter prompts of the Study Plan tab. Generic study-planning shapes filled with module names of the studyspace
// itself; nothing about any particular course is written here.

import { moduleLabel } from './topicLabel'

export interface PlannerSuggestion {
  id: string
  icon: string
  title: string
  focus: string
  prompt: string
}

/** Distinct module labels in the order the topics come (the caller passes them in course order). */
export function moduleLabelsOf(topics: ReadonlyArray<{ week?: string | null }>): string[] {
  const seen = new Set<string>()
  const labels: string[] = []
  for (const t of topics) {
    if (!t.week) continue
    const label = moduleLabel(t.week)
    if (label && !seen.has(label)) {
      seen.add(label)
      labels.push(label)
    }
  }
  return labels
}

/** Three starters naming real modules, or none when the studyspace has no modules. */
export function plannerSuggestions(modules: readonly string[]): PlannerSuggestion[] {
  if (modules.length === 0) return []
  const first = modules[0]
  const middle = modules[Math.floor(modules.length / 2)]
  const last = modules[modules.length - 1]
  const reviewSet = [...new Set([first, middle, last])]
  const reviewNames = reviewSet.length === 1 ? reviewSet[0] : `${reviewSet.slice(0, -1).join(', ')} and ${reviewSet[reviewSet.length - 1]}`
  return [
    {
      id: 'sprint',
      icon: '📅',
      title: '4-Day Peak Prep',
      focus: `Focus on ${first}`,
      prompt: `I have 6 hours a day. Build me a high-intensity 4-day sprint targeting my weak areas, starting with ${first}.`,
    },
    {
      id: 'exam-week',
      icon: '⏱️',
      title: '5-Day Intense Sprint',
      focus: `Focus on ${middle}`,
      prompt: `I want to study 4 hours a day, focusing on ${middle}. Let's do timed exams on Friday.`,
    },
    {
      id: 'review',
      icon: '📖',
      title: 'Conceptual Review',
      focus: `Cover ${reviewSet.length === 1 ? first : `${reviewSet.length} modules`}`,
      prompt: `Create a complete conceptual review study plan. Cover ${reviewNames}.`,
    },
  ]
}
