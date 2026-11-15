// Changing what exists: retry a failed source, remove a source, delete a studyspace. Each refuses with a readable reason
// instead of throwing, so the wizard can show it (a thrown error from a server action is masked in production builds).
import { prisma } from '@/lib/db'
import { removeCourseStorage, removeSourceFiles } from '@/server/storage'
import { parseSuggestion } from '@/lib/studyspace/suggestion'
import { enqueueSource, acquireExclusive, SourceBusyError } from './runner'

export type AdminResult = { ok: true } | { ok: false; reason: string }

const RETRY_STAGES = ['extracting', 'segmenting', 'importing_questions', 'generating_exercises']

/** Moves a failed source back to the stage that failed and queues it. Only `failed` sources can be retried. */
export async function retrySource(sourceId: string): Promise<AdminResult> {
  const source = await prisma.source.findUnique({ where: { id: sourceId }, select: { status: true, failedStage: true } })
  if (!source) return { ok: false, reason: 'File not found.' }
  if (source.status !== 'failed') return { ok: false, reason: 'Only a file that failed can be retried.' }
  if (!source.failedStage || !RETRY_STAGES.includes(source.failedStage)) {
    return { ok: false, reason: 'This file cannot be retried. Remove it and upload it again.' }
  }
  const moved = await prisma.source.updateMany({
    where: { id: sourceId, status: 'failed', failedStage: source.failedStage, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: new Date() } }] },
    data: { status: source.failedStage, failedStage: null, error: null },
  })
  if (moved.count !== 1) return { ok: false, reason: 'The file changed in the meantime. Reload and try again.' }
  enqueueSource(sourceId)
  return { ok: true }
}

/**
 * Removes a source with its topics, their exercises and its files. Refused when a question from it has been answered (the
 * answers belong to the student's history). A source that is being processed is stopped first: the cancel flag ends the work at the next
 * stage boundary and the lease is taken before the rows are deleted; if the stage does not end within ~25 s the removal is
 * refused with "try again in a minute" (the flag is cleared and the work simply continues).
 */
export async function removeSource(sourceId: string): Promise<AdminResult> {
  const source = await prisma.source.findUnique({ where: { id: sourceId }, select: { id: true, courseId: true, originalName: true } })
  if (!source) return { ok: false, reason: 'File not found.' }
  const answeredMessage = `Questions from "${source.originalName}" have already been answered in study sessions, so the file cannot be removed without losing that history.`
  const answered = () => prisma.exerciseLog.count({ where: { exercise: { topic: { sourceId } } } })
  if ((await answered()) > 0) return { ok: false, reason: answeredMessage }
  let exclusive: Awaited<ReturnType<typeof acquireExclusive>>
  try {
    exclusive = await acquireExclusive([sourceId])
  } catch (error) {
    if (error instanceof SourceBusyError) return { ok: false, reason: error.message }
    throw error
  }
  try {
    if ((await answered()) > 0) return { ok: false, reason: answeredMessage }
    // Topics and exercises follow through the cascade rules of the schema. A tutor-update suggestion that was based on this file goes in
    // the same transaction: it would offer a change for a file that is no longer there. (An initial proposal is re-derived on demand.)
    await prisma.$transaction(async (tx) => {
      await tx.source.deleteMany({ where: { id: sourceId } })
      const course = await tx.course.findUnique({ where: { id: source.courseId }, select: { profileSuggestion: true } })
      const stored = parseSuggestion(course?.profileSuggestion)
      if (stored && stored.kind === 'update' && stored.basedOnSourceIds.includes(sourceId)) {
        await tx.course.update({ where: { id: source.courseId }, data: { profileSuggestion: null } })
      }
    })
  } finally {
    await exclusive.release()
  }
  await removeSourceFiles(source.courseId, sourceId).catch((error) => console.warn('[ingest] could not remove files of', sourceId, error))
  return { ok: true }
}

/**
 * Deletes a studyspace: needs the exact title. Stops its running work first (same mechanism as removeSource), deletes the
 * course row (the cascades remove sources, topics, exercises, sessions, session items, logs and plans) and then its folders
 * under STORAGE_DIR (sources, summaries, the session index files of its sessions). Works for the two MIT studyspaces too, when
 * the owner types the title; their tracked `summaries/<code>` folder and the crawled files are not touched.
 * Not removable from the server: browser storage keys that mention the id (feynman_active_session_<id>, feynman_chat_mode_<id>); they
 * are harmless leftovers.
 */
export async function deleteStudyspace(courseId: string, confirmTitle: unknown): Promise<AdminResult> {
  const course = await prisma.course.findUnique({ where: { id: courseId }, select: { id: true, title: true } })
  if (!course) return { ok: false, reason: 'Studyspace not found.' }
  if (typeof confirmTitle !== 'string' || confirmTitle !== course.title) {
    return { ok: false, reason: 'To delete this studyspace, type its title exactly as it is written.' }
  }
  const sources = await prisma.source.findMany({ where: { courseId }, select: { id: true } })
  let exclusive: Awaited<ReturnType<typeof acquireExclusive>>
  try {
    exclusive = await acquireExclusive(sources.map((s) => s.id), { starterCourseId: courseId })
  } catch (error) {
    if (error instanceof SourceBusyError) return { ok: false, reason: error.message }
    throw error
  }
  let sessionIds: string[] = []
  try {
    sessionIds = (await prisma.studySession.findMany({ where: { courseId }, select: { id: true } })).map((s) => s.id)
    await prisma.course.delete({ where: { id: courseId } })
  } finally {
    await exclusive.release()
  }
  await removeCourseStorage(courseId, sessionIds).catch((error) => console.warn('[ingest] could not remove storage of', courseId, error))
  return { ok: true }
}
