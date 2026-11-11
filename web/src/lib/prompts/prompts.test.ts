import { describe, it, expect } from 'vitest'
import { LEGACY_PROFILES, LEGACY_VOICE_PROFILE } from '@/lib/studyspace/legacyProfiles'
import { defaultProfile, applyPreset, parseProfile, type TutorProfile } from '@/lib/studyspace/profile'
import {
  persona,
  explainMistakePrompt,
  enrichExercisePrompt,
  generateExercisePrompt,
  examDiagnosisPrompt,
  globalDiagnosisPrompt,
  plannerChatPrompt,
  studyPlanPrompt,
  moduleSummaryPrompt,
  voiceSystemInstruction,
  voiceExerciseContextMessage,
  voicePlannerContextMessage,
  chatModeDirective,
  chatModeSwitchMessage,
  effectiveChatMode,
  fileLinkInstructions,
  voiceFileLinkInstructions,
} from './index'

const legacy = LEGACY_PROFILES['14.750x']
const space: TutorProfile = {
  ...defaultProfile({ title: 'Organic chemistry' }),
  tutorIdentity: 'a patient organic chemistry tutor',
  contentLanguage: 'pt-BR',
  analogyDomains: ['cooking', 'Lego'],
}

const exerciseInput = {
  topic: { title: 'Aldol reactions', week: '01 · Carbonyls', isQuantitative: false },
  courseCode: 'orgchem',
  bucketContext: 'Unit/Topic: Aldol\nContent:\n...',
  styleExamples: 'Type: single_choice',
  alreadyAsked: '',
  targetType: 'single_choice',
}

describe('persona', () => {
  it('contains identity, level, tone, analogies and language', () => {
    const p = persona(space)
    expect(p).toContain('You are a patient organic chemistry tutor.')
    expect(p).toContain('undergraduate level')
    expect(p).toContain('Tone: Socratic professor')
    expect(p).toContain('Prefer analogies from: cooking, Lego.')
    expect(p).toContain('Respond in Brazilian Portuguese.')
  })
  it('omits the analogy sentence when there are no domains', () => {
    expect(persona({ ...space, analogyDomains: [] })).not.toContain('Prefer analogies')
  })
})

describe('generateExercisePrompt', () => {
  it('omits the whole calibration section when rigorExamples is empty', () => {
    const none = generateExercisePrompt(space, { ...exerciseInput, rigorExamples: '' })
    expect(none).not.toContain('RIGOR CALIBRATION')
    expect(none).not.toContain('No specific comprehensive review')
    const withRigor = generateExercisePrompt(space, { ...exerciseInput, rigorExamples: 'Q: hard one' })
    expect(withRigor).toContain('RIGOR CALIBRATION')
    expect(withRigor).toContain('Q: hard one')
  })

  it('keeps the economics guidance for legacy courses', () => {
    const p = generateExercisePrompt(legacy, { ...exerciseInput, courseCode: '14.750x', topic: { ...exerciseInput.topic, isQuantitative: true } })
    expect(p).toContain('Acemoglu et al. 2001')
    expect(p).toContain('COMPREHENSIVE REVIEW SYNTHESIS METHODOLOGY')
    expect(p).toContain('EMPIRICAL DATA TABLES')
    expect(p).toContain("Olken's corruption study")
    expect(p).toContain('\\( Y_{ic} = \\alpha')
    expect(generateExercisePrompt(LEGACY_PROFILES.JPAL102x, { ...exerciseInput, courseCode: 'JPAL102x' })).toContain('Acemoglu et al. 2001')
  })

  it('uses generic guidance for other spaces', () => {
    const p = generateExercisePrompt(space, exerciseInput)
    expect(p).not.toMatch(/Acemoglu|Olken|Balsakhi|econometric|MicroMasters|MIT/i)
    expect(p).toContain('QUESTION STYLE GUIDANCE')
    expect(p).toContain('course on Organic chemistry') // subject from defaultProfile title
    const q = generateExercisePrompt(space, { ...exerciseInput, topic: { ...exerciseInput.topic, isQuantitative: true } })
    expect(q).toContain('QUANTITATIVE QUESTION GUIDANCE')
    expect(q).toContain('LaTeX')
  })

  it('keeps the format rule for the target type', () => {
    expect(generateExercisePrompt(space, { ...exerciseInput, targetType: 'numeric' })).toContain('You MUST generate an exercise of type: "numeric"')
  })
})

describe('other builders', () => {
  it('start from the persona instead of a hard-coded MIT line', () => {
    const outputs = [
      explainMistakePrompt(space, { questionText: 'q', choices: ['a'], correctAnswer: 'a', userAnswer: 'b' }),
      enrichExercisePrompt(space, { contextText: 'c', exercise: { questionText: 'q', exerciseType: 'single_choice', correctAnswer: 'a' }, choices: ['a'] }),
      generateExercisePrompt(space, exerciseInput),
      examDiagnosisPrompt(space, { scoreSum: 1, totalCount: 2, scorePct: 50, sessionMode: 'exam', topicSummary: '-', wrongAnswers: '' }),
      globalDiagnosisPrompt(space, { courseCodes: ['orgchem'], topicLines: '-', weakTopicContent: '' }),
      plannerChatPrompt(space, { history: 'h', stats: '{}' }),
      studyPlanPrompt(space, { history: 'h', stats: '{}', topicCatalog: 'c' }),
      moduleSummaryPrompt(space, { courseCode: 'orgchem', courseTitle: 'Organic chemistry', module: '01', material: 'm' }),
    ]
    for (const out of outputs) {
      expect(out.startsWith(persona(space))).toBe(true)
      expect(out).not.toMatch(/MicroMasters|DEDP|MIT /)
    }
  })

  it('explainMistakePrompt falls back to Unknown for the topic', () => {
    expect(explainMistakePrompt(space, { questionText: 'q', choices: [], correctAnswer: 'a', userAnswer: 'b' })).toContain('Topic: Unknown')
  })

  it('studyPlanPrompt adds the final-days rule only when a calibration module is set', () => {
    const base = { history: 'h', stats: '{}', topicCatalog: 'c' }
    expect(studyPlanPrompt(space, base)).not.toContain('Mock Exams')
    expect(studyPlanPrompt(space, { ...base, calibrationModules: [] })).not.toContain('Mock Exams')
    const withModule = studyPlanPrompt(space, { ...base, calibrationModules: ['Week_13_Comprehensive_Review'] })
    expect(withModule).toContain('Mock Exams')
    expect(withModule).toContain('"Week_13_Comprehensive_Review"')
    expect(withModule).toContain('5. Compile a type-safe JSON')
    expect(studyPlanPrompt(space, base)).toContain('4. Compile a type-safe JSON')
  })

  it('global diagnosis keeps the legacy examples only for legacy courses', () => {
    const l = globalDiagnosisPrompt(legacy, { courseCodes: ['14.750x', 'JPAL102x'], topicLines: '-', weakTopicContent: '' })
    expect(l).toContain("Olken's media study")
    expect(l).toContain('all your courses (14.750x and JPAL102x)')
    expect(globalDiagnosisPrompt(space, { courseCodes: ['orgchem'], topicLines: '-', weakTopicContent: '' })).not.toContain('Olken')
  })

  it('module summary takes analogies from the profile', () => {
    const out = moduleSummaryPrompt(space, { courseCode: 'c', courseTitle: 't', module: 'm', material: '' })
    expect(out).toContain('(like cooking or Lego)')
    expect(out).toContain('No raw lesson materials available.')
  })
})

describe('voice prompts', () => {
  it('voiceSystemInstruction contains the five teaching rules and no examiner role', () => {
    const v = voiceSystemInstruction(LEGACY_VOICE_PROFILE)
    expect(v).toContain('You are a professor for MIT MicroMasters courses.')
    for (const rule of [
      '1. Dynamic Socratic Exploration',
      '2. HELP & STUCK MANDATE (CRITICAL)',
      '3. Proactive Encouraging Challenges',
      '4. Feynman Technique Analogy',
      '5. Loop Prevention',
    ]) {
      expect(v).toContain(rule)
    }
    expect(v).not.toContain('Socratic Examiner')
    expect(voiceSystemInstruction(space)).toContain('cooking, Lego, or visual sketches')
    expect(voiceSystemInstruction(space)).not.toMatch(/MIT|MicroMasters|bongo/)
  })

  const ctx = {
    topicTitle: 'Aldol',
    questionText: 'Which is it?',
    choices: ['A', 'B'],
    sessionMode: 'study',
    unitsText: '\n--- Unit: Aldol (File: /x.txt) ---\ntext\n',
    chatMode: 'probe' as const,
  }

  it('exercise context ends with the directive of the mode in effect', () => {
    for (const mode of ['probe', 'guide', 'explain'] as const) {
      const msg = voiceExerciseContextMessage(legacy, { ...ctx, chatMode: mode })
      expect(msg.endsWith(chatModeDirective(legacy, mode, 'study'))).toBe(true)
      expect(msg).toContain('Active Mode: Interactive Practice]')
      expect(msg).toContain('<private_knowledge>')
      expect(msg).toContain('--- Unit: Aldol')
    }
  })

  it('probe keeps the wording of the old hard-coded examiner paragraph', () => {
    const msg = voiceExerciseContextMessage(legacy, ctx)
    expect(msg).toContain(
      'Now, act as the Thesis Examiner. Initiate oral defense. Welcome them to the question, challenge them on what they are thinking, and probe their initial intuition BEFORE they select any draft answer. Do not read the choices out loud. Ask them to explain the concepts in their own words!',
    )
  })

  it('exam sessions always end with the exam directive, whatever the chat mode', () => {
    for (const mode of ['probe', 'guide', 'explain'] as const) {
      const msg = voiceExerciseContextMessage(legacy, { ...ctx, sessionMode: 'exam', chatMode: mode })
      expect(msg.endsWith(chatModeDirective(legacy, 'probe', 'exam'))).toBe(true)
      expect(msg).toContain('Active Mode: Timed Exam]')
      expect(msg).not.toContain('Thesis Examiner')
      expect(msg).not.toContain('/api/files/topic') // no link instructions in exams
    }
  })

  it('link instructions use topic ids only, with no copyable placeholder or example id', () => {
    const banned = [
      'TOPIC_ID', 'LOCAL_PATH', 'Slides File Title', 'Transcript Title', 'Source Lecture', 'ESTIMATED_PAGE', 'PAGE_NUMBER',
      'SHORT_QUOTE', '/Users/', 'OLS Basics', 'Leaders and Democratic Institutions', '/api/file?path=',
    ]
    for (const text of [fileLinkInstructions(), voiceFileLinkInstructions()]) {
      expect(text).toContain('/api/files/topic/')
      expect(text).toContain('Topic ID')
      for (const b of banned) expect(text, b).not.toContain(b)
      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i)
      expect(text).toContain('#page=N')
      expect(text).toContain('?highlight=')
    }
    const guide = voiceExerciseContextMessage(legacy, { ...ctx, chatMode: 'guide' })
    expect(guide).toContain('/api/files/topic/')
    expect(guide).not.toContain('localPath')
  })

  it('planner context drops the hard-coded study hours', () => {
    const msg = voicePlannerContextMessage()
    expect(msg).not.toMatch(/2 hours|MicroMasters/)
    expect(msg).toContain('"Study Plan" tab')
  })
})

describe('chatModeDirective', () => {
  it('has a distinct directive per mode', () => {
    const d = (['probe', 'guide', 'explain'] as const).map((m) => chatModeDirective(legacy, m, 'study'))
    expect(new Set(d).size).toBe(3)
    expect(d[0]).toContain('Thesis Examiner')
    expect(d[1]).toContain('step-by-step guide')
    expect(d[1]).toContain('ONE at a time')
    expect(d[2]).toContain('direct explainer')
    expect(d[2]).toContain('directly and completely')
    expect(d[2]).toContain('Do NOT end with a probing, quiz or check question')
    expect(d[2]).not.toContain('ONE short check question')
    expect(chatModeDirective(legacy, 'explain', 'study', { switching: true })).toContain('Do NOT end with a probing, quiz or check question')
    expect(d[1]).toContain('brief check question') // guide unchanged
    expect(d[0]).toContain('Ask them to explain the concepts in their own words')
  })

  it('exam always yields the exam directive: no hints, no answers', () => {
    const exam = chatModeDirective(legacy, 'probe', 'exam')
    for (const mode of ['probe', 'guide', 'explain'] as const) {
      expect(chatModeDirective(legacy, mode, 'exam')).toBe(exam)
      expect(chatModeDirective(legacy, mode, 'exam', { switching: true })).toBe(exam)
    }
    expect(exam).toContain('do NOT give hints')
    expect(exam).toContain('do NOT confirm or reveal the correct answer')
    expect(effectiveChatMode('explain', 'exam')).toBe('exam')
    expect(effectiveChatMode('explain', 'study')).toBe('explain')
  })

  it('switch message names the mode and carries the switching directive', () => {
    const msg = chatModeSwitchMessage(legacy, 'guide', 'study')
    expect(msg.startsWith('[SYSTEM MESSAGE: The student switched the tutor to guide mode. From now on')).toBe(true)
    expect(msg.endsWith(']')).toBe(true)
    expect(chatModeSwitchMessage(legacy, 'guide', 'exam')).toContain('timed exam')
  })
})

describe('defaultChatMode on profiles', () => {
  it('legacy and default profiles use probe; presets pick their own default', () => {
    expect(legacy.defaultChatMode).toBe('probe')
    expect(LEGACY_VOICE_PROFILE.defaultChatMode).toBe('probe')
    expect(defaultProfile({ title: 'x' }).defaultChatMode).toBe('probe')
    expect(applyPreset(space, 'patient_coach').defaultChatMode).toBe('guide')
    expect(applyPreset(space, 'exam_driller').defaultChatMode).toBe('probe')
  })

  it('stored profiles without the field still parse and get the default from the tone', () => {
    for (const [tone, expected] of [
      ['socratic_professor', 'probe'],
      ['patient_coach', 'guide'],
      ['exam_driller', 'probe'],
    ] as const) {
      const stored = { ...legacy, tone } as Record<string, unknown>
      delete stored.defaultChatMode
      expect(parseProfile(JSON.stringify(stored))?.defaultChatMode).toBe(expected)
    }
    const kept = parseProfile(JSON.stringify({ ...legacy, defaultChatMode: 'explain' }))
    expect(kept?.defaultChatMode).toBe('explain')
    expect(parseProfile(JSON.stringify({ ...legacy, defaultChatMode: 'bogus' }))).toBeNull()
  })
})

describe('enrichExercisePrompt rules', () => {
  it('forbids copying choices or solutions and inventing facts, and limits header removal', () => {
    const out = enrichExercisePrompt(space, { contextText: 'c', exercise: { questionText: 'q', exerciseType: 'single_choice', correctAnswer: 'a' }, choices: ['a'] })
    expect(out).toContain('Do NOT repeat or list the answer choices')
    expect(out).toContain('Never invent values, tables or facts')
    expect(out).toContain('Never rewrite only to remove it')
  })
})

describe('neutral exam items and explain mode in the voice instruction', () => {
  it('the exercise prompt forbids persona voice in the question and choices', () => {
    const prompt = generateExercisePrompt({ ...legacy, tone: 'patient_coach', contentLanguage: 'pt-BR', level: 'graduate' }, {
      topic: { title: 'T', week: 'W' }, bucketContext: 'ctx', styleExamples: '', alreadyAsked: '', targetType: 'single_choice',
    })
    expect(prompt).toContain('NEUTRAL EXAM ITEM')
    expect(prompt).toContain('No greetings, no role-play, no address to the student')
    expect(prompt).toContain('Portuguese')
    expect(prompt).toContain('graduate level')
    expect(prompt).toContain('The "explanation" may use the tone lightly')
  })
  it('the voice instruction says explain mode does not end with a question', () => {
    expect(voiceSystemInstruction(legacy)).toContain('do NOT end with a probing or quiz question')
  })
})
