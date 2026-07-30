import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { VoiceHub } from './VoiceHub'

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
    expect(screen.getByText('Live Voice Tutor')).toBeInTheDocument()
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
})
