'use client'

import { useCallback, useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Check, Loader2, Merge, Pencil, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { getOutlineAction, mergeTopicsAction, moveTopicToModuleAction, renameModuleAction, renameTopicAction, reorderAction } from '@/app/spaces/actions'
import type { OutlineModule, OutlineTopic } from '@/services/outlineService'
import { checkMerge, idsAfterModuleMove, idsAfterTopicMove } from '@/lib/outlineOps'

type Editing = { kind: 'topic' | 'module'; key: string; value: string }

function pageRange(t: OutlineTopic): string | null {
  if (!t.sourceIsPdf || t.pageStart === null) return null
  return t.pageEnd !== null && t.pageEnd !== t.pageStart ? `pages ${t.pageStart}-${t.pageEnd}` : `page ${t.pageStart}`
}

/**
 * Step 3: modules with their topics. Every change calls its server action and then reloads the outline, so what is shown is
 * what is stored. `onContinue` is the primary button (T25 puts the persona step behind it); `onBack` returns to the file list.
 */
export function OutlineEditor({ courseId, onContinue, continueLabel = 'Start studying', onBack }: { courseId: string; onContinue: () => void; continueLabel?: string; onBack?: () => void }) {
  const [modules, setModules] = useState<OutlineModule[] | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [editable, setEditable] = useState(true)
  const [selectionNote, setSelectionNote] = useState<string | null>(null)

  const apply = useCallback((result: Awaited<ReturnType<typeof getOutlineAction>>) => {
    if (result.ok) {
      setModules(result.modules)
      setEditable(result.editable)
      // Forget selections of topics that no longer exist
      const ids = new Set(result.modules.flatMap((m) => m.topics.map((t) => t.id)))
      setSelected((prev) => new Set([...prev].filter((id) => ids.has(id))))
    } else {
      setMessage(result.reason)
    }
  }, [])

  const load = useCallback(async () => {
    try {
      apply(await getOutlineAction(courseId))
    } catch {
      setMessage('Could not load the outline. Reload the page and try again.')
    }
  }, [apply, courseId])

  useEffect(() => {
    let cancelled = false
    getOutlineAction(courseId)
      .then((result) => { if (!cancelled) apply(result) })
      .catch(() => { if (!cancelled) setMessage('Could not load the outline. Reload the page and try again.') })
    return () => { cancelled = true }
  }, [apply, courseId])

  const run = async (action: () => Promise<{ ok: boolean; reason?: string }>): Promise<boolean> => {
    if (busy) return false
    setBusy(true)
    setMessage(null)
    let ok = false
    try {
      const result = await action()
      ok = result.ok
      if (!result.ok) setMessage(result.reason ?? 'That change was not saved. Try again.')
    } catch {
      setMessage('Could not reach the server. Try again.')
    }
    await load()
    setBusy(false)
    return ok
  }

  const saveRename = async () => {
    if (!editing) return
    const e = editing
    const ok = await run(() => (e.kind === 'topic' ? renameTopicAction(courseId, e.key, e.value) : renameModuleAction(courseId, e.key, e.value)))
    if (ok) setEditing(null)
  }

  const toggle = (module: OutlineModule, id: string) =>
    setSelected((prev) => {
      // Selections stay inside one module: picking in another one starts over
      const inModule = new Set(module.topics.map((t) => t.id))
      const next = new Set([...prev].filter((x) => inModule.has(x)))
      setSelectionNote(next.size < prev.size ? 'Only topics of the same file and module can be merged; the selection was restarted.' : null)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  if (modules === null) {
    return message ? <p role="alert" className="text-sm font-medium text-lecture-red">{message}</p> : <p className="flex items-center gap-2 text-sm text-charcoal-graphite/65"><Loader2 className="size-4 animate-spin" aria-hidden /> Loading the outline...</p>
  }

  const renameForm = (label: string) => (
    <form
      className="flex min-w-0 flex-1 items-center gap-1"
      onSubmit={(ev) => { ev.preventDefault(); void saveRename() }}
    >
      <Input aria-label={label} value={editing?.value ?? ''} onChange={(ev) => setEditing((p) => (p ? { ...p, value: ev.target.value } : p))} autoFocus disabled={busy} className="h-9 min-w-0 flex-1 bg-background text-sm" />
      <Button type="submit" size="icon" variant="outline" aria-label="Save name" title="Save" disabled={busy || !editing?.value.trim()} className="size-10 sm:size-9"><Check className="size-4" /></Button>
      <Button type="button" size="icon" variant="ghost" aria-label="Cancel renaming" title="Cancel" disabled={busy} onClick={() => setEditing(null)} className="size-10 sm:size-9"><X className="size-4" /></Button>
    </form>
  )

  return (
    <div className="flex flex-col gap-5 font-sans">
      <div>
        <h2 className="font-display text-xl font-bold italic text-charcoal-graphite">Review the outline</h2>
        <p className="mt-1 text-sm text-charcoal-graphite/70">Rename topics and modules, change their order, move a topic to another module, or merge topics that were split in the wrong place. You can change this later.</p>
      </div>

      {message && <p role="alert" className="text-sm font-medium text-lecture-red">{message}</p>}

      {modules.length === 0 && <p className="rounded-lg border border-dashed border-charcoal-graphite/25 p-4 text-sm text-charcoal-graphite/70">There are no topics yet. Go back to the files and check that at least one is ready.</p>}

      {modules.map((module, mi) => {
        const merge = checkMerge(module, selected)
        const chosen = module.topics.filter((t) => selected.has(t.id)).length
        return (
          <section key={module.name} aria-label={`Module ${module.title || module.name}`} className="overflow-hidden rounded-xl border border-charcoal-graphite/10 bg-card shadow-sm">
            <header className="flex flex-wrap items-center gap-2 border-b border-charcoal-graphite/10 bg-muted/15 px-3 py-2">
              {editing?.kind === 'module' && editing.key === module.name ? (
                renameForm('Module title')
              ) : (
                <>
                  <h3 className="min-w-0 flex-1 break-words font-display text-base font-bold italic text-charcoal-graphite">{module.name || 'Untitled module'}</h3>
                  {editable && (<>
                  <Button type="button" size="icon" variant="ghost" aria-label={`Rename module ${module.title || module.name}`} title="Rename module" disabled={busy} onClick={() => setEditing({ kind: 'module', key: module.name, value: module.title })} className="size-10 sm:size-9"><Pencil className="size-4" /></Button>
                  <Button type="button" size="icon" variant="ghost" aria-label={`Move module ${module.title || module.name} up`} title="Move module up" disabled={busy || mi === 0} onClick={() => { const ids = idsAfterModuleMove(modules, module.name, 'up'); if (ids) void run(() => reorderAction(courseId, ids)) }} className="size-10 sm:size-9"><ArrowUp className="size-4" /></Button>
                  <Button type="button" size="icon" variant="ghost" aria-label={`Move module ${module.title || module.name} down`} title="Move module down" disabled={busy || mi === modules.length - 1} onClick={() => { const ids = idsAfterModuleMove(modules, module.name, 'down'); if (ids) void run(() => reorderAction(courseId, ids)) }} className="size-10 sm:size-9"><ArrowDown className="size-4" /></Button>
                  </>)}
                </>
              )}
            </header>

            <ul>
              {module.topics.map((topic, ti) => {
                const range = pageRange(topic)
                const others = modules.filter((m) => m.name !== module.name)
                return (
                  <li key={topic.id} className="flex flex-col gap-2 border-b border-charcoal-graphite/5 px-3 py-2.5 last:border-b-0 sm:flex-row sm:items-start">
                    <div className="flex min-w-0 flex-1 items-start gap-2">
                      {editable && (
                        <span className="-ml-2 flex size-10 shrink-0 items-center justify-center sm:-ml-0 sm:-mt-0.5 sm:size-6">
                          <input type="checkbox" className="size-5 accent-fountain-ink sm:size-4" aria-label={`Select ${topic.title} for merging`} checked={selected.has(topic.id)} disabled={busy} onChange={() => toggle(module, topic.id)} />
                        </span>
                      )}
                      <div className="min-w-0 flex-1">
                        {editing?.kind === 'topic' && editing.key === topic.id ? (
                          renameForm('Topic title')
                        ) : (
                          <div className="flex items-start gap-1">
                            <p className="min-w-0 flex-1 break-words text-sm font-semibold text-charcoal-graphite">{topic.title}</p>
                            <Button type="button" size="icon" variant="ghost" aria-label={`Rename topic ${topic.title}`} title="Rename topic" disabled={busy} onClick={() => setEditing({ kind: 'topic', key: topic.id, value: topic.title })} className="-my-1 size-10 shrink-0 sm:size-8"><Pencil className="size-3.5" /></Button>
                          </div>
                        )}
                        <p className="mt-0.5 break-words text-xs text-charcoal-graphite/60">
                          {[topic.sourceName, range, `${topic.exerciseCount} question${topic.exerciseCount === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}
                          {topic.notStudyMaterial && <span className="ml-1.5 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900">Not study material</span>}
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1 pl-6 sm:pl-0">
                      {editable && (<>
                      <Button type="button" size="icon" variant="ghost" aria-label={`Move topic ${topic.title} up`} title="Move up" disabled={busy || ti === 0} onClick={() => { const ids = idsAfterTopicMove(modules, topic.id, 'up'); if (ids) void run(() => reorderAction(courseId, ids)) }} className="size-10 sm:size-9"><ArrowUp className="size-4" /></Button>
                      <Button type="button" size="icon" variant="ghost" aria-label={`Move topic ${topic.title} down`} title="Move down" disabled={busy || ti === module.topics.length - 1} onClick={() => { const ids = idsAfterTopicMove(modules, topic.id, 'down'); if (ids) void run(() => reorderAction(courseId, ids)) }} className="size-10 sm:size-9"><ArrowDown className="size-4" /></Button>
                      {others.length > 0 && (
                        <select
                          aria-label={`Move topic ${topic.title} to another module`}
                          value=""
                          disabled={busy}
                          onChange={(ev) => { const target = ev.target.value; if (target) void run(() => moveTopicToModuleAction(courseId, topic.id, target)) }}
                          className="h-10 max-w-36 sm:h-9 rounded-lg border border-input bg-background px-2 text-xs text-charcoal-graphite"
                        >
                          <option value="">Move to...</option>
                          {others.map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
                        </select>
                      )}
                      </>)}
                    </div>
                  </li>
                )
              })}
            </ul>

            {chosen < 2 && selectionNote && module.topics.some((t) => selected.has(t.id)) && <p className="border-t border-charcoal-graphite/10 bg-muted/10 px-3 py-2 text-xs text-charcoal-graphite/70">{selectionNote}</p>}
            {chosen >= 2 && (
              <footer className="flex flex-col gap-2 border-t border-charcoal-graphite/10 bg-muted/10 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                {!merge.ok && merge.reason ? <p className="text-xs text-charcoal-graphite/70">{merge.reason}</p> : <p className="text-xs text-charcoal-graphite/70">{chosen} topics selected. The merged topic keeps the first title.</p>}
                <Button type="button" size="sm" variant="outline" className="h-9 gap-1.5 px-3" disabled={busy || !merge.ok} onClick={() => void run(() => mergeTopicsAction(courseId, module.topics.filter((t) => selected.has(t.id)).map((t) => t.id)))}>
                  <Merge className="size-4" aria-hidden /> Merge selected topics
                </Button>
              </footer>
            )}
          </section>
        )
      })}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
        {onBack ? <Button type="button" variant="outline" className="h-10 px-4" onClick={onBack}>Back to files</Button> : <span />}
        <Button type="button" disabled={busy || modules.length === 0} onClick={onContinue} className="h-10 border-0 bg-lecture-red px-5 font-semibold text-white hover:bg-lecture-red/90">{continueLabel}</Button>
      </div>
    </div>
  )
}
