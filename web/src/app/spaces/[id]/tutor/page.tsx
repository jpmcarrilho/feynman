import { notFound, redirect } from 'next/navigation'
import { checkIsAuthenticated } from '@/app/auth-actions'
import { getSpaceStatus } from '@/services/spaceStatus'
import { getCourseWithProfile } from '@/services/studyspaceService'
import { readStoredPersonaStep } from '@/server/ingest/persona'
import { TutorSettingsView } from '@/components/features/spaces/TutorSettingsView'

export const dynamic = 'force-dynamic'

export default async function SpaceTutorPage({ params }: { params: Promise<{ id: string }> }) {
  // Guard on the server first: an unknown id must not tell a visitor without the passcode anything
  if (!(await checkIsAuthenticated())) {
    redirect('/')
  }
  const { id } = await params
  const status = await getSpaceStatus(id)
  if (!status) {
    notFound()
  }
  // A studyspace without topics is still being set up; its tutor is chosen in the setup steps
  if (status.outline.topics === 0) {
    redirect(`/spaces/${status.courseId}/setup`)
  }
  const initialPersona = await readStoredPersonaStep(status.courseId)
  // A tutor update suggested after a file was added, waiting for the owner's decision
  const updateSuggestion = (await getCourseWithProfile(status.courseId))?.updateSuggestion ?? null
  return (
    <main className="min-h-screen bg-background px-4 py-8 sm:px-8 sm:py-12">
      <TutorSettingsView key={status.courseId} courseId={status.courseId} title={status.title} initialPersona={initialPersona} updateSuggestion={updateSuggestion} />
    </main>
  )
}
