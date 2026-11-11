import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import * as actions from './actions'
import { getGeminiApiKey } from './auth-actions'

// Any prisma.model.method(...) or prisma.$transaction(...) call is counted and resolves to null.
const { dbCalls, makeCallableDb } = vi.hoisted(() => {
  const dbCalls = { count: 0 }
  const makeCallableDb = (): unknown =>
    new Proxy(function () {}, {
      get: () => makeCallableDb(),
      apply: () => {
        dbCalls.count++
        return Promise.resolve(null)
      },
    })
  return { dbCalls, makeCallableDb }
})

vi.mock('@/lib/db', () => ({
  prisma: makeCallableDb(),
}))

vi.mock('ai', () => ({
  generateText: vi.fn(),
  generateObject: vi.fn(),
}))

vi.mock('@ai-sdk/google', () => ({
  google: vi.fn(() => 'mocked-google-model'),
}))

// Real requireAuth -> real checkIsAuthenticated, with no session cookie present.
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}))

const exportedActionNames = Object.keys(actions).filter(
  (key) => typeof (actions as Record<string, unknown>)[key] === 'function'
)

describe('server actions require authentication', () => {
  const originalPasscode = process.env.APP_PASSCODE

  beforeAll(() => {
    process.env.APP_PASSCODE = 'test-passcode'
  })

  afterAll(() => {
    process.env.APP_PASSCODE = originalPasscode
  })

  it('covers every exported action in actions.ts', () => {
    // actions.ts exports 29 async functions; the floor guards against a broken import passing vacuously.
    expect(exportedActionNames.length).toBeGreaterThanOrEqual(29)
  })

  it.each(exportedActionNames)('%s rejects with Unauthorized and does not touch the database', async (name) => {
    dbCalls.count = 0
    const fn = (actions as Record<string, (...args: unknown[]) => Promise<unknown>>)[name]
    // Passing {} keeps destructured parameters (explainMistake) from throwing before the auth check runs.
    await expect(fn({})).rejects.toThrow('Unauthorized')
    expect(dbCalls.count).toBe(0)
  })

  it('getGeminiApiKey rejects with Unauthorized and never returns a key', async () => {
    await expect(getGeminiApiKey()).rejects.toThrow('Unauthorized')
  })
})
