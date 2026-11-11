import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { VoiceHub } from './VoiceHub'
import { LEGACY_VOICE_PROFILE } from '@/lib/studyspace/legacyProfiles'

describe('VoiceHub Component', () => {
  const mockConnect = vi.fn()
  const mockDisconnect = vi.fn()
  const mockSendText = vi.fn()

  const defaultLiveAPI = {
    isConnected: false,
    isConnecting: false,
    error: null,
    messages: [],
    connect: mockConnect,
    disconnect: mockDisconnect,
    sendText: mockSendText
  }

  it('renders correctly in initial state', () => {
    render(<VoiceHub liveAPI={defaultLiveAPI} />)
    expect(screen.getByText('Talk to the Professor')).toBeInTheDocument()
    expect(screen.getByText('Connect to start chatting hands-free.')).toBeInTheDocument()
    expect(screen.getByText('Start Voice Tutor')).toBeInTheDocument()
  })

  it('connects to Live API on button click', async () => {
    render(<VoiceHub liveAPI={defaultLiveAPI} />)
    const connectButton = screen.getByText('Start Voice Tutor')
    
    fireEvent.click(connectButton)
    expect(mockConnect).toHaveBeenCalled()
  })

  it('parks a typed message in pendingMessageRef and connects text-only instead of sending it', async () => {
    mockConnect.mockReset()
    mockSendText.mockReset()
    mockConnect.mockResolvedValue(undefined)
    const pendingMessageRef = { current: null as string | null }
    render(<VoiceHub liveAPI={{ ...defaultLiveAPI, setMuted: vi.fn() }} pendingMessageRef={pendingMessageRef} />)
    fireEvent.change(screen.getByPlaceholderText('Type a message to start chatting...'), { target: { value: 'hello tutor' } })
    fireEvent.submit(screen.getByPlaceholderText('Type a message to start chatting...').closest('form')!)
    expect(mockConnect).toHaveBeenCalledWith(false)
    expect(pendingMessageRef.current).toBe('hello tutor')
    expect(mockSendText).not.toHaveBeenCalled()
  })

  it('clears the pending message when the connection fails', async () => {
    mockConnect.mockReset()
    mockConnect.mockRejectedValue(new Error('x'))
    const pendingMessageRef = { current: null as string | null }
    render(<VoiceHub liveAPI={{ ...defaultLiveAPI, setMuted: vi.fn() }} pendingMessageRef={pendingMessageRef} />)
    fireEvent.change(screen.getByPlaceholderText('Type a message to start chatting...'), { target: { value: 'hi' } })
    fireEvent.submit(screen.getByPlaceholderText('Type a message to start chatting...').closest('form')!)
    await waitFor(() => expect(pendingMessageRef.current).toBeNull())
  })

  it('reports a typed message and a chat-mode switch as help asked, but not an empty message or the already active mode', () => {
    const onHelpRequested = vi.fn()
    const onChange = vi.fn()
    mockConnect.mockReset()
    mockConnect.mockResolvedValue(undefined)
    render(
      <VoiceHub
        liveAPI={{ ...defaultLiveAPI, setMuted: vi.fn() }}
        pendingMessageRef={{ current: null }}
        onHelpRequested={onHelpRequested}
        chatMode="probe"
        onChatModeChange={onChange}
        chatModeProfile={LEGACY_VOICE_PROFILE}
        sessionMode="study"
      />
    )
    const form = screen.getByPlaceholderText('Type a message to start chatting...').closest('form')!
    fireEvent.submit(form)
    expect(onHelpRequested).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('radio', { name: 'Probe' }))
    expect(onHelpRequested).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('radio', { name: 'Explain' }))
    expect(onHelpRequested).toHaveBeenCalledTimes(1)
    fireEvent.change(screen.getByPlaceholderText('Type a message to start chatting...'), { target: { value: 'hint please' } })
    fireEvent.submit(form)
    expect(onHelpRequested).toHaveBeenCalledTimes(2)
  })

  it('displays messages', () => {
    const activeLiveAPI = {
      ...defaultLiveAPI,
      isConnected: true,
      messages: [
        { id: '1', role: 'user', text: 'Hello' },
        { id: '2', role: 'model', text: 'Hi there' }
      ]
    }

    render(<VoiceHub liveAPI={activeLiveAPI} />)
    expect(screen.getByText('Hello')).toBeInTheDocument()
    expect(screen.getByText('Hi there')).toBeInTheDocument()
  })

  describe('chat mode selector', () => {
    const sendContext = vi.fn()
    const liveAPI = { ...defaultLiveAPI, isConnected: true, sendContext }
    const props = { chatModeProfile: LEGACY_VOICE_PROFILE, sessionMode: 'study' as string | null }

    beforeEach(() => sendContext.mockClear())

    it('is not rendered without chat mode props', () => {
      render(<VoiceHub liveAPI={liveAPI} />)
      expect(screen.queryByTestId('chat-mode-selector')).not.toBeInTheDocument()
    })

    it('is hidden in exam sessions', () => {
      render(<VoiceHub liveAPI={liveAPI} {...props} sessionMode="exam" chatMode="probe" onChatModeChange={vi.fn()} />)
      expect(screen.queryByTestId('chat-mode-selector')).not.toBeInTheDocument()
    })

    it('shows the current mode and sends exactly one non-interrupting switch message on change', () => {
      const onChange = vi.fn()
      render(<VoiceHub liveAPI={liveAPI} {...props} chatMode="probe" onChatModeChange={onChange} />)
      expect(screen.getByRole('radio', { name: 'Probe' })).toHaveAttribute('aria-checked', 'true')

      fireEvent.click(screen.getByRole('radio', { name: 'Guide' }))
      expect(onChange).toHaveBeenCalledWith('guide')
      expect(sendContext).toHaveBeenCalledTimes(1)
      const [text, opts] = sendContext.mock.calls[0]
      expect(text).toContain('The student switched the tutor to guide mode.')
      expect(opts).toEqual({ interrupt: false })

      // Clicking the active mode does nothing
      fireEvent.click(screen.getByRole('radio', { name: 'Probe' }))
      expect(onChange).toHaveBeenCalledTimes(1)
      expect(sendContext).toHaveBeenCalledTimes(1)
    })

    it('changes the mode without sending anything while disconnected', () => {
      const onChange = vi.fn()
      render(<VoiceHub liveAPI={{ ...liveAPI, isConnected: false }} {...props} chatMode="probe" onChatModeChange={onChange} />)
      fireEvent.click(screen.getByRole('radio', { name: 'Explain' }))
      expect(onChange).toHaveBeenCalledWith('explain')
      expect(sendContext).not.toHaveBeenCalled()
    })
  })
  describe('links in tutor replies', () => {
    const withMessages = (text: string) => ({ ...defaultLiveAPI, messages: [{ id: 'm1', role: 'model', text }] })

    it('turns a bracketed title followed by a bare file path into a link handled by the viewer', () => {
      const onViewFile = vi.fn()
      render(<VoiceHub liveAPI={withMessages('Have a look at\n[Lecture 2 slides]\n/api/files/topic/abc123#page=4')} onViewFile={onViewFile} />)
      fireEvent.click(screen.getByRole('button', { name: 'Lecture 2 slides' }))
      expect(onViewFile).toHaveBeenCalledWith('/api/files/topic/abc123#page=4')
    })

    it('leaves paths that are not the app\'s own file routes as plain text', () => {
      render(<VoiceHub liveAPI={withMessages('See /api/file?path=/etc/passwd and /api/files/topic/')} onViewFile={vi.fn()} />)
      expect(screen.queryByRole('button', { name: /Open document/ })).not.toBeInTheDocument()
      expect(screen.queryByRole('link')).not.toBeInTheDocument()
    })
  })

  describe('parent-held draft and close button', () => {
    it('shows and edits the draft given by the parent, so a typed message survives the panel being re-created', () => {
      const onDraftChange = vi.fn()
      const { rerender } = render(<VoiceHub liveAPI={defaultLiveAPI} draft="half a thought" onDraftChange={onDraftChange} />)
      const input = screen.getByPlaceholderText('Type a message to start chatting...') as HTMLInputElement
      expect(input.value).toBe('half a thought')
      fireEvent.change(input, { target: { value: 'more' } })
      expect(onDraftChange).toHaveBeenCalledWith('more')
      rerender(<VoiceHub liveAPI={defaultLiveAPI} draft="more" onDraftChange={onDraftChange} />)
      expect((screen.getByPlaceholderText('Type a message to start chatting...') as HTMLInputElement).value).toBe('more')
    })

    it('renders a Close tutor button only when onClose is given', () => {
      const onClose = vi.fn()
      const { rerender } = render(<VoiceHub liveAPI={defaultLiveAPI} />)
      expect(screen.queryByRole('button', { name: 'Close tutor' })).not.toBeInTheDocument()
      rerender(<VoiceHub liveAPI={defaultLiveAPI} onClose={onClose} />)
      fireEvent.click(screen.getByRole('button', { name: 'Close tutor' }))
      expect(onClose).toHaveBeenCalled()
    })
  })

  it('messages typed while connecting are parked together, not dropped and not sent directly', () => {
    mockConnect.mockReset()
    mockSendText.mockReset()
    mockConnect.mockReturnValue(new Promise(() => {})) // stays "connecting"
    const pendingMessageRef = { current: null as string | null }
    const api = { ...defaultLiveAPI, isConnecting: true, setMuted: vi.fn() }
    render(<VoiceHub liveAPI={api} pendingMessageRef={pendingMessageRef} />)
    const input = screen.getByPlaceholderText('Type a message to start chatting...')
    fireEvent.change(input, { target: { value: 'first' } })
    fireEvent.submit(input.closest('form')!)
    fireEvent.change(input, { target: { value: 'second' } })
    fireEvent.submit(input.closest('form')!)
    expect(pendingMessageRef.current).toBe('first\nsecond')
    expect(mockSendText).not.toHaveBeenCalled()
  })

  describe('Return while the tutor is connecting', () => {
    const PH = 'Type a message to start chatting...'

    it('the send button stays enabled while connecting, so Enter in the box submits (a disabled submit button blocks it)', () => {
      render(<VoiceHub liveAPI={{ ...defaultLiveAPI, isConnecting: true, setMuted: vi.fn() }} />)
      const send = screen.getByRole('button', { name: 'Send message' })
      expect(send).toBeDisabled() // nothing typed yet
      fireEvent.change(screen.getByPlaceholderText(PH), { target: { value: 'second message' } })
      expect(send).toBeEnabled()
    })

    it('accepts the message: clears the box, shows it as pending in the chat, sends it nowhere yet, and drops the bubble once connected', () => {
      mockConnect.mockReset()
      mockSendText.mockReset()
      mockConnect.mockReturnValue(new Promise(() => {}))
      const pendingMessageRef = { current: null as string | null }
      const api = { ...defaultLiveAPI, isConnecting: true, setMuted: vi.fn() }
      const { rerender } = render(<VoiceHub liveAPI={api} pendingMessageRef={pendingMessageRef} />)
      const input = screen.getByPlaceholderText(PH) as HTMLInputElement
      fireEvent.change(input, { target: { value: 'second message' } })
      fireEvent.submit(input.closest('form')!)
      expect(input.value).toBe('')
      expect(screen.getByTestId('pending-message')).toHaveTextContent('second message')
      expect(screen.getByTestId('pending-message')).toHaveTextContent('Sending when the tutor is connected')
      expect(pendingMessageRef.current).toBe('second message')
      expect(mockSendText).not.toHaveBeenCalled()

      rerender(<VoiceHub liveAPI={{ ...api, isConnecting: false, isConnected: true }} pendingMessageRef={pendingMessageRef} />)
      expect(screen.queryByTestId('pending-message')).not.toBeInTheDocument()
    })

    it('puts the parked text back in the box when the attempt fails', async () => {
      mockConnect.mockReset()
      mockConnect.mockRejectedValue(new Error('no'))
      const pendingMessageRef = { current: null as string | null }
      render(<VoiceHub liveAPI={{ ...defaultLiveAPI, setMuted: vi.fn() }} pendingMessageRef={pendingMessageRef} />)
      const input = screen.getByPlaceholderText(PH) as HTMLInputElement
      fireEvent.change(input, { target: { value: 'keep me' } })
      fireEvent.submit(input.closest('form')!)
      await waitFor(() => expect(input.value).toBe('keep me'))
      expect(pendingMessageRef.current).toBeNull()
      expect(screen.queryByTestId('pending-message')).not.toBeInTheDocument()
    })
  })
})
