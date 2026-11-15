'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { createStudyspaceAction } from '@/app/spaces/actions'
import { MAX_SPACE_GOAL_LENGTH, MAX_SPACE_NAME_LENGTH } from '@/lib/spaceLimits'

/** Step 0 of the wizard: name and optional goal, then on to the upload step. */
export function NewSpaceForm() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (saving) return
    if (!name.trim()) {
      setError('Enter a name for the studyspace.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const result = await createStudyspaceAction({ name, goal })
      if (!result.ok) {
        setError(result.reason)
        setSaving(false)
        return
      }
      router.push(`/spaces/${result.id}/setup?step=upload`)
    } catch {
      setError('Could not create the studyspace. Check your connection and try again.')
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5 rounded-xl border border-charcoal-graphite/10 bg-card p-5 font-sans shadow-md sm:p-6">
      <div>
        <h1 className="font-display text-2xl font-bold italic tracking-tight text-charcoal-graphite">New studyspace</h1>
        <p className="mt-1 text-sm text-charcoal-graphite/65">Give it a name. Next you upload the files to study from.</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="space-name" className="text-sm font-semibold text-charcoal-graphite">Name</label>
        <Input id="space-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={MAX_SPACE_NAME_LENGTH} required autoFocus disabled={saving} className="h-10 bg-background" placeholder="For example: Organic chemistry II" />
        <span className="text-xs text-charcoal-graphite/50" data-testid="name-count">{name.length}/{MAX_SPACE_NAME_LENGTH}</span>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="space-goal" className="text-sm font-semibold text-charcoal-graphite">Goal <span className="font-normal text-charcoal-graphite/55">(optional)</span></label>
        <textarea
          id="space-goal"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          maxLength={MAX_SPACE_GOAL_LENGTH}
          rows={3}
          disabled={saving}
          placeholder="For example: pass the final exam in January"
          className="w-full rounded-lg border border-input bg-background px-2.5 py-2 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 md:text-sm"
        />
        <span className="text-xs text-charcoal-graphite/50">{goal.length}/{MAX_SPACE_GOAL_LENGTH}</span>
      </div>
      {error && <p role="alert" className="text-sm font-medium text-lecture-red">{error}</p>}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Link href="/spaces" className="inline-flex h-10 items-center justify-center rounded-lg border border-charcoal-graphite/15 px-4 text-sm font-medium text-charcoal-graphite hover:bg-muted">Cancel</Link>
        <Button type="submit" disabled={saving || !name.trim()} className="h-10 border-0 bg-lecture-red px-5 font-semibold text-white hover:bg-lecture-red/90">
          {saving ? 'Creating...' : 'Create and upload files'}
        </Button>
      </div>
    </form>
  )
}
