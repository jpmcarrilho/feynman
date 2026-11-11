import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('@/app/auth-actions', () => ({
  createLiveToken: vi.fn(async () => ({ token: 'tok' })),
}))

import { useLiveAPI } from './useLiveAPI'

class FakeWebSocket {
  static OPEN = 1
  static instances: FakeWebSocket[] = []
  readyState = 1
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  onclose: ((e: unknown) => void) | null = null
  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {}
}

class FakeAudioContext {
  currentTime = 0
  state = 'running'
  destination = {}
  close() {
    this.state = 'closed'
    return Promise.resolve()
  }
}

describe('useLiveAPI context vs text', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('AudioContext', FakeAudioContext)
    Object.assign(window, { AudioContext: FakeAudioContext })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function connected() {
    const hook = renderHook(() => useLiveAPI('sys'))
    let p: Promise<void>
    await act(async () => {
      p = hook.result.current.connect(false)
      await new Promise((r) => setTimeout(r, 0))
    })
    await act(async () => {
      FakeWebSocket.instances[0].onopen?.()
      await p
    })
    return { hook, ws: FakeWebSocket.instances[0] }
  }

  it('sendContext sends a client turn without touching messages', async () => {
    const { hook, ws } = await connected()
    const before = ws.sent.length
    act(() => hook.result.current.sendContext('[SYSTEM MESSAGE: ctx]'))
    expect(ws.sent.length).toBe(before + 1)
    const payload = JSON.parse(ws.sent[ws.sent.length - 1])
    expect(payload.clientContent.turns[0].parts[0].text).toBe('[SYSTEM MESSAGE: ctx]')
    expect(payload.clientContent.turnComplete).toBe(true)
    expect(hook.result.current.messages).toEqual([])
  })

  it('sendContext with respond:false sends the turn without completing it', async () => {
    const { hook, ws } = await connected()
    act(() => hook.result.current.sendContext('[SYSTEM MESSAGE: ctx]', { respond: false }))
    const payload = JSON.parse(ws.sent[ws.sent.length - 1])
    expect(payload.clientContent.turnComplete).toBe(false)
    act(() => hook.result.current.sendText('question'))
    expect(JSON.parse(ws.sent[ws.sent.length - 1]).clientContent.turnComplete).toBe(true)
  })

  it('sendText still appends the real user message', async () => {
    const { hook } = await connected()
    act(() => hook.result.current.sendText('hello'))
    expect(hook.result.current.messages.map((m) => m.text)).toEqual(['hello'])
  })

  it('a server "interrupted" event (caused by the app\'s own context or typed message) is not student speech', async () => {
    const onSpeech = vi.fn()
    const hook = renderHook(() => useLiveAPI('sys', onSpeech))
    let p: Promise<void>
    await act(async () => {
      p = hook.result.current.connect(false)
      await new Promise((r) => setTimeout(r, 0))
    })
    await act(async () => {
      FakeWebSocket.instances[0].onopen?.()
      await p
    })
    const ws = FakeWebSocket.instances[0]
    // the student moves to the next question: the app sends the new exercise context, the server reports an interruption
    act(() => hook.result.current.sendContext('[SYSTEM MESSAGE: new exercise]', { interrupt: true }))
    await act(async () => {
      await ws.onmessage?.({ data: JSON.stringify({ serverContent: { interrupted: true } }) })
    })
    expect(onSpeech).not.toHaveBeenCalled()
    // a transcript of the student's audio is a signal
    await act(async () => {
      await ws.onmessage?.({ data: JSON.stringify({ serverContent: { inputTranscription: { text: 'hmm' } } }) })
    })
    expect(onSpeech).toHaveBeenCalledWith('transcript')
  })
})
