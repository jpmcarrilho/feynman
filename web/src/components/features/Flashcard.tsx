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
}

export function Flashcard({ questionText, exerciseType = 'single_choice', choices, correctAnswer, explanation, initialSelectedChoice, hasBeenAnswered, isExamMode = false, onAnswer, onRequestExplanation }: FlashcardProps) {
  const hasDropdownChoices = choices.some(c => /^\[Dropdown \d+\]/.test(c));
  
  // Dynamic override to multiple_choice if question text clearly requests selecting all that apply
  const isMultiSelectText = questionText.toLowerCase().includes('select all that apply') || 
                           questionText.toLowerCase().includes('choose all that apply') ||
                           questionText.toLowerCase().includes('select all correct') ||
                           exerciseType === 'multiple_choice';

  const effectiveExerciseType = hasDropdownChoices 
    ? 'dropdown' 
    : (isMultiSelectText ? 'multiple_choice' : exerciseType);

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

  const handleSubmit = () => {
    if (showResult) return
    if (!isExamMode) {
      setShowResult(true)
    }

    let isCorrect = false;
    let answerStr = '';

    if (effectiveExerciseType === 'single_choice') {
      isCorrect = selected === correctAnswer;
      answerStr = selected || '';
    } else if (effectiveExerciseType === 'multiple_choice') {
      try {
        const correctArr = JSON.parse(correctAnswer);
        isCorrect = multiSelected.length === correctArr.length && multiSelected.every(v => correctArr.includes(v));
      } catch (e) {
        const cleanCorrectAnswer = correctAnswer.trim().toLowerCase();
        const cleanUserAnswer = multiSelected.join(',').trim().toLowerCase();
        isCorrect = cleanUserAnswer === cleanCorrectAnswer || 
          (multiSelected.length === 1 && multiSelected[0].trim().toLowerCase() === cleanCorrectAnswer);
      }
      answerStr = JSON.stringify(multiSelected);
    } else if (effectiveExerciseType === 'numeric') {
      isCorrect = Math.abs(parseFloat(numericValue) - parseFloat(correctAnswer)) < 0.01;
      answerStr = numericValue;
    } else if (effectiveExerciseType === 'dropdown') {
      // 1. Parse expected answers (handles JSON array strings, pipe-separated strings, or single values)
      let expectedAnswers: string[] = [];
      try {
        const parsed = JSON.parse(correctAnswer);
        if (Array.isArray(parsed)) {
          expectedAnswers = parsed.map(s => s.toString());
        } else {
          expectedAnswers = [parsed.toString()];
        }
      } catch (e) {
        expectedAnswers = correctAnswer.split('|');
      }

      // 2. Get user's selected answers mapped with keys
      const selectedAnswers = Object.entries(dropdownValues).map(([k, v]) => {
        return k === '[BLANK]' ? v : `${k} ${v}`;
      });

      // 3. Clean helper to strip prefixes, spaces, and lowercase for precise comparison
      const clean = (s: string) => {
        if (!s) return '';
        return s
          .trim()
          .replace(/^\[Dropdown \d+\]\s*/i, '')
          .replace(/^\[Blank \d+\]\s*/i, '')
          .trim()
          .toLowerCase();
      };

      const cleanExpected = expectedAnswers.map(clean).filter(Boolean);
      const cleanSelected = selectedAnswers.map(clean).filter(Boolean);

      // 4. Compare expected vs selected sets
      isCorrect = cleanExpected.length > 0 && 
                  cleanExpected.length === cleanSelected.length &&
                  cleanExpected.every(exp => cleanSelected.includes(exp));

      answerStr = JSON.stringify(dropdownValues);
    }

    onAnswer(isCorrect, answerStr)
  }

  const handleSelectSingle = (choice: string) => {
    if (isExamMode) {
      setSelected(choice)
      onAnswer(choice.trim().toLowerCase() === correctAnswer.trim().toLowerCase(), choice)
    } else {
      if (showResult) return
      setSelected(choice)
      const isCorrect = choice === correctAnswer
      setShowResult(true)
      onAnswer(isCorrect, choice)
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
                  const isCorrect = Math.abs(parseFloat(e.target.value) - parseFloat(correctAnswer)) < 0.01;
                  onAnswer(isCorrect, e.target.value);
                }
              }}
              disabled={showResult}
              className={`transition-all duration-200 focus-visible:ring-fountain-ink ${
                showResult 
                  ? Math.abs(parseFloat(numericValue) - parseFloat(correctAnswer)) < 0.01 
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
