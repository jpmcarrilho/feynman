'use server'

import { requireAuth } from '@/server/auth'
import { prisma } from '@/lib/db'
import { resolveProfile } from '@/lib/studyspace/resolveProfile'
import type { TutorProfile } from '@/lib/studyspace/profile'
import { listSpaceSummaries, renameCourse, type SpaceSummary } from '@/services/spaceSummaries'

const MAX_NAME_LENGTH = 120

/** Every studyspace with its card numbers (see listSpaceSummaries for how they are computed). */
export async function listStudyspacesAction(): Promise<SpaceSummary[]> {
  await requireAuth()
  return listSpaceSummaries()
}

/** The tutor profile of a studyspace: the stored one, else the legacy profile of the two MIT courses, else a default. */
export async function getProfileAction(courseId: string): Promise<TutorProfile> {
  await requireAuth()
  const course = typeof courseId === 'string' && courseId ? await prisma.course.findUnique({ where: { id: courseId } }) : null
  if (!course) throw new Error('Studyspace not found.')
  return resolveProfile(course)
}

/** Renames a studyspace (its title only; the code and everything stored under it stay). */
export async function renameStudyspaceAction(id: string, name: string): Promise<void> {
  await requireAuth()
  const title = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : ''
  if (!title) throw new Error('A studyspace needs a name.')
  if (title.length > MAX_NAME_LENGTH) throw new Error(`The name can have at most ${MAX_NAME_LENGTH} characters.`)
  if (typeof id !== 'string' || !id || !(await renameCourse(id, title))) throw new Error('Studyspace not found.')
}
