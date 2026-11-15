/**
 * Multi-part problems. A group is a shared stem (setup, model, figure) with ordered sub-questions; every sub-question is an
 * ordinary exercise (own answer, grade, log) that points at the group with `groupId` / `groupPosition`. Pure and client-safe.
 */

export type GroupInfo = { id: string; title: string; stem: string }

export type GroupedExercise = {
  id: string
  groupId?: string | null
  groupPosition?: number | null
  group?: GroupInfo | null
}

export type GroupContext = { title: string; stem: string; part: number; total: number }

/**
 * What the card shows above a sub-question: the stem and "Part k of n". `part` and `total` count the sub-questions that are in
 * this session (a retired sub-question is not in it). Null for a standalone question or a group with no stem.
 */
export function groupContext(items: GroupedExercise[], index: number): GroupContext | null {
  const current = items[index]
  if (!current?.groupId || !current.group?.stem?.trim()) return null
  let part = 0
  let total = 0
  items.forEach((it, i) => {
    if (it.groupId !== current.groupId) return
    total++
    if (i <= index) part++
  })
  return { title: current.group.title, stem: current.group.stem, part, total }
}

/**
 * Makes a drawn selection group-complete: every drawn sub-question brings the other active sub-questions of its group, the
 * group sits where its first drawn member was, in `groupPosition` order, and a standalone question stays where it was drawn.
 *
 * `count` is the size the student asked for. A group is never split, so the session can run over it by up to the size of one
 * group; when it would run further, standalone questions at the end are dropped first (and then whole groups from the end,
 * the first one is always kept), so an exam of 10 does not turn into 25.
 */
export function expandGroupSelection<T extends GroupedExercise>(selected: T[], siblings: Map<string, T[]>, count: number): T[] {
  type Slot = { groupId: string | null; items: T[] }
  const slots: Slot[] = []
  const slotOfGroup = new Map<string, Slot>()
  const seen = new Set<string>()
  for (const ex of selected) {
    if (!ex.groupId) {
      if (seen.has(ex.id)) continue
      seen.add(ex.id)
      slots.push({ groupId: null, items: [ex] })
      continue
    }
    if (slotOfGroup.has(ex.groupId)) continue
    const members = [...(siblings.get(ex.groupId) ?? [ex])]
    if (!members.some((m) => m.id === ex.id)) members.push(ex)
    members.sort((a, b) => (a.groupPosition ?? 0) - (b.groupPosition ?? 0))
    const slot: Slot = { groupId: ex.groupId, items: members.filter((m) => !seen.has(m.id)) }
    members.forEach((m) => seen.add(m.id))
    slotOfGroup.set(ex.groupId, slot)
    slots.push(slot)
  }
  const size = () => slots.reduce((n, s) => n + s.items.length, 0)
  // Over the asked size: standalone questions go first, from the end, then whole groups from the end
  for (const dropGroups of [false, true]) {
    for (let i = slots.length - 1; i > 0 && size() > count; i--) {
      if (dropGroups || slots[i].groupId === null) slots.splice(i, 1)
    }
  }
  return slots.flatMap((s) => s.items)
}

export type PartState = 'open' | 'answered' | 'correct' | 'partial' | 'incorrect'
export type ProblemPart = { index: number; number: number; state: PartState; flagged: boolean; current: boolean }
export type ProblemSummary = { parts: ProblemPart[]; answered: number; total: number; points: number }

/**
 * The parts of the problem the exercise at `index` belongs to, for the strip above the card: every item of the session with the
 * same group, in session order, each with its state. `stateOf` says what the student did with an item (the screen knows logs and
 * exam drafts), `flaggedOf` whether it is flagged. `points` adds the score of the checked parts (`scoreOf`, 0 to 1 each).
 * Null for a standalone question or a group with a single item in the session.
 */
export function problemSummary(
  items: GroupedExercise[],
  index: number,
  stateOf: (item: GroupedExercise) => PartState,
  flaggedOf: (item: GroupedExercise) => boolean,
  scoreOf: (item: GroupedExercise) => number,
): ProblemSummary | null {
  const current = items[index]
  if (!current?.groupId) return null
  const members = items.map((item, i) => ({ item, i })).filter(({ item }) => item.groupId === current.groupId)
  if (members.length < 2) return null
  const parts = members.map(({ item, i }, n) => ({ index: i, number: n + 1, state: stateOf(item), flagged: flaggedOf(item), current: i === index }))
  return {
    parts,
    answered: parts.filter((p) => p.state !== 'open').length,
    total: parts.length,
    points: members.reduce((sum, { item }) => sum + (['correct', 'partial', 'incorrect'].includes(stateOf(item)) ? scoreOf(item) : 0), 0),
  }
}
