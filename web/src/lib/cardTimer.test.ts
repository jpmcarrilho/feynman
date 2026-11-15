import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CardTimer, cardKey, runningCardKey, type CardClockInputs } from './cardTimer'
import { DebouncedWriter } from './debouncedWriter'

describe('CardTimer', () => {
  let t = 0
  const timer = () => new CardTimer(() => t)
  beforeEach(() => { t = 0 })

  it('counts only while a card is running and keeps one running card at a time', () => {
    const c = timer()
    c.run('a'); t = 5000
    c.run('b'); t = 8000
    c.run(null); t = 20_000
    expect(c.totalMs('a')).toBe(5000)
    expect(c.totalMs('b')).toBe(3000)
    c.run('a'); t = 21_000
    expect(c.totalMs('a')).toBe(6000) // accumulates across leaving and coming back
  })

  it('take hands out whole seconds once; the remainder waits for the next take', () => {
    const c = timer()
    c.run('a'); t = 2500
    expect(c.take('a')).toBe(2)
    expect(c.take('a')).toBe(0)
    t = 3100
    expect(c.take('a')).toBe(1)
  })

  it('restore gives back seconds of a failed save, so nothing is lost and nothing counted twice', () => {
    const c = timer()
    c.run('a'); t = 10_000
    const d = c.take('a')
    expect(d).toBe(10)
    c.restore('a', d)
    expect(c.take('a')).toBe(10)
    expect(c.take('a')).toBe(0)
  })

  it('ignores restore of nothing and never goes negative', () => {
    const c = timer()
    c.restore('a', 5)
    c.restore('a', NaN)
    c.run('a'); t = 3000
    expect(c.take('a')).toBe(3)
  })

  it('lists the keys that still have unsent whole seconds, by prefix', () => {
    const c = timer()
    c.run(cardKey('s1', 'e1')); t = 3000
    c.run(cardKey('s2', 'e9')); t = 6000
    c.run(null)
    expect(c.keysWithUnsent('s1:')).toEqual(['s1:e1'])
    c.take('s1:e1')
    expect(c.keysWithUnsent('s1:')).toEqual([])
    expect(c.keysWithUnsent()).toEqual(['s2:e9'])
  })

  it('pauses while the page is hidden (visibilitychange drives run(null))', () => {
    vi.useFakeTimers()
    try {
      const c = new CardTimer(() => Date.now())
      let hidden = false
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') })
      const onVis = () => c.run(hidden ? null : 'a')
      document.addEventListener('visibilitychange', onVis)

      c.run('a')
      vi.advanceTimersByTime(4000)
      hidden = true
      document.dispatchEvent(new Event('visibilitychange'))
      vi.advanceTimersByTime(60_000) // away for a minute
      hidden = false
      document.dispatchEvent(new Event('visibilitychange'))
      vi.advanceTimersByTime(3000)
      expect(c.take('a')).toBe(7)
      document.removeEventListener('visibilitychange', onVis)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('runningCardKey', () => {
  const base: CardClockInputs = {
    key: 's:e1', sessionActive: true, examMode: false, answered: false, studyTabShowing: true,
    pageVisible: true, covered: false, closed: new Set(),
  }
  it('runs for an open question that is on screen', () => {
    expect(runningCardKey(base)).toBe('s:e1')
  })
  it.each([
    ['no current question', { key: null }],
    ['the session is not active', { sessionActive: false }],
    ['another tab (Tutor, History, Analytics, Resources, Plan) is showing', { studyTabShowing: false }],
    ['the page is hidden', { pageVisible: false }],
    ['a dialog, diagnosis or full-screen viewer covers the card', { covered: true }],
    ['the study question was answered', { answered: true }],
    ['the study question was answered at the click', { closed: new Set(['s:e1']) }],
  ])('stops when %s', (_n, patch) => {
    expect(runningCardKey({ ...base, ...patch })).toBeNull()
  })
  it('an exam question keeps counting after an answer was saved (the answer is only a draft)', () => {
    expect(runningCardKey({ ...base, examMode: true, answered: true })).toBe('s:e1')
  })
})

describe('time deltas with the debounced writer', () => {
  // Mirrors StudyInterface: the unsent seconds are taken when a write runs, so a replaced write cannot lose them.
  const setup = () => {
    let t = 0
    const timer = new CardTimer(() => t)
    const writer = new DebouncedWriter(() => {})
    const saved: number[] = []
    const failures = { next: 0 }
    const draft = (key: string, value: string) =>
      writer.schedule(`draft:${key}`, async () => {
        const seconds = timer.take(key)
        try {
          if (failures.next > 0) { failures.next--; throw new Error('network') }
          saved.push(seconds)
        } catch (e) {
          timer.restore(key, seconds)
          throw e
        }
        void value
      }, 500)
    return { timer, writer, saved, failures, draft, tick: (ms: number) => { t += ms } }
  }

  afterEach(() => vi.useRealTimers())

  it('a coalesced write loses no time: the newest closure sends everything counted so far', async () => {
    vi.useFakeTimers()
    const { timer, writer, saved, draft, tick } = setup()
    timer.run('a')
    tick(3000); draft('a', '1')
    tick(4000); draft('a', '2') // replaces the first before it ran
    await writer.flush()
    expect(saved).toEqual([7])
  })

  it('two queued saves never count the same seconds twice', async () => {
    vi.useFakeTimers()
    const { timer, writer, saved, tick } = setup()
    timer.run('a')
    tick(5000)
    writer.schedule('time:a', async () => { saved.push(timer.take('a')) }, 0)
    writer.schedule('draft:a', async () => { saved.push(timer.take('a')) }, 0)
    await writer.flush()
    expect(saved).toEqual([5, 0])
  })

  it('a failed save gives its seconds back and the next save carries them', async () => {
    vi.useFakeTimers()
    const { timer, writer, saved, failures, draft, tick } = setup()
    timer.run('a')
    tick(6000); failures.next = 1; draft('a', '1')
    await writer.flush()
    expect(saved).toEqual([])
    tick(2000); draft('a', '2')
    await writer.flush()
    expect(saved).toEqual([8])
  })

  it('time left on a card by quick navigation is still sent (its own key is never replaced by a draft)', async () => {
    vi.useFakeTimers()
    const { timer, writer, saved, tick } = setup()
    timer.run('a'); tick(4000)
    timer.run('b') // moved on quickly
    writer.schedule('time:a', async () => { saved.push(timer.take('a')) }, 0)
    tick(1000)
    writer.schedule('time:b', async () => { saved.push(timer.take('b')) }, 0)
    await writer.flush()
    expect(saved).toEqual([4, 1])
  })
})
