'use server'

import { requireAuth } from '@/server/auth'
import { prisma } from '@/lib/db'
import { resolveProfile } from '@/lib/studyspace/resolveProfile'
import type { TutorProfile } from '@/lib/studyspace/profile'
import { listSpaceSummaries, renameCourse, type SpaceSummary } from '@/services/spaceSummaries'
import { createStudyspace, type CreateSpaceResult } from '@/services/studyspaceService'
import { getSpaceStatus, type SpaceStatus } from '@/services/spaceStatus'
import type { AdminResult } from '@/server/ingest/admin'

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

// --- Upload pipeline (T23) -------------------------------------------------------------------------------------------
// Refusals come back as { ok: false, reason } because the message of an error thrown from a server action is masked in
// production builds; only a missing session throws.

/** Creates an empty studyspace (name ≤ 80 characters, optional goal ≤ 300). The caller then opens /spaces/<id>/setup. */
export async function createStudyspaceAction(input: { name: string; goal?: string }): Promise<CreateSpaceResult> {
  await requireAuth()
  return createStudyspace(input ?? {})
}

/** Deletes a studyspace and everything it owns; `confirmTitle` must equal its title exactly. */
export async function deleteStudyspaceAction(id: string, confirmTitle: string): Promise<AdminResult> {
  await requireAuth()
  if (typeof id !== 'string' || !id) return { ok: false, reason: 'Studyspace not found.' }
  const { deleteStudyspace } = await import('@/server/ingest/admin')
  return deleteStudyspace(id, confirmTitle)
}

/**
 * Status of every file of a studyspace for the wizard: safe to call every 2 seconds. Reads only; when this process has
 * nothing running and the studyspace has unfinished work it also queues that work (the safety net for a missed boot resume).
 */
export async function getSpaceStatusAction(id: string): Promise<SpaceStatus | null> {
  await requireAuth()
  if (typeof id !== 'string' || !id) return null
  const status = await getSpaceStatus(id)
  if (!status) return null
  const unfinished = status.processing || status.starterStatus === 'pending' || status.starterStatus === 'running'
  if (unfinished) {
    const { wakeIfIdle } = await import('@/server/ingest/runner')
    await wakeIfIdle(id).catch((error) => console.warn('[ingest] wake failed:', error))
  }
  return status
}

/** Retries a failed file from the stage that failed. */
export async function retrySourceAction(sourceId: string): Promise<AdminResult> {
  await requireAuth()
  if (typeof sourceId !== 'string' || !sourceId) return { ok: false, reason: 'File not found.' }
  const { retrySource } = await import('@/server/ingest/admin')
  return retrySource(sourceId)
}

/** Removes a file with its topics and questions; refused when a question from it was already answered. */
export async function removeSourceAction(sourceId: string): Promise<AdminResult> {
  await requireAuth()
  if (typeof sourceId !== 'string' || !sourceId) return { ok: false, reason: 'File not found.' }
  const { removeSource } = await import('@/server/ingest/admin')
  return removeSource(sourceId)
}
