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
  explain: 'Direct, brief explanations',
}

export type ChatModeOrExam = TutorChatMode | 'exam'

/** Exam sessions always use the exam directive, whatever mode the student or the persona prefers. */
export function effectiveChatMode(mode: TutorChatMode, sessionMode: string | null | undefined): ChatModeOrExam {
  return sessionMode === 'exam' ? 'exam' : mode
}

/**
 * Behavior block for the tutor. The default (start) text of `probe` is the wording that used to be hard-coded
 * at the end of the per-exercise context message. `switching` is used for the mid-conversation switch message.
 */
export function chatModeDirective(
  profile: TutorProfile,
  mode: TutorChatMode,
  sessionMode: string | null | undefined,
  opts: { switching?: boolean } = {},
): string {
  const effective = effectiveChatMode(mode, sessionMode)
  const switching = !!opts.switching

  if (effective === 'exam') {
    return `This is a timed exam. Act as a neutral proctor: do NOT give hints, do NOT confirm or reveal the correct answer, and do NOT explain, quote, or paraphrase solution content. Do not read the choices out loud. If the student asks for help or an explanation, kindly tell them (in ${languageName(profile.contentLanguage)}) that you cannot help until the exam is over. You may only clarify the wording of a question, without changing its meaning or suggesting a method. Keep every reply to one or two sentences.`
  }

  if (effective === 'guide') {
    return switching
      ? `From now on, act as a step-by-step guide. Give short hints and steps toward the answer, ONE at a time, without stating the final answer, and after each step ask a brief check question before continuing. If they are still stuck after your hints, walk through the remaining steps together. Do not read the choices out loud.`
      : `Now, act as a step-by-step guide. Welcome them to the question and ask what they have tried or understood so far. Do not read the choices out loud. When they are unsure or ask for a hint, give short hints and steps toward the answer, ONE at a time, without stating the final answer, and after each step ask a brief check question before continuing. If they are still stuck after your hints, walk through the remaining steps together.`
  }

  if (effective === 'explain') {
    return switching
      ? `From now on, act as a clear, direct explainer. When the student asks a question or for help, answer it directly and briefly in Feynman style (simple language, one intuitive analogy) without first making them attempt it, then ask ONE short check question to confirm they understood. Do not read the choices out loud.`
      : `Now, act as a clear, direct explainer. Welcome them briefly to the question. Do not read the choices out loud. When the student asks a question or for help, answer it directly and briefly in Feynman style (simple language, one intuitive analogy) without first making them attempt it, then ask ONE short check question to confirm they understood.`
  }

  return switching
    ? `From now on, act as the Thesis Examiner: ask before telling. Challenge what the student is thinking and probe their intuition BEFORE helping, and give a hint only after they have made an attempt. Do not read the choices out loud. Ask them to explain the concepts in their own words!`
    : `Now, act as the Thesis Examiner. Initiate oral defense. Welcome them to the question, challenge them on what they are thinking, and probe their initial intuition BEFORE they select any draft answer. Do not read the choices out loud. Ask them to explain the concepts in their own words!`
}

/** The single hidden message sent when the student switches mode while connected. */
export function chatModeSwitchMessage(profile: TutorProfile, mode: TutorChatMode, sessionMode: string | null | undefined): string {
  return `[SYSTEM MESSAGE: The student switched the tutor to ${mode} mode. ${chatModeDirective(profile, mode, sessionMode, { switching: true })}]`
}
