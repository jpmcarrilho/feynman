'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { acceptProfileUpdateAction, dismissProfileSuggestionAction } from '@/app/spaces/actions'
import { profileChanges } from '@/lib/studyspace/suggestion'
import type { ProfileSuggestion, TutorProfile } from '@/lib/studyspace/profile'

/**
 * A tutor update the app suggests after a file was added to the studyspace: why, and each changed field as "field: old → new".
 * Nothing changes until the owner clicks Accept (applies exactly the suggested profile; no starter questions are made) or Ignore.
 * `current` is the tutor in use now. `onResolved` runs after either, with the profile now in use, so the page can use it at once; after
 * Accept the banner stays as a short confirmation until it is dismissed, after Ignore it is gone.
 * `where` says which screen it is on: the tutor settings form below the banner is replaced by Accept.
 */
export function ProfileSuggestionBanner({
  courseId,
  suggestion,
  current,
  onResolved,
  where = 'study',
}: {
  courseId: string
  suggestion: ProfileSuggestion
  current: TutorProfile
  onResolved?: (outcome: 'accepted' | 'ignored', profile: TutorProfile) => void
  where?: 'study' | 'settings'
}) {
  const [busy, setBusy] = useState<'accept' | 'ignore' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<'accepted' | 'closed' | null>(null)
  const changes = profileChanges(current, suggestion.profile)

  // Only a suggested update has a banner; the first proposal of a new studyspace is shown by the tutor card
  if (suggestion.kind !== 'update' || done === 'closed') return null
  if (done === 'accepted') {
    return (
      <div role="status" className="flex items-start justify-between gap-3 rounded-lg border border-emerald-700/25 bg-emerald-50/60 p-3 text-sm text-charcoal-graphite font-sans">
        <p>
          Tutor updated. New questions and chat replies use it from now on. A voice call that is already open keeps the old tutor until you disconnect and connect again.
        </p>
        <Button type="button" size="sm" variant="outline" className="h-10 shrink-0 px-3 sm:h-9" aria-label="Dismiss the tutor updated message" onClick={() => setDone('closed')}>OK</Button>
      </div>
    )
  }

  const act = async (kind: 'accept' | 'ignore') => {
    if (busy) return
    setBusy(kind)
    setError(null)
    try {
      const result = kind === 'accept' ? await acceptProfileUpdateAction(courseId, suggestion.createdAt) : await dismissProfileSuggestionAction(courseId, suggestion.createdAt)
      if (!result.ok) {
        setError(result.reason)
        return
      }
      setDone(kind === 'accept' ? 'accepted' : 'closed')
      onResolved?.(kind === 'accept' ? 'accepted' : 'ignored', kind === 'accept' ? suggestion.profile : current)
    } catch {
      setError('Could not reach the server. Try again.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section aria-label="Suggested tutor update" className="flex flex-col gap-3 rounded-lg border border-fountain-ink/30 bg-fountain-ink/5 p-3 text-sm text-charcoal-graphite font-sans sm:p-4">
      <div>
        <h2 className="font-display text-base font-bold italic">Suggested tutor update</h2>
        <p className="mt-1 break-words">{suggestion.rationale}</p>
      </div>
      {changes.length > 0 && (
        <ul aria-label="Changes to the tutor" className="flex flex-col gap-1">
          {changes.map((c) => (
            <li key={c.field} className="break-words">
              <span className="font-semibold">{c.label}:</span> {c.from === null ? c.to : <>{c.from} <span aria-label="becomes">→</span> {c.to}</>}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-charcoal-graphite/70">
        Nothing changes unless you accept. Tone, chat mode and exam settings stay as you set them.
        {where === 'settings' ? ' Accepting replaces any unsaved change in the form below.' : ''}
      </p>
      {error && <p role="alert" className="text-sm font-medium text-lecture-red">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" aria-busy={busy === 'accept'} disabled={busy !== null} className="h-10 border-0 bg-lecture-red px-5 font-semibold text-white hover:bg-lecture-red/90" onClick={() => void act('accept')}>
          {busy === 'accept' ? 'Applying…' : 'Accept'}
        </Button>
        <Button type="button" variant="outline" aria-busy={busy === 'ignore'} disabled={busy !== null} className="h-10 px-4" onClick={() => void act('ignore')}>
          {busy === 'ignore' ? 'Ignoring…' : 'Ignore'}
        </Button>
      </div>
    </section>
  )
}
