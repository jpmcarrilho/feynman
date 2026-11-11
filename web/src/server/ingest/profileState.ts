// Whether a studyspace already has a tutor, shared by the runner (starter questions) and the upload route (bundle).
import { prisma } from '@/lib/db'
import { parseProfile } from '@/lib/studyspace/profile'

/**
 * True when the studyspace has a stored, valid tutor profile, or is one of the two imported studyspaces (topics that did not come
 * from an upload), which tutor with their legacy profile (resolveProfile) even where none is stored.
 */
export async function courseHasTutor(courseId: string): Promise<boolean> {
  const course = await prisma.course.findUnique({ where: { id: courseId }, select: { profile: true } })
  if (!course) return false
  if (parseProfile(course.profile) !== null) return true
  return (await prisma.topic.count({ where: { courseId, sourceId: null } })) > 0
}
