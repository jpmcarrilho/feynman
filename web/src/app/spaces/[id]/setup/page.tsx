import { notFound, redirect } from 'next/navigation'
import { checkIsAuthenticated } from '@/app/auth-actions'
import { getSpaceStatus } from '@/services/spaceStatus'
import { isImportedStudyspace } from '@/services/outlineService'
import { resolveSetupStep } from '@/lib/setupSteps'
import { SetupWizard } from '@/components/features/spaces/SetupWizard'

export const dynamic = 'force-dynamic'

export default async function SpaceSetupPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  // Guard on the server first: an unknown id must not tell a visitor without the passcode anything
  if (!(await checkIsAuthenticated())) {
    redirect('/')
  }

  const { id } = await params
  const { step } = await searchParams
  const status = await getSpaceStatus(id)
  if (!status) {
    notFound()
  }

  // Imported studyspaces (topics without a file) have no setup; adding files to an existing studyspace is done from the study page
  if (await isImportedStudyspace(id)) {
    redirect(`/spaces/${id}`)
  }

  // The requested step is only a hint: what the files are doing decides (so a reload always lands on a step that makes sense)
  const initial = status.sources.filter((s) => s.bundle === 'initial')
  const initialStep = resolveSetupStep(typeof step === 'string' ? step : null, {
    sourceCount: initial.length,
    initialFinished: status.initialBundleFinished,
    readyInitialCount: initial.filter((s) => s.status === 'ready').length,
  })

  return (
    <main className="min-h-screen bg-background px-4 py-8 sm:px-8 sm:py-12">
      <SetupWizard key={status.courseId} courseId={status.courseId} title={status.title} initialStep={initialStep} />
    </main>
  )
}
