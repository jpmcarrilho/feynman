'use client'

import { useState } from 'react'
import { DiagnosisMarkdown } from '../DiagnosisMarkdown'

/**
 * The stored report written before studyspaces, when one diagnosis covered both original courses. Read-only and
 * collapsed; there is no viewer on this page, so links to course files open in a new tab.
 */
export function OverallDiagnosis({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <details
      className="rounded-xl border border-charcoal-graphite/10 bg-card shadow-sm font-sans"
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-charcoal-graphite sm:px-5">
        Overall diagnosis (all studyspaces)
      </summary>
      {open && (
        <div className="border-t border-charcoal-graphite/10 px-4 py-4 sm:px-5">
          <p className="mb-3 text-xs text-charcoal-graphite/55">
            Written before studyspaces existed, over both original courses. It is kept as it was and is not updated; each studyspace has its own diagnosis in its Analytics tab.
          </p>
          <div className="prose dark:prose-invert max-w-none max-h-[60vh] overflow-y-auto break-words text-xs leading-relaxed text-charcoal-graphite/85 sm:text-sm">
            <DiagnosisMarkdown text={text} />
          </div>
        </div>
      )}
    </details>
  )
}
