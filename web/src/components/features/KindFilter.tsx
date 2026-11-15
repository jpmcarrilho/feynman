'use client'

import { HOMEWORK_CLASS, FINGER_CLASS } from '@/lib/weekLabels'

/**
 * Homework or finger exercises (the short quizzes after each lecture video), as one row of chips above the class list. It sets the
 * class filter, so it works with the modules ticked above it. Shown only when the studyspace has at least one of the two kinds.
 */
export function KindFilter({ availableClasses, selectedClasses, onChange }: {
  availableClasses: string[]
  selectedClasses: string[]
  onChange: (next: string[]) => void
}) {
  const has = (name: string) => availableClasses.includes(name)
  if (!has(HOMEWORK_CLASS) && !has(FINGER_CLASS)) return null
  const only = (name: string) => selectedClasses.length === 1 && selectedClasses[0] === name
  const options: { label: string; active: boolean; next: string[]; show: boolean }[] = [
    { label: 'Both', active: !only(HOMEWORK_CLASS) && !only(FINGER_CLASS) && !(selectedClasses.includes(HOMEWORK_CLASS) || selectedClasses.includes(FINGER_CLASS)), next: [], show: true },
    { label: 'Homework', active: only(HOMEWORK_CLASS), next: [HOMEWORK_CLASS], show: has(HOMEWORK_CLASS) },
    { label: 'Finger exercises', active: only(FINGER_CLASS), next: [FINGER_CLASS], show: has(FINGER_CLASS) },
  ]
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Kind of exercise" data-testid="kind-filter">
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Kind</span>
      {options.filter((o) => o.show).map((o) => (
        <button
          key={o.label}
          type="button"
          aria-pressed={o.active}
          onClick={() => onChange(o.next)}
          className={`rounded-full border px-3 py-1.5 text-xs font-semibold max-xl:py-2 ${o.active ? 'border-fountain-ink bg-fountain-ink/10 text-fountain-ink ring-1 ring-fountain-ink' : 'border-input bg-card/40 text-charcoal-graphite hover:bg-muted'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
