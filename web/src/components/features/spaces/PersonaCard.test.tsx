import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, within } from '@testing-library/react'
import { PersonaCard } from './PersonaCard'
import { PRESETS, TutorProfileSchema, defaultProfile, type TutorProfile } from '@/lib/studyspace/profile'
import type { PersonaStep } from '@/server/ingest/persona'

const a = { step: vi.fn(), regen: vi.fn(), accept: vi.fn(), status: vi.fn(), split: vi.fn(), keep: vi.fn() }
vi.mock('@/app/spaces/actions', () => ({
  getPersonaStepAction: (...x: unknown[]) => a.step(...x),
  regenerateProfileAction: (...x: unknown[]) => a.regen(...x),
  acceptProfileAction: (...x: unknown[]) => a.accept(...x),
  getSpaceStatusAction: (...x: unknown[]) => a.status(...x),
  splitStudyspaceAction: (...x: unknown[]) => a.split(...x),
  dismissSplitNoticeAction: (...x: unknown[]) => a.keep(...x),
}))

const profile = (over: Partial<TutorProfile> = {}): TutorProfile => ({ ...defaultProfile({ title: 'Chem' }), subject: 'Chemistry', tutorIdentity: 'a chemistry professor', ...over })
const step = (over: Partial<PersonaStep> = {}): PersonaStep => ({
  ok: true, mode: 'proposal', profile: profile(), rationale: 'Proposed from 2 files.', excludedSources: [], split: null,
  modules: [{ name: '01 · One', title: 'One' }, { name: '02 · Two', title: 'Two' }], readOnly: false, starterStatus: 'waiting_for_profile',
  starterProgress: { topicsWithQuestions: 0, studyTopics: 4 }, ...over,
})
const status = (starterStatus: string, done = 0) => ({ starterStatus, starterProgress: { topicsWithQuestions: done, studyTopics: 4 } })

beforeEach(() => {
  vi.clearAllMocks()
  a.keep.mockResolvedValue({ ok: true })
})
afterEach(() => vi.useRealTimers())

const flush = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
async function renderCard(initial: PersonaStep | { ok: false; reason: string }, onStudy = vi.fn()) {
  a.step.mockResolvedValue(initial)
  const view = render(<PersonaCard courseId="c1" onStudy={onStudy} onBack={vi.fn()} />)
  await flush()
  return { onStudy, ...view }
}

describe('PersonaCard', () => {
  it('shows a waiting state with a way to skip while the proposal is made', async () => {
    vi.useFakeTimers()
    let release: (v: unknown) => void = () => {}
    a.step.mockImplementation(() => new Promise((r) => { release = r }))
    const onStudy = vi.fn()
    render(<PersonaCard courseId="c1" onStudy={onStudy} />)
    await flush()
    expect(screen.getByText('Reading your outline to propose a tutor…')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Start studying with the default tutor' }))
    expect(onStudy).toHaveBeenCalled()
    release(step())
    await flush()
    expect(screen.getByLabelText('Subject')).toHaveValue('Chemistry')
  })

  it('shows the reason, Retry and the skip when the proposal fails', async () => {
    vi.useFakeTimers()
    const { onStudy } = await renderCard({ ok: false, reason: 'The tutor proposal failed twice.' })
    expect(screen.getByRole('alert')).toHaveTextContent('The tutor proposal failed twice.')
    a.step.mockResolvedValue(step())
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await flush()
    expect(screen.getByLabelText('Subject')).toBeInTheDocument()
    expect(onStudy).not.toHaveBeenCalled()
  })

  it('a preset changes tone, notes and default chat mode but keeps the owner’s other edits', async () => {
    vi.useFakeTimers()
    await renderCard(step())
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Organic chemistry' } })
    fireEvent.change(screen.getByLabelText('Analogy domains'), { target: { value: 'cooking, lego' } })
    fireEvent.click(screen.getByRole('radio', { name: /Patient coach/ }))
    expect(screen.getByRole('radio', { name: /Patient coach/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByLabelText('Tone notes')).toHaveValue(PRESETS.patient_coach.toneNotes)
    expect(screen.getByRole('radio', { name: /Guide/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByLabelText('Subject')).toHaveValue('Organic chemistry')
    expect(screen.getByLabelText('Analogy domains')).toHaveValue('cooking, lego')
  })

  it('Accept sends a schema-valid, normalized profile and then shows the starter progress', async () => {
    vi.useFakeTimers()
    a.accept.mockResolvedValue({ ok: true, starters: 'requested' })
    a.status
      .mockResolvedValueOnce(status('pending'))
      .mockResolvedValueOnce(status('running', 2))
      .mockResolvedValue(status('done', 4))
    const { onStudy } = await renderCard(step())
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Organic chemistry' } })
    const single = screen.getAllByLabelText('Single choice (%)')[0]
    fireEvent.change(single, { target: { value: '90' } })
    fireEvent.blur(single)
    fireEvent.change(screen.getByLabelText('Difficulty calibration module (optional)'), { target: { value: '02 · Two' } })
    fireEvent.click(screen.getByRole('button', { name: 'Accept tutor' }))
    await flush()
    expect(a.accept).toHaveBeenCalledTimes(1)
    const [id, sent] = a.accept.mock.calls[0]
    expect(id).toBe('c1')
    expect(TutorProfileSchema.safeParse(sent).success).toBe(true)
    expect(sent).toMatchObject({ subject: 'Organic chemistry', calibrationModule: '02 · Two' })
    expect(Object.values(sent.questionTypeMix as Record<string, number>).reduce((x, y) => x + y, 0)).toBeCloseTo(1, 10)
    expect(screen.getByText(/Preparing starter questions…/)).toBeInTheDocument()
    await flush(10)
    expect(screen.getByText(/2 of 4 topics/)).toBeInTheDocument() // the panel's first poll
    await flush(2100)
    expect(screen.getByText(/Starter questions are ready/)).toBeInTheDocument()
    const calls = a.status.mock.calls.length
    await flush(10_000)
    expect(a.status.mock.calls.length).toBe(calls) // stopped at done
    fireEvent.click(screen.getByRole('button', { name: 'Start studying now' }))
    expect(onStudy).toHaveBeenCalled()
  })

  it('does not send an invalid profile and says what to fix', async () => {
    vi.useFakeTimers()
    await renderCard(step())
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: '' } })
    expect(screen.getByRole('alert')).toHaveTextContent(/Subject/)
    expect(screen.getByRole('button', { name: 'Accept tutor' })).toBeDisabled()
    expect(a.accept).not.toHaveBeenCalled()
  })

  it('shows the server’s reason when accepting is refused', async () => {
    vi.useFakeTimers()
    a.accept.mockResolvedValue({ ok: false, reason: 'The tutor settings are not valid (subject).' })
    await renderCard(step())
    fireEvent.click(screen.getByRole('button', { name: 'Accept tutor' }))
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent('The tutor settings are not valid (subject).')
    expect(screen.queryByText(/Preparing starter questions/)).not.toBeInTheDocument()
  })

  it('Regenerate asks before discarding edits and only then calls the action', async () => {
    vi.useFakeTimers()
    a.regen.mockResolvedValue(step({ profile: profile({ subject: 'New proposal' }) }))
    await renderCard(step())
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' })) // nothing edited yet: goes straight through
    await flush()
    expect(a.regen).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('Subject')).toHaveValue('New proposal')
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Mine' } })
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }))
    expect(a.regen).toHaveBeenCalledTimes(1)
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Keep editing' }))
    expect(screen.getByLabelText('Subject')).toHaveValue('Mine')
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard my edits and regenerate' }))
    await flush()
    expect(a.regen).toHaveBeenCalledTimes(2)
  })

  it('names the files that failed and were left out', async () => {
    vi.useFakeTimers()
    await renderCard(step({ excludedSources: [{ id: 's1', name: 'broken.pdf', reason: 'The PDF is encrypted.' }] }))
    expect(screen.getByText(/left out of the proposal/)).toBeInTheDocument()
    expect(screen.getByText(/broken\.pdf: The PDF is encrypted\./)).toBeInTheDocument()
  })

  it('offers the split with the file names per group; Keep together only hides the notice', async () => {
    vi.useFakeTimers()
    a.split.mockResolvedValue({ ok: true, ids: ['c1', 'c2'], created: [{ id: 'c2', title: 'History' }] })
    const split = { groups: [{ label: 'Chemistry', sources: [{ id: 's1', name: 'chem.md' }] }, { label: 'History', sources: [{ id: 's2', name: 'wars.pdf' }] }] }
    await renderCard(step({ split }))
    expect(screen.getByText('chem.md')).toBeInTheDocument()
    expect(screen.getByText('wars.pdf')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Keep together' }))
    await flush()
    expect(screen.queryByRole('button', { name: 'Split into two studyspaces' })).not.toBeInTheDocument()
    expect(a.keep).toHaveBeenCalledWith('c1')
    expect(a.split).not.toHaveBeenCalled()
  })

  it('splits with the proposed groups and links to the new studyspace', async () => {
    vi.useFakeTimers()
    a.split.mockResolvedValue({ ok: true, ids: ['c1', 'c2'], created: [{ id: 'c2', title: 'History' }] })
    const split = { groups: [{ label: 'Chemistry', sources: [{ id: 's1', name: 'chem.md' }] }, { label: 'History', sources: [{ id: 's2', name: 'wars.pdf' }] }] }
    await renderCard(step({ split }))
    a.step.mockResolvedValue(step())
    fireEvent.click(screen.getByRole('button', { name: 'Split into two studyspaces' }))
    await flush()
    expect(a.split).toHaveBeenCalledWith('c1', [{ label: 'Chemistry', sourceIds: ['s1'] }, { label: 'History', sourceIds: ['s2'] }])
    expect(screen.getByRole('link', { name: 'History' })).toHaveAttribute('href', '/spaces/c2/setup?step=persona')
  })

  it('shows the accepted tutor for editing with a save button and no regenerate', async () => {
    vi.useFakeTimers()
    a.accept.mockResolvedValue({ ok: true, starters: 'not_needed' })
    a.status.mockResolvedValue(status('done', 4))
    await renderCard(step({ mode: 'accepted', rationale: null, starterStatus: 'done' }))
    expect(screen.queryByRole('button', { name: 'Regenerate' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Content language'), { target: { value: 'pt-BR' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await flush()
    expect(a.accept).toHaveBeenCalledWith('c1', expect.objectContaining({ contentLanguage: 'pt-BR' }))
  })

  it('shows the failed starter message with a retry for an accepted tutor', async () => {
    vi.useFakeTimers()
    await renderCard(step({ mode: 'accepted', rationale: null, starterStatus: 'failed' }))
    expect(screen.getByText('Starter questions could not be generated; sessions will generate questions as you go.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try starter questions again' })).toBeInTheDocument()
  })

  it('is read-only for an imported studyspace', async () => {
    vi.useFakeTimers()
    await renderCard(step({ mode: 'accepted', readOnly: true, rationale: null }))
    expect(screen.getByLabelText('Subject')).toBeDisabled()
    expect(screen.queryByRole('button', { name: /Save changes|Accept tutor/ })).not.toBeInTheDocument()
    expect(screen.getAllByText(/cannot be changed/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/Change anything and save/)).not.toBeInTheDocument()
    expect(screen.getByText(/Shown for reference/)).toBeInTheDocument()
  })

  it('shows a visible “Saved.” notice after saving an accepted tutor, and the refusal reason on failure', async () => {
    vi.useFakeTimers()
    a.status.mockResolvedValue(status('done', 4))
    await renderCard(step({ mode: 'accepted', rationale: null, starterStatus: 'done' }))
    a.accept.mockResolvedValueOnce({ ok: false, reason: 'Nope, refused.' })
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Changed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent('Nope, refused.')
    let release: (v: unknown) => void = () => {}
    a.accept.mockImplementationOnce(() => new Promise((r) => { release = r }))
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await flush()
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled()
    release({ ok: true, starters: 'not_needed' })
    await flush()
    expect(screen.getByText(/Saved\. New questions will use these settings\./)).toBeInTheDocument()
    expect(screen.getAllByRole('status').some((el) => /Saved\./.test(el.textContent ?? ''))).toBe(true)
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Changed again' } })
    expect(screen.queryByText(/Saved\./)).not.toBeInTheDocument()
  })

  it('renders a stored proposal at once, without asking the server', async () => {
    vi.useFakeTimers()
    render(<PersonaCard courseId="c1" onStudy={vi.fn()} initial={step()} />)
    expect(screen.getByLabelText('Subject')).toHaveValue('Chemistry')
    await flush()
    expect(a.step).not.toHaveBeenCalled()
  })

  it('offers common languages, with Other and a text field for a code that is not in the list', async () => {
    vi.useFakeTimers()
    await renderCard(step({ profile: profile({ contentLanguage: 'nl' }) }))
    expect(screen.getByLabelText('Content language')).toHaveValue('other')
    expect(screen.getByLabelText('Other language code')).toHaveValue('nl')
    fireEvent.change(screen.getByLabelText('Content language'), { target: { value: 'pt-BR' } })
    expect(screen.queryByLabelText('Other language code')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Content language')).toHaveValue('pt-BR')
    fireEvent.change(screen.getByLabelText('Content language'), { target: { value: 'other' } })
    fireEvent.change(screen.getByLabelText('Other language code'), { target: { value: 'ja-JP' } })
    fireEvent.click(screen.getByRole('button', { name: 'Accept tutor' }))
    a.accept.mockResolvedValue({ ok: true, starters: 'requested' })
    await flush()
    expect(a.accept).toHaveBeenCalledWith('c1', expect.objectContaining({ contentLanguage: 'ja-JP' }))
  })

  it('lets the owner name each group before splitting', async () => {
    vi.useFakeTimers()
    a.split.mockResolvedValue({ ok: true, ids: ['c1', 'c2'], keptTitle: 'Organic chemistry', created: [{ id: 'c2', title: 'World history' }] })
    const split = { groups: [{ label: 'Chemistry', sources: [{ id: 's1', name: 'chem.md' }] }, { label: 'History', sources: [{ id: 's2', name: 'wars.pdf' }] }] }
    await renderCard(step({ split }))
    expect(screen.getByLabelText('Name of the studyspace that stays')).toHaveValue('Chemistry')
    fireEvent.change(screen.getByLabelText('Name of the studyspace that stays'), { target: { value: 'Organic chemistry' } })
    fireEvent.change(screen.getByLabelText('Name of new studyspace 1'), { target: { value: 'World history' } })
    a.step.mockResolvedValue(step())
    fireEvent.click(screen.getByRole('button', { name: 'Split into two studyspaces' }))
    await flush()
    expect(a.split).toHaveBeenCalledWith('c1', [{ label: 'Organic chemistry', sourceIds: ['s1'] }, { label: 'World history', sourceIds: ['s2'] }])
    expect(screen.getByText(/now called “Organic chemistry”/)).toBeInTheDocument()
  })

  it('does not split with an empty name', async () => {
    vi.useFakeTimers()
    const split = { groups: [{ label: 'Chemistry', sources: [{ id: 's1', name: 'chem.md' }] }, { label: 'History', sources: [{ id: 's2', name: 'wars.pdf' }] }] }
    await renderCard(step({ split }))
    fireEvent.change(screen.getByLabelText('Name of new studyspace 1'), { target: { value: '  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Split into two studyspaces' }))
    await flush()
    expect(a.split).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(/1 to 80 characters/)
    // the message names the field by its label, not by a group number
    expect(screen.getByRole('alert')).toHaveTextContent('Check the field “Name of new studyspace 1”.')
    expect(screen.getByRole('alert')).not.toHaveTextContent(/group/i)
    fireEvent.change(screen.getByLabelText('Name of new studyspace 1'), { target: { value: 'History' } })
    fireEvent.change(screen.getByLabelText('Name of the studyspace that stays'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Split into two studyspaces' }))
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent('Check the field “Name of the studyspace that stays”.')
  })

  it('tells the page the new title of the studyspace that stays after a split', async () => {
    vi.useFakeTimers()
    a.split.mockResolvedValue({ ok: true, ids: ['c1', 'c2'], keptTitle: 'Organic chemistry', created: [{ id: 'c2', title: 'World history' }] })
    const split = { groups: [{ label: 'Chemistry', sources: [{ id: 's1', name: 'chem.md' }] }, { label: 'History', sources: [{ id: 's2', name: 'wars.pdf' }] }] }
    a.step.mockResolvedValue(step({ split }))
    const onRenamed = vi.fn()
    render(<PersonaCard courseId="c1" onStudy={vi.fn()} onRenamed={onRenamed} />)
    await flush()
    a.step.mockResolvedValue(step())
    fireEvent.click(screen.getByRole('button', { name: 'Split into two studyspaces' }))
    await flush()
    expect(onRenamed).toHaveBeenCalledWith('Organic chemistry')
  })

  describe('open answer share', () => {
    const legacy = () => profile({
      questionTypeMix: { single_choice: 0.4, multiple_choice: 0.2, numeric: 0, dropdown: 0.4, open: 0 },
      quantitativeQuestionTypeMix: { single_choice: 1 / 6, multiple_choice: 1 / 3, numeric: 1 / 3, dropdown: 1 / 6, open: 0 },
      quantitative: true,
      questionTypeCycles: { quantitative: ['numeric', 'multiple_choice'], qualitative: ['single_choice', 'dropdown'] },
    })

    it('shows a fifth, named share in both mixes, with the default 20% and 10%', async () => {
      vi.useFakeTimers()
      await renderCard(step({ profile: profile({ quantitative: true }) }))
      const open = screen.getAllByLabelText('Open answer (written) (%)')
      expect(open).toHaveLength(2)
      expect(open[0]).toHaveValue(20)
      expect(open[1]).toHaveValue(10)
      for (const group of screen.getAllByRole('group', { name: /Question types for/ })) {
        expect(within(group).getAllByRole('spinbutton')).toHaveLength(5)
        // five inputs wrap on two columns on a phone and sit in one row from the sm breakpoint on
        expect(group.querySelector('.grid')?.className).toMatch(/grid-cols-2/)
        expect(group.querySelector('.grid')?.className).toMatch(/sm:grid-cols-5/)
      }
    })

    it('keeps the typed share and scales the others to fill the rest, in whole percents that add up to 100', async () => {
      vi.useFakeTimers()
      a.accept.mockResolvedValue({ ok: true, starters: 'requested' })
      a.status.mockResolvedValue(status('pending'))
      await renderCard(step())
      const group = screen.getAllByRole('group', { name: /Question types for conceptual/ })[0]
      const values = () => within(group).getAllByRole('spinbutton').map((i) => Number((i as HTMLInputElement).value))
      expect(values()).toEqual([30, 25, 0, 25, 20])
      const open = screen.getAllByLabelText('Open answer (written) (%)')[0]
      fireEvent.change(open, { target: { value: '50' } })
      expect(open).toHaveValue(50) // the typed value stays, also after leaving the field
      fireEvent.blur(open)
      expect(open).toHaveValue(50)
      expect(values()).toEqual([19, 16, 0, 15, 50])
      expect(values().reduce((x, y) => x + y, 0)).toBe(100)
      fireEvent.change(open, { target: { value: '80' } })
      fireEvent.blur(open)
      expect(values().reduce((x, y) => x + y, 0)).toBe(100)
      expect(open).toHaveValue(80)
      fireEvent.click(screen.getByRole('button', { name: 'Accept tutor' }))
      await flush()
      const [, sent] = a.accept.mock.calls[0]
      expect(TutorProfileSchema.safeParse(sent).success).toBe(true)
      expect(sent.questionTypeMix.open).toBeCloseTo(0.8, 10)
      expect(sent.questionTypeMix.numeric).toBe(0)
      expect(screen.queryByText(/scaled to add up/)).not.toBeInTheDocument()
    })

    it('editing a share of a profile with a fixed order clears the order and says so', async () => {
      vi.useFakeTimers()
      a.accept.mockResolvedValue({ ok: true, starters: 'not_needed' })
      a.status.mockResolvedValue(status('done', 4))
      await renderCard(step({ mode: 'accepted', rationale: null, starterStatus: 'done', profile: legacy() }))
      expect(screen.getByText(/asks its question types in a fixed order\. If you change any share/)).toBeInTheDocument()
      // typing the value that is already shown is not an edit
      const same = screen.getAllByLabelText('Single choice (%)')[0]
      fireEvent.change(same, { target: { value: '40' } })
      fireEvent.blur(same)
      expect(screen.getByText(/asks its question types in a fixed order/)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()

      const open = screen.getAllByLabelText('Open answer (written) (%)')[0]
      fireEvent.change(open, { target: { value: '25' } })
      fireEvent.blur(open)
      expect(screen.getByText('The original fixed order of question types is replaced by these shares when you save.')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
      await flush()
      const [, sent] = a.accept.mock.calls[0]
      expect(sent.questionTypeCycles).toBeNull()
      expect(sent.questionTypeMix.open).toBeCloseTo(0.25, 10)
    })

    it('keeps the fixed order when no share is edited', async () => {
      vi.useFakeTimers()
      a.accept.mockResolvedValue({ ok: true, starters: 'not_needed' })
      a.status.mockResolvedValue(status('done', 4))
      await renderCard(step({ mode: 'accepted', rationale: null, starterStatus: 'done', profile: legacy() }))
      fireEvent.change(screen.getByLabelText('Content language'), { target: { value: 'pt-BR' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
      await flush()
      expect(a.accept.mock.calls[0][1].questionTypeCycles).toEqual({ quantitative: ['numeric', 'multiple_choice'], qualitative: ['single_choice', 'dropdown'] })
    })

    it('stays read-only for a fixed-order tutor of an imported studyspace, with its five disabled shares', async () => {
      vi.useFakeTimers()
      await renderCard(step({ mode: 'accepted', readOnly: true, rationale: null, profile: legacy() }))
      for (const input of screen.getAllByLabelText('Open answer (written) (%)')) {
        expect(input).toBeDisabled()
        expect(input).toHaveValue(0)
      }
      expect(screen.getByText(/shares above are shown for reference only/)).toBeInTheDocument()
    })
  })
})
