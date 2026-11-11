import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DebouncedWriter } from './debouncedWriter'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('DebouncedWriter', () => {
  it('sends only the latest value of a key after the delay', async () => {
    const w = new DebouncedWriter()
    const sent: string[] = []
    w.schedule('d:s:e', async () => { sent.push('1') }, 500)
    w.schedule('d:s:e', async () => { sent.push('12') }, 500)
    w.schedule('d:s:e', async () => { sent.push('123') }, 500)
    await vi.advanceTimersByTimeAsync(499)
    expect(sent).toEqual([])
    await vi.advanceTimersByTimeAsync(2)
    expect(sent).toEqual(['123'])
  })

  it('runs writes one at a time in queue order, even when an earlier one is slow', async () => {
    const w = new DebouncedWriter()
    const log: string[] = []
    let release!: () => void
    w.schedule('a', () => new Promise<void>((r) => { release = () => { log.push('a done'); r() } }), 0)
    w.schedule('b', async () => { log.push('b') }, 0)
    await vi.advanceTimersByTimeAsync(10)
    expect(log).toEqual([])
    release()
    await w.flush()
    expect(log).toEqual(['a done', 'b'])
  })

  it('flush sends pending debounced writes immediately and waits for them', async () => {
    const w = new DebouncedWriter()
    const run = vi.fn(async () => {})
    w.schedule('pos:s', run, 500)
    await w.flush()
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('a failing write is reported and does not block the next one', async () => {
    const onError = vi.fn()
    const w = new DebouncedWriter(onError)
    const next = vi.fn(async () => {})
    w.schedule('a', async () => { throw new Error('network') }, 0)
    w.schedule('b', next, 0)
    await w.flush()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(next).toHaveBeenCalled()
  })

  it('discard drops unsent writes of a session prefix only', async () => {
    const w = new DebouncedWriter()
    const old = vi.fn(async () => {})
    const keep = vi.fn(async () => {})
    w.schedule('s1:d:e', old, 500)
    w.schedule('s2:d:e', keep, 500)
    w.discard('s1:')
    await w.flush()
    expect(old).not.toHaveBeenCalled()
    expect(keep).toHaveBeenCalled()
  })
})
