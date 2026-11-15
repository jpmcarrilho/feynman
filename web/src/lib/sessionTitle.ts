// Title of a new study session from the topics it draws on. Pure.

export type TitleTopic = { week: string | null; sourceId: string | null; course: { code: string; title: string } | null }

/** The two imported studyspaces keep their course code (topics without a file); studyspaces made with the wizard show their title. */
export function courseLabel(t: TitleTopic): string | undefined {
  if (!t.course) return undefined
  return t.sourceId ? t.course.title : t.course.code
}

export function buildSessionTitle(mode: string, topics: TitleTopic[]): string {
  let sessionTitle = mode === 'exam' ? 'Timed Exam Session' : 'Random Study Session'
  if (topics.length === 0) return sessionTitle
  const courseCodes = Array.from(new Set(topics.map(courseLabel).filter(Boolean)))
  const weeks = Array.from(
    new Set(
      topics
        .map((t) => {
          const w = t.week || ''
          const match = w.match(/Week_(\d+)/i) || w.match(/Week\s*(\d+)/i)
          if (match) return `Week ${parseInt(match[1])}`
          return w.replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
        })
        .filter(Boolean),
    ),
  )
  const typePrefix = mode === 'exam' ? 'Exam' : 'Study'
  if (courseCodes.length > 0 && weeks.length > 0) sessionTitle = `${courseCodes.join(', ')} - ${weeks.join(', ')} (${typePrefix})`
  else if (courseCodes.length > 0) sessionTitle = `${courseCodes.join(', ')} ${typePrefix} Session`
  else if (weeks.length > 0) sessionTitle = `${weeks.join(', ')} ${typePrefix} Session`
  return sessionTitle
}
