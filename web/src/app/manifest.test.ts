import { describe, it, expect } from 'vitest'
import manifest from './manifest'

describe('web app manifest', () => {
  const m = manifest()

  it('starts at /spaces in standalone display', () => {
    expect(m.start_url).toBe('/spaces')
    expect(m.display).toBe('standalone')
  })

  it('declares the 192 and 512 PNG icons', () => {
    const icons = m.icons ?? []
    expect(icons).toContainEqual(expect.objectContaining({ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }))
    expect(icons).toContainEqual(expect.objectContaining({ src: '/icon-512.png', sizes: '512x512', type: 'image/png' }))
  })

  it('uses hex colors for background and theme', () => {
    expect(m.background_color).toMatch(/^#[0-9A-Fa-f]{6}$/)
    expect(m.theme_color).toMatch(/^#[0-9A-Fa-f]{6}$/)
  })
})
