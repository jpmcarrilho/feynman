'use client'

import { courseCredit, creditLine } from '@/lib/attribution'

/** One muted line naming the course the material comes from (and that the AI wrote the question, when it did). Nothing for an unknown course. */
export function SourceCredit({ courseCode, origin, className = '' }: { courseCode?: string | null; origin?: string | null; className?: string }) {
  const line = creditLine(courseCode, origin)
  const credit = courseCredit(courseCode)
  if (!line || !credit) return null
  return (
    <p data-testid="source-credit" className={`mt-3 text-[11px] leading-snug text-muted-foreground ${className}`}>
      {line}{' '}
      <a href={credit.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">Course page</a>
    </p>
  )
}
