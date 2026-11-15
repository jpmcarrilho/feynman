'use client'

import { useState } from 'react'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Loader2 } from 'lucide-react'
import { gradeAnswer, resolveExerciseType, formatScore, isPlaceholderChoice } from '@/lib/grading'
import { AnswerText } from './AnswerText'
import { Md, ConfirmBar, CONFIRM_BUTTON } from './cardParts'
import { OpenAnswer, type OpenLog } from './OpenAnswer'
import type { SelfScore } from '@/lib/openAnswer'
import type { OpenCheckOutcome } from '@/lib/openAnswerClient'

interface FlashcardProps {
  /** A sub-question of a multi-part problem: the shared stem is shown above the question (see lib/exerciseGroups.ts). */
  group?: { title: string; stem: string; part: number; total: number } | null
  questionText: string
  exerciseType?: string
  choices: string[]
  correctAnswer: string
  explanation?: string | null
  initialSelectedChoice?: string | null
  hasBeenAnswered?: boolean
  isExamMode?: boolean
  /**
   * Study mode: called once, when the student confirms ("Check answer"). Exam mode: called on every change of the answer
   * (a draft); an empty `userAnswer` means the answer was cleared.
   */
  onAnswer: (isCorrect: boolean, userAnswer: string) => void
  /** What the server stored for this answer. When it arrives it replaces the result computed here (same grader, so normally equal). */
  result?: { score: number; isCorrect: boolean } | null
  onRequestExplanation?: (userAnswer: string) => void
  /** Reports the question; resolves true when it was recorded. When omitted the card has no report control. */
  onReport?: (reason: ReportReason) => Promise<boolean>
  /** True when the question was already reported (shows the notice instead of the control). */
  reported?: boolean
  /** Written ("open") questions only: the session and question ids (the unsent draft is kept per question), the key points, the stored log, and the check. */
  openProps?: {
    sessionId: string
    exerciseId: string
    keyPoints: string[]
    log?: OpenLog | null
    onCheck?: (answer: string, selfScore?: SelfScore) => Promise<OpenCheckOutcome>
  }
}

export type ReportReason = 'wrong_answer' | 'unclear' | 'off_topic' | 'other'

const REPORT_OPTIONS: { value: ReportReason; label: string }[] = [
  { value: 'wrong_answer', label: 'The marked answer is wrong' },
  { value: 'unclear', label: 'The question is unclear' },
  { value: 'off_topic', label: 'It is off topic' },
  { value: 'other', label: 'Something else' },
]

// Phone (below sm): a comfortable reading size (17 px) with headings inside the question scaled to match; sm and up unchanged (text-xl)
const QUESTION_PROSE = 'prose dark:prose-invert max-w-none min-w-0 break-words text-xl leading-relaxed max-sm:text-[1.0625rem]! max-sm:leading-normal max-sm:[&_h1]:text-xl max-sm:[&_h2]:text-lg max-sm:[&_h3]:text-base max-sm:[&_h4]:text-base max-sm:[&_p]:my-2'
const CHOICE_PROSE = 'prose dark:prose-invert max-w-none min-w-0 text-sm break-words'

export function Flashcard({ group = null, questionText, exerciseType = 'single_choice', choices, correctAnswer, explanation, initialSelectedChoice, hasBeenAnswered, isExamMode = false, onAnswer, result, onRequestExplanation, onReport, reported = false, openProps }: FlashcardProps) {
  // The same type resolution and grading the server uses (src/lib/grading.ts)
  const effectiveExerciseType = resolveExerciseType({ exerciseType, choices, questionText })
  const grade = (userAnswer: string) =>
    gradeAnswer({ exerciseType, choices, correctAnswer, questionText }, userAnswer)

  let adjustedQuestionText = questionText;
  if (effectiveExerciseType === 'dropdown') {
    const dropdownsInChoices = new Set<string>();
    choices.forEach(c => {
      const match = c.match(/^(\[Dropdown \d+\])/);
      if (match) dropdownsInChoices.add(match[1]);
    });
    dropdownsInChoices.forEach(dd => {
      if (!adjustedQuestionText.includes(dd)) {
        adjustedQuestionText += ` ${dd}`;
      }
    });
  }

  const [selected, setSelected] = useState<string | null>(initialSelectedChoice || null)
  const [multiSelected, setMultiSelected] = useState<string[]>(() => {
    if (!initialSelectedChoice || effectiveExerciseType !== 'multiple_choice') return []
    try {
      return JSON.parse(initialSelectedChoice)
    } catch (e) {
      return [initialSelectedChoice]
    }
  })
  const [numericValue, setNumericValue] = useState<string>(initialSelectedChoice || '')
  const [dropdownValues, setDropdownValues] = useState<Record<string, string>>(() => {
    if (!initialSelectedChoice || effectiveExerciseType !== 'dropdown') return {}
    try {
      return JSON.parse(initialSelectedChoice)
    } catch(e) {
      return { '[BLANK]': initialSelectedChoice }
    }
  })
  
  const [showResult, setShowResult] = useState(() => {
    if (isExamMode) return false;
    return !!initialSelectedChoice || !!hasBeenAnswered;
  })
  const [hasRequestedHelp, setHasRequestedHelp] = useState(false)
  // Reporting takes three deliberate steps (open the form, pick a reason, press Send): no single tap reports a question
  const [reportOpen, setReportOpen] = useState(false)
  const [reportReason, setReportReason] = useState<ReportReason | null>(null)
  const [reportState, setReportState] = useState<'idle' | 'sending' | 'done' | 'failed'>(reported ? 'done' : 'idle')

  const sendReport = async () => {
    if (!onReport || !reportReason || reportState === 'sending') return
    setReportState('sending')
    try {
      setReportState((await onReport(reportReason)) ? 'done' : 'failed')
    } catch {
      setReportState('failed')
    }
  }

  /** The answer as it is stored and graded: '' when nothing is chosen. */
  const answerString = (values: { selected?: string | null; multi?: string[]; numeric?: string; dropdown?: Record<string, string> } = {}): string => {
    if (effectiveExerciseType === 'single_choice') return (values.selected !== undefined ? values.selected : selected) || ''
    if (effectiveExerciseType === 'multiple_choice') {
      const multi = values.multi ?? multiSelected
      return multi.length > 0 ? JSON.stringify(multi) : ''
    }
    if (effectiveExerciseType === 'numeric') return values.numeric ?? numericValue
    if (effectiveExerciseType === 'dropdown') {
      const dd = values.dropdown ?? dropdownValues
      return Object.values(dd).some(Boolean) ? JSON.stringify(dd) : ''
    }
    return ''
  }

  // Exam: every change of the answer is a draft, saved by the parent (no button); an empty string clears it.
  const saveDraft = (answer: string) => {
    if (isExamMode) onAnswer(grade(answer).isCorrect, answer)
  }

  /** Study mode: the student confirms the selection. Nothing is committed before this. */
  const handleSubmit = () => {
    if (showResult || isExamMode) return
    const answerStr = answerString()
    if (answerStr === '') return
    setShowResult(true)
    onAnswer(grade(answerStr).isCorrect, answerStr)
  }

  const handleSelectSingle = (choice: string) => {
    if (showResult) return
    setSelected(choice)
    saveDraft(choice)
  }

  const toggleMulti = (choice: string, checked: boolean) => {
    const next = checked ? [...multiSelected, choice] : multiSelected.filter(c => c !== choice)
    setMultiSelected(next)
    saveDraft(answerString({ multi: next }))
  }

  const changeNumeric = (value: string) => {
    setNumericValue(value)
    saveDraft(value)
  }

  const changeDropdown = (placeholder: string, value: string) => {
    const next = { ...dropdownValues, [placeholder]: value }
    setDropdownValues(next)
    saveDraft(answerString({ dropdown: next }))
  }

  const handleExplainMistake = () => {
    if (onRequestExplanation) {
      setHasRequestedHelp(true)
      let answerStr = selected || '';
      if (effectiveExerciseType === 'multiple_choice') answerStr = JSON.stringify(multiSelected);
      if (effectiveExerciseType === 'numeric') answerStr = numericValue;
      if (effectiveExerciseType === 'dropdown') {
        answerStr = Object.entries(dropdownValues).map(([k, v]) => k === '[BLANK]' ? v : `${k} ${v}`).join(' | ');
      }
      onRequestExplanation(answerStr)
    }
  }

  // The result shown after confirming: what the server stored when it is known, else the same grader run here
  const committedAnswer = showResult ? answerString() : ''
  const shownResult = showResult ? (result ?? grade(committedAnswer)) : null
  const answered = committedAnswer !== ''
  const fullyCorrect = !!shownResult && shownResult.isCorrect
  const partial = !!shownResult && !shownResult.isCorrect && shownResult.score > 0
  const resultText = !shownResult ? '' : !answered ? 'Not answered' : fullyCorrect ? 'Correct' : partial ? `Partially correct: ${formatScore(shownResult.score)} of 1` : 'Incorrect'
  const resultColor = fullyCorrect ? 'border-green-400 bg-green-100/60 text-green-900' : partial ? 'border-amber-400 bg-amber-100/60 text-amber-900' : 'border-lecture-red/40 bg-lecture-red/10 text-lecture-red'

  const renderQuestionText = () => {
    if (effectiveExerciseType === 'dropdown') {
      const parts = adjustedQuestionText.split(/(\[BLANK\]|\[Dropdown \d+\])/g);
      
      if (parts.length === 1) {
        return <Md text={adjustedQuestionText} className={QUESTION_PROSE} />;
      }

      return (
        <span className="flex flex-wrap items-center gap-2">
          {parts.map((part, index) => {
            const isPlaceholder = part === '[BLANK]' || /^\[Dropdown \d+\]$/.test(part);
            if (!isPlaceholder) {
              return <Md key={index} as="span" text={part} className={QUESTION_PROSE} />;
            }

            const relevantChoices = choices.filter(c => {
               if (part !== '[BLANK]') return c.startsWith(part);
               return true;
            }).map(c => part !== '[BLANK]' ? c.replace(part, '').trim() : c)
              // "Select an option" stored as a real choice is the prompt, not an answer: only the placeholder <option> below shows it
              .filter(c => !isPlaceholderChoice(c));

            const finalChoices = relevantChoices.length > 0 ? relevantChoices : choices.filter(c => !isPlaceholderChoice(c));

            return (
              <select 
                key={index}
                aria-label={part === '[BLANK]' ? 'Answer' : `Answer for ${part.slice(1, -1)}`}
                className="flex h-11 max-w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 sm:h-10 sm:text-sm"
                value={dropdownValues[part] || ''}
                onChange={(e) => changeDropdown(part, e.target.value)}
                disabled={showResult}
              >
                <option value="">Select an option</option>
                {finalChoices.map((c, i) => (
                  <option key={i} value={c}>{c}</option>
                ))}
              </select>
            );
          })}
        </span>
      )
    }
    return <Md text={adjustedQuestionText} className={QUESTION_PROSE} />;
  }

  return (
    <Card className="w-full max-w-2xl min-w-0 mx-auto overflow-visible max-sm:[--card-spacing:--spacing(3)] shadow-md border border-charcoal-graphite/10 bg-card">
      <CardHeader>
        {group && (
          <details open className="mb-4 w-full min-w-0 rounded-lg border border-fountain-ink/20 bg-fountain-ink/5 p-3" data-testid="group-stem">
            <summary className="cursor-pointer select-none text-xs font-semibold uppercase tracking-wide text-fountain-ink">
              Problem · part {group.part} of {group.total}{group.title ? ` · ${group.title}` : ''}
            </summary>
            <Md text={group.stem} className={`${CHOICE_PROSE} mt-2 text-base`} />
          </details>
        )}
        <div className="w-full min-w-0">{renderQuestionText()}</div>
      </CardHeader>
      <CardContent className="space-y-4 max-sm:space-y-3 min-w-0">
        
        {effectiveExerciseType === 'single_choice' && (
          <div className="grid gap-3">
            <div role="group" aria-label="Answer options" className="grid gap-3 max-sm:gap-2">
              {choices.map((choice, idx) => {
                let variant: 'default' | 'outline' | 'secondary' | 'destructive' = 'outline'
                let extraClasses = ''
                
                const isMatch = choice.trim() === correctAnswer.trim()
                const isSelected = choice.trim() === (selected || '').trim()

                if (showResult) {
                  if (isMatch) {
                    variant = 'outline' 
                    extraClasses = 'bg-green-100/60 hover:bg-green-100/60 text-green-900 border-green-400 font-semibold shadow-sm'
                  } else if (isSelected) {
                    variant = 'outline'
                    extraClasses = 'bg-lecture-red/10 hover:bg-lecture-red/10 text-lecture-red border-lecture-red/40'
                  } else {
                    extraClasses = 'border-charcoal-graphite/5 text-charcoal-graphite/40'
                  }
                } else if (isSelected) {
                  variant = 'outline'
                  extraClasses = 'bg-fountain-ink/15 text-fountain-ink border-fountain-ink font-semibold shadow-sm'
                } else {
                  extraClasses = 'hover:bg-fountain-ink/5 border-charcoal-graphite/15 text-charcoal-graphite/90'
                }

                return (
                  <Button
                    key={idx}
                    variant={variant}
                    aria-pressed={isSelected}
                    className={`justify-start h-auto min-h-11 min-w-0 py-3 max-sm:py-2.5 px-4 text-left whitespace-normal transition-all duration-200 ${extraClasses}`}
                    onClick={() => handleSelectSingle(choice)}
                    disabled={showResult}
                  >
                    <Md text={choice} className={CHOICE_PROSE} />
                  </Button>
                )
              })}
            </div>
            {!showResult && !isExamMode && (
              <ConfirmBar>
                <Button className={CONFIRM_BUTTON} onClick={handleSubmit} disabled={!selected}>
                  Check answer
                </Button>
              </ConfirmBar>
            )}
          </div>
        )}

        {effectiveExerciseType === 'multiple_choice' && (
          <div className="grid gap-3">
            <div role="group" aria-label="Answer options (select all that apply)" className="grid gap-3 max-sm:gap-2">
              {choices.map((choice, idx) => {
                let isCorrectChoice = false;
                try {
                  isCorrectChoice = JSON.parse(correctAnswer).includes(choice);
                } catch (e) {
                  isCorrectChoice = choice === correctAnswer;
                }

                const isChecked = multiSelected.includes(choice);
                
                let bgColor = 'border-charcoal-graphite/10 hover:bg-fountain-ink/5 text-charcoal-graphite/90';
                if (showResult) {
                  if (isCorrectChoice) bgColor = 'bg-green-100/60 border-green-400 text-green-900 font-medium';
                  else if (isChecked && !isCorrectChoice) bgColor = 'bg-lecture-red/10 border-lecture-red/40 text-lecture-red';
                  else bgColor = 'border-charcoal-graphite/5 text-charcoal-graphite/40';
                } else if (isChecked) {
                  bgColor = 'bg-fountain-ink/10 border-fountain-ink text-fountain-ink font-semibold';
                }

                return (
                  <div key={idx} className={`flex items-center space-x-3 px-3 min-h-11 rounded-md border transition-all duration-200 ${bgColor}`}>
                    <Checkbox 
                      id={`choice-${idx}`}
                      checked={isChecked}
                      disabled={showResult}
                      onCheckedChange={(checked) => toggleMulti(choice, !!checked)}
                      className="size-5 data-[state=checked]:bg-fountain-ink data-[state=checked]:border-fountain-ink"
                    />
                    <label htmlFor={`choice-${idx}`} className="cursor-pointer flex-1 break-words min-w-0 py-3">
                      <Md text={choice} className="prose dark:prose-invert max-w-none min-w-0 text-sm font-medium leading-tight" />
                    </label>
                  </div>
                )
              })}
            </div>
            {!showResult && !isExamMode && (
              <ConfirmBar>
                <Button className={CONFIRM_BUTTON} onClick={handleSubmit} disabled={multiSelected.length === 0}>
                  Check answer
                </Button>
              </ConfirmBar>
            )}
          </div>
        )}

        {effectiveExerciseType === 'numeric' && (
          <form
            className="flex flex-col gap-4"
            // Enter in the number field confirms the answer (study mode); in an exam the answer is already saved as a draft
            onSubmit={(e) => { e.preventDefault(); handleSubmit() }}
          >
            <Input 
              type="number" 
              inputMode="decimal"
              aria-label="Your answer"
              placeholder="Enter a number" 
              value={numericValue}
              onChange={(e) => changeNumeric(e.target.value)}
              disabled={showResult}
              className={`max-xl:h-11 transition-all duration-200 focus-visible:ring-fountain-ink ${
                showResult 
                  ? grade(numericValue).isCorrect
                    ? 'border-green-400 bg-green-100/30 text-green-900 font-semibold' 
                    : 'border-lecture-red bg-lecture-red/10 text-lecture-red'
                  : 'border-charcoal-graphite/20 bg-transparent'
              }`}
            />
            {!showResult && !isExamMode && (
              <ConfirmBar>
                <Button type="submit" className={CONFIRM_BUTTON} disabled={!numericValue}>
                  Check answer
                </Button>
              </ConfirmBar>
            )}
            {showResult && (
              <div className="text-sm font-medium">
                Correct Answer: <span className="text-green-600 font-semibold"><AnswerText exercise={{ exerciseType, choices, questionText }} answer={correctAnswer} /></span>
              </div>
            )}
          </form>
        )}

        {effectiveExerciseType === 'dropdown' && (
          <div className="flex flex-col gap-4">
            {!showResult && !isExamMode && (
              <ConfirmBar>
                <Button className={CONFIRM_BUTTON} onClick={handleSubmit} disabled={Object.values(dropdownValues).filter(Boolean).length === 0}>
                  Check answer
                </Button>
              </ConfirmBar>
            )}
            {showResult && (
              <div className="text-sm font-medium">
                Correct Answer: <span className="text-green-600 font-semibold"><AnswerText exercise={{ exerciseType, choices, questionText }} answer={correctAnswer} /></span>
              </div>
            )}
          </div>
        )}

        {effectiveExerciseType === 'open' && openProps && (
          <OpenAnswer
            sessionId={openProps.sessionId}
            exerciseId={openProps.exerciseId}
            mode={isExamMode ? 'exam' : 'study'}
            modelAnswer={correctAnswer}
            keyPoints={openProps.keyPoints}
            explanation={explanation}
            initialAnswer={initialSelectedChoice ?? ''}
            log={openProps.log}
            reviewing={!isExamMode && !!hasBeenAnswered}
            onCheck={openProps.onCheck}
            onDraft={(a) => onAnswer(false, a)}
            onDiscuss={onRequestExplanation ? () => { setHasRequestedHelp(true); onRequestExplanation(openProps.log?.userAnswer ?? '') } : undefined}
            discussRequested={hasRequestedHelp}
          />
        )}

        {/* Announced to screen readers when it fills in; always mounted so the announcement is made */}
        {effectiveExerciseType !== 'open' && (
        <div role="status" aria-live="polite" data-testid="answer-result" style={shownResult ? undefined : { margin: 0 }}>
          {shownResult && (
            <div className={`rounded-md border px-3 py-2 text-sm font-semibold ${resultColor}`}>{resultText}</div>
          )}
        </div>
        )}

        {isExamMode && effectiveExerciseType !== 'open' && (selected || multiSelected.length > 0 || numericValue || Object.values(dropdownValues).filter(Boolean).length > 0) && (
          <div role="status" aria-live="polite" className="text-xs text-fountain-ink bg-fountain-ink/10 px-3 py-1.5 rounded-md border border-fountain-ink/20 font-medium flex items-center gap-1.5 w-fit max-w-full">
            <span>✓ Answer saved as draft. You can change this anytime before submitting.</span>
          </div>
        )}

      </CardContent>
      {onReport && (
        <div className="px-6 pb-3 text-xs text-charcoal-graphite/50">
          {reportState === 'done' ? (
            <span>Reported &mdash; it won&apos;t be shown again.</span>
          ) : !reportOpen ? (
            <button type="button" className="min-h-11 underline-offset-2 hover:underline hover:text-charcoal-graphite/80 xl:min-h-0" onClick={() => setReportOpen(true)}>
              Report question
            </button>
          ) : (
            <div className="flex flex-col gap-2 rounded-md border border-charcoal-graphite/15 p-3" role="group" aria-label="Report this question">
              <span className="font-medium text-charcoal-graphite/70">What is wrong with this question?</span>
              {REPORT_OPTIONS.map((o) => ({ ...o, label: o.value === 'wrong_answer' && effectiveExerciseType === 'open' ? 'The model answer or the check is wrong' : o.label })).map((o) => (
                <label key={o.value} className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="report-reason" value={o.value} checked={reportReason === o.value} onChange={() => setReportReason(o.value)} />
                  {o.label}
                </label>
              ))}
              {reportState === 'failed' && <span className="text-lecture-red">The report could not be saved. Try again.</span>}
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="outline" disabled={!reportReason || reportState === 'sending'} onClick={sendReport}>
                  {reportState === 'sending' ? 'Sending...' : 'Send report'}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => { setReportOpen(false); setReportReason(null); setReportState('idle') }}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
      {showResult && effectiveExerciseType !== 'open' && (
        <CardFooter className="bg-muted p-6 rounded-b-xl border-t border-charcoal-graphite/10 flex flex-col items-start gap-4 shadow-sm">
          {explanation && (
            <div className="text-sm w-full">
              <strong className="text-charcoal-graphite font-display italic text-base block mb-2">Professor's Explanation:</strong>
              <Md text={explanation} className="mt-2 prose dark:prose-invert max-w-none min-w-0 text-sm break-words leading-relaxed text-charcoal-graphite/85" />
            </div>
          )}
          
          {onRequestExplanation && !hasRequestedHelp && answered && !!shownResult && !shownResult.isCorrect && (
            <Button 
              variant="outline" 
              onClick={handleExplainMistake}
              className="mt-2 max-xl:h-11 text-fountain-ink border-fountain-ink/30 hover:bg-fountain-ink/5"
            >
              Ask Voice Tutor to Explain My Mistake
            </Button>
          )}

          {hasRequestedHelp && (
            <div className="text-sm text-fountain-ink italic font-medium mt-2 animate-pulse">
              Asking Tutor... See the tutor panel.
            </div>
          )}
        </CardFooter>
      )}
    </Card>
  )
}
