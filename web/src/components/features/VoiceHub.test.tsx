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
})
