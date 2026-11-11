'use server'

import { requireAuth } from '@/server/auth'
import { prisma } from '@/lib/db'
import { resolveProfile } from '@/lib/studyspace/resolveProfile'
import type { TutorProfile } from '@/lib/studyspace/profile'
import { listSpaceSummaries, renameCourse, type SpaceSummary } from '@/services/spaceSummaries'
import { createStudyspace, type CreateSpaceResult } from '@/services/studyspaceService'
import { getSpaceStatus, type SpaceStatus } from '@/services/spaceStatus'
import type { AdminResult } from '@/server/ingest/admin'
import * as outline from '@/services/outlineService'
import type { OutlineReadResult, OutlineResult, MergeResult } from '@/services/outlineService'

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

// --- Outline (T24) ---------------------------------------------------------------------------------------------------
// Every id is checked against the given studyspace in the service; refusals come back as { ok: false, reason }.

/** Modules with their topics in order. */
export async function getOutlineAction(courseId: string): Promise<OutlineReadResult> {
  await requireAuth()
  if (typeof courseId !== 'string' || !courseId) return { ok: false, reason: 'Studyspace not found.' }
  return outline.getOutline(courseId)
}

export async function renameTopicAction(courseId: string, topicId: string, title: string): Promise<OutlineResult> {
  await requireAuth()
  return outline.renameTopic(courseId, topicId, title)
}

/** `from` is the stored label of the module ("02 · Title"), `to` the new title; the number prefix stays. */
export async function renameModuleAction(courseId: string, from: string, to: string): Promise<OutlineResult> {
  await requireAuth()
  return outline.renameModule(courseId, from, to)
}

/** Merges adjacent topics of one file (same module) into the first; returns the kept topic. */
export async function mergeTopicsAction(courseId: string, topicIds: string[]): Promise<MergeResult> {
  await requireAuth()
  return outline.mergeTopics(courseId, topicIds)
}

/** `orderedTopicIds` lists every topic of the studyspace once; modules are ordered by their first topic. */
export async function reorderAction(courseId: string, orderedTopicIds: string[]): Promise<OutlineResult> {
  await requireAuth()
  return outline.reorderTopics(courseId, orderedTopicIds)
}

/** Moves a topic to the end of another module (`module` is the stored label of that module). */
export async function moveTopicToModuleAction(courseId: string, topicId: string, module: string): Promise<OutlineResult> {
  await requireAuth()
  return outline.moveTopicToModule(courseId, topicId, module)
}

// --- Persona (T25) ---------------------------------------------------------------------------------------------------
// Refusals come back as { ok: false, reason }. The proposal takes 10 to 30 seconds; the caller shows a waiting state.

type PersonaStepResult = import('@/server/ingest/persona').PersonaStep | import('@/server/ingest/persona').PersonaFailure

/**
 * What the persona step shows: for a studyspace without an accepted tutor, the initial proposal (made now, once, unless a stored one
 * still matches the ready files); for one with an accepted tutor, that profile for editing, plus the progress of the starter questions.
 */
export async function getPersonaStepAction(courseId: string): Promise<PersonaStepResult> {
  await requireAuth()
  if (typeof courseId !== 'string' || !courseId) return { ok: false, reason: 'Studyspace not found.' }
  const { getPersonaStep } = await import('@/server/ingest/persona')
  return getPersonaStep(courseId)
}

/** Makes a new proposal and replaces the stored one (only while no tutor is accepted yet). */
export async function regenerateProfileAction(courseId: string): Promise<PersonaStepResult> {
  await requireAuth()
  if (typeof courseId !== 'string' || !courseId) return { ok: false, reason: 'Studyspace not found.' }
  const { getPersonaStep } = await import('@/server/ingest/persona')
  return getPersonaStep(courseId, {}, { force: true })
}

/**
 * Validates the profile on the server, stores it as the studyspace's tutor, clears the suggestion and asks for the starter questions
 * (once; editing an accepted tutor later starts nothing unless the last run failed).
 */
export async function acceptProfileAction(courseId: string, profile: TutorProfile): Promise<import('@/server/ingest/persona').AcceptResult> {
  await requireAuth()
  if (typeof courseId !== 'string' || !courseId) return { ok: false, reason: 'Studyspace not found.' }
  const { acceptProfile } = await import('@/server/ingest/persona')
  const { requestStarters } = await import('@/server/ingest/runner')
  return acceptProfile(courseId, profile, { requestStarters })
}

/**
 * Throws away the stored suggestion (an update the owner ignores). The accepted tutor stays as it is. `createdAt` is the suggestion the
 * owner was looking at: a newer one that replaced it is kept.
 */
export async function dismissProfileSuggestionAction(courseId: string, createdAt?: string): Promise<AdminResult> {
  await requireAuth()
  if (typeof courseId !== 'string' || !courseId) return { ok: false, reason: 'Studyspace not found.' }
  const { dismissSuggestion } = await import('@/server/ingest/persona')
  return dismissSuggestion(courseId, typeof createdAt === 'string' ? createdAt : undefined)
}

/** The stored tutor update, if any (what the open page shows in its banner). */
export async function getUpdateSuggestionAction(courseId: string): Promise<import('@/lib/studyspace/profile').ProfileSuggestion | null> {
  await requireAuth()
  if (typeof courseId !== 'string' || !courseId) return null
  const row = await prisma.course.findUnique({ where: { id: courseId }, select: { profileSuggestion: true } })
  const { parseUpdateSuggestion } = await import('@/lib/studyspace/suggestion')
  return parseUpdateSuggestion(row?.profileSuggestion)
}

/** Accept on a suggested tutor update: applies exactly the suggestion the owner saw (`createdAt` names it); starts no starter run. */
export async function acceptProfileUpdateAction(courseId: string, createdAt: string): Promise<AdminResult> {
  await requireAuth()
  if (typeof courseId !== 'string' || !courseId || typeof createdAt !== 'string' || !createdAt) return { ok: false, reason: 'Studyspace not found.' }
  const { acceptUpdateSuggestion } = await import('@/server/ingest/persona')
  return acceptUpdateSuggestion(courseId, createdAt)
}

/** "Keep together": removes the split offer from the stored proposal, nothing else. */
export async function dismissSplitNoticeAction(courseId: string): Promise<AdminResult> {
  await requireAuth()
  if (typeof courseId !== 'string' || !courseId) return { ok: false, reason: 'Studyspace not found.' }
  const { dismissSplitNotice } = await import('@/server/ingest/persona')
  return dismissSplitNotice(courseId)
}

/** Splits a studyspace: the first group stays, each other group becomes a new studyspace with its files, topics and questions. */
export async function splitStudyspaceAction(courseId: string, groups: { label: string; sourceIds: string[] }[]): Promise<import('@/server/ingest/split').SplitResult> {
  await requireAuth()
  if (typeof courseId !== 'string' || !courseId) return { ok: false, reason: 'Studyspace not found.' }
  const { splitStudyspace } = await import('@/server/ingest/split')
  return splitStudyspace(courseId, groups)
}
