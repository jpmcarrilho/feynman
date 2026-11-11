import 'dotenv/config'
import * as fs from 'fs'
import * as path from 'path'
import { prisma } from '../lib/db'
import { parseExerciseMarkdown, type ParsedExercise } from '../services/ingest'
import { LEGACY_COURSE_TITLES, LEGACY_PROFILES } from '../lib/studyspace/legacyProfiles'
import {
  GRADED_RULES,
  buildOutlineRanks,
  gradedRulesMatched,
  isQuantitativeWeek,
  legacySurveyFilterExcludes,
  majorityChoice,
  parseIdList,
  sortTopicsForOrder,
  stripEnrichmentMarker,
  ENRICHED_MARKER,
  type OutlineSection,
} from '../lib/studyspace/backfillRules'

// Usage: npx tsx src/scripts/backfill-studyspaces.ts [--dry-run] [--apply-graded] [--review-file=path]
// Idempotent. Run from web/. Stop any running next dev/start first.

const args = process.argv.slice(2)
const DRY = args.includes('--dry-run')
const APPLY_GRADED = args.includes('--apply-graded')
const reviewArg = args.find((a) => a.startsWith('--review-file='))
const REVIEW_FILE = path.resolve(process.cwd(), reviewArg ? reviewArg.slice('--review-file='.length) : 'backups/isGraded-review.tsv')
const OUTLINE_DIR = path.resolve(process.cwd(), '../MIT_Learn_Courses')
const CHUNK = 400

let totalChanges = 0
const log = (msg = '') => console.log(msg)
function changed(n: number) {
  totalChanges += n
}
function chunks<T>(arr: T[], size = CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

async function stepTitles(courses: { id: string; code: string; title: string }[]) {
  log('1. Course titles')
  for (const c of courses) {
    const target = LEGACY_COURSE_TITLES[c.code]
    if (target && c.title === c.code) {
      log(`   ${c.code}: "${c.title}" -> "${target}"`)
      if (!DRY) await prisma.course.update({ where: { id: c.id }, data: { title: target } })
      changed(1)
    } else {
      log(`   ${c.code}: unchanged`)
    }
  }
}

async function stepProfiles(courses: { id: string; code: string; profile: string | null; starterStatus: string | null }[]) {
  log('2. Profiles and starterStatus')
  for (const c of courses) {
    const legacy = LEGACY_PROFILES[c.code]
    if (!legacy) {
      log(`   ${c.code}: not a legacy course, skipped`)
      continue
    }
    const data: { profile?: string; starterStatus?: string } = {}
    if (c.profile === null) data.profile = JSON.stringify(legacy)
    if (c.starterStatus === null) data.starterStatus = 'done'
    const n = Object.keys(data).length
    log(`   ${c.code}: ${n ? Object.keys(data).join(' + ') + ' written' : 'unchanged'}`)
    if (n) {
      if (!DRY) await prisma.course.update({ where: { id: c.id }, data })
      changed(n)
    }
  }
}

async function stepOrder(courses: { id: string; code: string }[]) {
  log('3. Topic.order')
  for (const c of courses) {
    const topics = await prisma.topic.findMany({
      where: { courseId: c.id },
      select: { id: true, week: true, className: true, unit: true, resourceType: true, title: true, order: true },
    })
    if (topics.length === 0 || !topics.every((t) => t.order === 0)) {
      log(`   ${c.code}: already ordered (or empty), skipped`)
      continue
    }
    const outlinePath = path.join(OUTLINE_DIR, `${c.code}_outline.json`)
    let ranks: Map<string, number> | null = null
    if (fs.existsSync(outlinePath)) {
      ranks = buildOutlineRanks(JSON.parse(fs.readFileSync(outlinePath, 'utf-8')) as OutlineSection[])
    }
    const sorted = sortTopicsForOrder(topics, ranks)
    const unranked = ranks ? sorted.filter((t) => !t.className || !ranks!.has(t.className)).length : sorted.length
    log(`   ${c.code}: ${sorted.length} topics ordered (${ranks ? `outline found, ${unranked} unranked` : 'outline missing, fallback sort'})`)
    if (!DRY) {
      for (const part of chunks(sorted.map((t, i) => ({ id: t.id, order: i * 10 })), 200)) {
        await prisma.$transaction(part.map((p) => prisma.topic.update({ where: { id: p.id }, data: { order: p.order } })))
      }
    }
    changed(sorted.length)
  }
}

async function stepQuantitative(courses: { id: string; code: string }[]) {
  log('4. Topic.isQuantitative')
  for (const c of courses) {
    const topics = await prisma.topic.findMany({ where: { courseId: c.id, isQuantitative: false }, select: { id: true, week: true } })
    const ids = topics.filter((t) => isQuantitativeWeek(t.week)).map((t) => t.id)
    log(`   ${c.code}: ${ids.length} topics set to quantitative`)
    if (!DRY) for (const part of chunks(ids)) await prisma.topic.updateMany({ where: { id: { in: part } }, data: { isQuantitative: true } })
    changed(ids.length)
  }
}

async function stepSessionCourses(courses: { id: string; code: string }[]) {
  log('5. StudySession.courseId')
  const sessions = await prisma.studySession.findMany({
    where: { courseId: null },
    select: { id: true, title: true, mode: true, exerciseIds: true },
  })
  const exerciseCourse = new Map<string, string>()
  const topicCourse = new Map((await prisma.topic.findMany({ select: { id: true, courseId: true } })).map((t) => [t.id, t.courseId]))
  for (const e of await prisma.exercise.findMany({ select: { id: true, topicId: true } })) {
    const cid = topicCourse.get(e.topicId)
    if (cid) exerciseCourse.set(e.id, cid)
  }
  const perCourse = new Map<string, number>()
  const left: { id: string; reason: string }[] = []
  for (const s of sessions) {
    if (s.mode === 'global_diagnosis') {
      left.push({ id: s.id, reason: 'global_diagnosis stays null by design' })
      continue
    }
    let courseId: string | null = null
    let via = ''
    const logs = await prisma.exerciseLog.findMany({ where: { sessionId: s.id }, select: { exerciseId: true } })
    courseId = majorityChoice(logs.map((l) => exerciseCourse.get(l.exerciseId)))
    if (courseId) via = 'logs'
    if (!courseId) {
      const ids = parseIdList(s.exerciseIds)
      if (ids) {
        courseId = majorityChoice(ids.map((id) => exerciseCourse.get(id)))
        if (courseId) via = 'exerciseIds'
      }
    }
    if (!courseId && s.title) {
      const title = s.title
      const matches = courses.filter((c) => title.startsWith(c.code))
      if (matches.length === 1) {
        courseId = matches[0].id
        via = 'title'
      }
    }
    if (!courseId) {
      left.push({ id: s.id, reason: `no logs, ${s.exerciseIds ? 'exerciseIds unusable' : 'no exerciseIds'}, title ${JSON.stringify(s.title)} does not start with a course code` })
      continue
    }
    perCourse.set(`${courseId}|${via}`, (perCourse.get(`${courseId}|${via}`) ?? 0) + 1)
    if (!DRY) await prisma.studySession.update({ where: { id: s.id }, data: { courseId } })
    changed(1)
  }
  for (const [k, n] of perCourse) {
    const [cid, via] = k.split('|')
    log(`   ${courses.find((c) => c.id === cid)?.code}: ${n} sessions (via ${via})`)
  }
  log(`   sessions left without course: ${left.length}`)
  for (const l of left) log(`     ${l.id}: ${l.reason}`)
}

async function stepPlans() {
  log('6. StudyPlan.courseId')
  const plans = await prisma.studyPlan.findMany({ where: { courseId: null }, select: { id: true, sessions: { select: { courseId: true } } } })
  let n = 0
  for (const p of plans) {
    const courseId = majorityChoice(p.sessions.map((s) => s.courseId))
    if (!courseId) continue
    if (!DRY) await prisma.studyPlan.update({ where: { id: p.id }, data: { courseId } })
    n++
  }
  log(`   ${n} plans updated (${plans.length} without course)`)
  changed(n)
}

async function stepSessionItems() {
  log('7. SessionExercise and targetCount')
  const sessions = await prisma.studySession.findMany({
    select: { id: true, exerciseIds: true, targetCount: true, _count: { select: { items: true } } },
  })
  const existing = new Set((await prisma.exercise.findMany({ select: { id: true } })).map((e) => e.id))
  let itemRows = 0
  let sessionsWithItems = 0
  let targetsSet = 0
  let skippedMissing = 0
  for (const s of sessions) {
    const ids = parseIdList(s.exerciseIds)
    if (!ids || ids.length === 0) continue
    if (s._count.items === 0) {
      const seen = new Set<string>()
      const rows: { sessionId: string; exerciseId: string; position: number }[] = []
      ids.forEach((id, position) => {
        if (!existing.has(id)) {
          skippedMissing++
          return
        }
        if (seen.has(id)) return
        seen.add(id)
        rows.push({ sessionId: s.id, exerciseId: id, position })
      })
      if (rows.length) {
        if (!DRY) await prisma.sessionExercise.createMany({ data: rows })
        itemRows += rows.length
        sessionsWithItems++
        changed(rows.length)
      }
    }
    if (s.targetCount === null) {
      if (!DRY) await prisma.studySession.update({ where: { id: s.id }, data: { targetCount: ids.length } })
      targetsSet++
      changed(1)
    }
  }
  log(`   ${itemRows} items created for ${sessionsWithItems} sessions (${skippedMissing} ids skipped: exercise gone); targetCount set on ${targetsSet}`)
}

async function stepOrigin() {
  log('8. Exercise.origin')
  const n = await prisma.exercise.count({ where: { id: { startsWith: 'gen-' }, origin: { not: 'generated' } } })
  if (!DRY && n) await prisma.exercise.updateMany({ where: { id: { startsWith: 'gen-' }, origin: { not: 'generated' } }, data: { origin: 'generated' } })
  log(`   ${n} set to generated`)
  changed(n)
}

function readTopicSource(localPath: string): string | null {
  // Mirrors src/scripts/seed.ts: a file is read as-is, a directory concatenates its non-PDF files.
  if (!fs.existsSync(localPath)) return null
  const stat = fs.statSync(localPath)
  if (stat.isFile()) return localPath.toLowerCase().endsWith('.pdf') ? '' : fs.readFileSync(localPath, 'utf-8')
  let raw = ''
  for (const f of fs.readdirSync(localPath)) {
    const fp = path.join(localPath, f)
    if (fs.statSync(fp).isFile() && !fp.toLowerCase().endsWith('.pdf')) raw += fs.readFileSync(fp, 'utf-8') + '\n\n'
  }
  return raw
}

async function stepMarker() {
  log('9. Enrichment marker -> enrichedAt / originalQuestionText')
  const rows = await prisma.exercise.findMany({
    where: { questionText: { startsWith: ENRICHED_MARKER } },
    select: { id: true, questionText: true, choices: true, correctAnswer: true, originalQuestionText: true, topic: { select: { localPath: true } } },
  })
  const parsedCache = new Map<string, ParsedExercise[] | null>()
  const stats = { recovered: 0, unmatched: 0, generated: 0, noPath: 0, noFile: 0, noMatch: 0, ambiguous: 0 }
  const now = new Date()
  for (const r of rows) {
    const { text } = stripEnrichmentMarker(r.questionText)
    let original: string | null = null
    if (r.id.startsWith('gen-')) {
      stats.generated++
    } else if (!r.topic?.localPath) {
      stats.noPath++
    } else {
      const p = r.topic.localPath
      if (!parsedCache.has(p)) {
        const raw = readTopicSource(p)
        parsedCache.set(p, raw === null ? null : parseExerciseMarkdown(raw))
      }
      const parsed = parsedCache.get(p)
      if (!parsed) {
        stats.noFile++
      } else {
        const matches = parsed.filter((e) => e.correctAnswer === r.correctAnswer && JSON.stringify(e.choices) === r.choices)
        if (matches.length === 1) {
          original = matches[0].questionText
          stats.recovered++
        } else if (matches.length === 0) stats.noMatch++
        else stats.ambiguous++
      }
    }
    if (original === null && !r.id.startsWith('gen-')) stats.unmatched++
    if (!DRY) {
      await prisma.exercise.update({
        where: { id: r.id },
        data: { questionText: text, enrichedAt: now, ...(original !== null && r.originalQuestionText === null ? { originalQuestionText: original } : {}) },
      })
    }
    changed(1)
  }
  log(`   ${rows.length} marker rows stripped; imported rows: originals recovered ${stats.recovered}, unmatched ${stats.unmatched} (no path ${stats.noPath}, file missing ${stats.noFile}, no match ${stats.noMatch}, ambiguous ${stats.ambiguous}); generated rows (no original): ${stats.generated}`)
}

async function stepGraded() {
  log('10. Exercise.isGraded candidates (reviewed, not applied automatically)')
  const exercises = await prisma.exercise.findMany({
    select: { id: true, questionText: true, exerciseType: true, choices: true, correctAnswer: true, isGraded: true, topic: { select: { title: true } } },
  })
  const excludedByOldFilter = exercises.filter((e) => legacySurveyFilterExcludes(e.questionText, e.topic?.title)).length
  const perRule: Record<string, number> = Object.fromEntries(GRADED_RULES.map((r) => [r, 0]))
  const rows: { id: string; title: string; text: string; rules: string[] }[] = []
  for (const e of exercises) {
    if (!e.isGraded) continue
    const rules = gradedRulesMatched({ topicTitle: e.topic?.title, questionText: e.questionText, exerciseType: e.exerciseType, choices: e.choices, correctAnswer: e.correctAnswer })
    if (rules.length === 0) continue
    rules.forEach((r) => perRule[r]++)
    rows.push({ id: e.id, title: e.topic?.title ?? '', text: e.questionText, rules })
  }
  rows.sort((a, b) => a.rules.join().localeCompare(b.rules.join()) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
  const clean = (s: string) => s.replace(/[\t\r\n]+/g, ' ').trim()
  const tsv = ['id\ttopicTitle\tquestion160\trules', ...rows.map((r) => [r.id, clean(r.title), clean(r.text).slice(0, 160), r.rules.join(',')].join('\t'))].join('\n') + '\n'
  // With --apply-graded the review file is the approved input and must not be regenerated.
  if (!APPLY_GRADED) {
    fs.mkdirSync(path.dirname(REVIEW_FILE), { recursive: true })
    fs.writeFileSync(REVIEW_FILE, tsv)
  }
  log(`   candidates: ${rows.length}${APPLY_GRADED ? ` (review file ${REVIEW_FILE} read, not rewritten)` : ` (written to ${REVIEW_FILE})`}`)
  for (const r of GRADED_RULES) log(`     rule ${r}: ${perRule[r]}`)
  log(`   exercises excluded by today's createStudySession text filter: ${excludedByOldFilter}`)
  if (APPLY_GRADED) {
    const ids = fs
      .readFileSync(REVIEW_FILE, 'utf-8')
      .split('\n')
      .slice(1)
      .map((l) => l.split('\t')[0])
      .filter(Boolean)
    if (!DRY) for (const part of chunks(ids)) await prisma.exercise.updateMany({ where: { id: { in: part } }, data: { isGraded: false } })
    log(`   --apply-graded: ${ids.length} exercises set isGraded = false`)
    changed(ids.length)
  }
}

async function main() {
  log(`Studyspaces backfill${DRY ? ' (DRY RUN)' : ''}${APPLY_GRADED ? ' (--apply-graded)' : ''}`)
  const courses = await prisma.course.findMany({ select: { id: true, code: true, title: true, profile: true, starterStatus: true } })
  await stepTitles(courses)
  await stepProfiles(courses)
  await stepOrder(courses)
  await stepQuantitative(courses)
  await stepSessionCourses(courses)
  await stepPlans()
  await stepSessionItems()
  await stepOrigin()
  await stepMarker()
  await stepGraded()
  log('')
  log(`TOTAL CHANGES${DRY ? ' (would be made)' : ''}: ${totalChanges}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
