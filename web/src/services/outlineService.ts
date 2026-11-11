// Reading and editing the outline of a studyspace (modules and topics): rename, reorder, move, merge.
// Every function checks that the ids belong to the given studyspace and answers { ok: false, reason } instead of throwing, so the
// wizard can show the reason (an error thrown from a server action is masked in production builds).
//
// Conventions (plan 3.5): Topic.week is "NN · <Module title>", Topic.unit is the topic's position inside its module (1-based, as a
// string), Topic.order is the position inside the whole course. Edits rewrite all three so they stay consistent: modules are
// contiguous, `order` is 0..n-1 without gaps or repeats.
import { prisma } from '@/lib/db'
import { MAX_TOPIC_CHARS } from '@/lib/ingestLimits'
import { NOT_STUDY_MATERIAL_PREFIX } from '@/services/exerciseGenerator'
import { parseProfile } from '@/lib/studyspace/profile'

export const MAX_TOPIC_TITLE_LENGTH = 200
export const MAX_MODULE_TITLE_LENGTH = 120

export type OutlineTopic = {
  id: string
  title: string
  order: number
  pageStart: number | null
  pageEnd: number | null
  sourceId: string | null
  sourceName: string | null
  /** True when the source is a PDF, so the page range means real pages. */
  sourceIsPdf: boolean
  /** Active questions on this topic. */
  exerciseCount: number
  /** The segmentation marked it as front matter or logistics (no questions are made from it). */
  notStudyMaterial: boolean
}

export type OutlineModule = {
  /** The stored label (`Topic.week`), e.g. "02 · Market failures". The key of the module in every action. */
  name: string
  /** The label without its "NN · " prefix, e.g. "Market failures". */
  title: string
  topics: OutlineTopic[]
}

export type OutlineFailure = { ok: false; reason: string }
export type OutlineResult = { ok: true } | OutlineFailure
export type OutlineReadResult = { ok: true; modules: OutlineModule[]; editable: boolean } | OutlineFailure
export type MergeResult = { ok: true; id: string } | OutlineFailure

export const IMPORTED_OUTLINE_REASON = 'The outline of this studyspace was imported and cannot be rearranged. Topics can still be renamed.'

const NOT_FOUND_SPACE: OutlineFailure = { ok: false, reason: 'Studyspace not found.' }
const NUMBERED = /^(\d+) · ([\s\S]*)$/

/** "03 · Title" -> { prefix: "03", title: "Title" }; a label without a prefix keeps its whole text as the title. Pure. */
export function splitModuleName(name: string): { prefix: string | null; title: string } {
  const m = NUMBERED.exec(name)
  return m ? { prefix: m[1], title: m[2] } : { prefix: null, title: name }
}

/** "NN · Title" for the module at `index` (0-based); two digits, more only past 99 modules. Pure. */
export function moduleName(index: number, title: string): string {
  return `${String(index + 1).padStart(2, '0')} · ${title}`
}

/** Module groups of rows already sorted by `order`: module order = first appearance, topic order inside a module = row order. Pure. */
export function groupByModule<T extends { week: string | null }>(rows: T[]): { name: string; rows: T[] }[] {
  const groups: { name: string; rows: T[] }[] = []
  const byName = new Map<string, { name: string; rows: T[] }>()
  for (const row of rows) {
    const name = row.week ?? ''
    let g = byName.get(name)
    if (!g) {
      g = { name, rows: [] }
      byName.set(name, g)
      groups.push(g)
    }
    g.rows.push(row)
  }
  return groups
}

type Tx = Pick<typeof prisma, 'topic' | 'course'>

/**
 * The profile names a module by its stored label (`calibrationModule`; `examPreset` and `questionTypeCycles` hold no module name).
 * When labels change (rename, renumbering, a module that disappears) the profile follows: `mapping` is old label -> new label;
 * a label missing from it keeps its value, or becomes null when `dropUnmapped` (the module no longer exists).
 */
export async function followModuleLabels(tx: Tx, courseId: string, mapping: Map<string, string>, dropUnmapped: boolean): Promise<void> {
  const course = await tx.course.findUnique({ where: { id: courseId }, select: { profile: true } })
  const profile = parseProfile(course?.profile)
  const current = profile?.calibrationModule
  if (!profile || !current) return
  const next = mapping.has(current) ? mapping.get(current)! : dropUnmapped ? null : current
  if (next !== current) await tx.course.update({ where: { id: courseId }, data: { profile: JSON.stringify({ ...profile, calibrationModule: next }) } })
}

/**
 * Writes a layout: modules in the given order, each with its topics in the given order. Module labels with a "NN · " prefix are
 * renumbered to their new position (labels without one are left alone); `order` becomes 0..n-1 and `unit` the 1-based position
 * inside the module. Only rows that change are written.
 */
export async function writeLayout(tx: Tx, courseId: string, layout: { name: string; ids: string[] }[], current: Map<string, { week: string | null; order: number; unit: string | null }>) {
  let order = 0
  const labels = new Map<string, string>()
  for (const [mi, mod] of layout.entries()) {
    const { prefix, title } = splitModuleName(mod.name)
    const week = prefix !== null ? moduleName(mi, title) : mod.name
    labels.set(mod.name, week)
    for (const [ti, id] of mod.ids.entries()) {
      const before = current.get(id)
      const unit = String(ti + 1)
      if (!before || before.week !== week || before.order !== order || before.unit !== unit) {
        await tx.topic.update({ where: { id }, data: { week, order, unit } })
      }
      order++
    }
  }
  await followModuleLabels(tx, courseId, labels, true)
}

/** Imported studyspaces (topics without a file) keep real unit numbers and orders that the rewrite would destroy. */
async function hasImportedTopics(tx: Pick<typeof prisma, 'topic'>, courseId: string): Promise<boolean> {
  return (await tx.topic.count({ where: { courseId, sourceId: null } })) > 0
}

/** True when the studyspace has topics that did not come from an upload (the two imported MIT courses). */
export async function isImportedStudyspace(courseId: string): Promise<boolean> {
  return hasImportedTopics(prisma, courseId)
}

async function loadCurrent(tx: Tx, courseId: string) {
  const rows = await tx.topic.findMany({ where: { courseId }, orderBy: [{ order: 'asc' }, { id: 'asc' }], select: { id: true, week: true, order: true, unit: true } })
  return { rows, current: new Map(rows.map((r) => [r.id, r])) }
}

/** Rewrites `order`, `unit` and the "NN · " numbers of a studyspace so they are contiguous again (after topics moved in or out). */
export async function renumberOutline(tx: Tx, courseId: string): Promise<void> {
  const { rows, current } = await loadCurrent(tx, courseId)
  await writeLayout(tx, courseId, groupByModule(rows).map((g) => ({ name: g.name, ids: g.rows.map((r) => r.id) })), current)
}

/** The outline of a studyspace: modules in order, each with its topics in order. */
export async function getOutline(courseId: string): Promise<OutlineReadResult> {
  const course = await prisma.course.findUnique({ where: { id: courseId }, select: { id: true } })
  if (!course) return NOT_FOUND_SPACE
  const topics = await prisma.topic.findMany({
    where: { courseId },
    orderBy: [{ order: 'asc' }, { id: 'asc' }],
    select: {
      id: true, title: true, order: true, week: true, pageStart: true, pageEnd: true, sourceId: true,
      source: { select: { originalName: true, mimeType: true } },
      _count: { select: { exercises: { where: { status: 'active' } } } },
      exercises: { where: { status: 'rejected', reportedReason: { startsWith: NOT_STUDY_MATERIAL_PREFIX } }, select: { id: true }, take: 1 },
    },
  })
  const modules = groupByModule(topics).map((g) => ({
    name: g.name,
    title: splitModuleName(g.name).title,
    topics: g.rows.map<OutlineTopic>((t) => ({
      id: t.id, title: t.title, order: t.order, pageStart: t.pageStart, pageEnd: t.pageEnd, sourceId: t.sourceId,
      sourceName: t.source?.originalName ?? null, sourceIsPdf: t.source?.mimeType === 'application/pdf',
      exerciseCount: t._count.exercises, notStudyMaterial: t.exercises.length > 0,
    })),
  }))
  return { ok: true, modules, editable: !topics.some((t) => t.sourceId === null) }
}

const cleanLabel = (v: unknown) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '')
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0

export async function renameTopic(courseId: string, topicId: string, title: unknown): Promise<OutlineResult> {
  const clean = cleanLabel(title)
  if (!clean) return { ok: false, reason: 'A topic needs a title.' }
  if (clean.length > MAX_TOPIC_TITLE_LENGTH) return { ok: false, reason: `A topic title can have at most ${MAX_TOPIC_TITLE_LENGTH} characters.` }
  if (!isId(courseId) || !isId(topicId)) return { ok: false, reason: 'Topic not found.' }
  const done = await prisma.topic.updateMany({ where: { id: topicId, courseId }, data: { title: clean } })
  return done.count === 1 ? { ok: true } : { ok: false, reason: 'Topic not found in this studyspace.' }
}

/** Renames a module: `from` is its stored label, `to` the new title (the "NN · " prefix is kept). */
export async function renameModule(courseId: string, from: string, to: unknown): Promise<OutlineResult> {
  const clean = cleanLabel(to)
  if (!clean) return { ok: false, reason: 'A module needs a title.' }
  if (clean.length > MAX_MODULE_TITLE_LENGTH) return { ok: false, reason: `A module title can have at most ${MAX_MODULE_TITLE_LENGTH} characters.` }
  if (!isId(courseId) || typeof from !== 'string') return NOT_FOUND_SPACE
  return prisma.$transaction(async (tx) => {
    if (await hasImportedTopics(tx, courseId)) return { ok: false, reason: IMPORTED_OUTLINE_REASON } as const
    const { rows } = await loadCurrent(tx, courseId)
    const members = rows.filter((r) => (r.week ?? '') === from)
    if (members.length === 0) return { ok: false, reason: 'Module not found in this studyspace.' } as const
    const { prefix } = splitModuleName(from)
    const next = prefix !== null ? `${prefix} · ${clean}` : clean
    if (next === from) return { ok: true } as const
    if (rows.some((r) => (r.week ?? '') === next)) return { ok: false, reason: 'Another module already has that title. Choose a different one.' } as const
    await tx.topic.updateMany({ where: { courseId, week: from }, data: { week: next } })
    await followModuleLabels(tx, courseId, new Map([[from, next]]), false)
    return { ok: true } as const
  })
}

/**
 * Sets the order of all topics. `orderedTopicIds` must list every topic of the studyspace exactly once. Modules keep together:
 * their order is the position of their first topic in the list, and the topics inside keep the order given.
 */
export async function reorderTopics(courseId: string, orderedTopicIds: unknown): Promise<OutlineResult> {
  if (!isId(courseId)) return NOT_FOUND_SPACE
  if (!Array.isArray(orderedTopicIds) || !orderedTopicIds.every(isId)) return { ok: false, reason: 'The new order is not valid.' }
  const ids = orderedTopicIds as string[]
  return prisma.$transaction(async (tx) => {
    if (await hasImportedTopics(tx, courseId)) return { ok: false, reason: IMPORTED_OUTLINE_REASON } as const
    const { rows, current } = await loadCurrent(tx, courseId)
    if (rows.length === 0) return NOT_FOUND_SPACE
    const unique = new Set(ids)
    if (unique.size !== ids.length || ids.length !== rows.length || !ids.every((id) => current.has(id))) {
      return { ok: false, reason: 'The outline changed since you opened it. Reload and try again.' } as const
    }
    const sorted = ids.map((id) => ({ id, week: current.get(id)!.week }))
    await writeLayout(tx, courseId, groupByModule(sorted).map((g) => ({ name: g.name, ids: g.rows.map((r) => r.id) })), current)
    return { ok: true } as const
  })
}

/** Moves a topic to the end of another module (`moduleName` is the stored label of an existing module). */
export async function moveTopicToModule(courseId: string, topicId: string, targetModule: string): Promise<OutlineResult> {
  if (!isId(courseId) || !isId(topicId) || typeof targetModule !== 'string') return { ok: false, reason: 'Topic not found.' }
  return prisma.$transaction(async (tx) => {
    if (await hasImportedTopics(tx, courseId)) return { ok: false, reason: IMPORTED_OUTLINE_REASON } as const
    const { rows, current } = await loadCurrent(tx, courseId)
    const topic = current.get(topicId)
    if (!topic) return { ok: false, reason: 'Topic not found in this studyspace.' } as const
    const groups = groupByModule(rows)
    const target = groups.find((g) => g.name === targetModule)
    if (!target) return { ok: false, reason: 'Module not found in this studyspace.' } as const
    if ((topic.week ?? '') === targetModule) return { ok: true } as const
    const layout = groups
      .map((g) => ({ name: g.name, ids: g.rows.map((r) => r.id).filter((id) => id !== topicId) }))
      .map((g) => (g.name === targetModule ? { ...g, ids: [...g.ids, topicId] } : g))
      .filter((g) => g.ids.length > 0) // a module left empty disappears and the others are renumbered
    await writeLayout(tx, courseId, layout, current)
    return { ok: true } as const
  })
}

const parseTerms = (raw: string | null): string[] => {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/**
 * Merges 2 or more adjacent topics of one source (same module, no other topic between them in the outline) into the first one:
 * content in order, page range spanning all, summaries joined, key terms united, questions and session topic lists re-pointed to
 * the kept topic. One transaction. Returns the id of the kept topic.
 */
export async function mergeTopics(courseId: string, topicIds: unknown): Promise<MergeResult> {
  if (!isId(courseId)) return NOT_FOUND_SPACE
  if (!Array.isArray(topicIds) || !topicIds.every(isId)) return { ok: false, reason: 'Choose the topics to merge.' }
  const wanted = new Set(topicIds as string[])
  if (wanted.size < 2) return { ok: false, reason: 'Choose at least two topics to merge.' }

  return prisma.$transaction(async (tx) => {
    if (await hasImportedTopics(tx, courseId)) return { ok: false, reason: IMPORTED_OUTLINE_REASON } as const
    const all = await tx.topic.findMany({ where: { courseId }, orderBy: [{ order: 'asc' }, { id: 'asc' }], select: { id: true, week: true, sourceId: true } })
    if ([...wanted].some((id) => !all.some((t) => t.id === id))) return { ok: false, reason: 'A chosen topic was not found in this studyspace.' } as const
    const picked = all.filter((t) => wanted.has(t.id))
    const first = picked[0]
    if (!first.sourceId || picked.some((t) => t.sourceId !== first.sourceId)) {
      return { ok: false, reason: 'Only topics from the same file can be merged.' } as const
    }
    if (picked.some((t) => (t.week ?? '') !== (first.week ?? ''))) {
      return { ok: false, reason: 'These topics are in different modules. Move them into one module first.' } as const
    }
    const start = all.findIndex((t) => t.id === first.id)
    if (!picked.every((t, i) => all[start + i]?.id === t.id)) {
      return { ok: false, reason: 'Only topics that sit next to each other can be merged. Topics in between would be skipped.' } as const
    }
    const source = await tx.source.findUnique({ where: { id: first.sourceId }, select: { status: true, originalName: true } })
    if (source && source.status !== 'ready' && source.status !== 'failed') {
      return { ok: false, reason: `"${source.originalName}" is still being processed. Try again when it is ready.` } as const
    }

    const full = await tx.topic.findMany({ where: { id: { in: picked.map((t) => t.id) } }, include: { exercises: { select: { id: true, status: true, reportedReason: true } } } })
    const ordered = picked.map((p) => full.find((f) => f.id === p.id)!)
    const kept = ordered[0]
    const removed = ordered.slice(1)

    const content = ordered.map((t) => t.content?.trim() ?? '').filter(Boolean).join('\n\n')
    if (content.length > MAX_TOPIC_CHARS) {
      return { ok: false, reason: `The merged topic would have ${content.length.toLocaleString('en-US')} characters; the limit is ${MAX_TOPIC_CHARS.toLocaleString('en-US')}. Merge fewer topics.` } as const
    }
    const starts = ordered.map((t) => t.pageStart).filter((n): n is number => n !== null)
    const ends = ordered.map((t) => t.pageEnd).filter((n): n is number => n !== null)
    const seen = new Set<string>()
    const terms: string[] = []
    for (const term of ordered.flatMap((t) => parseTerms(t.keyTerms))) {
      const key = term.trim().toLowerCase()
      if (key && !seen.has(key)) {
        seen.add(key)
        terms.push(term)
      }
    }
    const summary = ordered.map((t) => t.summary?.trim() ?? '').filter(Boolean).join('\n\n')

    // Front matter markers: the merged topic is study material as soon as one of its parts is
    const isMarker = (e: { status: string; reportedReason: string | null }) => e.status === 'rejected' && (e.reportedReason ?? '').startsWith(NOT_STUDY_MATERIAL_PREFIX)
    const hasStudyPart = ordered.some((t) => !t.exercises.some(isMarker))
    const removedIds = removed.map((t) => t.id)

    await tx.exercise.updateMany({ where: { topicId: { in: removedIds } }, data: { topicId: kept.id } })
    if (hasStudyPart) {
      const markers = ordered.flatMap((t) => t.exercises.filter(isMarker).map((e) => e.id))
      if (markers.length > 0) await tx.exercise.deleteMany({ where: { id: { in: markers }, logs: { none: {} } } })
    }

    // Sessions remember the topics they were started with as a JSON list
    const sessions = await tx.studySession.findMany({ where: { courseId, topicIds: { not: null } }, select: { id: true, topicIds: true } })
    for (const s of sessions) {
      const list = parseTerms(s.topicIds)
      if (!list.some((id) => removedIds.includes(id))) continue
      const next = [...new Set(list.map((id) => (removedIds.includes(id) ? kept.id : id)))]
      await tx.studySession.update({ where: { id: s.id }, data: { topicIds: JSON.stringify(next) } })
    }

    await tx.topic.update({
      where: { id: kept.id },
      data: {
        content: content || null,
        summary: summary || null,
        keyTerms: terms.length > 0 ? JSON.stringify(terms) : kept.keyTerms,
        isQuantitative: ordered.some((t) => t.isQuantitative),
        pageStart: starts.length > 0 ? Math.min(...starts) : null,
        pageEnd: ends.length > 0 ? Math.max(...ends) : null,
      },
    })
    await tx.topic.deleteMany({ where: { id: { in: removedIds } } })

    // Close the gaps: order 0..n-1 and unit by position
    const { rows, current } = await loadCurrent(tx, courseId)
    await writeLayout(tx, courseId, groupByModule(rows).map((g) => ({ name: g.name, ids: g.rows.map((r) => r.id) })), current)
    return { ok: true, id: kept.id } as const
  })
}
