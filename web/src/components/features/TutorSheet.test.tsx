import { describe, it, expect, vi } from 'vitest'
import { useRef, useState } from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { TutorSheet, TAP_GUARD_MS } from './TutorSheet'
import { VoiceHub } from './VoiceHub'

const liveAPI = {
  isConnected: false,
  isConnecting: false,
  error: null,
  messages: [],
  connect: vi.fn(),
  disconnect: vi.fn(),
  sendText: vi.fn(),
  setMuted: vi.fn(),
}

function Harness({ api = liveAPI }: { api?: typeof liveAPI }) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button ref={buttonRef} onClick={() => setOpen(true)}>Tutor</button>
      <TutorSheet open={open} onOpenChange={setOpen} returnFocusRef={buttonRef}>
        <VoiceHub liveAPI={api} onClose={() => setOpen(false)} />
      </TutorSheet>
    </>
  )
}

describe('TutorSheet', () => {
  it('is closed at first and opens as a labelled dialog containing the VoiceHub', async () => {
    render(<Harness />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByText('Talk to the Professor')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Tutor' }))
    const dialog = await screen.findByRole('dialog', { name: 'Tutor' })
    expect(dialog).toContainElement(screen.getByText('Talk to the Professor'))
    expect(screen.getAllByText('Talk to the Professor')).toHaveLength(1)
  })

  it('moves focus into the sheet and closes with the Close button, returning focus to the button', async () => {
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Tutor' })
    opener.focus()
    fireEvent.click(opener)
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'Close tutor' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it('closes with Escape', async () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Tutor' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('opening and closing never disconnects the tutor', async () => {
    const disconnect = vi.fn()
    render(<Harness api={{ ...liveAPI, isConnected: true, disconnect }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Tutor' }))
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'Close tutor' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('a tap on the area above the sheet closes it and does not reach a control under the backdrop', async () => {
    const underneath = vi.fn()
    function Page() {
      const [open, setOpen] = useState(true)
      return (
        <>
          <button onClick={underneath}>Option under the backdrop</button>
          <TutorSheet open={open} onOpenChange={setOpen}>
            <VoiceHub liveAPI={liveAPI} onClose={() => setOpen(false)} />
          </TutorSheet>
        </>
      )
    }
    render(<Page />)
    await screen.findByRole('dialog')
    const backdrop = document.querySelector('[data-slot="dialog-overlay"]') as HTMLElement
    fireEvent.click(backdrop)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(underneath).not.toHaveBeenCalled()
  })

  it('keeps taps off the page for a moment after closing (the click a touch browser sends late), then lets them through', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const underneath = vi.fn()
      function Page() {
        const [open, setOpen] = useState(true)
        return (
          <>
            <button onClick={underneath}>Option under the backdrop</button>
            <TutorSheet open={open} onOpenChange={setOpen}>
              <VoiceHub liveAPI={liveAPI} onClose={() => setOpen(false)} />
            </TutorSheet>
          </>
        )
      }
      render(<Page />)
      await screen.findByRole('dialog')
      fireEvent.click(screen.getByRole('button', { name: 'Close tutor' }))
      const guard = await screen.findByTestId('tap-guard')
      // a late tap lands on the guard (its handlers consume it); the control under it is not clicked
      fireEvent.click(guard)
      expect(underneath).not.toHaveBeenCalled()
      await act(async () => { vi.advanceTimersByTime(TAP_GUARD_MS + 50) })
      expect(screen.queryByTestId('tap-guard')).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Option under the backdrop' }))
      expect(underneath).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('Escape closes it without disconnecting the tutor', async () => {
    const disconnect = vi.fn()
    render(<Harness api={{ ...liveAPI, isConnected: true, disconnect }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Tutor' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(disconnect).not.toHaveBeenCalled()
  })
})
