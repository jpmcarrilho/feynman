import type { TutorChatMode, TutorProfile } from '@/lib/studyspace/profile'
import { languageName } from './persona'

export const CHAT_MODE_LABELS: Record<TutorChatMode, string> = {
  probe: 'Probe',
  guide: 'Guide',
  explain: 'Explain',
}

export const CHAT_MODE_HINTS: Record<TutorChatMode, string> = {
  probe: 'Asks before telling; hints only after you try',
  guide: 'Short hints, one step at a time',
  explain: 'Direct, complete explanations',
}

export type ChatModeOrExam = TutorChatMode | 'exam'

/** Exam sessions always use the exam directive, whatever mode the student or the persona prefers. */
export function effectiveChatMode(mode: TutorChatMode, sessionMode: string | null | undefined): ChatModeOrExam {
  return sessionMode === 'exam' ? 'exam' : mode
}

/**
 * The rules of each chat mode, stated once. `voiceSystemInstruction` carries them; the start and switch directives
 * only name the mode and refer to them.
 */
export const CHAT_MODE_RULES = `- Probe: ask before telling. Ask what the student thinks and why, challenge their reasoning, and give a hint only after they have made an attempt. If they say they are stuck or do not know, stop questioning and give the next small hint or the underlying concept (never the fact that decides the question; see the answer rules).
- Guide: give short hints and intermediate steps toward the answer, one at a time, and after each step ask a brief check question. If they stay stuck, walk through the remaining steps together, but when only the final step or the final choice remains (before the check), ask the student to take it and do not state it.
- Explain: answer directly and completely, without first making the student attempt it. Name the concept, state the relevant fact or result plainly, then explain why, using the exercise's own terms and numbers. An analogy is optional: it comes after the plain statement, never instead of it. Do not end with a probing or quiz question; at most offer, in one short sentence, to go deeper or give an example.
- Exam: the timed-exam message governs. No hints, no answers, no solution content.`

/**
 * Message that tells the tutor which mode is in effect. `opening` (first context of a call, spoken) asks for one short
 * welcome; every later message says not to greet. `switching` is used for the mid-conversation switch message.
 */
export function chatModeDirective(
  profile: TutorProfile,
  mode: TutorChatMode,
  sessionMode: string | null | undefined,
  opts: { switching?: boolean; opening?: boolean; leavingExplain?: boolean } = {},
): string {
  const effective = effectiveChatMode(mode, sessionMode)

  if (effective === 'exam') {
    return `This is a timed exam. Act as a neutral proctor: do NOT give hints, do NOT confirm or reveal the correct answer, and do NOT explain, quote, or paraphrase solution content. Do not read the choices out loud. If the student asks for help or an explanation, kindly tell them (in ${languageName(profile.contentLanguage)}) that you cannot help until the exam is over. You may only clarify the wording of a question, without changing its meaning or suggesting a method. Keep every reply to one or two sentences.`
  }

  const label = CHAT_MODE_LABELS[effective]
  if (opts.switching) {
    const reminder = opts.leavingExplain
      ? ` You already hold the answer key from Explain mode; the ${label} answer rules apply again: do not state or confirm the answer until the student has checked it.`
      : ''
    return `From now on apply the ${label} rules from your instructions instead of the previous mode's. Do not reply to this message; wait for the student.${reminder}`
  }
  const lead = opts.opening ? 'This is the start of the call, so that sentence may include a brief welcome.' : 'Do not greet or welcome the student.'
  const about = effective === 'explain' ? 'on what this exercise is about, ending with an offer to explain it' : 'on what this exercise is about'
  return `Apply the ${label} rules from your instructions to everything you say next. If you speak before the student has asked anything, say at most one short sentence ${about}, and never give the answer, a hint or any part of the key in it. ${lead} When the student asks something, answer it by the rules.`
}

/** The single hidden message sent when the student switches mode while connected. */
export function chatModeSwitchMessage(
  profile: TutorProfile,
  mode: TutorChatMode,
  sessionMode: string | null | undefined,
  opts: { leavingExplain?: boolean } = {},
): string {
  return `[SYSTEM MESSAGE: The student switched the tutor to ${mode} mode. ${chatModeDirective(profile, mode, sessionMode, { switching: true, leavingExplain: opts.leavingExplain })}]`
}
