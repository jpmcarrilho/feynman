'use client'

import { useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Loader2 } from 'lucide-react'
import {
  OPEN_ANSWER_MAX_CHARS,
  OPEN_ANSWER_MIN_CHARS,
  isOpenAnswerLongEnough,
  openResultLabel,
  type GradedBy,
  type KeyPointStatus,
  type OpenFeedback,
  type SelfScore,
} from '@/lib/openAnswer'
import { openDraftStorageKey, type OpenCheckOutcome } from '@/lib/openAnswerClient'
import { Md, ConfirmBar, CONFIRM_BUTTON } from './cardParts'

/** The stored answer of a written question (a log of the session). */
export interface OpenLog {
  userAnswer: string | null
  score: number
  isCorrect: boolean
  gradedBy?: GradedBy | null
  feedback?: OpenFeedback | null
}

export interface OpenAnswerProps {
  sessionId: string
  exerciseId: string
  /** 'exam': an exam in progress (drafts only, nothing about the model answer is shown). 'study': the student checks the answer. */
  mode: 'study' | 'exam'
  /** The model answer (Markdown with `$…$` math). Shown only after the answer is checked or the exam is submitted. */
  modelAnswer: string
  keyPoints: string[]
  explanation?: string | null
  /** Exam: the draft saved on the server. Study: ignored (the unsent draft is read from this browser). */
  initialAnswer?: string
  /** What the server stored for this question, once it is answered. */
  log?: OpenLog | null
  /** The session is over (submitted exam, finished session): a question without a log reads "Not answered". */
  reviewing?: boolean
  /** Study mode: checks the answer (optionally with the student's own score). Resolves to the outcome; the parent stores it in the session. */
  onCheck?: (answer: string, selfScore?: SelfScore) => Promise<OpenCheckOutcome>
  /** Exam mode: every change of the text (an empty string clears it). */
  onDraft?: (answer: string) => void
  /** "Discuss my answer with the tutor". */
  onDiscuss?: () => void
  discussRequested?: boolean
}

const STATUS_TEXT: Record<KeyPointStatus, { mark: string; text: string; className: string }> = {
  covered: { mark: '✓', text: 'Covered', className: 'text-green-800' },
  partly: { mark: '~', text: 'Partly covered', className: 'text-amber-800' },
  missing: { mark: '✗', text: 'Missing', className: 'text-lecture-red' },
}

const SELF_OPTIONS: { score: SelfScore; label: string }[] = [
  { score: 1, label: 'I had all of it' },
  { score: 0.5, label: 'Some of it' },
  { score: 0, label: 'Not really' },
]

function readDraft(sessionId: string, exerciseId: string): string {
  try {
    return localStorage.getItem(openDraftStorageKey(sessionId, exerciseId)) ?? ''
  } catch {
    return ''
  }
}
function writeDraft(sessionId: string, exerciseId: string, text: string) {
  try {
    if (text === '') localStorage.removeItem(openDraftStorageKey(sessionId, exerciseId))
    else localStorage.setItem(openDraftStorageKey(sessionId, exerciseId), text)
  } catch {
    // storage unavailable (private window, full): the answer simply is not kept across a reload
  }
}

const MD_BLOCK = 'prose dark:prose-invert max-w-none min-w-0 text-sm break-words leading-relaxed text-charcoal-graphite/90'

/** The written-answer part of a flashcard: the text area, the check, the self-assessment fallback and the result. */
export function OpenAnswer({
  sessionId,
  exerciseId,
  mode,
  modelAnswer,
  keyPoints,
  explanation,
  initialAnswer,
  log,
  reviewing = false,
  onCheck,
  onDraft,
  onDiscuss,
  discussRequested = false,
}: OpenAnswerProps) {
  const fieldId = useId()
  const [text, setText] = useState<string>(() => (mode === 'exam' ? (initialAnswer ?? '') : log ? '' : readDraft(sessionId, exerciseId)))
  const [phase, setPhase] = useState<'editing' | 'checking' | 'unchecked'>('editing')
  const [message, setMessage] = useState<string | null>(null)
  // The result this card received itself (the parent's log arrives a moment later and then takes over)
  const [local, setLocal] = useState<OpenLog | null>(null)
  const busyRef = useRef(false)

  const shown: OpenLog | null = log ?? local
  const exam = mode === 'exam'
  const canCheck = isOpenAnswerLongEnough(text)

  const changeText = (value: string) => {
    const next = value.slice(0, OPEN_ANSWER_MAX_CHARS)
    setText(next)
    setMessage(null)
    if (exam) onDraft?.(next)
    else writeDraft(sessionId, exerciseId, next)
  }

  /** Sends the answer (or the student's own score for it). One request at a time for this card. */
  const run = async (selfScore?: SelfScore) => {
    if (!onCheck || busyRef.current) return
    if (selfScore === undefined && !canCheck) return
    busyRef.current = true
    setMessage(null)
    setPhase(selfScore === undefined ? 'checking' : 'unchecked')
    let outcome: OpenCheckOutcome | null = null
    try {
      outcome = await onCheck(text.trim(), selfScore)
    } catch {
      outcome = null
    } finally {
      busyRef.current = false
    }
    if (outcome && outcome.status === 'stored') {
      writeDraft(sessionId, exerciseId, '')
      setLocal({ userAnswer: text.trim(), score: outcome.score, isCorrect: outcome.isCorrect, gradedBy: outcome.gradedBy, feedback: outcome.feedback })
      setPhase('editing')
      return
    }
    if (outcome && outcome.status === 'unchecked') {
      setPhase('unchecked')
      setMessage(selfScore === undefined ? null : 'Your assessment could not be saved. Try again.')
      return
    }
    setPhase(selfScore === undefined ? 'editing' : 'unchecked')
    setMessage(
      outcome
        ? 'This answer could not be saved. The session may have ended.'
        : 'Something went wrong while checking. Your answer is kept; try again.',
    )
  }

  // ---- Result (checked, or the session is over) ---------------------------------------------------------------------
  if (shown || (reviewing && !exam)) {
    const answered = !!shown && !!(shown.userAnswer ?? '').trim()
    const pending = shown?.gradedBy === 'pending'
    const score = shown?.score ?? 0
    const fullyCorrect = !!shown && !pending && score >= 1
    // Nothing to add when the explanation is empty or only repeats the model answer (rows stored that way by older imports)
    const norm = (t: string) => t.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
    const showExplanation = !!explanation && norm(explanation) !== '' && norm(explanation) !== norm(modelAnswer)
    const partial = !!shown && !pending && score > 0 && score < 1
    const label = !answered ? 'Not answered' : openResultLabel({ score, gradedBy: shown?.gradedBy })
    const colour = pending
      ? 'border-charcoal-graphite/25 bg-muted text-charcoal-graphite'
      : fullyCorrect
        ? 'border-green-400 bg-green-100/60 text-green-900'
        : partial
          ? 'border-amber-400 bg-amber-100/60 text-amber-900'
          : 'border-lecture-red/40 bg-lecture-red/10 text-lecture-red'
    const feedback = shown?.feedback ?? null
    const checkedPoints = feedback && feedback.keyPoints.length > 0 ? feedback.keyPoints : null
    return (
      <div className="flex flex-col gap-4" data-testid="open-answer-result">
        {answered && (
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-charcoal-graphite/60">Your answer</div>
            {/* The student's own words are shown as typed: plain text, never Markdown */}
            <p className="mt-1 whitespace-pre-wrap break-words rounded-md border border-charcoal-graphite/15 bg-muted/40 px-3 py-2 text-sm" data-testid="open-student-answer">{shown?.userAnswer}</p>
          </div>
        )}
        <div role="status" aria-live="polite" data-testid="answer-result">
          <div className={`rounded-md border px-3 py-2 text-sm font-semibold ${colour}`}>
            {label}
            {shown?.gradedBy === 'self' && <span className="font-normal"> (self-assessed)</span>}
            {pending && <span className="font-normal"> It counts 0 until it is checked.</span>}
          </div>
        </div>
        {feedback?.text && <Md text={feedback.text} className={MD_BLOCK} />}
        {(checkedPoints || keyPoints.length > 0) && (
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-charcoal-graphite/60">Key points</div>
            <ul className="mt-1 space-y-1.5 text-sm" data-testid="open-key-points">
              {checkedPoints
                ? checkedPoints.map((k, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <span className={`shrink-0 font-semibold ${STATUS_TEXT[k.status].className}`}>
                        <span aria-hidden="true">{STATUS_TEXT[k.status].mark} </span>
                        {STATUS_TEXT[k.status].text}:
                      </span>
                      <Md as="span" text={k.point} className="prose dark:prose-invert min-w-0 max-w-none text-sm break-words prose-p:my-0" />
                    </li>
                  ))
                : keyPoints.map((k, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <span aria-hidden="true" className="shrink-0">•</span>
                      <Md as="span" text={k} className="prose dark:prose-invert min-w-0 max-w-none text-sm break-words prose-p:my-0" />
                    </li>
                  ))}
            </ul>
          </div>
        )}
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-charcoal-graphite/60">Model answer</div>
          <Md text={modelAnswer} className={`mt-1 ${MD_BLOCK}`} />
        </div>
        {showExplanation && (
          <div className="text-sm w-full">
            <strong className="text-charcoal-graphite font-display italic text-base block mb-2">Professor&apos;s Explanation:</strong>
            <Md text={explanation} className={MD_BLOCK} />
          </div>
        )}
        {onDiscuss && answered && !pending && !fullyCorrect && !discussRequested && (
          <Button variant="outline" onClick={onDiscuss} className="self-start max-xl:h-11 text-fountain-ink border-fountain-ink/30 hover:bg-fountain-ink/5">
            Discuss my answer with the tutor
          </Button>
        )}
        {discussRequested && (
          <div className="text-sm text-fountain-ink italic font-medium animate-pulse">Asking Tutor... See the tutor panel.</div>
        )}
      </div>
    )
  }

  // ---- Writing (study or exam) and the self-assessment fallback ------------------------------------------------------
  const locked = phase !== 'editing'
  return (
    <div className="flex flex-col gap-3">
      <div>
        <label htmlFor={fieldId} className="sr-only">Your answer</label>
        <textarea
          id={fieldId}
          rows={5}
          maxLength={OPEN_ANSWER_MAX_CHARS}
          value={text}
          readOnly={locked}
          placeholder="Write your answer in your own words"
          onChange={(e) => changeText(e.target.value)}
          aria-describedby={`${fieldId}-count`}
          className="block w-full min-w-0 resize-y rounded-md border border-charcoal-graphite/20 bg-transparent px-3 py-2 text-base leading-relaxed shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-fountain-ink read-only:bg-muted/40 sm:text-sm"
        />
        <div id={`${fieldId}-count`} className="mt-1 flex flex-wrap justify-between gap-x-3 text-xs text-charcoal-graphite/60">
          <span>{!exam && !canCheck ? `Write at least ${OPEN_ANSWER_MIN_CHARS} characters, not counting spaces, to check your answer.` : ''}</span>
          <span>{text.length} / {OPEN_ANSWER_MAX_CHARS}</span>
        </div>
      </div>

      {message && <p role="alert" className="text-sm text-lecture-red">{message}</p>}

      {exam && text.trim() !== '' && (
        <div role="status" aria-live="polite" className="text-xs text-fountain-ink bg-fountain-ink/10 px-3 py-1.5 rounded-md border border-fountain-ink/20 font-medium flex items-center gap-1.5 w-fit max-w-full">
          <span>✓ Answer saved as draft. You can change this anytime before submitting.</span>
        </div>
      )}

      {!exam && phase === 'unchecked' && (
        <div className="flex flex-col gap-3 rounded-md border border-amber-400 bg-amber-100/50 p-3 text-amber-950" data-testid="open-unchecked">
          <p className="text-sm">The answer check is not available right now, so compare your answer with the model answer and score it yourself.</p>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide">Model answer</div>
            <Md text={modelAnswer} className={`mt-1 ${MD_BLOCK}`} />
          </div>
          {keyPoints.length > 0 && (
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide">Key points</div>
              <ul className="mt-1 space-y-1 text-sm">
                {keyPoints.map((k, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span aria-hidden="true" className="shrink-0">•</span>
                    <Md as="span" text={k} className="prose dark:prose-invert min-w-0 max-w-none text-sm break-words prose-p:my-0" />
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div role="group" aria-label="How much of the model answer did you have?" className="grid gap-2 sm:grid-cols-3">
            {SELF_OPTIONS.map((o) => (
              <Button key={o.score} type="button" variant="outline" className="min-h-11 whitespace-normal bg-white" onClick={() => run(o.score)}>
                {o.label}
              </Button>
            ))}
          </div>
        </div>
      )}

      {!exam && phase !== 'unchecked' && (
        <ConfirmBar className="max-sm:-mx-3 max-sm:px-3">
          <Button type="button" className={CONFIRM_BUTTON} onClick={() => run()} disabled={!canCheck || phase === 'checking'}>
            {phase === 'checking' ? (
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Checking your answer…</>
            ) : (
              'Check answer'
            )}
          </Button>
        </ConfirmBar>
      )}
      {phase === 'checking' && <span role="status" className="sr-only">Checking your answer…</span>}
    </div>
  )
}
