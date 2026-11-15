'use client'

import type { ProblemSummary, PartState } from '@/lib/exerciseGroups'

const STATE_STYLE: Record<PartState, string> = {
  open: 'border-charcoal-graphite/20 bg-white text-charcoal-graphite/70 hover:bg-fountain-ink/5',
  answered: 'border-fountain-ink/50 bg-fountain-ink/10 text-fountain-ink',
  correct: 'border-green-500 bg-green-100/70 text-green-900',
  partial: 'border-amber-400 bg-amber-100/70 text-amber-900',
  incorrect: 'border-red-400 bg-red-100/70 text-red-900',
}
const STATE_LABEL: Record<PartState, string> = { open: 'not answered', answered: 'answered', correct: 'correct', partial: 'partly correct', incorrect: 'incorrect' }

/**
 * The parts of a multi-part problem as a strip of numbered chips above the card: where the student is, what is answered, how it
 * went, and a click goes to that part. Shown only for a problem with at least two parts in the session.
 */
export function ProblemParts({ summary, onSelect, showScore }: { summary: ProblemSummary; onSelect: (index: number) => void; showScore: boolean }) {
  return (
    <nav aria-label="Parts of this problem" data-testid="problem-parts" className="mb-3 flex w-full min-w-0 flex-wrap items-center gap-2">
      {summary.parts.map((p) => (
        <button
          key={p.index}
          type="button"
          onClick={() => onSelect(p.index)}
          aria-current={p.current ? 'step' : undefined}
          aria-label={`Part ${p.number} of ${summary.total}, ${STATE_LABEL[p.state]}${p.flagged ? ', flagged' : ''}${p.current ? ', current' : ''}`}
          className={`h-9 min-w-9 rounded-full border px-3 text-sm font-semibold transition-colors max-xl:h-11 max-xl:min-w-11 ${STATE_STYLE[p.state]} ${p.current ? 'ring-2 ring-fountain-ink ring-offset-1' : ''}`}
        >
          {p.number}
          {p.flagged ? <span aria-hidden="true" className="ml-1 text-xs">⚑</span> : null}
        </button>
      ))}
      <span className="ml-1 text-xs text-charcoal-graphite/70">
        {summary.answered} of {summary.total} answered
        {showScore && summary.answered > 0 ? ` · ${Math.round(summary.points * 100) / 100} of ${summary.total} points` : ''}
      </span>
    </nav>
  )
}
