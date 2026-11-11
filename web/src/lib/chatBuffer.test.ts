import { describe, it, expect, vi } from 'vitest'
import { ChatBuffer } from './chatBuffer'

type Msg = { role: string; text: string }
const msgs = (...t: string[]): Msg[] => t.map((text) => ({ role: 'user', text }))

/** Mimics the autosave timer: save what the buffer allows for `sessionId`, through `save`. */
function autosaveTick(buf: ChatBuffer<Msg>, sessionId: string, save: (id: string, m: Msg[]) => void) {
  const m = buf.changedSnapshot(sessionId)
  if (!m) return
  buf.markSaved(sessionId, m)
  save(sessionId, m)
}

describe('ChatBuffer (the tutor chat leaked from session F into session G)', () => {
  it('start F, chat, start G, autosave tick: G saves nothing and F keeps its chat', () => {
    const buf = new ChatBuffer<Msg>()
    const saved = new Map<string, Msg[]>()
    const save = vi.fn((id: string, m: Msg[]) => { saved.set(id, m) })

    buf.observe(buf.replace('F', []))
    const fChat = msgs('hello', 'tutor reply')
    buf.observe(fChat)
    autosaveTick(buf, 'F', save)
    expect(saved.get('F')).toEqual(fChat)

    // "Practice This Week": the session on screen becomes G
    buf.replace('G', [])
    // the timer fires before React re-rendered; the state still holds F's list (stale render)
    buf.observe(fChat)
    autosaveTick(buf, 'G', save)
    expect(saved.has('G')).toBe(false)
    expect(saved.get('F')).toEqual(fChat)
    // and the timer of F's closure cannot save either
    autosaveTick(buf, 'F', save)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('once the empty list is shown, only G\'s own new messages are saved to G', () => {
    const buf = new ChatBuffer<Msg>()
    const save = vi.fn()
    buf.observe(buf.replace('F', []))
    buf.observe(msgs('f1'))
    const empty = buf.replace('G', [])
    buf.observe(empty) // committed
    autosaveTick(buf, 'G', save)
    expect(save).not.toHaveBeenCalled()
    buf.observe(msgs('g1'))
    autosaveTick(buf, 'G', save)
    expect(save).toHaveBeenCalledWith('G', msgs('g1'))
    autosaveTick(buf, 'F', save)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('a conversation restored from the server belongs to that session', () => {
    const buf = new ChatBuffer<Msg>()
    const restored = buf.replace('H', msgs('old1', 'old2'))
    buf.observe(restored)
    expect(buf.snapshot('H')).toEqual(msgs('old1', 'old2'))
    expect(buf.snapshot('F')).toBeNull()
  })

  it('does not save the same state twice, but saves again after a new message', () => {
    const buf = new ChatBuffer<Msg>()
    const save = vi.fn()
    buf.observe(buf.replace('F', []))
    buf.observe(msgs('a'))
    autosaveTick(buf, 'F', save)
    autosaveTick(buf, 'F', save)
    expect(save).toHaveBeenCalledTimes(1)
    buf.observe(msgs('a', 'b'))
    autosaveTick(buf, 'F', save)
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('after the session on screen is cleared (end, cancel) nothing can be saved to anyone', () => {
    const buf = new ChatBuffer<Msg>()
    buf.observe(buf.replace('F', []))
    buf.observe(msgs('a'))
    const cleared = buf.replace(null, [])
    buf.observe(msgs('a')) // stale render
    expect(buf.snapshot('F')).toBeNull()
    buf.observe(cleared)
    expect(buf.snapshot('F')).toBeNull()
  })
})
