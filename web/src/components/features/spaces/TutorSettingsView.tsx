'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { PersonaStep } from '@/server/ingest/persona'
import { PersonaCard } from './PersonaCard'

/** /spaces/<id>/tutor: the tutor of one studyspace, for editing later. */
export function TutorSettingsView({ courseId, title, initialPersona }: { courseId: string; title: string; initialPersona?: PersonaStep | null }) {
  const router = useRouter()
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 font-sans">
      <header className="flex flex-col gap-3">
        <Link href="/spaces" className="w-fit text-sm text-charcoal-graphite/60 hover:text-charcoal-graphite hover:underline">All studyspaces</Link>
        <h1 className="break-words font-display text-2xl font-bold italic tracking-tight text-charcoal-graphite sm:text-3xl">{title}</h1>
        <p className="text-sm text-charcoal-graphite/70">Tutor settings</p>
      </header>
      <PersonaCard courseId={courseId} initial={initialPersona ?? undefined} onStudy={() => router.push(`/spaces/${courseId}`)} />
    </div>
  )
}
