import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..')
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? files(p) : /\.(tsx?|css)$/.test(f) ? [p] : []
  })
}

describe('KaTeX stylesheet', () => {
  it('is imported once, in the root layout, so every page that renders math (study cards, tutor, viewer, /spaces) has it', () => {
    expect(readFileSync(join(__dirname, 'layout.tsx'), 'utf8')).toContain('katex/dist/katex.min.css')
    const others = files(SRC).filter((f) => !f.endsWith('layout.tsx') && !f.endsWith('layout.test.ts') && readFileSync(f, 'utf8').includes('katex.min.css'))
    expect(others).toEqual([])
  })
})
