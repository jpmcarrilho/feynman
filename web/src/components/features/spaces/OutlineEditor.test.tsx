import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { OutlineEditor } from './OutlineEditor'
import type { OutlineModule, OutlineTopic } from '@/services/outlineService'

const a = {
  getOutlineAction: vi.fn(), mergeTopicsAction: vi.fn(), moveTopicToModuleAction: vi.fn(), renameModuleAction: vi.fn(), renameTopicAction: vi.fn(), reorderAction: vi.fn(),
}
vi.mock('@/app/spaces/actions', () => ({
  getOutlineAction: (...x: unknown[]) => a.getOutlineAction(...x),
  mergeTopicsAction: (...x: unknown[]) => a.mergeTopicsAction(...x),
  moveTopicToModuleAction: (...x: unknown[]) => a.moveTopicToModuleAction(...x),
  renameModuleAction: (...x: unknown[]) => a.renameModuleAction(...x),
  renameTopicAction: (...x: unknown[]) => a.renameTopicAction(...x),
  reorderAction: (...x: unknown[]) => a.reorderAction(...x),
}))

const topic = (id: string, sourceId: string, over: Partial<OutlineTopic> = {}): OutlineTopic => ({
  id, title: `Topic ${id}`, order: 0, pageStart: 1, pageEnd: 3, sourceId, sourceName: `${sourceId}.pdf`, sourceIsPdf: true, exerciseCount: 2, notStudyMaterial: false, ...over,
})
const modules: OutlineModule[] = [
  { name: '01 · One', title: 'One', topics: [topic('t1', 's1'), topic('t2', 's1'), topic('t3', 's2'), topic('t4', 's1')] },
  { name: '02 · Two', title: 'Two', topics: [topic('t5', 's2', { sourceIsPdf: false, pageStart: 1, pageEnd: 1 })] },
]

beforeEach(() => {
  vi.clearAllMocks()
  a.getOutlineAction.mockResolvedValue({ ok: true, modules, editable: true })
  for (const k of ['mergeTopicsAction', 'moveTopicToModuleAction', 'renameModuleAction', 'renameTopicAction', 'reorderAction'] as const) a[k].mockResolvedValue({ ok: true, id: 't1' })
})

const open = async () => {
  render(<OutlineEditor courseId="c1" onContinue={vi.fn()} />)
  await screen.findByText('Topic t1')
}
const pick = (id: string) => fireEvent.click(screen.getByLabelText(`Select Topic ${id} for merging`))

describe('OutlineEditor', () => {
  it('shows modules, topics, source names and page ranges for PDFs only', async () => {
    await open()
    expect(screen.getByRole('heading', { name: '01 · One' })).toBeInTheDocument()
    expect(screen.getAllByText(/s1\.pdf · pages 1-3 · 2 questions/).length).toBe(3)
    expect(screen.getByText(/^s2\.pdf · 2 questions/)).toBeInTheDocument()
  })

  it('offers merge for adjacent topics of the same file', async () => {
    await open()
    pick('t1')
    expect(screen.queryByRole('button', { name: /merge selected/i })).toBeNull()
    pick('t2')
    const merge = screen.getByRole('button', { name: /merge selected/i })
    expect(merge).toBeEnabled()
    fireEvent.click(merge)
    await waitFor(() => expect(a.mergeTopicsAction).toHaveBeenCalledWith('c1', ['t1', 't2']))
    await waitFor(() => expect(a.getOutlineAction).toHaveBeenCalledTimes(2)) // refetched
  })

  it('disables merge and says why for topics that are not adjacent or come from different files', async () => {
    await open()
    pick('t1')
    pick('t4')
    expect(screen.getByRole('button', { name: /merge selected/i })).toBeDisabled()
    expect(screen.getByText(/next to each other/)).toBeInTheDocument()
    pick('t4')
    pick('t3')
    pick('t2')
    // t1 t2 t3: t3 is another file
    expect(screen.getByRole('button', { name: /merge selected/i })).toBeDisabled()
    expect(screen.getByText(/same file/)).toBeInTheDocument()
    expect(a.mergeTopicsAction).not.toHaveBeenCalled()
  })

  it('moves a topic up or down by sending the full new order', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Move topic Topic t2 up' }))
    await waitFor(() => expect(a.reorderAction).toHaveBeenCalledWith('c1', ['t2', 't1', 't3', 't4', 't5']))
    fireEvent.click(await screen.findByRole('button', { name: 'Move topic Topic t1 down' }))
    await waitFor(() => expect(a.reorderAction).toHaveBeenLastCalledWith('c1', ['t2', 't1', 't3', 't4', 't5']))
  })

  it('disables moving the first topic up and the last one down; moves modules', async () => {
    await open()
    expect(screen.getByRole('button', { name: 'Move topic Topic t1 up' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Move topic Topic t4 down' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Move topic Topic t3 down' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Move module One up' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Move module One down' }))
    await waitFor(() => expect(a.reorderAction).toHaveBeenCalledWith('c1', ['t5', 't1', 't2', 't3', 't4']))
  })

  it('moves a topic to another module', async () => {
    await open()
    fireEvent.change(screen.getByLabelText('Move topic Topic t1 to another module'), { target: { value: '02 · Two' } })
    await waitFor(() => expect(a.moveTopicToModuleAction).toHaveBeenCalledWith('c1', 't1', '02 · Two'))
  })

  it('renames a topic and a module inline and shows a refusal reason', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Rename topic Topic t1' }))
    fireEvent.change(screen.getByLabelText('Topic title'), { target: { value: 'Supply' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
    await waitFor(() => expect(a.renameTopicAction).toHaveBeenCalledWith('c1', 't1', 'Supply'))
    await waitFor(() => expect(screen.queryByLabelText('Topic title')).toBeNull())

    a.renameModuleAction.mockResolvedValueOnce({ ok: false, reason: 'Another module already has that title.' })
    fireEvent.click(screen.getByRole('button', { name: 'Rename module Two' }))
    fireEvent.change(screen.getByLabelText('Module title'), { target: { value: 'One' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Another module already has that title.')
    expect(a.renameModuleAction).toHaveBeenCalledWith('c1', '02 · Two', 'One')
  })

  it('has a Start studying button that continues', async () => {
    const onContinue = vi.fn()
    render(<OutlineEditor courseId="c1" onContinue={onContinue} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Start studying' }))
    expect(onContinue).toHaveBeenCalled()
  })

  it('explains why the selection restarted when a topic of another module is ticked', async () => {
    await open()
    pick('t1')
    pick('t5')
    expect(screen.getByText(/same file and module can be merged; the selection was restarted/)).toBeInTheDocument()
    expect(screen.getByLabelText('Select Topic t1 for merging')).not.toBeChecked()
    expect(screen.getByLabelText('Select Topic t5 for merging')).toBeChecked()
  })

  it('offers only renaming topics when the outline cannot be rearranged', async () => {
    a.getOutlineAction.mockResolvedValue({ ok: true, modules, editable: false })
    await open()
    expect(screen.getByRole('button', { name: 'Rename topic Topic t1' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Move topic/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /module/i })).toBeNull()
    expect(screen.queryByLabelText(/for merging/)).toBeNull()
    expect(screen.queryByLabelText(/to another module/)).toBeNull()
  })

  it('gives icon buttons and checkboxes a 40 px hit area below the sm breakpoint', async () => {
    await open()
    expect(screen.getByRole('button', { name: 'Move topic Topic t2 up' }).className).toContain('size-10')
    expect(screen.getByRole('button', { name: 'Rename topic Topic t1' }).className).toContain('size-10')
    expect(screen.getByLabelText('Select Topic t1 for merging').parentElement!.className).toContain('size-10')
  })
})
