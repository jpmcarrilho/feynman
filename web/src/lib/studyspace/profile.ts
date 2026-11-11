import { z } from 'zod'

export const TypeEnum = z.enum(['single_choice', 'multiple_choice', 'numeric', 'dropdown'])
export type QuestionType = z.infer<typeof TypeEnum>

// How the tutor answers in the chat/voice panel (section 5.7). The student can switch it at any time.
export const ChatModeEnum = z.enum(['probe', 'guide', 'explain'])
export type TutorChatMode = z.infer<typeof ChatModeEnum>

export const QuestionTypeMixSchema = z.object({
  single_choice: z.number().min(0).max(1),
  multiple_choice: z.number().min(0).max(1),
  numeric: z.number().min(0).max(1),
  dropdown: z.number().min(0).max(1),
})

export const TutorProfileSchema = z.object({
  version: z.literal(1),
  subject: z.string().min(1).max(120), // "Development economics: political economy"
  level: z.enum(['intro', 'undergraduate', 'graduate', 'professional']),
  tutorIdentity: z.string().min(1).max(200), // one line: "an economics professor who teaches political economy"
  tone: z.enum(['socratic_professor', 'patient_coach', 'exam_driller']),
  toneNotes: z.string().max(300).default(''),
  // Chat mode used until the student picks another one. Stored profiles written before this field existed
  // do not have it; parseProfile fills it from the tone preset.
  defaultChatMode: ChatModeEnum,
  analogyDomains: z.array(z.string().max(40)).max(5),
  quantitative: z.boolean(),
  questionTypeMix: QuestionTypeMixSchema, // used for non-quantitative topics
  quantitativeQuestionTypeMix: QuestionTypeMixSchema, // used for isQuantitative topics
  contentLanguage: z.string().min(2).max(10), // BCP-47, e.g. "en", "pt-BR"
  sampleExplanation: z.object({ concept: z.string(), explanation: z.string().max(1200) }),
  calibrationModule: z.string().nullable(), // Topic.week value used for rigor examples; null = none
  examPreset: z.object({ label: z.string(), questionCount: z.number().int().min(1).max(200) }).nullable(),
  // Legacy override: when set, replaces the mix-derived cycle (see pickQuestionType).
  questionTypeCycles: z.object({ quantitative: z.array(TypeEnum), qualitative: z.array(TypeEnum) }).nullable(),
})
export type TutorProfile = z.infer<typeof TutorProfileSchema>

// What the LLM returns for a proposal (code adds the rest)
export const ProfileProposalSchema = z.object({
  profile: TutorProfileSchema.omit({ version: true, calibrationModule: true, examPreset: true, questionTypeCycles: true }),
  subjectsCoherent: z.boolean(),
  subjectGroups: z.array(z.object({ label: z.string(), sourceIds: z.array(z.string()) })), // only meaningful when !subjectsCoherent
})

// The same shape for the model call, without `.default(...)` (structured output schemas stay free of defaults, plan 5.2).
export const ProfileProposalModelSchema = z.object({
  profile: ProfileProposalSchema.shape.profile.extend({ toneNotes: z.string().max(300) }),
  subjectsCoherent: z.boolean(),
  subjectGroups: z.array(z.object({ label: z.string(), sourceIds: z.array(z.string()) })),
})

// What the model returns when it is asked whether a new file calls for a change of the accepted tutor (T26). It always returns the
// full set of fields it may change (unchanged ones copied), so the schema has no optional or nullable fields; code works out what
// differs. Tone, tone notes, chat mode, calibration module and exam preset are the owner's choices and are not in it.
export const ProfileUpdateModelSchema = z.object({
  changeWarranted: z.boolean(),
  rationale: z.string(),
  subject: z.string(),
  level: TutorProfileSchema.shape.level,
  tutorIdentity: z.string(),
  analogyDomains: z.array(z.string()),
  quantitative: z.boolean(),
  questionTypeMix: QuestionTypeMixSchema,
  quantitativeQuestionTypeMix: QuestionTypeMixSchema,
  contentLanguage: z.string(),
  sampleConcept: z.string(),
  sampleExplanation: z.string(),
})

export const ProfileSuggestionSchema = z.object({
  kind: z.enum(['initial', 'update']),
  createdAt: z.string(),
  // Ids of the ready files an initial proposal was made from; a different set later means the proposal is stale.
  basedOnSourceIds: z.array(z.string()).default([]),
  profile: TutorProfileSchema,
  rationale: z.string().max(600),
  excludedSources: z.array(z.object({ id: z.string(), name: z.string(), reason: z.string() })),
  split: z.object({ groups: z.array(z.object({ label: z.string(), sourceIds: z.array(z.string()) })) }).nullable(),
})
export type ProfileSuggestion = z.infer<typeof ProfileSuggestionSchema>

export const PRESETS: Record<TutorProfile['tone'], { label: string; toneNotes: string; defaultChatMode: TutorChatMode }> = {
  socratic_professor: { label: 'Socratic professor', toneNotes: 'Ask before telling; probe reasoning; rigorous.', defaultChatMode: 'probe' },
  patient_coach: { label: 'Patient coach', toneNotes: 'Short steps, frequent encouragement, more hints before questions.', defaultChatMode: 'guide' },
  exam_driller: { label: 'Exam driller', toneNotes: 'Exam-style questions, time awareness, concise corrections.', defaultChatMode: 'probe' },
}

export function parseProfile(json: string | null | undefined): TutorProfile | null {
  if (!json) return null
  try {
    const raw: unknown = JSON.parse(json)
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const obj = raw as Record<string, unknown>
      // Profiles stored before defaultChatMode existed: derive it from the tone preset.
      if (obj.defaultChatMode === undefined && typeof obj.tone === 'string' && obj.tone in PRESETS) {
        obj.defaultChatMode = PRESETS[obj.tone as TutorProfile['tone']].defaultChatMode
      }
    }
    const result = TutorProfileSchema.safeParse(raw)
    return result.success ? result.data : null
  } catch {
    return null
  }
}

const MIX_KEYS: QuestionType[] = ['single_choice', 'multiple_choice', 'numeric', 'dropdown']
export type QuestionTypeMix = z.infer<typeof QuestionTypeMixSchema>

/**
 * Scales a question-type mix to sum to 1. Negative and non-finite weights count as 0; `noNumeric` zeroes the numeric weight
 * first. When nothing is left, `fallback` (normalized the same way) is returned. Pure.
 */
export function normalizeMix(mix: Partial<Record<QuestionType, number>>, opts: { noNumeric?: boolean; fallback?: QuestionTypeMix } = {}): QuestionTypeMix {
  const weight = (t: QuestionType) => {
    const v = mix[t]
    return typeof v === 'number' && Number.isFinite(v) && v > 0 && !(opts.noNumeric && t === 'numeric') ? v : 0
  }
  const total = MIX_KEYS.reduce((a, t) => a + weight(t), 0)
  if (total <= 0) {
    if (opts.fallback) return normalizeMix(opts.fallback, { noNumeric: opts.noNumeric })
    return opts.noNumeric ? { single_choice: 0.5, multiple_choice: 0.25, numeric: 0, dropdown: 0.25 } : { single_choice: 0.25, multiple_choice: 0.25, numeric: 0.25, dropdown: 0.25 }
  }
  const out = { single_choice: 0, multiple_choice: 0, numeric: 0, dropdown: 0 }
  for (const t of MIX_KEYS) out[t] = weight(t) / total
  return out
}

export function defaultProfile(course: { title: string; goal?: string | null }): TutorProfile {
  const subject = course.title.trim().slice(0, 120) || 'General study'
  return {
    version: 1,
    subject,
    level: 'undergraduate',
    tutorIdentity: `a patient and rigorous tutor for ${subject}`.slice(0, 200),
    tone: 'socratic_professor',
    toneNotes: PRESETS.socratic_professor.toneNotes,
    defaultChatMode: PRESETS.socratic_professor.defaultChatMode,
    analogyDomains: [],
    quantitative: false,
    questionTypeMix: { single_choice: 0.4, multiple_choice: 0.3, numeric: 0, dropdown: 0.3 },
    quantitativeQuestionTypeMix: { single_choice: 0.2, multiple_choice: 0.2, numeric: 0.5, dropdown: 0.1 },
    contentLanguage: 'en',
    sampleExplanation: {
      concept: subject,
      explanation: 'Let us start from what you already know about this topic, then build the idea one step at a time.',
    },
    calibrationModule: null,
    examPreset: null,
    questionTypeCycles: null,
  }
}

export function applyPreset(p: TutorProfile, tone: TutorProfile['tone']): TutorProfile {
  return { ...p, tone, toneNotes: PRESETS[tone].toneNotes, defaultChatMode: PRESETS[tone].defaultChatMode }
}

const TYPE_ORDER: QuestionType[] = ['single_choice', 'numeric', 'multiple_choice', 'dropdown']
const CYCLE_SLOTS = 10

/** 10 slots by largest-remainder rounding, interleaved round-robin in TYPE_ORDER. */
export function buildCycleFromMix(mix: z.infer<typeof QuestionTypeMixSchema>): QuestionType[] {
  const weights = TYPE_ORDER.map((t) => Math.max(0, mix[t]))
  const total = weights.reduce((a, b) => a + b, 0)
  if (total <= 0) return ['single_choice']
  const exact = weights.map((w) => (w / total) * CYCLE_SLOTS)
  const slots = exact.map((x) => Math.floor(x))
  let left = CYCLE_SLOTS - slots.reduce((a, b) => a + b, 0)
  const byRemainder = exact
    .map((x, i) => ({ i, rem: x - Math.floor(x) }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i)
  for (const { i } of byRemainder) {
    if (left <= 0) break
    slots[i]++
    left--
  }
  const cycle: QuestionType[] = []
  while (slots.some((s) => s > 0)) {
    TYPE_ORDER.forEach((t, i) => {
      if (slots[i] > 0) {
        cycle.push(t)
        slots[i]--
      }
    })
  }
  return cycle
}

export function pickQuestionType(p: TutorProfile, isQuantitative: boolean, existingCount: number): QuestionType {
  const override = p.questionTypeCycles ? (isQuantitative ? p.questionTypeCycles.quantitative : p.questionTypeCycles.qualitative) : []
  const cycle = override.length > 0 ? override : buildCycleFromMix(isQuantitative ? p.quantitativeQuestionTypeMix : p.questionTypeMix)
  return cycle[Math.max(0, existingCount) % cycle.length]
}
