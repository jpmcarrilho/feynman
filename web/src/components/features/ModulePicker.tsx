'use client'

import { useRef } from 'react'
import { moduleRange, weakestModules, type ModuleStat } from '@/lib/sessionConfig'

/**
 * The modules (course weeks) of a studyspace as cards: how many questions, how much of it the student has seen and how it went, so a
 * week can be picked by progress. Click toggles a module, shift-click takes every module between the last click and this one.
 */
export function ModulePicker({ stats, selected, onChange, formatLabel }: {
  stats: ModuleStat[]
  selected: string[]
  onChange: (next: string[]) => void
  formatLabel: (key: string) => string
}) {
  const lastClicked = useRef<string | null>(null)

  const toggle = (key: string, shift: boolean) => {
    if (shift && lastClicked.current && lastClicked.current !== key) {
      const range = moduleRange(stats, lastClicked.current, key)
      onChange([...new Set([...selected, ...range])])
    } else {
      onChange(selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key])
    }
    lastClicked.current = key
  }

  return (
    <div className="flex flex-col" data-testid="module-picker">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">Module</span>
        <div className="flex flex-wrap gap-1.5 text-xs">
          <button type="button" className="rounded-full border border-input px-2.5 py-1 font-semibold hover:bg-muted" onClick={() => onChange(stats.filter((s) => s.questions > 0).map((s) => s.key))}>All</button>
          <button type="button" className="rounded-full border border-input px-2.5 py-1 font-semibold hover:bg-muted" onClick={() => onChange(weakestModules(stats, 3))}>Weakest 3</button>
          <button type="button" className="rounded-full border border-input px-2.5 py-1 font-semibold hover:bg-muted" onClick={() => onChange([])}>Clear</button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {stats.map((s) => {
          const isSelected = selected.includes(s.key)
          const empty = s.questions === 0
          return (
            <button
              key={s.key}
              type="button"
              aria-pressed={isSelected}
              onClick={(e) => toggle(s.key, e.shiftKey)}
              className={`flex min-w-0 flex-col gap-1.5 rounded-lg border p-2.5 text-left transition-colors ${
                isSelected ? 'border-fountain-ink bg-fountain-ink/10 ring-1 ring-fountain-ink' : 'border-input bg-card/40 hover:bg-muted'
              } ${empty ? 'opacity-60' : ''}`}
            >
              <span className="whitespace-normal break-words text-xs font-semibold leading-tight text-charcoal-graphite">{formatLabel(s.key)}</span>
              {empty ? (
                <span className="text-[10px] text-muted-foreground">No questions yet</span>
              ) : (
                <>
                  <span className="flex items-center justify-between gap-1 text-[10px] text-muted-foreground">
                    <span>{s.questions} questions</span>
                    {s.accuracy === null ? (
                      <span className="rounded-sm border bg-muted/40 px-1 font-bold uppercase">Unseen</span>
                    ) : (
                      <span className={`rounded-sm border px-1 font-bold uppercase ${s.accuracy >= 70 ? 'border-green-200 bg-green-50 text-green-700' : s.accuracy >= 50 ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-red-200 bg-red-50 text-red-700'}`}>{s.accuracy}% acc</span>
                    )}
                  </span>
                  <span className="h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
                    <span className="block h-full rounded-full bg-fountain-ink" style={{ width: `${s.coverage}%` }} />
                  </span>
                  <span className="flex justify-between text-[10px] text-muted-foreground">
                    <span>{s.coverage}% seen</span>
                    {s.problems > 0 ? <span>{s.problems} {s.problems === 1 ? 'problem' : 'problems'}</span> : null}
                  </span>
                </>
              )}
            </button>
          )
        })}
        {stats.length === 0 && <div className="col-span-full p-3 text-center text-xs italic text-muted-foreground">No modules</div>}
      </div>
    </div>
  )
}
