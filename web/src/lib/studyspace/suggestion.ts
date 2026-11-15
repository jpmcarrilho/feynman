// Reading a stored profile suggestion and describing how it differs from the accepted tutor. Pure and client-safe.
import { ProfileSuggestionSchema, type ProfileSuggestion, type QuestionType, type QuestionTypeMix, type TutorProfile } from './profile'

/** Course.profileSuggestion parsed and validated; null when empty or invalid. */
export function parseSuggestion(raw: string | null | undefined): ProfileSuggestion | null {
  if (!raw) return null
  try {
    const r = ProfileSuggestionSchema.safeParse(JSON.parse(raw))
    return r.success ? r.data : null
  } catch {
    return null
  }
}

/** The stored suggestion when it is a tutor update, else null. */
export function parseUpdateSuggestion(raw: string | null | undefined): ProfileSuggestion | null {
  const s = parseSuggestion(raw)
  return s && s.kind === 'update' ? s : null
}

/** The profile fields a model-made update may change. Tone, tone notes, chat mode, calibration module and exam preset are the owner's. */
export const UPDATABLE_FIELDS = [
  'subject', 'level', 'tutorIdentity', 'analogyDomains', 'quantitative', 'questionTypeMix', 'quantitativeQuestionTypeMix', 'contentLanguage', 'sampleExplanation',
] as const
export type UpdatableField = (typeof UPDATABLE_FIELDS)[number]

export const FIELD_LABELS: Record<UpdatableField, string> = {
  subject: 'Subject',
  level: 'Level',
  tutorIdentity: 'Tutor identity',
  analogyDomains: 'Analogy domains',
  quantitative: 'Quantitative material',
  questionTypeMix: 'Question types (concepts)',
  quantitativeQuestionTypeMix: 'Question types (calculations)',
  contentLanguage: 'Content language',
  sampleExplanation: 'Sample explanation',
}

const LEVEL_LABELS: Record<TutorProfile['level'], string> = { intro: 'Introductory', undergraduate: 'Undergraduate', graduate: 'Graduate', professional: 'Professional' }
const TYPE_SHORT: Record<QuestionType, string> = { single_choice: 'single choice', multiple_choice: 'multiple choice', numeric: 'numeric', dropdown: 'dropdown', open: 'open answer' }
const TYPES: QuestionType[] = ['single_choice', 'multiple_choice', 'numeric', 'dropdown', 'open']

const percent = (n: number) => Math.round(n * 100)

/** "single choice 40%, multiple choice 30%, dropdown 30%" (types with 0% left out). */
export function describeMix(mix: QuestionTypeMix): string {
  const parts = TYPES.filter((t) => percent(mix[t]) > 0).map((t) => `${TYPE_SHORT[t]} ${percent(mix[t])}%`)
  return parts.length > 0 ? parts.join(', ') : 'none'
}

/** True when two mixes are equal to the percent. */
export function sameMix(a: QuestionTypeMix, b: QuestionTypeMix): boolean {
  return TYPES.every((t) => percent(a[t]) === percent(b[t]))
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()

/** True when two analogy lists hold the same domains (case, spacing and order aside). */
export function sameDomains(a: string[], b: string[]): boolean {
  const x = [...new Set(a.map(norm))].sort()
  const y = [...new Set(b.map(norm))].sort()
  return x.length === y.length && x.every((v, i) => v === y[i])
}

/** Whether one updatable field differs between two profiles. */
export function fieldChanged(field: UpdatableField, a: TutorProfile, b: TutorProfile): boolean {
  switch (field) {
    case 'analogyDomains': return !sameDomains(a.analogyDomains, b.analogyDomains)
    case 'questionTypeMix': return !sameMix(a.questionTypeMix, b.questionTypeMix)
    case 'quantitativeQuestionTypeMix': return !sameMix(a.quantitativeQuestionTypeMix, b.quantitativeQuestionTypeMix)
    case 'sampleExplanation': return norm(a.sampleExplanation.concept) !== norm(b.sampleExplanation.concept) || norm(a.sampleExplanation.explanation) !== norm(b.sampleExplanation.explanation)
    case 'subject':
    case 'tutorIdentity':
    case 'contentLanguage': return norm(a[field]) !== norm(b[field])
    default: return a[field] !== b[field]
  }
}

function show(field: UpdatableField, p: TutorProfile): string {
  switch (field) {
    case 'level': return LEVEL_LABELS[p.level]
    case 'analogyDomains': return p.analogyDomains.length > 0 ? p.analogyDomains.join(', ') : 'none'
    case 'quantitative': return p.quantitative ? 'yes' : 'no'
    case 'sampleExplanation': return 'updated'
    case 'questionTypeMix': return describeMix(p.questionTypeMix)
    case 'quantitativeQuestionTypeMix': return describeMix(p.quantitativeQuestionTypeMix)
    default: return String(p[field])
  }
}

/** `from` is null when only the new value is shown ("Sample explanation: updated"). */
export type ProfileChange = { field: UpdatableField; label: string; from: string | null; to: string }

/** The updatable fields that differ between the accepted profile and the suggested one, as text for the banner. */
export function profileChanges(from: TutorProfile, to: TutorProfile): ProfileChange[] {
  return UPDATABLE_FIELDS.filter((f) => fieldChanged(f, from, to)).map((f) => ({ field: f, label: FIELD_LABELS[f], from: f === 'sampleExplanation' ? null : show(f, from), to: show(f, to) }))
}
