// Student-facing labels for where a question comes from. Pure and client-safe.
//
// Stored `Topic.week` ("Module" in the UI) comes in three shapes:
//   legacy, two numbers   "Week_01_Week_1__Introduction_to_Politi"   (the course's own week number, title cut short)
//   legacy, one number    "Week_06_Sampling_and_Sample_Size"
//   uploaded content      "03 · Module title"                          (NN is the module index, see plan 3.5)
// `Topic.className` is the lecture / class name ("Introduction to Political Economy (14 Questions)") or, for uploaded
// content, the source file name. `Topic.title` of imported question topics is only "Question 6", so it is not shown.

export interface LabelledTopic {
  week?: string | null
  className?: string | null
  title?: string | null
}

/** Underscores to spaces. The same normalization the module pickers use. */
export function formatDisplayName(name: string | null | undefined): string {
  if (!name) return ''
  return name.replace(/_+/g, ' ').trim()
}

const UPLOADED_MODULE_RE = /^\d+\s·\s/
const LEGACY_DOUBLE_WEEK_RE = /^Week_0*(\d+)_Week_\d+_+(.*)$/
const LEGACY_SINGLE_WEEK_RE = /^Week_0*(\d+)_+(.*)$/

function cleanClassName(className: string | null | undefined): string {
  return formatDisplayName(className)
    .replace(/\s*\(\d+\s+Questions?\)\s*$/i, '')
    .replace(/\.(pdf|txt|md)$/i, '')
    .trim()
}

/** "Week 1", or "NN · Module title" for uploaded content, or the cleaned stored text for anything else. */
function moduleHead(week: string): string {
  if (UPLOADED_MODULE_RE.test(week)) return week.trim()
  const m = week.match(LEGACY_DOUBLE_WEEK_RE) || week.match(LEGACY_SINGLE_WEEK_RE)
  return m ? `Week ${parseInt(m[1], 10)}` : formatDisplayName(week)
}

/** A module as the student reads it: "Week 6 · Sampling and Sample Size", "03 · Cell biology". */
export function moduleLabel(week: string | null | undefined): string {
  if (!week) return ''
  if (UPLOADED_MODULE_RE.test(week)) return week.trim()
  const m = week.match(LEGACY_DOUBLE_WEEK_RE) || week.match(LEGACY_SINGLE_WEEK_RE)
  if (!m) return formatDisplayName(week)
  const title = formatDisplayName(m[2])
  return title ? `Week ${parseInt(m[1], 10)} · ${title}` : `Week ${parseInt(m[1], 10)}`
}

/**
 * Where a question comes from: the module and the class or lecture, for example
 * "Week 1 · Introduction to Political Economy and Economic Development". Falls back to whichever part exists, then to the
 * topic title.
 */
export function topicSourceLabel(topic: LabelledTopic | null | undefined): string {
  if (!topic) return ''
  const head = topic.week ? moduleHead(topic.week) : ''
  const cls = cleanClassName(topic.className)
  if (head && cls) return `${head} · ${cls}`
  return head || cls || formatDisplayName(topic.title)
}
