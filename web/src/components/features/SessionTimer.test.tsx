import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { SessionTimer, secondsBetween } from './SessionTimer'

const START = '2026-11-11T10:00:00.000Z'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('SessionTimer', () => {
  it('an active session keeps counting past the target instead of stopping at it', () => {
    vi.setSystemTime(new Date('2026-11-11T10:05:11.000Z'))
    render(<SessionTimer durationSeconds={300} startTime={START} />)
    expect(screen.getByText('Elapsed: 5:11')).toBeInTheDocument()
    expect(screen.getByText('Target: 5:00')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(3000) })
    expect(screen.getByText('Elapsed: 5:14')).toBeInTheDocument()
  })

  it('measures elapsed time on the server clock (startTime + server offset), not the client clock', () => {
    // client clock is 1 h behind the server
    vi.setSystemTime(new Date('2026-11-11T09:02:00.000Z'))
    render(<SessionTimer durationSeconds={300} startTime={START} serverOffsetMs={3_600_000} />)
    expect(screen.getByText('Elapsed: 2:00')).toBeInTheDocument()
  })

  it('a session that is over shows its fixed duration, with no running clock', () => {
    vi.setSystemTime(new Date('2026-12-31T00:00:00.000Z')) // months later: the old bug counted from the original start
    render(<SessionTimer durationSeconds={300} startTime={START} endTime="2026-11-11T10:07:30.000Z" active={false} />)
    expect(screen.getByText('Duration: 7:30')).toBeInTheDocument()
    expect(screen.queryByText(/Elapsed/)).toBeNull()
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(screen.getByText('Duration: 7:30')).toBeInTheDocument()
  })

  it('a session that is over without an end time shows nothing', () => {
    const { container } = render(<SessionTimer durationSeconds={300} startTime={START} endTime={null} active={false} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('secondsBetween never goes negative', () => {
    expect(secondsBetween(5000, 1000)).toBe(0)
    expect(secondsBetween(0, 61_999)).toBe(61)
  })
})
