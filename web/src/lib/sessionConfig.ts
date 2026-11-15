/**
 * The study-session configuration, as pure functions: what a module (a course week) holds and how far the student is in it, what
 * a session of a given size will draw, the goal presets, and the last configuration kept between sessions. Client-safe; the dialog
 * (components/features/ConfigureSessionDialog.tsx) only draws it.
 */

/** The fields of a topic (see `getTopicsWithPerformance`) that the configuration needs. All counts may be missing on older data. */
export type ConfigTopic = {
  id: string
  week?: string | null
  totalExercises?: number | null
  uniquelyCompleted?: number | null
  accuracy?: number | null
  groupedExercises?: number | null
  groupCount?: number | null
}

export type ModuleStat = {
  /** The module label as stored on the topics (`Topic.week`). */
  key: string
  topicIds: string[]
  /** Questions a session can draw from. */
  questions: number
  /** Of those, answered at least once. */
  completed: number
  /** completed / questions, 0 to 100. */
  coverage: number
  /** Share of correct answers, 0 to 100, or null when nothing was answered. Weighted by the questions answered per topic. */
  accuracy: number | null
  /** Multi-part problems and the number of parts in them. */
  problems: number
  problemParts: number
}

const num = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** One entry per module (week), in the order the modules first appear in `topics`. Topics without a module are left out. */
export function moduleStats(topics: ConfigTopic[]): ModuleStat[] {
  const order: string[] = []
  const byKey = new Map<string, ConfigTopic[]>()
  for (const t of topics) {
    if (!t.week) continue
    if (!byKey.has(t.week)) { byKey.set(t.week, []); order.push(t.week) }
    byKey.get(t.week)!.push(t)
  }
  return order.map((key) => {
    const list = byKey.get(key)!
    const questions = list.reduce((n, t) => n + num(t.totalExercises), 0)
    const completed = list.reduce((n, t) => n + num(t.uniquelyCompleted), 0)
    const answered = list.filter((t) => t.accuracy !== null && t.accuracy !== undefined && num(t.uniquelyCompleted) > 0)
    const weight = answered.reduce((n, t) => n + num(t.uniquelyCompleted), 0)
    const accuracy = weight > 0 ? Math.round(answered.reduce((n, t) => n + num(t.accuracy) * num(t.uniquelyCompleted), 0) / weight) : null
    return {
      key,
      topicIds: list.map((t) => t.id),
      questions,
      completed,
      coverage: questions > 0 ? Math.round((completed / questions) * 100) : 0,
      accuracy,
      problems: list.reduce((n, t) => n + num(t.groupCount), 0),
      problemParts: list.reduce((n, t) => n + num(t.groupedExercises), 0),
    }
  })
}

/** The weakest modules: answered ones by lowest accuracy first, then unseen ones, never empty ones. */
export function weakestModules(stats: ModuleStat[], howMany = 3): string[] {
  return stats
    .filter((s) => s.questions > 0)
    .map((s) => ({ s, rank: s.accuracy === null ? 101 : s.accuracy }))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, howMany)
    .map(({ s }) => s.key)
}

/** The module keys between two clicked modules, both included (shift-click), in display order. */
export function moduleRange(stats: ModuleStat[], fromKey: string, toKey: string): string[] {
  const a = stats.findIndex((s) => s.key === fromKey)
  const b = stats.findIndex((s) => s.key === toKey)
  if (a < 0 || b < 0) return [toKey]
  const [lo, hi] = a <= b ? [a, b] : [b, a]
  return stats.slice(lo, hi + 1).map((s) => s.key)
}

export type SelectionStat = { topics: number; questions: number; unseen: number; problems: number; problemParts: number }

/** What the session can draw from. `scopeIds` empty means every topic. */
export function selectionStats(topics: ConfigTopic[], scopeIds: string[]): SelectionStat {
  const ids = new Set(scopeIds)
  const inScope = ids.size === 0 ? topics : topics.filter((t) => ids.has(t.id))
  const questions = inScope.reduce((n, t) => n + num(t.totalExercises), 0)
  const completed = inScope.reduce((n, t) => n + num(t.uniquelyCompleted), 0)
  return {
    topics: inScope.length,
    questions,
    unseen: Math.max(0, questions - completed),
    problems: inScope.reduce((n, t) => n + num(t.groupCount), 0),
    problemParts: inScope.reduce((n, t) => n + num(t.groupedExercises), 0),
  }
}

export type SessionPlan = {
  count: number
  /** Questions taken from the course's own questions. */
  fromCourse: number
  /** Questions written by the AI while the student studies: the share asked for, plus whatever the course questions cannot cover. */
  fromAi: number
  /** True when the course has fewer questions than the mix asks for, so the AI fills in more than the mix says. */
  shortOfCourse: boolean
}

/** Mirrors how a session is drawn (`startSession`): at most the course share of `count` comes from stored questions, the rest is written. */
export function planSession(count: number, aiSharePct: number, available: number): SessionPlan {
  const share = Math.min(100, Math.max(0, aiSharePct)) / 100
  const wanted = Math.floor(count * (1 - share))
  const fromCourse = Math.min(wanted, Math.max(0, available))
  return { count, fromCourse, fromAi: count - fromCourse, shortOfCourse: available < wanted }
}

/** Minutes per question, rounded to a tenth, or null without a time limit or questions. */
export function minutesPerQuestion(timeLimitSeconds: number | null, count: number): number | null {
  if (!timeLimitSeconds || count <= 0) return null
  return Math.round((timeLimitSeconds / 60 / count) * 10) / 10
}

// --- presets and the remembered configuration -------------------------------------------------------------------------------

export type Focus = 'balanced' | 'remedial' | 'unstudied' | 'maintenance'

export type SessionConfig = {
  mode: 'study' | 'exam'
  count: number
  practiceMinutes: number
  examMinutes: number
  /** Share of AI-written questions, 0 (course questions only) to 100. */
  sourcingMix: number
  focus: Focus
  /** Module keys ticked in the picker. */
  weeks: string[]
}

export const DEFAULT_CONFIG: SessionConfig = { mode: 'study', count: 10, practiceMinutes: 5, examMinutes: 75, sourcingMix: 50, focus: 'balanced', weeks: [] }

export type PresetId = 'quick' | 'weak' | 'new' | 'problems' | 'exam'

export type SessionPreset = { id: PresetId; label: string; hint: string }

export const PRESETS: SessionPreset[] = [
  { id: 'quick', label: 'Quick 10', hint: '10 course questions, balanced' },
  { id: 'weak', label: 'Weak spots', hint: '20 questions, mostly what you got wrong' },
  { id: 'new', label: 'New material', hint: '20 questions you have not seen' },
  { id: 'problems', label: 'Problems', hint: 'Topics that have multi-part problems' },
  { id: 'exam', label: 'Exam simulation', hint: 'Timed, course questions' },
]

/**
 * What a preset sets. `topicIds` is returned only by presets that choose topics (Problems: the topics that hold multi-part
 * problems). Every preset uses course questions only (sourcingMix 0) and clears the module picker; the student can still change
 * anything afterwards.
 */
export function applyPreset(id: PresetId, topics: ConfigTopic[], examPreset?: { questionCount: number } | null): { config: SessionConfig; topicIds: string[] } {
  const base: SessionConfig = { ...DEFAULT_CONFIG, sourcingMix: 0, weeks: [] }
  switch (id) {
    case 'quick': return { config: { ...base, count: 10, practiceMinutes: 15 }, topicIds: [] }
    case 'weak': return { config: { ...base, count: 20, practiceMinutes: 30, focus: 'remedial' }, topicIds: [] }
    case 'new': return { config: { ...base, count: 20, practiceMinutes: 30, focus: 'unstudied' }, topicIds: [] }
    case 'problems': return { config: { ...base, count: 20, practiceMinutes: 30 }, topicIds: topics.filter((t) => num(t.groupCount) > 0).map((t) => t.id) }
    case 'exam': return { config: { ...base, mode: 'exam', count: examPreset?.questionCount ?? 20, examMinutes: 75 }, topicIds: [] }
  }
}

const STORAGE_PREFIX = 'feynman:session-config:'

function isConfig(v: unknown): v is SessionConfig {
  const c = v as Partial<SessionConfig> | null
  return !!c && (c.mode === 'study' || c.mode === 'exam')
    && Number.isFinite(c.count) && Number.isFinite(c.practiceMinutes) && Number.isFinite(c.examMinutes) && Number.isFinite(c.sourcingMix)
    && ['balanced', 'remedial', 'unstudied', 'maintenance'].includes(c.focus as string)
    && Array.isArray(c.weeks) && c.weeks.every((w) => typeof w === 'string')
}

/** The last configuration of a studyspace, or null (nothing saved, storage blocked or an old shape). Never throws. */
export function loadConfig(spaceKey: string, storage: Pick<Storage, 'getItem'> | null = typeof window === 'undefined' ? null : window.localStorage): SessionConfig | null {
  try {
    const raw = storage?.getItem(STORAGE_PREFIX + spaceKey)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return isConfig(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Keeps the configuration of a studyspace for next time. Never throws. */
export function saveConfig(spaceKey: string, config: SessionConfig, storage: Pick<Storage, 'setItem'> | null = typeof window === 'undefined' ? null : window.localStorage): void {
  try {
    storage?.setItem(STORAGE_PREFIX + spaceKey, JSON.stringify(config))
  } catch {
    /* storage blocked or full: the configuration is only a convenience */
  }
}
