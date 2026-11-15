/**
 * Where the course material comes from. The studyspaces built from MITx courses use their lectures, exercises and readings, and the
 * questions the app writes are derived from them, so the source is named wherever that material or a question from it is shown
 * (the repository LICENSE asks for attribution to be kept in the app, and ATTRIBUTION.md at the repository root gives the full
 * statement). Pure and client-safe. A course not listed here has no credit line.
 */

export type CourseCredit = {
  /** The course code as stored on `Course.code`. */
  code: string
  title: string
  provider: string
  /** The run of the course the material was taken from. */
  run: string
  /** The course page on MIT Learn (needs a sign-in). */
  url: string
}

const MIT_LEARN = 'https://courses.learn.mit.edu/learn/course/course-v1:MITxT+'

const CREDITS: CourseCredit[] = [
  { code: '14.740x', title: 'Foundations of Development Policy', provider: 'MITx', run: '3T2026', url: `${MIT_LEARN}14.740x+3T2026` },
  { code: '14.750x', title: 'Political Economy and Economic Development', provider: 'MITx', run: '2T2026', url: `${MIT_LEARN}14.750x+2T2026` },
  { code: 'JPAL102x', title: 'Designing and Running Randomized Evaluations', provider: 'MITx / J-PAL', run: '2T2026', url: `${MIT_LEARN}JPAL102x+2T2026` },
]

export function courseCredit(code: string | null | undefined): CourseCredit | null {
  return CREDITS.find((c) => c.code === code) ?? null
}

/** Questions the app wrote itself (not imported from the course files). */
export function isWrittenByAi(origin: string | null | undefined): boolean {
  return origin === 'generated' || origin === 'starter'
}

/** The credit line for a course, with a note when the question was written by the AI. Null for an unknown course. */
export function creditLine(code: string | null | undefined, origin?: string | null): string | null {
  const c = courseCredit(code)
  if (!c) return null
  const base = `Course material: ${c.code} ${c.title}, ${c.provider} (MIT Learn, run ${c.run}). Used for personal, non-commercial study.`
  return isWrittenByAi(origin) ? `${base} This question was written by AI from that material.` : base
}
