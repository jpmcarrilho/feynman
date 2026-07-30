'use client'

import { useState } from 'react'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Loader2 } from 'lucide-react'

interface FlashcardProps {
  questionText: string
  choices: string[]
  correctAnswer: string
  explanation?: string | null
  initialSelectedChoice?: string | null
  hasBeenAnswered?: boolean
  onAnswer: (isCorrect: boolean, userAnswer: string) => void
  onRequestExplanation?: (userAnswer: string) => void
}

export function Flashcard({ questionText, choices, correctAnswer, explanation, initialSelectedChoice, hasBeenAnswered, onAnswer, onRequestExplanation }: FlashcardProps) {
  const [selected, setSelected] = useState<string | null>(initialSelectedChoice || null)
  const [showResult, setShowResult] = useState(!!initialSelectedChoice || !!hasBeenAnswered)
  const [hasRequestedHelp, setHasRequestedHelp] = useState(false)

  const handleSelect = (choice: string) => {
    if (showResult) return
    setSelected(choice)
    const isCorrect = choice === correctAnswer
    setShowResult(true)
    onAnswer(isCorrect, choice)
  }

  const handleExplainMistake = () => {
    if (!selected || selected === correctAnswer || !onRequestExplanation) return
    setHasRequestedHelp(true)
    onRequestExplanation(selected)
  }

  return (
    <Card className="w-full max-w-2xl mx-auto shadow-md">
      <CardHeader>
        <CardTitle className="text-xl leading-relaxed whitespace-pre-wrap">{questionText}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
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
                className={`justify-start h-auto py-3 px-4 text-left whitespace-pre-wrap ${extraClasses}`}
                onClick={() => handleSelect(choice)}
                disabled={showResult}
              >
                {choice}
              </Button>
            )
          })}
        </div>
      </CardContent>
      {showResult && (
        <CardFooter className="bg-muted/50 p-6 rounded-b-xl border-t flex flex-col items-start gap-4">
          {explanation && (
            <div className="text-sm w-full">
              <strong>Official Explanation:</strong>
              <p className="mt-2 whitespace-pre-wrap">{explanation}</p>
            </div>
          )}
          
          {selected !== correctAnswer && onRequestExplanation && !hasRequestedHelp && (
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
