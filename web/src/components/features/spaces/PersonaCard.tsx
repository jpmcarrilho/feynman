'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  acceptProfileAction, dismissSplitNoticeAction, getPersonaStepAction, getSpaceStatusAction, regenerateProfileAction, splitStudyspaceAction,
} from '@/app/spaces/actions'
import {
  PRESETS, TutorProfileSchema, applyPreset, normalizeMix,
  type QuestionType, type QuestionTypeMix, type TutorChatMode, type TutorProfile,
} from '@/lib/studyspace/profile'
import { CHAT_MODE_HINTS, CHAT_MODE_LABELS } from '@/lib/prompts/chatMode'
import { MAX_SPACE_NAME_LENGTH } from '@/lib/spaceLimits'
import type { PersonaStep } from '@/server/ingest/persona'

export const STARTER_POLL_MS = 2000

const LEVELS: { value: TutorProfile['level']; label: string }[] = [
  { value: 'intro', label: 'Introductory' },
  { value: 'undergraduate', label: 'Undergraduate' },
  { value: 'graduate', label: 'Graduate' },
  { value: 'professional', label: 'Professional' },
]
const MODES: TutorChatMode[] = ['probe', 'guide', 'explain']
const TONES = Object.keys(PRESETS) as TutorProfile['tone'][]
const TYPE_LABELS: Record<QuestionType, string> = {
  single_choice: 'Single choice', multiple_choice: 'Multiple choice', numeric: 'Numeric answer', dropdown: 'Dropdown',
}
const TYPES = Object.keys(TYPE_LABELS) as QuestionType[]
const FIELD_LABELS: Record<string, string> = {
  subject: 'Subject', tutorIdentity: 'Tutor identity', contentLanguage: 'Content language', toneNotes: 'Tone notes', examPreset: 'Exam preset', analogyDomains: 'Analogy domains',
}

const LANGUAGES: { value: string; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'pt-BR', label: 'Portuguese' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
]

/** What the card shows for a loaded step (also the server-rendered first paint). */
function viewOf(step: PersonaStep) {
  return {
    draft: step.profile,
    baseline: JSON.stringify(step.profile),
    analogyText: step.profile.analogyDomains.join(', '),
    saved: step.mode === 'accepted' && ['pending', 'running', 'failed'].includes(step.starterStatus ?? '')
      ? { starterStatus: step.starterStatus, progress: step.starterProgress }
      : null,
    splitNames: step.split ? step.split.groups.map((g) => g.label) : [],
  }
}

const fieldClass = 'h-10 sm:h-9'
const selectClass = 'h-10 w-full rounded-lg border border-input bg-background px-2.5 text-base text-charcoal-graphite outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60 sm:h-9 sm:text-sm'
const primaryButton = 'h-10 border-0 bg-lecture-red px-5 font-semibold text-white hover:bg-lecture-red/90'

/** First problem of a profile in plain words, or null when it is valid. */
export function profileProblem(p: TutorProfile): string | null {
  const r = TutorProfileSchema.safeParse(p)
  if (r.success) return null
  const issue = r.error.issues[0]
  const key = String(issue.path[0] ?? '')
  return `${FIELD_LABELS[key] ?? 'A field'}: ${issue.message.toLowerCase()}.`
}

function Field({ label, hint, children, htmlFor }: { label: string; hint?: string; children: React.ReactNode; htmlFor?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-sm font-semibold text-charcoal-graphite">{label}</label>
      {children}
      {hint && <p className="text-xs text-charcoal-graphite/60">{hint}</p>}
    </div>
  )
}

/** Percent fields of a question-type mix. The profile always holds the normalized mix; the typed text is shown until the field loses focus. */
function MixEditor({ legend, mix, noNumeric, onChange }: { legend: string; mix: QuestionTypeMix; noNumeric: boolean; onChange: (m: QuestionTypeMix) => void }) {
  const [raw, setRaw] = useState<Partial<Record<QuestionType, string>>>({})
  const pct = (t: QuestionType) => String(Math.round(mix[t] * 100))
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-semibold text-charcoal-graphite">{legend}</legend>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {TYPES.map((t) => (
          <div key={t} className="flex flex-col gap-1">
            <label htmlFor={`mix-${legend}-${t}`} className="text-xs text-charcoal-graphite/70">{TYPE_LABELS[t]} (%)</label>
            <Input
              id={`mix-${legend}-${t}`}
              type="number"
              inputMode="numeric"
              min={0}
              max={100}
              className={fieldClass}
              disabled={noNumeric && t === 'numeric'}
              value={noNumeric && t === 'numeric' ? '0' : raw[t] ?? pct(t)}
              onChange={(e) => {
                const next = { ...raw, [t]: e.target.value }
                setRaw(next)
                const weights = Object.fromEntries(TYPES.map((k) => [k, Number(next[k] ?? pct(k)) / 100])) as Record<QuestionType, number>
                onChange(normalizeMix(weights, { noNumeric, fallback: mix }))
              }}
              onBlur={() => setRaw({})}
            />
          </div>
        ))}
      </div>
      <p className="text-xs text-charcoal-graphite/60">The shares are scaled to add up to 100% when you leave a field.</p>
    </fieldset>
  )
}

type StarterView = { starterStatus: string | null; progress: { topicsWithQuestions: number; studyTopics: number } }

/** After Accept: progress of the starter questions, polled like the processing view (no overlapping polls, stops at done or failed, pauses while hidden). */
function StarterPanel({ courseId, initial, onStudy, onRetry }: { courseId: string; initial: StarterView; onStudy: () => void; onRetry: () => void }) {
  const [view, setView] = useState<StarterView>(initial)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inFlight = useRef(false)
  const alive = useRef(true)
  const active = useRef(initial.starterStatus === 'pending' || initial.starterStatus === 'running')
  const pollRef = useRef<() => void>(() => {})

  const poll = useCallback(async () => {
    if (!alive.current || inFlight.current) return
    inFlight.current = true
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    try {
      const status = await getSpaceStatusAction(courseId)
      if (!alive.current) return
      if (status) {
        setView({ starterStatus: status.starterStatus, progress: status.starterProgress })
        active.current = status.starterStatus === 'pending' || status.starterStatus === 'running'
      }
    } catch {
      // keep polling: a failed read is not a failed run
    } finally {
      inFlight.current = false
    }
    if (alive.current && active.current && document.visibilityState === 'visible') timer.current = setTimeout(() => pollRef.current(), STARTER_POLL_MS)
  }, [courseId])

  useEffect(() => {
    pollRef.current = () => void poll()
    alive.current = true
    if (active.current) timer.current = setTimeout(() => pollRef.current(), 0)
    const onVisible = () => {
      if (document.visibilityState === 'visible' && active.current && !timer.current) void poll()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive.current = false
      if (timer.current) clearTimeout(timer.current)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [poll])

  const { starterStatus, progress } = view
  const working = starterStatus === 'pending' || starterStatus === 'running'
  return (
    <div role="status" className="flex flex-col gap-3 rounded-lg border border-charcoal-graphite/15 bg-card p-4 text-sm">
      {working && (
        <p className="flex items-center gap-2 font-medium text-charcoal-graphite">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Preparing starter questions… {progress.topicsWithQuestions} of {progress.studyTopics} topics have a question
        </p>
      )}
      {starterStatus === 'done' && <p className="font-medium text-emerald-800">Starter questions are ready: {progress.topicsWithQuestions} of {progress.studyTopics} topics have a question.</p>}
      {starterStatus === 'failed' && <p className="font-medium text-amber-800">Starter questions could not be generated; sessions will generate questions as you go.</p>}
      {!working && starterStatus !== 'done' && starterStatus !== 'failed' && <p className="text-charcoal-graphite/70">Starter questions will be prepared when the tutor is saved.</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" className={primaryButton} onClick={onStudy}>Start studying now</Button>
        {starterStatus === 'failed' && <Button type="button" variant="outline" className="h-10 px-4" onClick={onRetry}>Try starter questions again</Button>}
      </div>
      {working && <p className="text-xs text-charcoal-graphite/60">You do not have to wait: sessions use the questions that exist and make the rest as you go.</p>}
    </div>
  )
}

/**
 * The tutor card: shows the proposal (or the accepted tutor) and lets the owner edit every field. Used by the setup wizard after the
 * outline and by the tutor settings page. `onStudy` opens the study page.
 */
export function PersonaCard({ courseId, onStudy, onBack, onRenamed, initial }: { courseId: string; onStudy: () => void; onBack?: () => void; /** Called with the new title of this studyspace after a split, so the page header can show it at once. */ onRenamed?: (title: string) => void; initial?: PersonaStep }) {
  const [first] = useState(() => (initial ? viewOf(initial) : null))
  const [phase, setPhase] = useState<'loading' | 'error' | 'ready'>(initial ? 'ready' : 'loading')
  const [reason, setReason] = useState('')
  const [step, setStep] = useState<PersonaStep | null>(initial ?? null)
  const [draft, setDraft] = useState<TutorProfile | null>(first?.draft ?? null)
  const [baseline, setBaseline] = useState(first?.baseline ?? '')
  const [analogyText, setAnalogyText] = useState(first?.analogyText ?? '')
  const [notice, setNotice] = useState<string | null>(null)
  const [splitNames, setSplitNames] = useState<string[]>(first?.splitNames ?? [])
  const [otherLanguage, setOtherLanguage] = useState(false)
  const [confirmRegen, setConfirmRegen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [saved, setSaved] = useState<StarterView | null>(first?.saved ?? null)
  const [splitDone, setSplitDone] = useState<{ kept: string; created: { id: string; title: string }[] } | null>(null)
  const [splitHidden, setSplitHidden] = useState(false)
  const token = useRef(0)

  const apply = useCallback((result: Awaited<ReturnType<typeof getPersonaStepAction>>) => {
    if (!result.ok) {
      setReason(result.reason)
      setPhase('error')
      return
    }
    const v = viewOf(result)
    setStep(result)
    setDraft(v.draft)
    setBaseline(v.baseline)
    setAnalogyText(v.analogyText)
    setSplitNames(v.splitNames)
    setOtherLanguage(false)
    setNotice(null)
    setSplitHidden(false)
    setSaved(v.saved)
    setPhase('ready')
  }, [])

  const fetchStep = useCallback(
    async (fn: () => ReturnType<typeof getPersonaStepAction>) => {
      const mine = ++token.current
      try {
        const result = await fn()
        if (mine === token.current) apply(result)
      } catch {
        if (mine === token.current) {
          setReason('Could not reach the server.')
          setPhase('error')
        }
      }
    },
    [apply],
  )

  useEffect(() => {
    if (initial) return
    let cancelled = false
    getPersonaStepAction(courseId)
      .then((result) => { if (!cancelled) apply(result) })
      .catch(() => {
        if (!cancelled) {
          setReason('Could not reach the server.')
          setPhase('error')
        }
      })
    return () => { cancelled = true }
  }, [courseId, apply, initial])

  const restart = (fn: () => ReturnType<typeof getPersonaStepAction>) => {
    setPhase('loading')
    setMessage(null)
    setConfirmRegen(false)
    setSplitDone(null)
    void fetchStep(fn)
  }

  if (phase === 'loading') {
    return (
      <div className="flex flex-col gap-3 font-sans" role="status" aria-live="polite">
        <h2 className="font-display text-xl font-bold italic text-charcoal-graphite">Your tutor</h2>
        <p className="flex items-center gap-2 text-sm text-charcoal-graphite/80"><Loader2 className="size-4 animate-spin" aria-hidden /> Reading your outline to propose a tutor…</p>
        <p className="text-xs text-charcoal-graphite/60">This takes about 10 to 30 seconds. You can skip it and change the tutor later.</p>
        <div><Button type="button" variant="outline" className="h-10 px-4" onClick={onStudy}>Start studying with the default tutor</Button></div>
      </div>
    )
  }
  if (phase === 'error' || !step || !draft) {
    return (
      <div className="flex flex-col gap-3 font-sans">
        <h2 className="font-display text-xl font-bold italic text-charcoal-graphite">Your tutor</h2>
        <p role="alert" className="text-sm font-medium text-lecture-red">{reason || 'The tutor could not be loaded.'}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" className={primaryButton} onClick={() => restart(() => getPersonaStepAction(courseId))}>Retry</Button>
          <Button type="button" variant="outline" className="h-10 px-4" onClick={onStudy}>Start studying with the default tutor</Button>
          {onBack && <Button type="button" variant="ghost" className="h-10 px-4" onClick={onBack}>Back to outline</Button>}
        </div>
      </div>
    )
  }

  const accepted = step.mode === 'accepted'
  const readOnly = step.readOnly
  const dirty = JSON.stringify(draft) !== baseline
  const problem = profileProblem(draft)
  const set = (patch: Partial<TutorProfile>) => setDraft((d) => (d ? { ...d, ...patch } : d))

  const accept = async () => {
    if (busy || problem) return
    setBusy(true)
    setMessage(null)
    try {
      const result = await acceptProfileAction(courseId, draft)
      if (!result.ok) {
        setMessage(result.reason)
        return
      }
      const firstAccept = step.mode === 'proposal'
      setBaseline(JSON.stringify(draft))
      const status = await getSpaceStatusAction(courseId).catch(() => null)
      const starterStatus = status?.starterStatus ?? null
      const progress = status?.starterProgress ?? { topicsWithQuestions: 0, studyTopics: 0 }
      setSaved(firstAccept || ['pending', 'running', 'failed'].includes(starterStatus ?? '') ? { starterStatus, progress } : null)
      setNotice(
        firstAccept
          ? `Tutor saved.${result.starters === 'requested' ? ' Starter questions are being prepared in the background.' : ''}`
          : `Saved. New questions will use these settings.${result.starters === 'requested' ? ' Starter questions are being prepared again.' : ''}`,
      )
      setStep((s) => (s ? { ...s, mode: 'accepted', rationale: null, split: null, excludedSources: [] } : s))
    } catch {
      setMessage('Could not reach the server. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const regenerate = () => {
    if (dirty && !confirmRegen) {
      setConfirmRegen(true)
      return
    }
    restart(() => regenerateProfileAction(courseId))
  }

  const split = async () => {
    if (!step.split || busy) return
    setBusy(true)
    setMessage(null)
    try {
      const names = step.split.groups.map((g, i) => (splitNames[i] ?? g.label).trim().replace(/\s+/g, ' '))
      const badName = names.findIndex((n) => !n || n.length > MAX_SPACE_NAME_LENGTH)
      if (badName >= 0) {
        const field = badName === 0 ? 'Name of the studyspace that stays' : `Name of new studyspace ${badName}`
        setMessage(`Each studyspace needs a name of 1 to ${MAX_SPACE_NAME_LENGTH} characters. Check the field “${field}”.`)
        return
      }
      const result = await splitStudyspaceAction(courseId, step.split.groups.map((g, i) => ({ label: names[i], sourceIds: g.sources.map((x) => x.id) })))
      if (!result.ok) {
        setMessage(result.reason)
        return
      }
      setSplitDone({ kept: result.keptTitle, created: result.created })
      onRenamed?.(result.keptTitle)
      setPhase('loading')
      await fetchStep(() => getPersonaStepAction(courseId))
    } catch {
      setMessage('Could not reach the server. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const retryStarters = async () => {
    if (busy) return
    setBusy(true)
    setMessage(null)
    try {
      const result = await acceptProfileAction(courseId, JSON.parse(baseline) as TutorProfile)
      if (!result.ok) {
        setMessage(result.reason)
        return
      }
      const status = await getSpaceStatusAction(courseId).catch(() => null)
      setSaved({ starterStatus: status?.starterStatus ?? 'pending', progress: status?.starterProgress ?? { topicsWithQuestions: 0, studyTopics: 0 } })
    } catch {
      setMessage('Could not reach the server. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const keepTogether = async () => {
    setSplitHidden(true)
    await dismissSplitNoticeAction(courseId).catch(() => {})
  }

  return (
    <div className="flex flex-col gap-5 font-sans">
      <div>
        <h2 className="font-display text-xl font-bold italic text-charcoal-graphite">Your tutor</h2>
        <p className="mt-1 text-sm text-charcoal-graphite/70">
          {readOnly ? 'Shown for reference. These settings cannot be changed here.' : accepted ? 'This is the tutor of this studyspace. Change anything and save.' : 'Proposed from your files. Change anything you like, then accept.'}{' '}
          {step.rationale}
        </p>
      </div>

      {splitDone && (
        <div role="status" className="rounded-lg border border-emerald-700/25 bg-emerald-50/50 p-3 text-sm text-charcoal-graphite">
          <p className="font-medium">The studyspace was split. This one is now called “{splitDone.kept}”.</p>
          <ul className="mt-1 list-disc pl-5">
            {splitDone.created.map((c) => (
              <li key={c.id}><Link href={`/spaces/${c.id}/setup?step=persona`} className="underline">{c.title}</Link> is ready for its own tutor.</li>
            ))}
          </ul>
        </div>
      )}

      {step.excludedSources.length > 0 && (
        <div role="note" className="flex items-start gap-2 rounded-lg border border-amber-600/30 bg-amber-50/60 p-3 text-sm text-charcoal-graphite">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-700" aria-hidden />
          <div>
            <p className="font-medium">These files failed and were left out of the proposal:</p>
            <ul className="mt-1 list-disc pl-5">{step.excludedSources.map((s) => <li key={s.id} className="break-words">{s.name}: {s.reason}</li>)}</ul>
          </div>
        </div>
      )}

      {!accepted && step.split && !splitHidden && (
        <div role="note" className="flex flex-col gap-3 rounded-lg border border-charcoal-graphite/20 bg-card p-3 text-sm text-charcoal-graphite">
          <p className="font-medium">These files look like different subjects. One tutor for all of them may fit none well.</p>
          <ul className="flex flex-col gap-1">
            {step.split.groups.map((g, i) => (
              <li key={i} className="flex flex-col gap-1">
                <label htmlFor={`split-name-${i}`} className="text-xs font-semibold text-charcoal-graphite/70">
                  {i === 0 ? 'Name of the studyspace that stays' : `Name of new studyspace ${i}`}
                </label>
                <Input
                  id={`split-name-${i}`}
                  className={fieldClass}
                  maxLength={MAX_SPACE_NAME_LENGTH}
                  value={splitNames[i] ?? g.label}
                  onChange={(e) => setSplitNames((prev) => step.split!.groups.map((x, k) => (k === i ? e.target.value : prev[k] ?? x.label)))}
                />
                <span className="break-words text-xs">{g.sources.map((x) => x.name).join(', ')}</span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button type="button" className={primaryButton} disabled={busy || readOnly} onClick={split}>
              {step.split.groups.length === 2 ? 'Split into two studyspaces' : `Split into ${step.split.groups.length} studyspaces`}
            </Button>
            <Button type="button" variant="outline" className="h-10 px-4" disabled={busy} onClick={keepTogether}>Keep together</Button>
          </div>
        </div>
      )}

      {readOnly && (
        <p role="note" className="rounded-lg border border-charcoal-graphite/15 bg-card p-3 text-sm text-charcoal-graphite/80">
          This is one of the imported courses. You can look at its tutor settings here, but they cannot be changed.
        </p>
      )}

      <fieldset disabled={readOnly || busy} className="flex flex-col gap-5 disabled:opacity-90">
        <Field label="Subject" htmlFor="persona-subject">
          <Input id="persona-subject" className={fieldClass} maxLength={120} value={draft.subject} onChange={(e) => set({ subject: e.target.value })} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Level" htmlFor="persona-level">
            <select id="persona-level" className={selectClass} value={draft.level} onChange={(e) => set({ level: e.target.value as TutorProfile['level'] })}>
              {LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
            </select>
          </Field>
          <Field label="Content language" htmlFor="persona-language">
            {(() => {
              const inList = LANGUAGES.some((l) => l.value === draft.contentLanguage)
              const other = otherLanguage || !inList
              return (
                <>
                  <select
                    id="persona-language"
                    className={selectClass}
                    value={other ? 'other' : draft.contentLanguage}
                    onChange={(e) => {
                      if (e.target.value === 'other') setOtherLanguage(true)
                      else {
                        setOtherLanguage(false)
                        set({ contentLanguage: e.target.value })
                      }
                    }}
                  >
                    {LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                    <option value="other">Other</option>
                  </select>
                  {other && (
                    <Input aria-label="Other language code" className={fieldClass} maxLength={10} value={draft.contentLanguage} onChange={(e) => set({ contentLanguage: e.target.value })} />
                  )}
                  {other && <p className="text-xs text-charcoal-graphite/60">A language code such as nl or ja-JP.</p>}
                </>
              )
            })()}
          </Field>
        </div>
        <Field label="Who the tutor is" htmlFor="persona-identity" hint="One line, for example: an organic chemistry professor who teaches reaction mechanisms.">
          <Input id="persona-identity" className={fieldClass} maxLength={200} value={draft.tutorIdentity} onChange={(e) => set({ tutorIdentity: e.target.value })} />
        </Field>

        <div className="flex flex-col gap-2" role="radiogroup" aria-label="Tone">
          <span className="text-sm font-semibold text-charcoal-graphite">Tone</span>
          <div className="grid gap-2 sm:grid-cols-3">
            {TONES.map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={draft.tone === t}
                onClick={() => setDraft((d) => (d ? applyPreset(d, t) : d))}
                className={`min-h-10 rounded-lg border px-3 py-2 text-left text-sm sm:min-h-9 ${draft.tone === t ? 'border-fountain-ink bg-fountain-ink/10 font-semibold' : 'border-charcoal-graphite/20 bg-background'} text-charcoal-graphite`}
              >
                {PRESETS[t].label}
              </button>
            ))}
          </div>
          <p className="text-xs text-charcoal-graphite/60">Choosing a tone also sets the notes below and the default chat mode. Your other edits stay.</p>
        </div>
        <Field label="Tone notes" htmlFor="persona-notes">
          <textarea id="persona-notes" rows={2} maxLength={300} className="w-full rounded-lg border border-input bg-background px-2.5 py-2 text-base text-charcoal-graphite outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 sm:text-sm" value={draft.toneNotes} onChange={(e) => set({ toneNotes: e.target.value })} />
        </Field>

        <div className="flex flex-col gap-2" role="radiogroup" aria-label="Default chat mode">
          <span className="text-sm font-semibold text-charcoal-graphite">Default chat mode</span>
          <div className="grid gap-2 sm:grid-cols-3">
            {MODES.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={draft.defaultChatMode === m}
                onClick={() => set({ defaultChatMode: m })}
                className={`flex min-h-10 flex-col rounded-lg border px-3 py-2 text-left text-sm sm:min-h-9 ${draft.defaultChatMode === m ? 'border-fountain-ink bg-fountain-ink/10' : 'border-charcoal-graphite/20 bg-background'} text-charcoal-graphite`}
              >
                <span className="font-semibold">{CHAT_MODE_LABELS[m]}</span>
                <span className="text-xs text-charcoal-graphite/70">{CHAT_MODE_HINTS[m]}</span>
              </button>
            ))}
          </div>
          <p className="text-xs text-charcoal-graphite/60">You can switch the mode in the chat at any time.</p>
        </div>

        <Field label="Analogy domains" htmlFor="persona-analogies" hint="Up to 5, separated by commas. The tutor draws its analogies from these.">
          <Input
            id="persona-analogies"
            className={fieldClass}
            value={analogyText}
            onChange={(e) => {
              setAnalogyText(e.target.value)
              set({ analogyDomains: e.target.value.split(',').map((x) => x.trim().slice(0, 40)).filter(Boolean).slice(0, 5) })
            }}
          />
        </Field>

        <div className="flex flex-col gap-3">
          <label className="flex min-h-10 items-center gap-2 text-sm font-semibold text-charcoal-graphite sm:min-h-0">
            <input type="checkbox" className="size-5 sm:size-4" checked={draft.quantitative} onChange={(e) => set({ quantitative: e.target.checked, ...(e.target.checked ? {} : { questionTypeMix: normalizeMix(draft.questionTypeMix, { noNumeric: true }), quantitativeQuestionTypeMix: normalizeMix(draft.quantitativeQuestionTypeMix, { noNumeric: true }) }) })} />
            This subject involves calculations
          </label>
          <MixEditor legend="Question types for conceptual topics" mix={draft.questionTypeMix} noNumeric={!draft.quantitative} onChange={(m) => set({ questionTypeMix: m })} />
          {draft.quantitative && <MixEditor legend="Question types for calculation topics" mix={draft.quantitativeQuestionTypeMix} noNumeric={false} onChange={(m) => set({ quantitativeQuestionTypeMix: m })} />}
        </div>

        <Field label="Sample explanation" hint="How the tutor would explain a concept from your files. Read-only; Regenerate makes a new one.">
          <div className="rounded-lg border border-charcoal-graphite/15 bg-card p-3 text-sm text-charcoal-graphite" data-testid="sample-explanation">
            <p className="font-semibold">{draft.sampleExplanation.concept}</p>
            <p className="mt-1 whitespace-pre-wrap">{draft.sampleExplanation.explanation}</p>
          </div>
        </Field>

        <Field label="Difficulty calibration module (optional)" htmlFor="persona-calibration" hint="A module whose questions show the tutor how hard your exam is. Leave empty if there is none.">
          <select id="persona-calibration" className={selectClass} value={draft.calibrationModule ?? ''} onChange={(e) => set({ calibrationModule: e.target.value || null })}>
            <option value="">None</option>
            {step.modules.map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
          </select>
        </Field>

        <div className="flex flex-col gap-2">
          <label className="flex min-h-10 items-center gap-2 text-sm font-semibold text-charcoal-graphite sm:min-h-0">
            <input type="checkbox" className="size-5 sm:size-4" checked={draft.examPreset !== null} onChange={(e) => set({ examPreset: e.target.checked ? { label: 'Final exam', questionCount: 30 } : null })} />
            Practice exam preset
          </label>
          {draft.examPreset && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Exam name" htmlFor="persona-exam-label">
                <Input id="persona-exam-label" className={fieldClass} value={draft.examPreset.label} onChange={(e) => set({ examPreset: { ...draft.examPreset!, label: e.target.value } })} />
              </Field>
              <Field label="Number of questions" htmlFor="persona-exam-count" hint="1 to 200.">
                <Input id="persona-exam-count" type="number" inputMode="numeric" min={1} max={200} className={fieldClass} value={String(draft.examPreset.questionCount)} onChange={(e) => set({ examPreset: { ...draft.examPreset!, questionCount: Math.round(Number(e.target.value)) } })} />
              </Field>
            </div>
          )}
        </div>
      </fieldset>

      {message && <p role="alert" className="text-sm font-medium text-lecture-red">{message}</p>}
      {problem && !readOnly && <p role="alert" className="text-sm font-medium text-lecture-red">{problem}</p>}

      {confirmRegen && (
        <div role="alertdialog" aria-label="Discard edits" className="flex flex-col gap-2 rounded-lg border border-amber-600/30 bg-amber-50/60 p-3 text-sm text-charcoal-graphite">
          <p>Regenerating makes a new proposal and discards the changes you made on this card.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" className={primaryButton} onClick={regenerate}>Discard my edits and regenerate</Button>
            <Button type="button" variant="outline" className="h-10 px-4" onClick={() => setConfirmRegen(false)}>Keep editing</Button>
          </div>
        </div>
      )}

      <div role="status" aria-live="polite">{notice && !dirty && <p className="text-sm font-medium text-emerald-800">{notice}</p>}</div>

      {saved && <StarterPanel key={saved.starterStatus ?? 'none'} courseId={courseId} initial={saved} onStudy={onStudy} onRetry={retryStarters} />}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2">
          {onBack && !accepted && <Button type="button" variant="outline" className="h-10 px-4" disabled={busy} onClick={onBack}>Back to outline</Button>}
          {!accepted && <Button type="button" variant="outline" className="h-10 px-4" disabled={busy} onClick={regenerate}>Regenerate</Button>}
          {!saved && <Button type="button" variant="ghost" className="h-10 px-4" onClick={onStudy}>{accepted ? 'Back to studying' : 'Start studying with the default tutor'}</Button>}
        </div>
        {!readOnly && (
          <Button type="button" aria-busy={busy} disabled={busy || !!problem || (accepted && !dirty)} className={primaryButton} onClick={accept}>
            {busy ? 'Saving…' : accepted ? 'Save changes' : 'Accept tutor'}
          </Button>
        )}
      </div>
    </div>
  )
}
