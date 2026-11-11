import { notFound, redirect } from 'next/navigation'
import { checkIsAuthenticated } from '@/app/auth-actions'
import { getCourseWithProfile } from '@/services/studyspaceService'
import { StudyInterface } from '@/components/features/StudyInterface'

export const dynamic = 'force-dynamic'

export default async function SpacePage({ params }: { params: Promise<{ id: string }> }) {
  // Guard on the server first: an unknown id must not tell a visitor without the passcode anything
  if (!(await checkIsAuthenticated())) {
    redirect('/')
  }

  const { id } = await params
  // Stored profile, else the legacy profile of the two MIT courses, else a neutral default (resolveProfile)
  const course = await getCourseWithProfile(id)
  if (!course) {
    notFound()
  }

  // key: moving from one studyspace to another remounts the interface, so no state of the first one survives
  return <StudyInterface key={course.id} courseId={course.id} courseTitle={course.title} profile={course.profile} />
}
