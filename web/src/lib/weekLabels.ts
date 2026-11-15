/**
 * Course weeks as modules. The app's segmenter names modules itself, so one week of a course can end up spread over several of
 * them (and every uploaded file adds more). Progress and results are grouped by `Topic.week`, so a studyspace built from a course
 * that has weeks labels each topic with its real week, read from the name of the file it came from:
 *
 *   Week_05_Insurance_lectures.md      lecture transcripts of week 5
 *   Exercises_week_05_homework.md      the homework of week 5
 *   Exercises_week_05_finger.md        the finger exercises (the short quizzes after each lecture video) of week 5
 *   Exercises_week_05.md               exercises of week 5 that are not split by kind
 *   Week_05_Slides_05_Insurance_Part1.pdf   slides, readings and handouts of week 5
 *
 * Pure and client-safe; `src/scripts/relabel-weeks.ts` applies it to a studyspace.
 */

export type SourceKind = 'lectures' | 'exercises' | 'file'

export type ExerciseKind = 'homework' | 'finger'

export type WeekFile = { week: number; kind: SourceKind; /** Exercise files only: the kind named in the file name, when it names one. */ exerciseKind?: ExerciseKind }

/** The week and kind of a source file name, or null when the name carries no week. */
export function parseWeekFile(name: string): WeekFile | null {
  const exercises = name.match(/^Exercises_week_(\d{1,2})(?:_(homework|finger))?\./i)
  if (exercises) return { week: Number(exercises[1]), kind: 'exercises', ...(exercises[2] ? { exerciseKind: exercises[2].toLowerCase() as ExerciseKind } : {}) }
  const weekly = name.match(/^Week_(\d{1,2})_/i)
  if (!weekly) return null
  return { week: Number(weekly[1]), kind: /_lectures\.(md|txt)$/i.test(name) ? 'lectures' : 'file' }
}

/** "Week 05 · Insurance": the module label of a week. Two digits so labels sort in course order. */
export function weekLabel(week: number, title: string): string {
  return `Week ${String(week).padStart(2, '0')} · ${title.trim()}`
}

/** Order of the kinds inside a week: lectures, then exercises, then the slides and readings. */
export const KIND_RANK: Record<SourceKind, number> = { lectures: 0, exercises: 1, file: 2 }

/** The sequential a lecture topic belongs to: the first `## <sequential> - <unit>` heading of its text, without the unit. */
export function sequentialOf(content: string | null | undefined): string | null {
  const m = (content ?? '').match(/^## (.+?) - .+$/m)
  return m ? m[1].trim() : null
}

/** The class names of the two kinds of exercise: the session screen offers them as a filter. */
export const HOMEWORK_CLASS = 'Homework'
export const FINGER_CLASS = 'Finger exercises'

/** The class (the lesson or file) a topic is listed under inside its week. */
export function classNameFor(kind: SourceKind, fileName: string, content: string | null | undefined): string {
  if (kind === 'exercises') {
    const named = parseWeekFile(fileName)?.exerciseKind
    return named === 'homework' ? HOMEWORK_CLASS : named === 'finger' ? FINGER_CLASS : 'Exercises'
  }
  if (kind === 'lectures') return sequentialOf(content) ?? 'Lectures'
  return fileName.replace(/^Week_\d{1,2}_/i, '').replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim() || fileName
}
