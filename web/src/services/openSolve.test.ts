import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'
import { openSolve, openSolveSchema, OPEN_SOLVE_TIMEOUT_MS } from './openSolve'
import { openSolvePrompt, OPEN_SOLVE_PROMPT_VERSION } from '@/lib/prompts'

vi.mock('ai', () => ({ generateText: vi.fn(), generateObject: vi.fn() }))
vi.mock('@ai-sdk/google', () => ({ google: vi.fn(() => 'mocked-google-model') }))

type Call = { prompt: string; schema: unknown; abortSignal?: AbortSignal; maxRetries?: number }
const input = { questionText: 'Explain why fixed effects remove time-invariant differences.', groundingContext: 'Unit/Topic: Panels\nContent:\nDemeaning by unit removes constants.', language: 'pt-BR' }

beforeEach(() => vi.clearAllMocks())

describe('openSolve', () => {
  it('sends the question and the grounding window with a timeout, and nothing else', async () => {
    const calls: Call[] = []
    const generate = (async (a: Call) => {
      calls.push(a)
      return { object: { answerable: true, issue: ' ', answer: '  Demeaning cancels constants.  ' } }
    }) as never
    const out = await openSolve(input, { generate })
    expect(out).toMatchObject({ answerable: true, issue: '', answer: 'Demeaning cancels constants.' })
    expect(out.ms).toBeGreaterThanOrEqual(0)
    expect(calls).toHaveLength(1)
    expect(calls[0].schema).toBe(openSolveSchema)
    expect(calls[0].maxRetries).toBe(1)
    expect(calls[0].abortSignal).toBeInstanceOf(AbortSignal)
    expect(calls[0].prompt).toContain(input.questionText)
    expect(calls[0].prompt).toContain('Demeaning by unit removes constants.')
    expect(calls[0].prompt).toContain('Portuguese')
    expect(OPEN_SOLVE_TIMEOUT_MS).toBeGreaterThan(0)
  })

  it('lets model errors and invalid output propagate', async () => {
    await expect(openSolve(input, { generate: (async () => { throw new Error('provider down') }) as never })).rejects.toThrow('provider down')
    await expect(openSolve(input, { generate: (async () => ({ object: { answerable: 'yes' } })) as never })).rejects.toThrow()
  })

  it('has a schema free of defaults and a prompt that names its version rule: no model answer, no key points', () => {
    expect(JSON.stringify(z.toJSONSchema(openSolveSchema))).not.toContain('"default"')
    expect(OPEN_SOLVE_PROMPT_VERSION).toBe('open-solve-v1')
    const p = openSolvePrompt({ questionText: 'Q?', groundingContext: 'CTX', language: 'en' })
    expect(p).toContain('CTX')
    expect(p).toMatch(/answerable = false/)
    expect(p).not.toMatch(/key point|model answer/i)
  })
})
