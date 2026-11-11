'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, Loader2, UploadCloud, X, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatBytes } from '@/lib/formatBytes'
import { ALLOWED_EXTENSIONS, checkUploadList, MAX_FILE_BYTES } from '@/lib/ingestLimits'

export type UploadedSource = { id: string; originalName: string; status: string; sizeBytes: number; nameAlreadyInSpace?: boolean }

type ItemState = 'waiting' | 'uploading' | 'accepted' | 'refused'
type Item = { key: number; file: File; state: ItemState; error?: string; note?: string; sourceId?: string }

const STATE_LABEL: Record<ItemState, string> = { waiting: 'Waiting', uploading: 'Uploading', accepted: 'Accepted', refused: 'Refused' }
const mb = formatBytes

/**
 * Drag and drop plus file input. Files are checked in the browser with the same rules as the server (type, size, empty) and sent
 * one per request, one after the other, so one bad file never blocks the others. `bundle` says whether the files belong to the
 * first setup ('initial') or are added later to a studyspace being studied ('later').
 */
export function SourceDropzone({
  courseId,
  bundle,
  onUploaded,
  onBusyChange,
  removedSourceIds,
}: {
  courseId: string
  bundle: 'initial' | 'later'
  /** Called after each accepted file. */
  onUploaded?: (source: UploadedSource) => void
  /** True while any file is waiting or uploading. */
  onBusyChange?: (busy: boolean) => void
  /** Files that were removed from the studyspace: their "Accepted" entries disappear. */
  removedSourceIds?: readonly string[]
}) {
  const [items, setItems] = useState<Item[]>([])
  const [dragging, setDragging] = useState(false)
  const queue = useRef<number[]>([])
  const files = useRef(new Map<number, File>())
  const running = useRef(false)
  const nextKey = useRef(1)
  const input = useRef<HTMLInputElement>(null)
  const callbacks = useRef({ onUploaded, onBusyChange })
  useEffect(() => {
    callbacks.current = { onUploaded, onBusyChange }
  })

  const patch = useCallback((key: number, change: Partial<Item>) => setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...change } : i))), [])

  const busy = items.some((i) => i.state === 'waiting' || i.state === 'uploading')
  useEffect(() => {
    callbacks.current.onBusyChange?.(busy)
  }, [busy])

  const uploadOne = useCallback(
    async (key: number) => {
      const file = files.current.get(key)
      if (!file) return
      patch(key, { state: 'uploading' })
      try {
        const body = new FormData()
        body.append('files', file)
        body.append('bundle', bundle)
        const res = await fetch(`/api/spaces/${encodeURIComponent(courseId)}/sources`, { method: 'POST', body })
        const data = (await res.json().catch(() => null)) as { sources?: UploadedSource[]; error?: string; files?: { name: string | null; error: string }[] } | null
        if (res.status === 201 && data?.sources?.[0]) {
          const source = data.sources[0]
          patch(key, { state: 'accepted', sourceId: source.id, note: source.nameAlreadyInSpace ? 'A file with this name was already in this studyspace; both are kept.' : undefined })
          callbacks.current.onUploaded?.(source)
        } else if (res.status === 401) {
          patch(key, { state: 'refused', error: 'You are signed out. Reload the page and enter the passcode again.' })
        } else {
          patch(key, { state: 'refused', error: data?.files?.[0]?.error ?? data?.error ?? `The upload failed (HTTP ${res.status}). Try again.` })
        }
      } catch {
        patch(key, { state: 'refused', error: 'Could not reach the server. Check your connection and add the file again.' })
      } finally {
        files.current.delete(key)
      }
    },
    [bundle, courseId, patch],
  )

  const pump = useCallback(async () => {
    if (running.current) return
    running.current = true
    try {
      for (let key = queue.current.shift(); key !== undefined; key = queue.current.shift()) await uploadOne(key)
    } finally {
      running.current = false
    }
  }, [uploadOne])

  const addFiles = useCallback(
    (list: FileList | File[]) => {
      const added: Item[] = []
      for (const file of Array.from(list)) {
        const key = nextKey.current++
        const problem = checkUploadList([{ name: file.name, size: file.size }])[0]
        if (problem) {
          added.push({ key, file, state: 'refused', error: problem.error })
        } else {
          files.current.set(key, file)
          queue.current.push(key)
          added.push({ key, file, state: 'waiting' })
        }
      }
      if (added.length === 0) return
      setItems((prev) => [...prev, ...added])
      void pump()
    },
    [pump],
  )

  const visible = items.filter((i) => !(i.sourceId && removedSourceIds?.includes(i.sourceId)))
  const accept = ALLOWED_EXTENSIONS.join(',')

  return (
    <div className="flex flex-col gap-3 font-sans">
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files) }}
        className={`flex flex-col items-center gap-2 rounded-xl border-2 border-dashed p-6 text-center transition-colors ${dragging ? 'border-fountain-ink bg-fountain-ink/5' : 'border-charcoal-graphite/25 bg-card'}`}
        data-testid="dropzone"
      >
        <UploadCloud className="size-8 text-charcoal-graphite/50" aria-hidden />
        <p className="text-sm font-semibold text-charcoal-graphite">Drop files here</p>
        <p className="text-xs text-charcoal-graphite/60">.txt, .md or .pdf, up to {mb(MAX_FILE_BYTES)} each</p>
        <Button type="button" variant="outline" className="h-10 px-4" onClick={() => input.current?.click()}>Choose files</Button>
        <input
          ref={input}
          type="file"
          multiple
          accept={accept}
          aria-label="Choose files to upload"
          className="sr-only"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files)
            e.target.value = ''
          }}
        />
      </div>

      {visible.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="Files being uploaded">
          {visible.map((item) => (
            <li key={item.key} className="flex items-start gap-2 rounded-lg border border-charcoal-graphite/10 bg-card px-3 py-2 text-sm" data-state={item.state}>
              <span className="mt-0.5 shrink-0" aria-hidden>
                {item.state === 'uploading' ? <Loader2 className="size-4 animate-spin text-fountain-ink" /> : item.state === 'accepted' ? <CheckCircle2 className="size-4 text-emerald-700" /> : item.state === 'refused' ? <AlertCircle className="size-4 text-lecture-red" /> : <span className="block size-4 rounded-full border border-charcoal-graphite/30" />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="break-words font-medium text-charcoal-graphite">{item.file.name} <span className="font-normal text-charcoal-graphite/50">({mb(item.file.size)})</span></p>
                <p className={`text-xs ${item.state === 'refused' ? 'font-medium text-lecture-red' : 'text-charcoal-graphite/60'}`}>
                  {item.state === 'refused' ? item.error : STATE_LABEL[item.state]}
                  {item.state === 'accepted' && item.note ? ` · ${item.note}` : ''}
                </p>
              </div>
              {(item.state === 'refused' || item.state === 'accepted') && (
                <Button type="button" variant="ghost" size="icon" aria-label={`Dismiss ${item.file.name}`} title="Dismiss" className="size-8 shrink-0" onClick={() => setItems((prev) => prev.filter((i) => i.key !== item.key))}>
                  <X className="size-4" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
