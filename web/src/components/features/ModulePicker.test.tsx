import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ModulePicker } from './ModulePicker'
import type { ModuleStat } from '@/lib/sessionConfig'

const stat = (key: string, over: Partial<ModuleStat> = {}): ModuleStat => ({ key, topicIds: [key], questions: 20, completed: 10, coverage: 50, accuracy: 60, problems: 0, problemParts: 0, ...over })
const stats = [stat('Week 01'), stat('Week 02', { accuracy: null, completed: 0, coverage: 0 }), stat('Week 03', { accuracy: 30, problems: 2 }), stat('Week 04', { questions: 0, completed: 0, coverage: 0, accuracy: null })]

function setup(selected: string[] = []) {
  const onChange = vi.fn()
  render(<ModulePicker stats={stats} selected={selected} onChange={onChange} formatLabel={(k) => k} />)
  return onChange
}

describe('ModulePicker', () => {
  it('shows questions, progress, accuracy and problems per module, and marks empty ones', () => {
    setup()
    expect(screen.getAllByText('20 questions')).toHaveLength(3)
    expect(screen.getByText('60% acc')).toBeTruthy()
    expect(screen.getByText('Unseen')).toBeTruthy()
    expect(screen.getByText('30% acc')).toBeTruthy()
    expect(screen.getByText('2 problems')).toBeTruthy()
    expect(screen.getByText('No questions yet')).toBeTruthy()
    expect(screen.getByText('Module')).toBeTruthy()
  })
  it('toggles a module on click', () => {
    const onChange = setup(['Week 01'])
    fireEvent.click(screen.getByText('Week 02'))
    expect(onChange).toHaveBeenLastCalledWith(['Week 01', 'Week 02'])
    fireEvent.click(screen.getByText('Week 01'))
    expect(onChange).toHaveBeenLastCalledWith([])
    expect(screen.getByText('Week 01').closest('button')?.getAttribute('aria-pressed')).toBe('true')
  })
  it('shift-click takes the range from the last click', () => {
    const onChange = setup()
    fireEvent.click(screen.getByText('Week 01'))
    fireEvent.click(screen.getByText('Week 03'), { shiftKey: true })
    expect(onChange).toHaveBeenLastCalledWith(['Week 01', 'Week 02', 'Week 03'])
  })
  it('All picks the modules that have questions, Weakest 3 the lowest accuracy then unseen, Clear empties', () => {
    const onChange = setup()
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(onChange).toHaveBeenLastCalledWith(['Week 01', 'Week 02', 'Week 03'])
    fireEvent.click(screen.getByRole('button', { name: 'Weakest 3' }))
    expect(onChange).toHaveBeenLastCalledWith(['Week 03', 'Week 01', 'Week 02'])
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(onChange).toHaveBeenLastCalledWith([])
  })
})
