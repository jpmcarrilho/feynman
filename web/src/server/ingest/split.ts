// Splitting a studyspace whose files are about unrelated subjects (T25): the first group stays, every other group becomes a new
// studyspace that gets its sources, topics (with their questions, which follow the topic) and stored files.
//
// Order of work, so a crash never leaves a row pointing at a missing file:
//   1. take the runner's exclusive hold on the moved sources (no stage runs underneath);
//   2. COPY their folders to the new studyspace's folder (the old folders stay);
//   3. one database transaction: create the new studyspaces, re-point Source.courseId / storageKey and Topic.courseId, renumber
//      the modules and `order` of every studyspace involved, clear the old suggestion;
//   4. only after the commit, delete the old folders. A crash before 3 leaves unused copies; a crash before 4 leaves unused old folders.
import { prisma } from '@/lib/db'
import { MAX_SPACE_NAME_LENGTH } from '@/lib/spaceLimits'
import { parseProfile } from '@/lib/studyspace/profile'
import { copySourceFiles, removeCourseStorage, removeSourceFiles } from '@/server/storage'
import { isImportedStudyspace, renumberOutline } from '@/services/outlineService'
import { makeSpaceCode } from '@/services/studyspaceService'
import { acquireExclusive, SourceBusyError } from './runner'

export type SplitResult = { ok: true; ids: string[]; keptTitle: string; created: { id: string; title: string }[] } | { ok: false; reason: string }

const MAX_GROUPS = 5

type Group = { label: string; sourceIds: string[] }

function shapeOf(groups: unknown): Group[] | null {
  if (!Array.isArray(groups) || groups.length < 2 || groups.length > MAX_GROUPS) return null
  const out: Group[] = []
  for (const g of groups) {
    if (!g || typeof g !== 'object') return null
    const { label, sourceIds } = g as { label?: unknown; sourceIds?: unknown }
    if (!Array.isArray(sourceIds) || sourceIds.length === 0 || !sourceIds.every((x) => typeof x === 'string' && x)) return null
    out.push({ label: typeof label === 'string' ? label.trim().replace(/\s+/g, ' ') : '', sourceIds: sourceIds as string[] })
  }
  return out
}

/** Every reason a split is refused, checked before and again under the exclusive hold. Returns the message or null. */
async function refusal(courseId: string, groups: Group[]): Promise<string | null> {
  const course = await prisma.course.findUnique({ where: { id: courseId }, select: { profile: true } })
  if (!course) return 'Studyspace not found.'
  if (await isImportedStudyspace(courseId)) return 'An imported studyspace cannot be split.'
  if (parseProfile(course.profile)) return 'This studyspace already has a tutor, so it can no longer be split. Add the other files to a new studyspace instead.'
  if ((await prisma.studySession.count({ where: { courseId } })) > 0 || (await prisma.exerciseLog.count({ where: { exercise: { topic: { courseId } } } })) > 0) {
    return 'This studyspace already has study sessions, so it cannot be split without breaking that history.'
  }
  const sources = await prisma.source.findMany({ where: { courseId }, select: { id: true, originalName: true, status: true, storageKey: true } })
  const busy = sources.find((s) => s.status !== 'ready' && s.status !== 'failed')
  if (busy) return `"${busy.originalName}" is still being processed. Try again when it is done.`
  const ready = new Set(sources.filter((s) => s.status === 'ready').map((s) => s.id))
  const seen = new Set<string>()
  for (const g of groups) {
    for (const id of g.sourceIds) {
      if (!ready.has(id) || seen.has(id)) return 'The groups do not match the files of this studyspace. Reload the page and try again.'
      seen.add(id)
    }
  }
  if (seen.size !== ready.size) return 'The groups do not cover every file of this studyspace. Reload the page and try again.'
  const prefix = `sources/${courseId}/`
  if (sources.some((s) => seen.has(s.id) && !s.storageKey.startsWith(prefix))) return 'A file of this studyspace is stored in an unexpected place, so it cannot be moved.'
  return null
}

export async function splitStudyspace(courseId: string, groupsInput: unknown): Promise<SplitResult> {
  const groups = shapeOf(groupsInput)
  if (!groups) return { ok: false, reason: 'Choose at least two groups of files, each with at least one file.' }
  const long = groups.find((g) => g.label.length > MAX_SPACE_NAME_LENGTH)
  if (long) return { ok: false, reason: `A studyspace name can have at most ${MAX_SPACE_NAME_LENGTH} characters.` }
  const first = await refusal(courseId, groups)
  if (first) return { ok: false, reason: first }

  const moved = groups.slice(1).flatMap((g, i) => g.sourceIds.map((sourceId) => ({ sourceId, groupIndex: i + 1 })))
  let exclusive: Awaited<ReturnType<typeof acquireExclusive>>
  try {
    exclusive = await acquireExclusive(moved.map((m) => m.sourceId), { starterCourseId: courseId })
  } catch (error) {
    if (error instanceof SourceBusyError) return { ok: false, reason: error.message }
    throw error
  }
  const newIds = groups.slice(1).map(() => crypto.randomUUID())
  try {
    const again = await refusal(courseId, groups)
    if (again) return { ok: false, reason: again }
    const course = await prisma.course.findUniqueOrThrow({ where: { id: courseId }, select: { title: true, goal: true } })
    const titles = groups.slice(1).map((g, i) => (g.label || `${course.title} (${i + 2})`).slice(0, MAX_SPACE_NAME_LENGTH))

    try {
      for (const m of moved) {
        await copySourceFiles(courseId, newIds[m.groupIndex - 1], m.sourceId)
      }
      await prisma.$transaction(
        async (tx) => {
          if ((await tx.studySession.count({ where: { courseId } })) > 0) throw new Error('sessions appeared')
          for (const [i, id] of newIds.entries()) {
            await tx.course.create({ data: { id, code: makeSpaceCode(titles[i]), title: titles[i], goal: course.goal, starterStatus: 'waiting_for_profile' } })
          }
          for (const m of moved) {
            const target = newIds[m.groupIndex - 1]
            const row = await tx.source.findUniqueOrThrow({ where: { id: m.sourceId }, select: { storageKey: true } })
            await tx.source.update({ where: { id: m.sourceId }, data: { courseId: target, storageKey: row.storageKey.replace(`sources/${courseId}/`, `sources/${target}/`) } })
            await tx.topic.updateMany({ where: { sourceId: m.sourceId }, data: { courseId: target } })
          }
          // The studyspace that stays takes the name of its group when one was given
          const keptName = groups[0].label
          await tx.course.update({ where: { id: courseId }, data: { profileSuggestion: null, ...(keptName && keptName !== course.title ? { title: keptName } : {}) } })
          for (const id of [courseId, ...newIds]) await renumberOutline(tx, id)
        },
        { timeout: 60_000, maxWait: 10_000 },
      )
    } catch (error) {
      console.error('[split] failed:', error)
      // Nothing was committed: the copies are unused
      for (const id of newIds) await removeCourseStorage(id).catch(() => {})
      return { ok: false, reason: 'The studyspace could not be split and nothing was changed. Try again.' }
    }
    for (const m of moved) await removeSourceFiles(courseId, m.sourceId).catch((error) => console.warn('[split] could not remove old files of', m.sourceId, error))
    return { ok: true, ids: [courseId, ...newIds], keptTitle: groups[0].label && groups[0].label !== course.title ? groups[0].label : course.title, created: newIds.map((id, i) => ({ id, title: titles[i] })) }
  } finally {
    await exclusive.release()
  }
}
