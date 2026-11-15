'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { PersonaStep } from '@/server/ingest/persona'
import type { ProfileSuggestion } from '@/lib/studyspace/profile'
import { PersonaCard } from './PersonaCard'
import { ProfileSuggestionBanner } from './ProfileSuggestionBanner'
import { useSuggestionWatch } from './useSuggestionWatch'

/** /spaces/<id>/tutor: the tutor of one studyspace, for editing later, with a suggested update (if one is stored) above the form. */
export function TutorSettingsView({ courseId, title, initialPersona, updateSuggestion = null }: { courseId: string; title: string; initialPersona?: PersonaStep | null; updateSuggestion?: ProfileSuggestion | null }) {
  const router = useRouter()
  const [persona, setPersona] = useState<PersonaStep | null | undefined>(initialPersona)
  const [suggestion, setSuggestion] = useState<ProfileSuggestion | null>(updateSuggestion)
  const [formKey, setFormKey] = useState(0)
  useSuggestionWatch(courseId, suggestion?.createdAt ?? null, setSuggestion)
  const [name, setName] = useState(title)
  const current = persona?.profile ?? null
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 font-sans">
      <header className="flex flex-col gap-3">
        <Link href="/spaces" className="w-fit text-sm text-charcoal-graphite/60 hover:text-charcoal-graphite hover:underline">All studyspaces</Link>
        <h1 className="break-words font-display text-2xl font-bold italic tracking-tight text-charcoal-graphite sm:text-3xl">{name}</h1>
        <p className="text-sm text-charcoal-graphite/70">Tutor settings</p>
      </header>
      {suggestion && current && (
        <ProfileSuggestionBanner
          key={suggestion.createdAt}
          courseId={courseId}
          suggestion={suggestion}
          current={current}
          where="settings"
          onResolved={(outcome, next) => {
            if (outcome === 'ignored') {
              setSuggestion(null)
              return
            }
            // The form below starts again from the tutor that was just applied
            setPersona((p) => (p ? { ...p, profile: next } : p))
            setFormKey((k) => k + 1)
          }}
        />
      )}
      <PersonaCard key={formKey} courseId={courseId} initial={persona ?? undefined} onStudy={() => router.push(`/spaces/${courseId}`)} onRenamed={setName} />
    </div>
  )
}
