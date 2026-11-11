'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { SETUP_STEPS, SETUP_STEP_LABELS, type SetupStep } from '@/lib/setupSteps'
import { SourceDropzone } from './SourceDropzone'
import { ProcessingView } from './ProcessingView'
import { OutlineEditor } from './OutlineEditor'
import type { PersonaStep } from '@/server/ingest/persona'
import { PersonaCard } from './PersonaCard'

/** The setup steps of one studyspace. The first step comes from the server (resolveSetupStep); moving on updates the address without a reload. */
export function SetupWizard({ courseId, title, initialStep, initialPersona }: { courseId: string; title: string; initialStep: SetupStep; initialPersona?: PersonaStep | null }) {
  const router = useRouter()
  const [step, setStepState] = useState<SetupStep>(initialStep)
  const [uploading, setUploading] = useState(false)
  const [accepted, setAccepted] = useState(0)

  // The address always names the step that is shown (a reload on ?step=upload while files are processing lands on processing)
  useEffect(() => {
    window.history.replaceState(null, '', `/spaces/${encodeURIComponent(courseId)}/setup?step=${initialStep}`)
  }, [courseId, initialStep])

  const go = (next: SetupStep) => {
    setStepState(next)
    window.history.replaceState(null, '', `/spaces/${encodeURIComponent(courseId)}/setup?step=${next}`)
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 font-sans">
      <header className="flex flex-col gap-3">
        <Link href="/spaces" className="w-fit text-sm text-charcoal-graphite/60 hover:text-charcoal-graphite hover:underline">All studyspaces</Link>
        <h1 className="break-words font-display text-2xl font-bold italic tracking-tight text-charcoal-graphite sm:text-3xl">{title}</h1>
        <ol className="flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label="Setup steps">
          {SETUP_STEPS.map((s, i) => (
            <li key={s} aria-current={s === step ? 'step' : undefined} className={s === step ? 'font-semibold text-charcoal-graphite' : 'text-charcoal-graphite/50'}>
              {i + 1}. {SETUP_STEP_LABELS[s]}
            </li>
          ))}
        </ol>
      </header>

      {step === 'upload' && (
        <section className="flex flex-col gap-4" aria-label="Upload files">
          <div>
            <h2 className="font-display text-xl font-bold italic text-charcoal-graphite">Upload your files</h2>
            <p className="mt-1 text-sm text-charcoal-graphite/70">Add lecture notes, slides or readings as .txt, .md or .pdf. Files that contain practice questions are used for them too.</p>
          </div>
          <SourceDropzone courseId={courseId} bundle="initial" onUploaded={() => setAccepted((n) => n + 1)} onBusyChange={setUploading} />
          <div className="flex justify-end">
            <Button type="button" disabled={uploading || accepted === 0} onClick={() => go('processing')} className="h-10 border-0 bg-lecture-red px-5 font-semibold text-white hover:bg-lecture-red/90">
              {uploading ? 'Uploading...' : 'Continue'}
            </Button>
          </div>
        </section>
      )}

      {step === 'processing' && <ProcessingView courseId={courseId} onReview={() => go('outline')} />}

      {step === 'outline' && <OutlineEditor courseId={courseId} continueLabel="Continue" onBack={() => go('processing')} onContinue={() => go('persona')} />}

      {step === 'persona' && <PersonaCard courseId={courseId} initial={step === initialStep ? initialPersona ?? undefined : undefined} onBack={() => go('outline')} onStudy={() => router.push(`/spaces/${courseId}`)} />}
    </div>
  )
}
