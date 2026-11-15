'use client'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { answerDisplayLines, type GradableExercise } from '@/lib/grading'
import { scrollableTableComponents } from './markdownComponents'
import { preprocessLaTeX } from './DiagnosisMarkdown'

type AnswerShape = Pick<GradableExercise, 'exerciseType' | 'choices' | 'questionText'>

function Line({ text }: { text: string }) {
  return (
    <span className="prose dark:prose-invert max-w-none min-w-0 break-words text-inherit prose-p:my-0 prose-p:text-inherit">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={{ ...scrollableTableComponents, p: ({ children }) => <>{children}</> }}>{preprocessLaTeX(text)}</ReactMarkdown>
    </span>
  )
}

/**
 * An answer as the student reads it (see answerDisplayLines): one line for a single value, a bulleted list for several.
 * Used wherever a stored answer or an answer key is shown, so raw JSON never reaches the screen.
 */
export function AnswerText({ exercise, answer, empty = '—' }: { exercise: AnswerShape; answer: string | null | undefined; empty?: string }) {
  const lines = answerDisplayLines(exercise, answer)
  if (lines.length === 0) return <>{empty}</>
  if (lines.length === 1) return <Line text={lines[0]} />
  return (
    <ul className="m-0 list-disc space-y-0.5 pl-5" data-testid="answer-list">
      {lines.map((l, i) => (
        <li key={i}><Line text={l} /></li>
      ))}
    </ul>
  )
}
