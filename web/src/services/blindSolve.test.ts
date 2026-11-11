import { describe, it, expect, vi, beforeEach } from 'vitest'
import { generateObject } from 'ai'
import { blindSolve, judgeSolution, solutionToUserAnswer } from './blindSolve'

vi.mock('ai', () => ({ generateText: vi.fn(), generateObject: vi.fn() }))
vi.mock('@ai-sdk/google', () => ({ google: vi.fn(() => 'mocked-google-model') }))

const single = { questionText: 'Pick the prime.', exerciseType: 'single_choice', choices: ['4', '6', '7', '9'], correctAnswer: '7' }
const multi = { questionText: 'Select all that apply: even numbers', exerciseType: 'multiple_choice', choices: ['2', '3', '4', '5'], correctAnswer: '["2","4"]' }
const numeric = { questionText: 'Compute 0.4+0.4 (two decimals).', exerciseType: 'numeric', choices: [], correctAnswer: '0.8' }
const dropdown = { questionText: 'Coin: [Dropdown 1].', exerciseType: 'dropdown', choices: ['one half', 'one third', 'one quarter'], correctAnswer: 'one half' }
const sol = (answer: string[], answerable = true, issue = '') => ({ answerable, issue, answer })

beforeEach(() => vi.clearAllMocks())

describe('judgeSolution grades the solver with the one grader', () => {
  it('passes a correct answer for each type', () => {
    expect(judgeSolution(single, sol(['7'])).passed).toBe(true)
    expect(judgeSolution(multi, sol(['4', '2'])).passed).toBe(true)
    expect(judgeSolution(numeric, sol(['0.80'])).passed).toBe(true)
    expect(judgeSolution(numeric, sol(['0.8001'])).passed).toBe(true) // within the grader's tolerance
    expect(judgeSolution(dropdown, sol(['one half'])).passed).toBe(true)
  })

  it('rejects a wrong answer for each type', () => {
    expect(judgeSolution(single, sol(['9'])).passed).toBe(false)
    expect(judgeSolution(multi, sol(['3', '5'])).passed).toBe(false)
    expect(judgeSolution(numeric, sol(['0.9'])).passed).toBe(false)
    expect(judgeSolution(dropdown, sol(['one third'])).passed).toBe(false)
    expect(judgeSolution(single, sol([])).passed).toBe(false)
  })

  it('does not accept partial credit on multi-select: the exact set is required', () => {
    const subset = judgeSolution(multi, sol(['2']))
    expect(subset.passed).toBe(false)
    expect(subset.score).toBe(0.5)
    expect(judgeSolution(multi, sol(['2', '4', '5'])).passed).toBe(false)
  })

  it('rejects an unanswerable question even when the solver guessed the key', () => {
    const r = judgeSolution(single, sol(['7'], false, 'The exam rules are not given.'))
    expect(r.passed).toBe(false)
    expect(r.answerable).toBe(false)
    expect(r.reason).toContain('not_answerable')
    expect(r.reason).toContain('exam rules')
  })

  it('builds the answer string the flashcard would send', () => {
    expect(solutionToUserAnswer('multiple_choice', ['a', 'b'])).toBe('["a","b"]')
    expect(solutionToUserAnswer('dropdown', ['[Dropdown 1] x'])).toBe('{"[Dropdown 1]":"x"}')
    expect(solutionToUserAnswer('numeric', ['3'])).toBe('3')
    expect(solutionToUserAnswer('single_choice', [])).toBe('')
  })
})

describe('blindSolve', () => {
  it('makes one structured call whose prompt has the question and choices but never the key', async () => {
    vi.mocked(generateObject).mockResolvedValue({ object: sol(['7']) } as never)
    const r = await blindSolve({ ...single, correctAnswer: 'KEY-7', choices: ['4', '6', 'KEY-7', '9'] })
    expect(generateObject).toHaveBeenCalledTimes(1)
    const prompt = vi.mocked(generateObject).mock.calls[0][0].prompt as string
    expect(prompt).toContain('Pick the prime.')
    expect(prompt).toContain('- KEY-7')
    expect(r.passed).toBe(false) // the solver said "7", which is not the key here
    expect(typeof r.ms).toBe('number')
  })

  it('shows dropdown options without their blank prefix and numeric questions without choices', async () => {
    vi.mocked(generateObject).mockResolvedValue({ object: sol(['one half']) } as never)
    await blindSolve({ ...dropdown, choices: ['[Dropdown 1] one half', '[Dropdown 1] one third', '[Dropdown 1] one quarter'] })
    expect(vi.mocked(generateObject).mock.calls[0][0].prompt).toContain('- one half')
    vi.mocked(generateObject).mockResolvedValue({ object: sol(['0.8']) } as never)
    await blindSolve(numeric)
    expect(vi.mocked(generateObject).mock.calls[1][0].prompt).toContain('no choices')
  })
})
