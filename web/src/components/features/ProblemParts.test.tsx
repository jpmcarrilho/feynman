import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ProblemParts } from './ProblemParts'
import type { ProblemSummary } from '@/lib/exerciseGroups'

const summary: ProblemSummary = {
  parts: [
    { index: 4, number: 1, state: 'correct', flagged: false, current: false },
    { index: 5, number: 2, state: 'incorrect', flagged: true, current: true },
    { index: 6, number: 3, state: 'open', flagged: false, current: false },
  ],
  answered: 2, total: 3, points: 1,
}

describe('ProblemParts', () => {
  it('shows each part with its state, marks the current one and sends the clicked index', () => {
    const onSelect = vi.fn()
    render(<ProblemParts summary={summary} onSelect={onSelect} showScore />)
    expect(screen.getByRole('button', { name: 'Part 1 of 3, correct' })).toBeTruthy()
    const current = screen.getByRole('button', { name: 'Part 2 of 3, incorrect, flagged, current' })
    expect(current.getAttribute('aria-current')).toBe('step')
    fireEvent.click(screen.getByRole('button', { name: 'Part 3 of 3, not answered' }))
    expect(onSelect).toHaveBeenCalledWith(6)
    expect(screen.getByText(/2 of 3 answered · 1 of 3 points/)).toBeTruthy()
  })
  it('does not show points when scores are hidden (an exam in progress)', () => {
    render(<ProblemParts summary={summary} onSelect={() => {}} showScore={false} />)
    expect(screen.getByText('2 of 3 answered')).toBeTruthy()
    expect(screen.queryByText(/points/)).toBeNull()
  })
})
