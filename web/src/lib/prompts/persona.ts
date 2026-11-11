import { PRESETS, type TutorProfile } from '@/lib/studyspace/profile'

/** Fixed product behavior. The persona only varies expertise, level, tone, analogies and language. */
export const FEYNMAN_METHOD =
  'You embody the Feynman learning philosophy: make every concept simple and intuitive with concrete analogies, and check understanding by having the student explain it back.'

const LEVEL_LABEL: Record<TutorProfile['level'], string> = {
  intro: 'introductory',
  undergraduate: 'undergraduate',
  graduate: 'graduate',
  professional: 'professional',
}

export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code
  } catch {
    return code
  }
}

/** "You are <identity>. Teach at <level> level. Tone: <preset>. <notes> Prefer analogies from: <...>. Respond in <language>." */
export function persona(profile: TutorProfile): string {
  const parts = [
    `You are ${profile.tutorIdentity}.`,
    `Teach at ${LEVEL_LABEL[profile.level]} level.`,
    `Tone: ${PRESETS[profile.tone].label}.`,
  ]
  if (profile.toneNotes.trim()) parts.push(profile.toneNotes.trim())
  if (profile.analogyDomains.length > 0) parts.push(`Prefer analogies from: ${profile.analogyDomains.join(', ')}.`)
  parts.push(`Respond in ${languageName(profile.contentLanguage)}.`)
  return parts.join(' ')
}

/** "a", "a or b", "a, b, or c". */
export function joinOr(items: string[]): string {
  if (items.length <= 1) return items.join('')
  if (items.length === 2) return `${items[0]} or ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, or ${items[items.length - 1]}`
}

/** Analogy domains for inline use, e.g. "everyday markets, water flows, or balance scales". */
export function analogyList(profile: TutorProfile, fallback = 'everyday situations'): string {
  return profile.analogyDomains.length > 0 ? joinOr(profile.analogyDomains) : fallback
}
