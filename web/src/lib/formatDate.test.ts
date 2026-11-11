import { describe, it, expect, vi, afterEach } from 'vitest'
import { formatLocal, formatPlaceholder } from './formatDate'

afterEach(() => vi.restoreAllMocks())

describe('formatDate', () => {
  it('formats in the browser locale and time zone, with one rule for every screen', () => {
    const iso = '2026-08-15T01:27:15.587+00:00'
    expect(formatLocal(iso)).toBe(new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }))
    expect(formatLocal(iso, 'datetime')).toBe(new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))
  })

  it('uses whatever locale the browser reports, not a fixed one', () => {
    const spy = vi.spyOn(Date.prototype, 'toLocaleString').mockReturnValue('11 de nov. de 2026')
    expect(formatLocal('2026-11-11T12:00:00Z')).toBe('11 de nov. de 2026')
    expect(spy.mock.calls[0][0]).toBeUndefined()
  })

  it('placeholder is locale-free, and invalid dates give an empty string', () => {
    expect(formatPlaceholder('2026-08-15T23:59:00Z')).toBe('2026-08-15')
    expect(formatPlaceholder('nope')).toBe('')
    expect(formatLocal('nope')).toBe('')
  })
})
