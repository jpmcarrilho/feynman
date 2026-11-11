'use client'

import { useState } from 'react'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Loader2 } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { gradeAnswer, resolveExerciseType } from '@/lib/grading'

const preprocessLaTeX = (text: string | null | undefined) => {
  if (!text) return '';
  let processed = text.replace(/\\\[([\s\S]*?)\\\]/g, '$$$$$1$$$$');
  processed = processed.replace(/\\\(([\s\S]*?)\\\)/g, '$$$1$$');
  return processed;
}

interface FlashcardProps {
  questionText: string
  exerciseType?: string
  choices: string[]
  correctAnswer: string
  explanation?: string | null
  initialSelectedChoice?: string | null
  hasBeenAnswered?: boolean
  isExamMode?: boolean
  onAnswer: (isCorrect: boolean, userAnswer: string) => void
  onRequestExplanation?: (userAnswer: string) => void
  /** Reports the question; resolves true when it was recorded. When omitted the card has no report control. */
  onReport?: (reason: ReportReason) => Promise<boolean>
  /** True when the question was already reported (shows the notice instead of the control). */
  reported?: boolean
}

export type ReportReason = 'wrong_answer' | 'unclear' | 'off_topic' | 'other'

const REPORT_OPTIONS: { value: ReportReason; label: string }[] = [
  { value: 'wrong_answer', label: 'The marked answer is wrong' },
  { value: 'unclear', label: 'The question is unclear' },
  { value: 'off_topic', label: 'It is off topic' },
  { value: 'other', label: 'Something else' },
]

export function Flashcard({ questionText, exerciseType = 'single_choice', choices, correctAnswer, explanation, initialSelectedChoice, hasBeenAnswered, isExamMode = false, onAnswer, onRequestExplanation, onReport, reported = false }: FlashcardProps) {
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

  const handleSubmit = () => {
    if (showResult) return
    if (!isExamMode) {
      setShowResult(true)
    }

    let answerStr = '';

    if (effectiveExerciseType === 'single_choice') {
      answerStr = selected || '';
    } else if (effectiveExerciseType === 'multiple_choice') {
      answerStr = JSON.stringify(multiSelected);
    } else if (effectiveExerciseType === 'numeric') {
      answerStr = numericValue;
    } else if (effectiveExerciseType === 'dropdown') {
      answerStr = JSON.stringify(dropdownValues);
    }

    onAnswer(grade(answerStr).isCorrect, answerStr)
  }

  const handleSelectSingle = (choice: string) => {
    if (isExamMode) {
      setSelected(choice)
      onAnswer(grade(choice).isCorrect, choice)
    } else {
      if (showResult) return
      setSelected(choice)
      setShowResult(true)
      onAnswer(grade(choice).isCorrect, choice)
    }
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

  const renderQuestionText = () => {
    if (effectiveExerciseType === 'dropdown') {
      const parts = adjustedQuestionText.split(/(\[BLANK\]|\[Dropdown \d+\])/g);
      
      if (parts.length === 1) {
        return <div className="prose dark:prose-invert max-w-none text-xl leading-relaxed"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{preprocessLaTeX(adjustedQuestionText)}</ReactMarkdown></div>;
      }

      return (
        <span className="flex flex-wrap items-center gap-2">
          {parts.map((part, index) => {
            const isPlaceholder = part === '[BLANK]' || /^\[Dropdown \d+\]$/.test(part);
            if (!isPlaceholder) {
              return <span key={index} className="prose dark:prose-invert max-w-none text-xl leading-relaxed"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{preprocessLaTeX(part)}</ReactMarkdown></span>;
            }

            const relevantChoices = choices.filter(c => {
               if (part !== '[BLANK]') return c.startsWith(part);
               return true;
            }).map(c => part !== '[BLANK]' ? c.replace(part, '').trim() : c);

            const finalChoices = relevantChoices.length > 0 ? relevantChoices : choices;

            return (
              <select 
                key={index}
                className="flex h-10 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
                value={dropdownValues[part] || ''}
                onChange={(e) => setDropdownValues({...dropdownValues, [part]: e.target.value})}
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
    return <div className="prose dark:prose-invert max-w-none text-xl leading-relaxed"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{preprocessLaTeX(adjustedQuestionText)}</ReactMarkdown></div>;
  }

  return (
    <Card className="w-full max-w-2xl mx-auto shadow-md border border-charcoal-graphite/10 bg-card">
      <CardHeader>
        <div className="w-full">{renderQuestionText()}</div>
      </CardHeader>
      <CardContent className="space-y-4">
        
        {effectiveExerciseType === 'single_choice' && (
          <div className="grid gap-3">
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
                  className={`justify-start h-auto py-3 px-4 text-left whitespace-normal transition-all duration-200 ${extraClasses}`}
                  onClick={() => handleSelectSingle(choice)}
                  disabled={showResult}
                >
                  <div className="prose dark:prose-invert max-w-none text-sm break-words"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{preprocessLaTeX(choice)}</ReactMarkdown></div>
                </Button>
              )
            })}
          </div>
        )}

        {effectiveExerciseType === 'multiple_choice' && (
          <div className="grid gap-3">
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
                <div key={idx} className={`flex items-start space-x-3 p-3 rounded-md border transition-all duration-200 ${bgColor}`}>
                  <Checkbox 
                    id={`choice-${idx}`}
                    checked={isChecked}
                    disabled={showResult}
                    onCheckedChange={(checked) => {
                      if (checked) setMultiSelected([...multiSelected, choice]);
                      else setMultiSelected(multiSelected.filter(c => c !== choice));
                    }}
                    className="mt-1 data-[state=checked]:bg-fountain-ink data-[state=checked]:border-fountain-ink"
                  />
                  <label htmlFor={`choice-${idx}`} className="cursor-pointer flex-1 break-words min-w-0">
                    <div className="prose dark:prose-invert max-w-none text-sm font-medium leading-tight"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{preprocessLaTeX(choice)}</ReactMarkdown></div>
                  </label>
                </div>
              )
            })}
            {!showResult && (
              <Button className="mt-4 w-full bg-fountain-ink hover:bg-fountain-ink/90 text-white border-0 shadow-sm font-medium" onClick={handleSubmit} disabled={multiSelected.length === 0}>
                {isExamMode ? 'Save Answer' : 'Submit Answer'}
              </Button>
            )}
          </div>
        )}

        {effectiveExerciseType === 'numeric' && (
          <div className="flex flex-col gap-4">
            <Input 
              type="number" 
              placeholder="Enter a number" 
              value={numericValue}
              onChange={(e) => {
                setNumericValue(e.target.value);
                if (isExamMode) {
                  // For numeric, we can also auto-save on change so they don't absolutely have to click the button, but still provide the button
                  onAnswer(grade(e.target.value).isCorrect, e.target.value);
                }
              }}
              disabled={showResult}
              className={`transition-all duration-200 focus-visible:ring-fountain-ink ${
                showResult 
                  ? grade(numericValue).isCorrect
                    ? 'border-green-400 bg-green-100/30 text-green-900 font-semibold' 
                    : 'border-lecture-red bg-lecture-red/10 text-lecture-red'
                  : 'border-charcoal-graphite/20 bg-transparent'
              }`}
            />
            {!showResult && (
              <Button className="bg-fountain-ink hover:bg-fountain-ink/90 text-white border-0 shadow-sm font-medium" onClick={handleSubmit} disabled={!numericValue}>
                {isExamMode ? 'Save Answer' : 'Submit Answer'}
              </Button>
            )}
            {showResult && (
              <div className="text-sm font-medium">
                Correct Answer: <span className="text-green-600 font-semibold">{correctAnswer}</span>
              </div>
            )}
          </div>
        )}

        {effectiveExerciseType === 'dropdown' && (
          <div className="flex flex-col gap-4">
            {!showResult && (
              <Button className="bg-fountain-ink hover:bg-fountain-ink/90 text-white border-0 shadow-sm font-medium" onClick={handleSubmit} disabled={Object.values(dropdownValues).filter(Boolean).length === 0}>
                {isExamMode ? 'Save Answer' : 'Submit Answer'}
              </Button>
            )}
            {showResult && (
              <div className="text-sm font-medium">
                Correct Answer: <span className="text-green-600 font-semibold">{correctAnswer}</span>
              </div>
            )}
          </div>
        )}

        {isExamMode && (selected || multiSelected.length > 0 || numericValue || Object.values(dropdownValues).filter(Boolean).length > 0) && (
          <div className="text-xs text-fountain-ink bg-fountain-ink/10 px-3 py-1.5 rounded-md border border-fountain-ink/20 font-medium flex items-center gap-1.5 w-fit">
            <span>✓ Answer saved as draft. You can change this anytime before submitting.</span>
          </div>
        )}

      </CardContent>
      {onReport && (
        <div className="px-6 pb-3 text-xs text-charcoal-graphite/50">
          {reportState === 'done' ? (
            <span>Reported &mdash; it won&apos;t be shown again.</span>
          ) : !reportOpen ? (
            <button type="button" className="underline-offset-2 hover:underline hover:text-charcoal-graphite/80" onClick={() => setReportOpen(true)}>
              Report question
            </button>
          ) : (
            <div className="flex flex-col gap-2 rounded-md border border-charcoal-graphite/15 p-3" role="group" aria-label="Report this question">
              <span className="font-medium text-charcoal-graphite/70">What is wrong with this question?</span>
              {REPORT_OPTIONS.map((o) => (
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
      {showResult && (
        <CardFooter className="bg-muted p-6 rounded-b-xl border-t border-charcoal-graphite/10 flex flex-col items-start gap-4 shadow-sm">
          {explanation && (
            <div className="text-sm w-full">
              <strong className="text-charcoal-graphite font-display italic text-base block mb-2">Professor's Explanation:</strong>
              <div className="mt-2 prose dark:prose-invert max-w-none text-sm break-words leading-relaxed text-charcoal-graphite/85"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{preprocessLaTeX(explanation)}</ReactMarkdown></div>
            </div>
          )}
          
          {onRequestExplanation && !hasRequestedHelp && (
            <Button 
              variant="outline" 
              onClick={handleExplainMistake}
              className="mt-2 text-fountain-ink border-fountain-ink/30 hover:bg-fountain-ink/5"
            >
              Ask Voice Tutor to Explain My Mistake
            </Button>
          )}

          {hasRequestedHelp && (
            <div className="text-sm text-fountain-ink italic font-medium mt-2 animate-pulse">
              Asking Tutor... Check the chat sidebar.
            </div>
          )}
        </CardFooter>
      )}
    </Card>
  )
}
