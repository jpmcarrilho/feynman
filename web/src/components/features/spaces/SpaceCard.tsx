'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Pencil, PlayCircle } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { renameStudyspaceAction } from '@/app/spaces/actions'
import { LocalDate } from '@/components/features/LocalDate'
import type { SpaceSummary } from '@/services/spaceSummaries'

const MAX_NAME_LENGTH = 120

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col rounded-lg border border-charcoal-graphite/10 bg-background/60 px-3 py-2">
      <span className="text-lg font-bold text-charcoal-graphite leading-tight" data-testid={`stat-${label.toLowerCase()}`}>{value.toLocaleString('en-US')}</span>
      <span className="text-[10px] font-semibold uppercase tracking-wider text-charcoal-graphite/50">{label}</span>
    </div>
  )
}

/** One studyspace on the /spaces page: numbers, last studied, accuracy, open and rename. */
export function SpaceCard({ space }: { space: SpaceSummary }) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(space.title)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed || saving) return
    if (trimmed === space.title) {
      setEditing(false)
      return
    }
    setSaving(true)
    setError(null)
    try {
      await renameStudyspaceAction(space.id, trimmed)
      setEditing(false)
      router.refresh()
    } catch {
      setError('Could not rename this studyspace. Check the name (1 to 120 characters) and try again.')
    } finally {
      setSaving(false)
    }
  }

  const cancel = () => {
    setName(space.title)
    setError(null)
    setEditing(false)
  }

  return (
    <Card className="border border-charcoal-graphite/10 shadow-md bg-card font-sans" data-testid="space-card">
      <CardHeader className="gap-2">
        <div className="flex items-start justify-between gap-2">
          {editing ? (
            <form onSubmit={save} className="flex w-full flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                aria-label="Studyspace name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={MAX_NAME_LENGTH}
                disabled={saving}
                autoFocus
                className="h-9 flex-1 bg-background text-sm"
              />
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={saving || !name.trim()} className="bg-fountain-ink hover:bg-fountain-ink/90 text-white border-0">
                  {saving ? 'Saving...' : 'Save'}
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={cancel} disabled={saving}>Cancel</Button>
              </div>
            </form>
          ) : (
            <>
              <CardTitle className="font-display italic text-xl font-bold leading-snug text-charcoal-graphite break-words min-w-0">{space.title}</CardTitle>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Rename ${space.title}`}
                title="Rename"
                onClick={() => setEditing(true)}
                className="shrink-0 text-charcoal-graphite/50 hover:text-charcoal-graphite"
              >
                <Pencil className="size-4" />
              </Button>
            </>
          )}
        </div>
        {error && <p role="alert" className="text-xs font-medium text-lecture-red">{error}</p>}
        {space.goal && <p className="text-xs leading-relaxed text-charcoal-graphite/65 line-clamp-3">{space.goal}</p>}
        {space.hasActiveSession && (
          <span className="w-fit rounded-full bg-lecture-red/10 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-lecture-red">Session in progress</span>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Modules" value={space.moduleCount} />
          <Stat label="Topics" value={space.topicCount} />
          <Stat label="Questions" value={space.questionCount} />
        </div>
        <dl className="grid grid-cols-2 gap-2 text-xs text-charcoal-graphite/70">
          <div>
            <dt className="font-semibold uppercase tracking-wider text-[10px] text-charcoal-graphite/50">Last studied</dt>
            <dd data-testid="last-studied">
              {space.lastStudiedAt ? (
                <LocalDate value={space.lastStudiedAt} />
              ) : (
                'Not studied yet'
              )}
            </dd>
          </div>
          <div>
            <dt className="font-semibold uppercase tracking-wider text-[10px] text-charcoal-graphite/50">Accuracy to date</dt>
            <dd data-testid="accuracy">{space.accuracy === null ? 'No answers yet' : `${space.accuracy}%`}</dd>
          </div>
        </dl>
        <Link
          href={`/spaces/${space.id}`}
          className={buttonVariants({ className: 'h-11 w-full gap-2 bg-lecture-red text-white hover:bg-lecture-red/90 border-0 shadow-sm font-semibold text-base' })}
        >
          <PlayCircle className="size-5" />
          Open
        </Link>
      </CardContent>
    </Card>
  )
}
