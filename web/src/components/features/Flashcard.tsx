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

interface FlashcardProps {
  questionText: string
  exerciseType?: string
  choices: string[]
  correctAnswer: string
  explanation?: string | null
  initialSelectedChoice?: string | null
  hasBeenAnswered?: boolean
  onAnswer: (isCorrect: boolean, userAnswer: string) => void
  onRequestExplanation?: (userAnswer: string) => void
}

export function Flashcard({ questionText, exerciseType = 'single_choice', choices, correctAnswer, explanation, initialSelectedChoice, hasBeenAnswered, onAnswer, onRequestExplanation }: FlashcardProps) {
  const [selected, setSelected] = useState<string | null>(initialSelectedChoice || null)
  const [multiSelected, setMultiSelected] = useState<string[]>(() => {
    if (!initialSelectedChoice || exerciseType !== 'multiple_choice') return []
    try {
      return JSON.parse(initialSelectedChoice)
    } catch (e) {
      return [initialSelectedChoice]
    }
  })
  const [numericValue, setNumericValue] = useState<string>(initialSelectedChoice || '')
  const [dropdownValues, setDropdownValues] = useState<Record<string, string>>(() => {
    if (!initialSelectedChoice || exerciseType !== 'dropdown') return {}
    try {
      return JSON.parse(initialSelectedChoice)
    } catch(e) {
      return { '[BLANK]': initialSelectedChoice }
    }
  })
  
  const [showResult, setShowResult] = useState(!!initialSelectedChoice || !!hasBeenAnswered)
  const [hasRequestedHelp, setHasRequestedHelp] = useState(false)

  const handleSubmit = () => {
    if (showResult) return
    setShowResult(true)

    let isCorrect = false;
    let answerStr = '';

    if (exerciseType === 'single_choice') {
      isCorrect = selected === correctAnswer;
      answerStr = selected || '';
    } else if (exerciseType === 'multiple_choice') {
      try {
        const correctArr = JSON.parse(correctAnswer);
        // Simple strict match for now
        isCorrect = multiSelected.length === correctArr.length && multiSelected.every(v => correctArr.includes(v));
      } catch (e) {
        // Fallback if not JSON
        isCorrect = multiSelected.join(',') === correctAnswer;
      }
      answerStr = JSON.stringify(multiSelected);
    } else if (exerciseType === 'numeric') {
      // Allow slight floating point variations
      isCorrect = Math.abs(parseFloat(numericValue) - parseFloat(correctAnswer)) < 0.01;
      answerStr = numericValue;
    } else if (exerciseType === 'dropdown') {
      const expectedAnswers = correctAnswer.split('|').map(s => s.trim());
      const selectedAnswers = Object.entries(dropdownValues).map(([k, v]) => k === '[BLANK]' ? v : `${k} ${v}`).map(s => s.trim());
      
      if (expectedAnswers.length === 1 && Object.keys(dropdownValues).length <= 1) {
        isCorrect = Object.values(dropdownValues)[0]?.trim().toLowerCase() === correctAnswer.trim().toLowerCase();
      } else {
        isCorrect = expectedAnswers.length > 0 && expectedAnswers.every(ans => selectedAnswers.some(sel => sel.toLowerCase() === ans.toLowerCase()));
      }
      answerStr = JSON.stringify(dropdownValues);
    }

    onAnswer(isCorrect, answerStr)
  }

  const handleSelectSingle = (choice: string) => {
    if (showResult) return
    setSelected(choice)
    const isCorrect = choice === correctAnswer
    setShowResult(true)
    onAnswer(isCorrect, choice)
  }

  const handleExplainMistake = () => {
    if (onRequestExplanation) {
      setHasRequestedHelp(true)
      let answerStr = selected || '';
      if (exerciseType === 'multiple_choice') answerStr = JSON.stringify(multiSelected);
      if (exerciseType === 'numeric') answerStr = numericValue;
      if (exerciseType === 'dropdown') {
        answerStr = Object.entries(dropdownValues).map(([k, v]) => k === '[BLANK]' ? v : `${k} ${v}`).join(' | ');
      }
      onRequestExplanation(answerStr)
    }
  }

  const renderQuestionText = () => {
    if (exerciseType === 'dropdown') {
      const parts = questionText.split(/(\[BLANK\]|\[Dropdown \d+\])/g);
      
      if (parts.length === 1) {
        return <div className="prose dark:prose-invert max-w-none text-xl leading-relaxed"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{questionText}</ReactMarkdown></div>;
      }

      return (
        <span className="flex flex-wrap items-center gap-2">
          {parts.map((part, index) => {
            const isPlaceholder = part === '[BLANK]' || /^\[Dropdown \d+\]$/.test(part);
            if (!isPlaceholder) {
              return <span key={index} className="prose dark:prose-invert max-w-none text-xl leading-relaxed"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{part}</ReactMarkdown></span>;
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
    return <div className="prose dark:prose-invert max-w-none text-xl leading-relaxed"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{questionText}</ReactMarkdown></div>;
  }

  return (
    <Card className="w-full max-w-2xl mx-auto shadow-md">
      <CardHeader>
        <div className="w-full">{renderQuestionText()}</div>
      </CardHeader>
      <CardContent className="space-y-4">
        
        {exerciseType === 'single_choice' && (
          <div className="grid gap-3">
            {choices.map((choice, idx) => {
              let variant: 'default' | 'outline' | 'secondary' | 'destructive' = 'outline'
              let extraClasses = ''
              
              const isMatch = choice.trim() === correctAnswer.trim()
              const isSelected = choice.trim() === (selected || '').trim()

              if (showResult) {
                if (isMatch) {
                  variant = 'default' 
                  extraClasses = 'bg-green-600 hover:bg-green-700 text-white border-green-600'
                } else if (isSelected) {
                  variant = 'destructive'
                }
              } else if (isSelected) {
                variant = 'secondary'
              }

              return (
                <Button
                  key={idx}
                  variant={variant}
                  className={`justify-start h-auto py-3 px-4 text-left whitespace-normal ${extraClasses}`}
                  onClick={() => handleSelectSingle(choice)}
                  disabled={showResult}
                >
                  <div className="prose dark:prose-invert max-w-none text-sm break-words"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{choice}</ReactMarkdown></div>
                </Button>
              )
            })}
          </div>
        )}

        {exerciseType === 'multiple_choice' && (
          <div className="grid gap-3">
            {choices.map((choice, idx) => {
              let isCorrectChoice = false;
              try {
                isCorrectChoice = JSON.parse(correctAnswer).includes(choice);
              } catch (e) {
                isCorrectChoice = choice === correctAnswer;
              }

              const isChecked = multiSelected.includes(choice);
              
              let bgColor = '';
              if (showResult) {
                if (isCorrectChoice) bgColor = 'bg-green-100 border-green-500';
                else if (isChecked && !isCorrectChoice) bgColor = 'bg-red-100 border-red-500';
              }

              return (
                <div key={idx} className={`flex items-start space-x-3 p-3 rounded-md border ${bgColor}`}>
                  <Checkbox 
                    id={`choice-${idx}`}
                    checked={isChecked}
                    disabled={showResult}
                    onCheckedChange={(checked) => {
                      if (checked) setMultiSelected([...multiSelected, choice]);
                      else setMultiSelected(multiSelected.filter(c => c !== choice));
                    }}
                    className="mt-1"
                  />
                  <label htmlFor={`choice-${idx}`} className="cursor-pointer flex-1 break-words min-w-0">
                    <div className="prose dark:prose-invert max-w-none text-sm font-medium leading-tight"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{choice}</ReactMarkdown></div>
                  </label>
                </div>
              )
            })}
            {!showResult && (
              <Button className="mt-4 w-full" onClick={handleSubmit} disabled={multiSelected.length === 0}>
                Submit Answer
              </Button>
            )}
          </div>
        )}

        {exerciseType === 'numeric' && (
          <div className="flex flex-col gap-4">
            <Input 
              type="number" 
              placeholder="Enter a number" 
              value={numericValue}
              onChange={(e) => setNumericValue(e.target.value)}
              disabled={showResult}
              className={showResult ? (Math.abs(parseFloat(numericValue) - parseFloat(correctAnswer)) < 0.01 ? 'border-green-500 bg-green-50' : 'border-red-500 bg-red-50') : ''}
            />
            {!showResult && (
              <Button onClick={handleSubmit} disabled={!numericValue}>
                Submit Answer
              </Button>
            )}
            {showResult && (
              <div className="text-sm font-medium">
                Correct Answer: <span className="text-green-600">{correctAnswer}</span>
              </div>
            )}
          </div>
        )}

        {exerciseType === 'dropdown' && (
          <div className="flex flex-col gap-4">
            {!showResult && (
              <Button onClick={handleSubmit} disabled={Object.values(dropdownValues).filter(Boolean).length === 0}>
                Submit Answer
              </Button>
            )}
            {showResult && (
              <div className="text-sm font-medium">
                Correct Answer: <span className="text-green-600">{correctAnswer}</span>
              </div>
            )}
          </div>
        )}

      </CardContent>
      {showResult && (
        <CardFooter className="bg-muted/50 p-6 rounded-b-xl border-t flex flex-col items-start gap-4">
          {explanation && (
            <div className="text-sm w-full">
              <strong>Official Explanation:</strong>
              <div className="mt-2 prose dark:prose-invert max-w-none text-sm break-words"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{explanation}</ReactMarkdown></div>
            </div>
          )}
          
          {onRequestExplanation && !hasRequestedHelp && (
            <Button 
              variant="outline" 
              onClick={handleExplainMistake}
            >
              Ask Voice Tutor to Explain My Mistake
            </Button>
          )}

          {hasRequestedHelp && (
            <div className="text-sm text-blue-600 dark:text-blue-400 italic">
              Asking Tutor... Check the chat sidebar.
            </div>
          )}
        </CardFooter>
      )}
    </Card>
  )
}
