'use client'

import { useEffect, useRef } from 'react'
import { Loader2 } from 'lucide-react'
import type { SourceStatusView } from '@/services/spaceStatus'
import { QUESTION_IMPORT_NOTE } from '@/lib/uploadNotes'
import { SourceDropzone } from './SourceDropzone'
import { SourceRow } from './ProcessingView'
import { useSpaceSources } from './useSpaceSources'

/** True when `next` holds a file that is ready now and was not ready (or not known) in `previous`: new topics exist. */
export function newlyReady(previous: SourceStatusView[], next: SourceStatusView[]): boolean {
  const before = new Map(previous.map((s) => [s.id, s.status]))
  return next.some((s) => s.status === 'ready' && before.get(s.id) !== 'ready')
}

/**
 * "Add files" of an existing studyspace: the dropzone (when opened) and a compact list of the files that are not ready yet or failed,
 * with the same status text, Retry and Remove as the processing step of the wizard. Reads the status every 2 seconds while a file is
 * unfinished (no overlapping reads, paused while the tab is hidden, stopped when nothing is pending). `onTopicsChanged` is called when
 * a file became ready, so the list of resources can load its new topics without a page reload.
 */
export function AddFilesPanel({ courseId, open, onTopicsChanged, onActivity }: { courseId: string; open: boolean; onTopicsChanged: () => void; /** A file was uploaded or became ready: the page may now get a tutor-update suggestion. */ onActivity?: () => void }) {
  const { status, missing, loadError, message, busyId, confirmId, retries, removed, poll, retry, remove } = useSpaceSources(courseId, {
    keepPollingWhenEmpty: false,
    onChange: (previous, next) => {
      if (newlyReady(previous, next)) {
        onTopicsChanged()
        onActivity?.()
      }
    },
  })
  const all = (status?.sources ?? []).filter((s) => !removed.includes(s.id))
  const unfinished = all.filter((s) => s.status !== 'ready')
  // A finished file leaves the dropzone's list ("Accepted"): the Resources list shows it from then on
  const finished = all.filter((s) => s.status === 'ready')
  const finishedIds = finished.map((s) => s.id)
  const working = unfinished.filter((s) => s.status !== 'failed')

  // After a removal the Resources list drops the file's topics
  const removedCount = useRef(0)
  useEffect(() => {
    if (removed.length > removedCount.current) {
      onTopicsChanged()
      onActivity?.()
    }
    removedCount.current = removed.length
  })

  if (!open && all.length === 0 && !missing && !loadError && !message) return null

  return (
    <section id="add-files-panel" aria-label="Add files" className="flex flex-col gap-3 rounded-xl border border-charcoal-graphite/10 bg-card p-4 font-sans">
      {open && (
        <>
          <p className="text-sm text-charcoal-graphite/70">
            Add .txt, .md or .pdf files. Each one is read and split into topics that are added after your existing ones; the topics you already have are not changed. {QUESTION_IMPORT_NOTE}
          </p>
          <SourceDropzone courseId={courseId} bundle="later" removedSourceIds={[...removed, ...finishedIds]} onUploaded={() => { void poll(); onActivity?.() }} />
        </>
      )}

      {missing && <p role="alert" className="text-sm font-medium text-lecture-red">This studyspace no longer exists.</p>}
      {loadError && <p role="alert" className="text-sm font-medium text-lecture-red">Could not read the status of your files. Retrying…</p>}
      {message && <p role="alert" className="text-sm font-medium text-lecture-red">{message}</p>}

      {unfinished.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-charcoal-graphite">
            {working.length > 0 && <Loader2 className="size-4 animate-spin text-fountain-ink" aria-hidden />}
            {working.length > 0 ? 'Files being processed' : 'Files that need attention'}
          </h3>
          <ul className="flex flex-col gap-2" aria-label="Files not ready yet">
            {unfinished.map((s) => (
              <SourceRow
                key={s.id}
                source={s}
                busy={busyId === s.id}
                confirming={confirmId === s.id}
                retry={retries[s.id]}
                onRetry={() => retry(s)}
                onRemove={() => remove(s)}
              />
            ))}
          </ul>
        </div>
      )}

      {finished.length > 0 && (
        <details className="group rounded-lg border border-charcoal-graphite/10 bg-background">
          <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-semibold text-charcoal-graphite">Files in this studyspace ({finished.length})</summary>
          <ul className="flex flex-col gap-2 p-3 pt-1" aria-label="Files in this studyspace">
            {finished.map((s) => (
              <SourceRow
                key={s.id}
                source={s}
                busy={busyId === s.id}
                confirming={confirmId === s.id}
                retry={retries[s.id]}
                onRetry={() => retry(s)}
                onRemove={() => remove(s)}
              />
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
