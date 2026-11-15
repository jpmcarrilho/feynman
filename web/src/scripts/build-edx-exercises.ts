// Builds the exercise upload files of an edX crawl (MIT_Learn_Courses/<course>) with multi-part problems.
//
//   npx tsx src/scripts/build-edx-exercises.ts <course dir> <output dir>
//
// For each homework sequential it reads the handout PDF(s) saved in the sequential, asks the model which questions of each unit
// form one problem with a shared setup (src/server/ingest/problemSets.ts, checked by code), and writes `# Problem set:`
// sections. Quiz units of the lectures stay standalone. Two files per week (`Exercises_week_NN_homework.md`, `Exercises_week_NN_finger.md`). A homework with no handout PDF uses the slides, readings and lecture
// transcripts of its week as the source of the setup (the same code check applies). Writes the files, plus
// `groups.json` (what was found, for review); a unit that already has groups there is not asked again, so a re-run only
// retries the units that failed. Needs GOOGLE_GENERATIVE_AI_API_KEY (loaded from the environment).
import fs from 'fs'
import path from 'path'
import { parsePdfBuffer } from '@/services/ingest'
import { proposeProblemSets, renderUnit, type ProposedGroup } from '@/server/ingest/problemSets'
import { newModelStats } from '@/server/ingest/modelCall'
import { mapWithConcurrency } from '@/server/ingest/pool'

const [courseDir, outDir] = process.argv.slice(2)
if (!courseDir || !outDir) {
  console.error('usage: build-edx-exercises <course dir> <output dir>')
  process.exit(1)
}

const isDir = (p: string) => fs.statSync(p).isDirectory()
const clean = (s: string) => s.replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
const exerciseNumber = (f: string) => parseInt(f.match(/\d+/)![0], 10)

type UnitJob = { week: string; weekIndex: number; seq: string; unit: string; blocks: string[]; handout: string; homework: boolean; weekSource: boolean }

/** Slides, readings and lecture transcripts of one week: the fallback source of a homework setup when it has no handout. */
async function weekSourceText(weekDir: string): Promise<string> {
  const pdfs: string[] = []
  const transcripts: string[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.pdf$/i.test(e.name)) pdfs.push(p)
      else if (e.name === 'Transcript.txt') transcripts.push(p)
    }
  }
  walk(weekDir)
  const seen = new Set<string>()
  let text = ''
  for (const pdf of pdfs.sort()) {
    const buf = fs.readFileSync(pdf)
    const key = `${buf.length}:${path.basename(pdf)}`
    if (seen.has(key)) continue
    seen.add(key)
    text += `${await parsePdfBuffer(buf)}\n\n`
  }
  for (const t of transcripts.sort()) text += `${fs.readFileSync(t, 'utf8')}\n\n`
  return text
}

function listPdfs(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...listPdfs(p))
    else if (/\.pdf$/i.test(e.name) && /(HW|Assignment|Homework|Questions)/i.test(e.name)) out.push(p)
  }
  return out
}

async function collect(): Promise<UnitJob[]> {
  const jobs: UnitJob[] = []
  const weeks = fs.readdirSync(courseDir).filter((w) => w.startsWith('Week_')).sort()
  for (const [weekIndex, week] of weeks.entries()) {
    for (const seq of fs.readdirSync(path.join(courseDir, week)).sort()) {
      const sd = path.join(courseDir, week, seq)
      if (!isDir(sd) || /Entrance/i.test(seq)) continue
      const homework = /Homework|Assignment/i.test(seq)
      let handout = ''
      let weekSource = false
      if (homework) {
        for (const pdf of listPdfs(sd)) handout += `${await parsePdfBuffer(fs.readFileSync(pdf))}\n\n`
        if (!handout.trim()) {
          handout = await weekSourceText(path.join(courseDir, week))
          weekSource = true
        }
      }
      for (const unit of fs.readdirSync(sd).sort()) {
        const ud = path.join(sd, unit)
        if (!isDir(ud)) continue
        const blocks: string[] = []
        for (const f of fs.readdirSync(ud).filter((f) => /^Exercise_\d+\.md$/.test(f)).sort((a, b) => exerciseNumber(a) - exerciseNumber(b))) {
          const t = fs.readFileSync(path.join(ud, f), 'utf8')
          if (/\[x\]/i.test(t)) blocks.push(t.trim())
        }
        if (blocks.length > 0) jobs.push({ week, weekIndex, seq, unit, blocks, handout, homework, weekSource })
      }
    }
  }
  return jobs
}

const questionText = (block: string) => block.replace(/^# Question\s*/, '').split(/^## Choices/m)[0].trim().slice(0, 900)

async function main() {
  fs.mkdirSync(outDir, { recursive: true })
  const jobs = await collect()
  const stats = newModelStats()
  const report: { week: string; seq: string; unit: string; questions: number; groups: { title: string; questionNumbers: number[]; stem: string }[]; error?: string }[] = []
  const rendered = new Map<UnitJob, string>()
  const previousFile = path.join(outDir, 'groups.json')
  const previous: typeof report = fs.existsSync(previousFile) ? JSON.parse(fs.readFileSync(previousFile, 'utf8')) : []
  const reuse = (job: UnitJob) => previous.find((r) => r.week === job.week && r.seq === job.seq && r.unit === job.unit && !r.error && r.questions === job.blocks.length)

  await mapWithConcurrency(jobs, 4, async (job) => {
    let groups: ProposedGroup[] = []
    let error: string | undefined
    const before = reuse(job)
    if (before) {
      groups = before.groups
    } else if (job.homework && job.blocks.length >= 2) {
      try {
        groups = await proposeProblemSets({ unitTitle: `${clean(job.seq)} / ${clean(job.unit)}`, handout: job.handout, questions: job.blocks.map(questionText) }, { stats })
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
      }
    }
    rendered.set(job, renderUnit(job.blocks, groups))
    report.push({ week: job.week, seq: job.seq, unit: job.unit, questions: job.blocks.length, groups, error })
    console.log(`${job.week.slice(0, 7)} ${clean(job.seq).slice(0, 40)} / ${job.unit.slice(0, 24)}: ${job.blocks.length} questions, ${groups.length} groups${before ? ' (kept)' : ''}${job.weekSource ? ' (week source)' : ''}${error ? `, ERROR ${error}` : ''}`)
  })

  // Two files per week, units in course order: the homework (graded assignments) and the finger exercises (the short quizzes after
  // each lecture video). The file name carries the week and the kind (src/scripts/relabel-weeks.ts reads both).
  const byWeek = new Map<number, UnitJob[]>()
  for (const job of jobs) byWeek.set(job.weekIndex, [...(byWeek.get(job.weekIndex) ?? []), job])
  for (const [, list] of [...byWeek.entries()].sort((x, y) => x[0] - y[0])) {
    const number = list[0].week.slice(5, 7)
    for (const [kind, isHomework] of [['homework', true], ['finger', false]] as const) {
      const part = list.filter((j) => j.homework === isHomework)
      if (part.length === 0) continue
      fs.writeFileSync(path.join(outDir, `Exercises_week_${number}_${kind}.md`), `${part.map((j) => rendered.get(j)).join('\n\n')}\n`)
      console.log(`wrote Exercises_week_${number}_${kind}.md`)
    }
  }
  fs.writeFileSync(path.join(outDir, 'groups.json'), JSON.stringify(report, null, 1))
  console.log({ units: jobs.length, groups: report.reduce((n, r) => n + r.groups.length, 0), errors: report.filter((r) => r.error).length, modelCalls: stats.calls, failedCalls: stats.failedCalls })
}
main()
