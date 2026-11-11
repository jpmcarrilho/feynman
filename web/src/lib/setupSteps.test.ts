import { describe, it, expect } from 'vitest'
import { resolveSetupStep, isSetupStep } from './setupSteps'

const s = (over: Partial<Parameters<typeof resolveSetupStep>[1]>) => ({ sourceCount: 1, initialFinished: false, readyInitialCount: 0, ...over })

describe('resolveSetupStep', () => {
  it('shows upload when there are no files, whatever was requested', () => {
    expect(resolveSetupStep('outline', s({ sourceCount: 0 }))).toBe('upload')
    expect(resolveSetupStep(undefined, s({ sourceCount: 0 }))).toBe('upload')
  })
  it('shows processing while files are unfinished, even when the outline is requested', () => {
    expect(resolveSetupStep('outline', s({}))).toBe('processing')
    expect(resolveSetupStep('upload', s({}))).toBe('processing')
  })
  it('shows processing when every file failed', () => {
    expect(resolveSetupStep('outline', s({ initialFinished: true }))).toBe('processing')
  })
  it('shows the outline when files are finished and one is ready, unless processing is requested', () => {
    const done = s({ initialFinished: true, readyInitialCount: 2 })
    expect(resolveSetupStep(undefined, done)).toBe('outline')
    expect(resolveSetupStep('upload', done)).toBe('outline')
    expect(resolveSetupStep('processing', done)).toBe('processing')
  })
  it('recognizes step names', () => {
    expect(isSetupStep('outline')).toBe(true)
    expect(isSetupStep('x')).toBe(false)
  })
})
