'use client'

import { PRESETS, type PresetId } from '@/lib/sessionConfig'

/** One-click goals above the settings: each sets mode, length, mix and focus; everything can still be changed afterwards. */
export function PresetBar({ onPreset, onLast, hasLast }: { onPreset: (id: PresetId) => void; onLast: () => void; hasLast: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Session goals" data-testid="preset-bar">
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Goal</span>
      {PRESETS.map((p) => (
        <button
          key={p.id}
          type="button"
          title={p.hint}
          onClick={() => onPreset(p.id)}
          className="rounded-full border border-input bg-card/40 px-3 py-1.5 text-xs font-semibold text-charcoal-graphite hover:bg-fountain-ink/10 hover:border-fountain-ink/40 max-xl:py-2"
        >
          {p.label}
        </button>
      ))}
      {hasLast && (
        <button
          type="button"
          title="The settings of your last session"
          onClick={onLast}
          className="rounded-full border border-fountain-ink/40 bg-fountain-ink/10 px-3 py-1.5 text-xs font-semibold text-fountain-ink hover:bg-fountain-ink/15 max-xl:py-2"
        >
          Same as last time
        </button>
      )}
    </div>
  )
}
