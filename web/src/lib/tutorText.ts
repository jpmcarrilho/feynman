/**
 * Safety net for tutor text shown in the chat: the model sometimes starts a reply by echoing a hidden directive
 * ("Mode: Explain. Follow the Explain rules from your instructions. ...") or the start of a [SYSTEM MESSAGE.
 * The prompts forbid it; this removes what still gets through. Pure.
 *
 * What is removed, only at the very start of the reply and in this order:
 *  1. a leading "[SYSTEM MESSAGE ..." block (to its closing bracket; everything, while the bracket has not arrived yet);
 *  2. a leading mode label: "Mode: Probe|Guide|Explain|Exam" (any case, optional spaces, optional ./,/; after it);
 *     a bare "Mode:" with nothing after it yet (still streaming) hides the text for now;
 *  3. then, repeatedly, leading sentences that are directive wording: "Follow/Apply the <X> rules from your
 *     instructions", "Go straight to the substance", "Do not greet ...", "Discuss the correct answer openly";
 *  4. and only when something was removed in steps 1 to 3: leading sentences written mostly in a non-Latin script
 *     (a transliterated copy of an instruction), as long as a later sentence is mostly Latin script. A reply that is
 *     really in another script, with no echo before it, is never touched.
 * Anything else ("Mode choice matters here because...") is left alone, since a label needs a colon and a mode name.
 */
const LABEL = /^\s*mode\s*:\s*(probe|guide|explain|exam)\b[\s.,;:!-]*/i
const PARTIAL_LABEL = /^\s*mode\s*:\s*[a-z]*\s*$/i
const DIRECTIVE_SENTENCES = [
  /^\s*(?:follow|apply) the (?:probe|guide|explain|exam|\w+) rules from your instructions[^.!?\n]*[.!?]?/i,
  /^\s*go straight to the substance[^.!?\n]*[.!?]?/i,
  /^\s*do not greet[^.!?\n]*[.!?]?/i,
  /^\s*discuss the correct answer openly[^.!?\n]*[.!?]?/i,
]
const SENTENCE_END = /[.!?।۔。！？]+\s*/u

function isMostlyNonLatin(sentence: string): boolean {
  const letters = sentence.match(/\p{L}/gu) ?? []
  if (letters.length === 0) return false
  const latin = letters.filter((c) => /\p{Script=Latin}/u.test(c)).length
  return latin / letters.length < 0.5
}

export function stripDirectiveEcho(text: string): string {
  let s = text.replace(/^\s+/, '')
  let removed = false

  if (/^\[SYSTEM MESSAGE/i.test(s)) {
    const close = s.indexOf(']')
    if (close === -1) return ''
    s = s.slice(close + 1).replace(/^\s+/, '')
    removed = true
  }
  if (PARTIAL_LABEL.test(s) && !LABEL.test(s)) return ''
  const label = s.match(LABEL)
  if (label) {
    s = s.slice(label[0].length)
    removed = true
  }
  for (let more = true; more && removed; ) {
    more = false
    for (const re of DIRECTIVE_SENTENCES) {
      const m = s.match(re)
      if (m) {
        s = s.slice(m[0].length).replace(/^\s+/, '')
        more = true
      }
    }
  }
  if (!removed) return text

  // A transliterated copy of an instruction: leading non-Latin sentences, kept if nothing Latin follows them
  for (;;) {
    const end = s.search(SENTENCE_END)
    if (end === -1) break
    const first = s.slice(0, end)
    const rest = s.slice(end).replace(SENTENCE_END, '')
    if (!isMostlyNonLatin(first) || !/\p{Script=Latin}/u.test(rest)) break
    s = rest
  }
  return s.replace(/^\s+/, '')
}

/**
 * Whether the tutor may speak by itself when a new exercise context arrives. Only in a live voice call: the microphone
 * is on (a typed message, or a text-only connection, mutes it) and no typed message is waiting to be answered.
 * Otherwise the context is sent silently and the tutor waits for the student.
 */
export function tutorSpeaksOnContext(state: { isMuted: boolean; pendingTypedMessage: boolean }): boolean {
  return !state.isMuted && !state.pendingTypedMessage
}

/**
 * The transcript that is stored for a session: injected [SYSTEM MESSAGE turns and model messages that are empty after
 * the strip are left out, and only role/text/id are kept, so the stored tutor text is the stripped text, never the raw
 * echo the model streamed. Pure.
 */
export function transcriptForSave(messages: unknown[]): unknown[] {
  const out: unknown[] = []
  for (const item of messages || []) {
    const m = item as { id?: unknown; role?: unknown; text?: unknown } | null
    if (!m || typeof m !== 'object') continue
    if (m.role === 'user' && typeof m.text === 'string' && m.text.startsWith('[SYSTEM MESSAGE')) continue
    if (m.role === 'model' && (typeof m.text !== 'string' || m.text.trim() === '')) continue
    const { id, role, text } = m
    out.push({ ...(id !== undefined ? { id } : {}), role, text })
  }
  return out
}
