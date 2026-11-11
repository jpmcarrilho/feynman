import type { TutorProfile } from './profile'

// Hand-written from the prompt text that was hard-coded before studyspaces.
// Mixes are the proportions of today's type cycles:
//   quantitative: numeric, multiple_choice, single_choice, numeric, multiple_choice, dropdown
//   qualitative:  single_choice, dropdown, single_choice, multiple_choice, dropdown
// The exact cycles are kept in questionTypeCycles so legacy behavior is unchanged.
const LEGACY_CYCLES = {
  quantitative: ['numeric', 'multiple_choice', 'single_choice', 'numeric', 'multiple_choice', 'dropdown'],
  qualitative: ['single_choice', 'dropdown', 'single_choice', 'multiple_choice', 'dropdown'],
} as const

const LEGACY_QUALITATIVE_MIX = { single_choice: 0.4, multiple_choice: 0.2, numeric: 0, dropdown: 0.4 }
const LEGACY_QUANTITATIVE_MIX = { single_choice: 1 / 6, multiple_choice: 1 / 3, numeric: 1 / 3, dropdown: 1 / 6 }

function legacyBase(subject: string, tutorIdentity: string, calibrationModule: string, examLabel: string, questionCount: number): TutorProfile {
  return {
    version: 1,
    subject,
    level: 'graduate',
    tutorIdentity,
    tone: 'socratic_professor',
    toneNotes: 'Ask before telling; probe reasoning; rigorous.',
    analogyDomains: ['everyday markets', 'water flows', 'balance scales'],
    quantitative: true,
    questionTypeMix: LEGACY_QUALITATIVE_MIX,
    quantitativeQuestionTypeMix: LEGACY_QUANTITATIVE_MIX,
    contentLanguage: 'en',
    sampleExplanation: {
      concept: 'Why a result needs a comparison group',
      explanation:
        'Imagine two identical water tanks, one of which you tweak. Only by comparing the two levels afterwards can you say the tweak caused the difference. What do you think we would be measuring if we only looked at the tweaked tank?',
    },
    calibrationModule,
    examPreset: { label: examLabel, questionCount },
    questionTypeCycles: { quantitative: [...LEGACY_CYCLES.quantitative], qualitative: [...LEGACY_CYCLES.qualitative] },
  }
}

export const LEGACY_COURSE_TITLES: Record<string, string> = {
  '14.750x': '14.750x Political Economy and Economic Development',
  JPAL102x: 'JPAL102x Designing and Running Randomized Evaluations',
}

export const LEGACY_PROFILES: Record<string, TutorProfile> = {
  '14.750x': legacyBase(
    'Political economy and economic development',
    'an MIT economics professor teaching the 14.750x MicroMasters course',
    'Week_13_Comprehensive_Review',
    '14.750x Final',
    32,
  ),
  JPAL102x: legacyBase(
    'Designing and running randomized evaluations',
    'an MIT/J-PAL professor teaching JPAL102x',
    'Week_16_Comprehensive_Review',
    'JPAL102x Final',
    53,
  ),
}
