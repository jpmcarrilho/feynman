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
  voiceAnswerCheckedMessage,
  voiceAnswerKeyMessage,
  chatModeSwitchMessages,
  voicePlannerContextMessage,
  CHAT_MODE_RULES,
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
  it('voiceSystemInstruction has one fixed order of sections and no examiner role', () => {
    const v = voiceSystemInstruction(LEGACY_VOICE_PROFILE)
    expect(v).toContain('You are a professor for MIT MicroMasters courses.')
    const order = ['SCOPE', 'WHAT YOU RECEIVE', 'CHAT MODES', 'ANSWER RULES', 'STYLE'].map((h) => v.indexOf(`\n${h}\n`))
    expect(order.every((i) => i > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(v).not.toContain('Socratic Examiner')
    expect(voiceSystemInstruction(space)).toContain('cooking, Lego, or visual sketches')
    expect(voiceSystemInstruction(space)).not.toMatch(/MIT|MicroMasters|bongo/)
  })

  it('persona fields are inserted in the instruction', () => {
    const v = voiceSystemInstruction({ ...space, toneNotes: 'Be dry and brief.', level: 'professional' })
    expect(v).toContain('You are a patient organic chemistry tutor.')
    expect(v).toContain('Teach at professional level.')
    expect(v).toContain('Be dry and brief.')
    expect(v).toContain('Respond in Brazilian Portuguese')
    expect(v).toContain('Prefer analogies from: cooking, Lego.')
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
      expect(msg.endsWith(`${chatModeDirective(legacy, mode, 'study')}]`)).toBe(true)
      expect(msg).toContain('Active Mode: Interactive Practice\n')
      expect(msg).toContain('<private_knowledge>')
      expect(msg).toContain('--- Unit: Aldol')
    }
  })

  it('the mode rules appear once, in the instruction, and the directives refer to them', () => {
    const v = voiceSystemInstruction(legacy)
    expect(v.split(CHAT_MODE_RULES).length - 1).toBe(1)
    for (const mode of ['probe', 'guide', 'explain'] as const) {
      for (const opts of [{}, { opening: true }, { switching: true }]) {
        const d = chatModeDirective(legacy, mode, 'study', opts)
        expect(d).toContain(`${mode[0].toUpperCase()}${mode.slice(1)} rules from your instructions`)
        expect(d.length).toBeLessThan(560)
        for (const rule of CHAT_MODE_RULES.split('\n')) expect(d).not.toContain(rule.slice(0, 40))
      }
    }
    expect(voiceExerciseContextMessage(legacy, ctx).split('Probe rules').length - 1).toBe(1)
  })

  it('exam sessions always end with the exam directive, whatever the chat mode', () => {
    for (const mode of ['probe', 'guide', 'explain'] as const) {
      const msg = voiceExerciseContextMessage(legacy, { ...ctx, sessionMode: 'exam', chatMode: mode })
      expect(msg.endsWith(`${chatModeDirective(legacy, 'probe', 'exam')}]`)).toBe(true)
      expect(msg).toContain('Active Mode: Timed Exam\n')
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
  it('has a distinct directive per mode and per moment', () => {
    const modes = ['probe', 'guide', 'explain'] as const
    const all = modes.flatMap((m) => [{}, { opening: true }, { switching: true }].map((o) => chatModeDirective(legacy, m, 'study', o)))
    expect(new Set(all).size).toBe(9)
    expect(chatModeDirective(legacy, 'explain', 'study')).toContain('ending with an offer to explain it')
    expect(chatModeDirective(legacy, 'probe', 'study')).not.toContain('offer to explain')
    expect(chatModeDirective(legacy, 'guide', 'study', { switching: true })).toContain('wait for the student')
  })

  it('only the opening directive welcomes the student; later and switch directives forbid a greeting', () => {
    for (const mode of ['probe', 'guide', 'explain'] as const) {
      expect(chatModeDirective(legacy, mode, 'study', { opening: true })).toContain('brief welcome')
      expect(chatModeDirective(legacy, mode, 'study')).toContain('Do not greet')
      expect(chatModeDirective(legacy, mode, 'study')).not.toContain('brief welcome')
      expect(chatModeDirective(legacy, mode, 'study', { switching: true })).toContain('Do not reply to this message')
      expect(chatModeDirective(legacy, mode, 'study', { switching: true })).not.toContain('brief welcome')
    }
  })

  it('mode rules: each mode says what it does and Explain names the concept first and never ends on a question', () => {
    const rules = Object.fromEntries(CHAT_MODE_RULES.split('\n').map((l) => [l.slice(2, l.indexOf(':')), l]))
    expect(Object.keys(rules)).toEqual(['Probe', 'Guide', 'Explain', 'Exam'])
    expect(rules.Probe).toContain('ask before telling')
    expect(rules.Probe).toContain('hint only after they have made an attempt')
    expect(rules.Guide).toContain('one at a time')
    expect(rules.Guide).toContain('brief check question')
    expect(rules.Explain).toContain('Name the concept, state the relevant fact or result plainly, then explain why')
    expect(rules.Explain).toContain('never instead of it')
    expect(rules.Explain).toContain('Do not end with a probing or quiz question')
    expect(rules.Explain).toContain('at most offer')
    expect(rules.Explain).not.toMatch(/ask before telling|check question|probe their/i)
    expect(rules.Probe).not.toMatch(/directly and completely/)
    expect(rules.Guide).not.toMatch(/ask before telling|directly and completely/)
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
    expect(voiceSystemInstruction(legacy)).toContain('Do not end with a probing or quiz question')
  })
})

describe('tutor behavior rules in the voice instruction', () => {
  const instruction = voiceSystemInstruction(legacy)
  const section = (name: string, next: string) => instruction.slice(instruction.indexOf(`\n${name}\n`), instruction.indexOf(`\n${next}\n`))

  it('is a study tutor: no legal, medical or financial disclaimers unless personal advice is asked', () => {
    const scope = section('SCOPE', 'WHAT YOU RECEIVE')
    expect(scope).toContain('Never add legal, medical or financial disclaimers')
    expect(scope).toContain('Only if the student asks for personal advice')
  })

  it('states the answer-reveal rules per mode, before and after the check', () => {
    const rules = section('ANSWER RULES', 'STYLE')
    expect(rules).toContain('Probe never states the correct answer or says which choice is right')
    expect(rules).toContain('Guide gives hints and intermediate steps but never the final answer')
    expect(rules).toContain('Explain may state the answer when the student asks for it directly')
    expect(rules).toContain('Every mode may discuss the correct answer openly')
    expect(rules).toContain('Then Probe and Guide help them see why')
    expect(rules).toContain('Exam: never')
    expect(rules).toContain('Never praise, confirm or evaluate an answer the student has not given')
  })

  it('no longer carries the old rules that forced the answer out in every mode', () => {
    expect(instruction).not.toMatch(/HELP & STUCK MANDATE|MUST IMMEDIATELY|Loop Prevention|validate them and explain/)
    expect(instruction).not.toContain('rules 2, 3 and 5')
  })

  it('grounds the tutor in the exercise and material and admits what the material does not cover', () => {
    const received = section('WHAT YOU RECEIVE', 'CHAT MODES')
    expect(received).toContain('Rely on the exercise and that material')
    expect(received).toContain('the material does not cover, say so in one short sentence')
    expect(received).toContain('general knowledge at your teaching level')
    expect(received).toContain('never refer to "the lecture"')
    expect(received).toContain('Never assume what the student selected unless a message says so')
  })

  it('style: language, length, no headings, one greeting at most, no choices read aloud', () => {
    const style = instruction.slice(instruction.indexOf('\nSTYLE\n'))
    expect(style).toContain('unless the student writes in another language')
    expect(style).toContain('short paragraph or a few short steps')
    expect(style).toContain('no markdown headings')
    expect(style).toContain('Spoken replies: shorter still')
    expect(style).toContain('Greet at most once')
    expect(style).toContain('every typed question goes straight to the substance')
    expect(style).toContain('Do not read the choices out loud, and do not name the chat mode when you speak')
    expect(style).toContain('An analogy is optional, comes after the plain statement')
  })

  it('a mode rule overrides persona wording that says to ask before telling', () => {
    const p = { ...legacy, toneNotes: 'Ask before telling; probe reasoning; rigorous.' }
    expect(voiceSystemInstruction(p)).toContain('A mode rule overrides any wording in your persona about asking before telling')
  })

  it('the instruction has no contradictions with Explain mode and stays short', () => {
    expect(instruction).not.toContain('check understanding by having the student explain it back')
    expect(instruction.length).toBeLessThan(6500)
  })

  it('imported (legacy) profiles go through the same builder with the same rules', () => {
    for (const p of Object.values(LEGACY_PROFILES)) {
      const v = voiceSystemInstruction(p)
      expect(v).toContain(CHAT_MODE_RULES)
      expect(v).toContain('ANSWER RULES')
    }
  })
})

describe('exercise context: answer state', () => {
  const base = {
    topicTitle: 'Aldol',
    questionText: 'Which product forms?',
    choices: ['A', 'B'],
    sessionMode: 'study',
    unitsText: '\n--- Unit: Aldol (Topic ID: t1) ---\ntext\n',
    chatMode: 'explain' as const,
  }
  const checked = { checked: true as const, chosen: 'B', score: 0, correctAnswer: 'A', explanation: 'Because the enolate attacks first.' }

  it('says "not checked yet" by default and tells the tutor not to assume a selection', () => {
    const msg = voiceExerciseContextMessage(legacy, base)
    expect(msg).toContain('Answer status: not checked yet.')
    expect(msg).toContain('do not assume what they selected')
    expect(msg).not.toContain('Correct answer:')
    expect(voiceExerciseContextMessage(legacy, { ...base, answer: { checked: false } })).toContain('not checked yet')
  })

  it('carries the answer, result, correct answer and explanation once checked', () => {
    const msg = voiceExerciseContextMessage(legacy, { ...base, answer: checked })
    expect(msg).toContain('Answer status: CHECKED.')
    expect(msg).toContain("Student's answer: B")
    expect(msg).toContain('Result: incorrect')
    expect(msg).toContain('Correct answer: A')
    expect(msg).toContain('Explanation: Because the enolate attacks first.')
    expect(msg).not.toContain('not checked yet')
    expect(voiceExerciseContextMessage(legacy, { ...base, answer: { ...checked, score: 1 } })).toContain('Result: correct')
    expect(voiceExerciseContextMessage(legacy, { ...base, answer: { ...checked, score: 0.5 } })).toContain('Result: partly correct (score 50%)')
    expect(voiceExerciseContextMessage(legacy, { ...base, answer: { ...checked, explanation: null } })).not.toContain('Explanation:')
  })

  it('caps a very long explanation', () => {
    const msg = voiceExerciseContextMessage(legacy, { ...base, answer: { ...checked, explanation: 'x'.repeat(5000) } })
    expect(msg.length).toBeLessThan(base.unitsText.length + 3200)
  })

  it('an exam never carries an answer or its state', () => {
    const msg = voiceExerciseContextMessage(legacy, { ...base, sessionMode: 'exam', answer: checked })
    expect(msg).not.toContain('Answer status')
    expect(msg).not.toContain('Correct answer')
    expect(msg).not.toContain('enolate')
  })

  it('only an opening context asks for a welcome', () => {
    expect(voiceExerciseContextMessage(legacy, { ...base, opening: true })).toContain('brief welcome')
    expect(voiceExerciseContextMessage(legacy, base)).not.toContain('brief welcome')
    expect(voiceExerciseContextMessage(legacy, base)).toContain('Do not greet')
  })

  it('every mode ends with its directive and uses one link-instruction block', () => {
    for (const mode of ['probe', 'guide', 'explain'] as const) {
      const msg = voiceExerciseContextMessage(legacy, { ...base, chatMode: mode, opening: true })
      expect(msg.endsWith(`${chatModeDirective(legacy, mode, 'study', { opening: true })}]`)).toBe(true)
      expect(msg.split('/api/files/topic/ followed by').length - 1).toBe(1)
    }
  })

  it('the answer-checked message carries the same facts and does not ask for a reply', () => {
    const msg = voiceAnswerCheckedMessage(checked)
    expect(msg).toContain('Answer status: CHECKED.')
    expect(msg).toContain("Student's answer: B")
    expect(msg).toContain('Correct answer: A')
    expect(msg).toContain('Do not reply to this message by itself')
  })
})

describe('private answer key (Explain mode, before the check)', () => {
  const base = {
    topicTitle: 'Aldol',
    questionText: 'Which product forms?',
    choices: ['A', 'B'],
    sessionMode: 'study',
    unitsText: '\n--- Unit: Aldol (Topic ID: t1) ---\ntext\n',
    chatMode: 'explain' as const,
  }
  const key = { correctAnswer: 'The beta-hydroxy aldehyde', explanation: 'The enolate adds to the carbonyl.' }
  const unchecked = { checked: false as const, key }
  const checked = { checked: true as const, chosen: 'B', score: 0, correctAnswer: key.correctAnswer, explanation: key.explanation }

  it('start in Explain, not checked: the key is present, marked as private reference', () => {
    const msg = voiceExerciseContextMessage(legacy, { ...base, answer: unchecked })
    expect(msg).toContain('Private reference, for accuracy only; state it only as the Explain rules allow')
    expect(msg).toContain('Correct answer: The beta-hydroxy aldehyde')
    expect(msg).toContain('Explanation: The enolate adds to the carbonyl.')
    expect(msg).toContain('Answer status: not checked yet.')
    expect(msg).not.toContain('CHECKED')
  })

  it('start in Probe or Guide, not checked: the key is absent', () => {
    for (const chatMode of ['probe', 'guide'] as const) {
      const msg = voiceExerciseContextMessage(legacy, { ...base, chatMode, answer: unchecked })
      expect(msg).not.toContain('beta-hydroxy')
      expect(msg).not.toContain('enolate adds')
      expect(msg).not.toContain('Private reference')
    }
  })

  it('exam: the key is absent in every mode', () => {
    for (const chatMode of ['probe', 'guide', 'explain'] as const) {
      const msg = voiceExerciseContextMessage(legacy, { ...base, chatMode, sessionMode: 'exam', answer: unchecked })
      expect(msg).not.toContain('beta-hydroxy')
      expect(msg).not.toContain('Private reference')
      expect(chatModeSwitchMessages(legacy, chatMode, 'probe', 'exam', unchecked).join('\n')).not.toContain('beta-hydroxy')
    }
  })

  it('checked: the answer and the key are present in every mode', () => {
    for (const chatMode of ['probe', 'guide', 'explain'] as const) {
      const msg = voiceExerciseContextMessage(legacy, { ...base, chatMode, answer: checked })
      expect(msg).toContain('Answer status: CHECKED.')
      expect(msg).toContain('Correct answer: The beta-hydroxy aldehyde')
      expect(msg).not.toContain('Private reference')
    }
  })

  it('switch to Explain before the check: a key message (no reply) comes first, then the switch', () => {
    const msgs = chatModeSwitchMessages(legacy, 'explain', 'probe', 'study', unchecked)
    expect(msgs).toHaveLength(2)
    expect(msgs[0]).toBe(voiceAnswerKeyMessage(key))
    expect(msgs[0]).toContain('Private reference')
    expect(msgs[0]).toContain('Correct answer: The beta-hydroxy aldehyde')
    expect(msgs[0]).toContain('Do not reply to this message by itself')
    expect(msgs[1]).toBe(chatModeSwitchMessage(legacy, 'explain', 'study'))
    expect(msgs[1]).not.toContain('beta-hydroxy')
  })

  it('switch to Explain after the check, to Probe or Guide, or without a key: only the switch message', () => {
    expect(chatModeSwitchMessages(legacy, 'explain', 'probe', 'study', checked)).toHaveLength(1)
    expect(chatModeSwitchMessages(legacy, 'explain', 'probe', 'study')).toHaveLength(1)
    expect(chatModeSwitchMessages(legacy, 'guide', 'probe', 'study', unchecked)).toHaveLength(1)
    expect(chatModeSwitchMessages(legacy, 'probe', 'guide', 'study', unchecked)[0]).not.toContain('beta-hydroxy')
  })

  it('switch away from Explain before the check: reminds the tutor the answer rules apply again', () => {
    for (const mode of ['probe', 'guide'] as const) {
      const msgs = chatModeSwitchMessages(legacy, mode, 'explain', 'study', unchecked)
      expect(msgs).toHaveLength(1)
      expect(msgs[0]).toContain('answer rules apply again')
      expect(msgs[0]).toContain('do not state or confirm the answer until the student has checked it')
      expect(msgs[0]).not.toContain('beta-hydroxy')
      // no reminder after the check, or when the previous mode was not Explain
      expect(chatModeSwitchMessages(legacy, mode, 'explain', 'study', checked)[0]).not.toContain('apply again')
      expect(chatModeSwitchMessages(legacy, mode, mode === 'probe' ? 'guide' : 'probe', 'study', unchecked)[0]).not.toContain('apply again')
    }
  })

  it('the answer rules require agreement with the key and plain disagreement when it looks wrong', () => {
    const v = voiceSystemInstruction(legacy)
    expect(v).toContain('agree with the stored key in the context')
    expect(v).toContain('say so plainly instead of silently teaching something else')
    expect(v).toContain('In Explain mode you also get the stored correct answer and explanation as a private key before the check')
  })
})

describe('hints that settle a recall question, and filler evaluation', () => {
  const v = voiceSystemInstruction(legacy)
  const rules = v.slice(v.indexOf('\nANSWER RULES\n'), v.indexOf('\nSTYLE\n'))
  const style = v.slice(v.indexOf('\nSTYLE\n'))

  it('Probe and Guide never state the deciding fact before the check', () => {
    expect(rules).toContain('Probe and Guide never state the fact, finding, value or definition that by itself decides the question')
    expect(rules).toContain('stating it IS the answer')
    expect(rules).toContain('stops one step short')
    expect(rules).toContain('comes down to recalling a specific result')
    expect(rules).toContain('point to where it sits in the material if the context gives a source')
    expect(rules).toContain('check their answer or switch to Explain for the direct answer')
  })

  it('the Probe stuck sentence is reconciled with it', () => {
    expect(CHAT_MODE_RULES).toContain('the underlying concept (never the fact that decides the question; see the answer rules)')
    expect(rules.indexOf('Before the check, Probe and Guide')).toBeGreaterThan(rules.indexOf('Before the answer is checked'))
  })

  it('no filler evaluation openers', () => {
    expect(style).toContain('Do not open with an evaluation or affirmation')
    for (const w of ['"Right"', '"Exactly"', '"Great"', '"That\'s reasonable"', '"Good thinking"']) expect(style).toContain(w)
    expect(style).toContain('unless the student just said something that is actually correct')
    expect(style).toContain('say neutrally what it leaves out')
    expect(style).toContain('without ruling on their final choice (Probe) and without giving the answer (Probe and Guide)')
    expect(style).toContain('"Sure", "Okay"')
  })

  it('the instruction stays compact', () => {
    expect(v.length).toBeLessThan(6500)
  })
})

describe('hidden messages are system messages, never chat', () => {
  const key = { correctAnswer: 'K', explanation: 'E' }
  const checked = { checked: true as const, chosen: 'B', score: 0, correctAnswer: 'A', explanation: 'x' }
  const base = { topicTitle: 'T', questionText: 'Q?', choices: ['A', 'B'], sessionMode: 'study', unitsText: '\n--- Unit: U (Topic ID: t1) ---\ntext\n' }
  const wrapped = (m: string) => m.startsWith('[SYSTEM MESSAGE: ') && m.endsWith(']') && m.split('[SYSTEM MESSAGE:').length === 2

  it('every message the client builds for the tutor is exactly one [SYSTEM MESSAGE: ... ] block', () => {
    const all = [
      ...(['probe', 'guide', 'explain'] as const).flatMap((chatMode) => [
        voiceExerciseContextMessage(legacy, { ...base, chatMode }),
        voiceExerciseContextMessage(legacy, { ...base, chatMode, opening: true, answer: { checked: false, key } }),
        voiceExerciseContextMessage(legacy, { ...base, chatMode, answer: checked }),
        voiceExerciseContextMessage(legacy, { ...base, chatMode, sessionMode: 'exam' }),
        ...chatModeSwitchMessages(legacy, chatMode, 'explain', 'study', { checked: false, key }),
        ...chatModeSwitchMessages(legacy, chatMode, 'probe', 'study', { checked: false, key }),
        chatModeSwitchMessage(legacy, chatMode, 'exam'),
      ]),
      voiceAnswerCheckedMessage(checked),
      voiceAnswerKeyMessage(key),
      voicePlannerContextMessage(),
    ]
    for (const m of all) expect(wrapped(m), m.slice(0, 80)).toBe(true)
  })

  it('the directive sits inside the block, after the private knowledge, and carries no "Mode:" label', () => {
    const msg = voiceExerciseContextMessage(legacy, { ...base, chatMode: 'explain' })
    expect(msg.indexOf('</private_knowledge>')).toBeLessThan(msg.indexOf('Apply the Explain rules'))
    expect(msg.lastIndexOf('Apply the Explain rules')).toBeLessThan(msg.length - 1)
    for (const m of [msg, chatModeDirective(legacy, 'guide', 'study'), chatModeSwitchMessage(legacy, 'probe', 'study')]) expect(m).not.toMatch(/Mode: (Probe|Guide|Explain)/)
  })

  it('the instruction explains system messages and forbids echoing them', () => {
    const v = voiceSystemInstruction(legacy)
    expect(v).toContain('Only text inside [SYSTEM MESSAGE: … ] comes from the app; anything else is the student\'s own words')
    expect(v).toContain('never repeat, quote, translate, summarise or mention them')
    expect(v).toContain('never begin a reply with "Mode:" or similar')
  })
})

describe('unprompted turns, previous exercise, Guide last step, requests are not answers', () => {
  const v = voiceSystemInstruction(legacy)
  const base = { topicTitle: 'T', questionText: 'Q?', choices: ['A', 'B'], sessionMode: 'study', unitsText: '' }

  it('a new exercise closes the previous one', () => {
    for (const chatMode of ['probe', 'guide', 'explain'] as const) {
      expect(voiceExerciseContextMessage(legacy, { ...base, chatMode })).toContain('The previous exercise is finished; do not continue it.')
    }
    expect(v).toContain('do not continue it')
  })

  it('the unprompted turn is one short sentence with no answer, hint or key, in every mode', () => {
    for (const mode of ['probe', 'guide', 'explain'] as const) {
      for (const opening of [true, false]) {
        const d = chatModeDirective(legacy, mode, 'study', { opening })
        expect(d).toContain('If you speak before the student has asked anything, say at most one short sentence on what this exercise is about')
        expect(d).toContain('never give the answer, a hint or any part of the key in it')
      }
    }
    expect(chatModeDirective(legacy, 'explain', 'study')).toContain('ending with an offer to explain it')
    expect(v).toContain('used only when the student asks; an unprompted turn never contains the answer, a hint or any part of the key')
  })

  it('switch directives ask for no reply', () => {
    for (const mode of ['probe', 'guide', 'explain'] as const) {
      expect(chatModeDirective(legacy, mode, 'study', { switching: true })).toContain('Do not reply to this message; wait for the student.')
    }
  })

  it('Guide asks the student to take the last step or choice and does not state it', () => {
    const guide = CHAT_MODE_RULES.split('\n').find((l) => l.startsWith('- Guide'))!
    expect(guide).toContain('when only the final step or the final choice remains (before the check), ask the student to take it and do not state it')
  })

  it('"next step", "ok", "continue" are requests, not answers', () => {
    expect(v).toContain('A request such as "next step", "ok" or "continue" is not an answer: start the reply with the step, not with an affirmation')
  })
})

describe('after the check: say plainly right or wrong, and the correct answer', () => {
  const v = voiceSystemInstruction(legacy)
  const rules = v.slice(v.indexOf('\nANSWER RULES\n'), v.indexOf('\nSTYLE\n'))
  const line = rules.split('\n').find((l) => l.startsWith('- After the answer is checked'))!

  it('the first reply starts with one plain sentence, whatever the student asked', () => {
    expect(line).toContain("your first reply to the student's next question, whatever it is (even just \"Why?\"), starts with one plain sentence saying whether their answer was right and what the correct answer is")
  })
  it('then Probe and Guide help with why (questions fine) and Explain explains directly', () => {
    expect(line).toContain('Then Probe and Guide help them see why it is right and why their choice was or was not (questions and steps are fine now)')
    expect(line).toContain('Explain explains directly')
    expect(line).toContain('Every mode may discuss the correct answer openly')
  })
  it('style: "Perfect" is a forbidden opener and the mode is not named in speech', () => {
    expect(v).toContain('"Great", "Perfect",')
    expect(v).toContain('do not name the chat mode when you speak')
  })
})
