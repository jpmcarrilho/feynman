// Pure helpers of the outline editor: what to send to the server for a move, and whether a selection can be merged.
import type { OutlineModule } from '@/services/outlineService'

/** Every topic id of the outline in outline order. */
export const flattenIds = (modules: OutlineModule[]): string[] => modules.flatMap((m) => m.topics.map((t) => t.id))

/** The full id list after moving a topic one step up or down inside its module; null when it is already at that end. */
export function idsAfterTopicMove(modules: OutlineModule[], topicId: string, dir: 'up' | 'down'): string[] | null {
  const mi = modules.findIndex((m) => m.topics.some((t) => t.id === topicId))
  if (mi < 0) return null
  const ids = modules[mi].topics.map((t) => t.id)
  const i = ids.indexOf(topicId)
  const j = dir === 'up' ? i - 1 : i + 1
  if (j < 0 || j >= ids.length) return null
  ;[ids[i], ids[j]] = [ids[j], ids[i]]
  return modules.flatMap((m, k) => (k === mi ? ids : m.topics.map((t) => t.id)))
}

/** The full id list after moving a module one step up or down; null at the ends. */
export function idsAfterModuleMove(modules: OutlineModule[], name: string, dir: 'up' | 'down'): string[] | null {
  const i = modules.findIndex((m) => m.name === name)
  const j = dir === 'up' ? i - 1 : i + 1
  if (i < 0 || j < 0 || j >= modules.length) return null
  const next = [...modules]
  ;[next[i], next[j]] = [next[j], next[i]]
  return flattenIds(next)
}

export type MergeCheck = { ok: true } | { ok: false; reason: string | null }

/** Whether the selected topics of a module can be merged: 2 or more, all from one file, next to each other. `reason` is null when fewer than 2 are chosen. */
export function checkMerge(module: OutlineModule, selected: ReadonlySet<string>): MergeCheck {
  const positions = module.topics.flatMap((t, i) => (selected.has(t.id) ? [i] : []))
  if (positions.length < 2) return { ok: false, reason: null }
  const picked = positions.map((i) => module.topics[i])
  if (!picked[0].sourceId || picked.some((t) => t.sourceId !== picked[0].sourceId)) return { ok: false, reason: 'Only topics from the same file can be merged.' }
  if (positions.some((p, k) => k > 0 && p !== positions[k - 1] + 1)) return { ok: false, reason: 'Only topics that sit next to each other can be merged.' }
  return { ok: true }
}
