import { describe, it, expect } from 'vitest'
import { renderToString } from 'react-dom/server'
import { render, screen } from '@testing-library/react'
import { LocalDate } from './LocalDate'
import { formatLocal } from '@/lib/formatDate'

const iso = '2026-08-15T01:27:15.587+00:00'

describe('LocalDate', () => {
  it('server render shows the locale-free ISO date (so hydration cannot mismatch)', () => {
    const html = renderToString(<LocalDate value={iso} />)
    expect(html).toContain('2026-08-15')
    expect(html.toLowerCase()).toContain('datetime="2026-08-15t01:27:15.587z"')
  })

  it('after mount shows the browser-formatted value', async () => {
    render(<LocalDate value={iso} kind="datetime" />)
    const el = await screen.findByText(formatLocal(iso, 'datetime'))
    expect(el.tagName).toBe('TIME')
  })
})
