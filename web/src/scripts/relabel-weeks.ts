// Labels every topic of a studyspace with its course week, read from the name of the file it came from (see lib/weekLabels.ts),
// sets the class (lesson) of each topic and puts the topics in course order: week, then lectures, exercises, slides and readings.
//
//   DATABASE_URL=file:./dev.db npx tsx src/scripts/relabel-weeks.ts <course id> <names.json> [--dry]
//
// names.json maps a week number to its title: {"1": "Introduction", "2": "Nutrition and Productivity", ...}. A source whose name
// carries no week is left alone. Safe to run again.
import fs from 'fs'
import { prisma } from '@/lib/db'
import { parseWeekFile, weekLabel, classNameFor, KIND_RANK } from '@/lib/weekLabels'

const [courseId, namesPath, flag] = process.argv.slice(2)
if (!courseId || !namesPath) {
  console.error('usage: relabel-weeks <course id> <names.json> [--dry]')
  process.exit(1)
}
const dry = flag === '--dry'

async function main() {
  const names: Record<string, string> = JSON.parse(fs.readFileSync(namesPath, 'utf8'))
  const topics = await prisma.topic.findMany({
    where: { courseId },
    select: { id: true, order: true, content: true, source: { select: { originalName: true } } },
  })
  type Row = { id: string; order: number; week: number; rank: number; label: string; className: string }
  const rows: Row[] = []
  const untouched: string[] = []
  for (const t of topics) {
    const name = t.source?.originalName
    const parsed = name ? parseWeekFile(name) : null
    if (!name || !parsed) { untouched.push(t.id); continue }
    const title = names[String(parsed.week)]
    if (!title) throw new Error(`names.json has no title for week ${parsed.week} (${name})`)
    rows.push({ id: t.id, order: t.order, week: parsed.week, rank: KIND_RANK[parsed.kind], label: weekLabel(parsed.week, title), className: classNameFor(parsed.kind, name, t.content) })
  }
  rows.sort((a, b) => a.week - b.week || a.rank - b.rank || a.order - b.order)
  const labels = new Map<string, number>()
  rows.forEach((r) => labels.set(r.label, (labels.get(r.label) ?? 0) + 1))
  console.log({ topics: topics.length, relabelled: rows.length, untouched: untouched.length })
  console.table([...labels.entries()].map(([label, n]) => ({ label, topics: n })))
  if (dry) return
  // Untouched topics keep their order after the labelled ones
  await prisma.$transaction(async (tx) => {
    let order = 0
    for (const r of rows) await tx.topic.update({ where: { id: r.id }, data: { week: r.label, className: r.className, order: order++ } })
    for (const id of untouched) await tx.topic.update({ where: { id }, data: { order: order++ } })
  }, { timeout: 120_000, maxWait: 30_000 })
  console.log('done')
}
main().finally(() => prisma.$disconnect())
