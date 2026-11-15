import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { PhoneAccessCard } from './PhoneAccessCard'

const base = {
  state: 'off', url: 'https://my-mac.tail1234.ts.net', qrSvg: null, canToggle: true, reason: null, message: null,
  consentCommand: 'tailscale serve --bg --https=443 localhost:3000', isLocal: true,
}
const fetchMock = vi.fn()
const reply = (body: object, status = 200) => fetchMock.mockResolvedValueOnce({ ok: status < 400, status, json: async () => body })

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const sw = () => screen.getByRole('switch', { name: 'Phone access' })

describe('PhoneAccessCard', () => {
  it('off: shows the pill and an enabled switch', async () => {
    reply(base)
    render(<PhoneAccessCard />)
    await waitFor(() => expect(screen.getByTestId('phone-status')).toHaveTextContent('Off'))
    expect(sw()).toBeEnabled()
    expect(sw()).toHaveAttribute('aria-checked', 'false')
  })

  it('not installed: switch disabled, reason and install hint shown', async () => {
    reply({ ...base, state: 'not_installed', url: null, canToggle: false, reason: 'Tailscale is not installed on this Mac.' })
    render(<PhoneAccessCard />)
    await waitFor(() => expect(screen.getByTestId('phone-status')).toHaveTextContent('Tailscale not installed'))
    expect(sw()).toBeDisabled()
    expect(screen.getByTestId('phone-reason')).toHaveTextContent('not installed')
    expect(screen.getByText(/tailscale\.com\/download/)).toBeInTheDocument()
  })

  it('not running: switch disabled with hint', async () => {
    reply({ ...base, state: 'tailscale_not_running', url: null, canToggle: false, reason: 'Tailscale is not running or not signed in on this Mac.' })
    render(<PhoneAccessCard />)
    await waitFor(() => expect(screen.getByTestId('phone-status')).toHaveTextContent('Tailscale not running'))
    expect(sw()).toBeDisabled()
  })

  it('on: address link, copy button and QR image', async () => {
    reply({ ...base, state: 'on', qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' })
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    render(<PhoneAccessCard />)
    const link = await screen.findByRole('link', { name: base.url })
    expect(link).toHaveAttribute('href', base.url)
    const img = screen.getByRole('img', { name: /QR code/ })
    expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml/)
    expect(sw()).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('button', { name: /Copy address/ }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(base.url))
    expect(await screen.findByText('Copied')).toBeInTheDocument()
  })

  it('from the phone: shows the reason and the switch is disabled', async () => {
    reply({ ...base, state: 'on', canToggle: false, isLocal: false, reason: 'Switching is done on the Mac that runs the app, not from here.' })
    render(<PhoneAccessCard />)
    await waitFor(() => expect(screen.getByTestId('phone-reason')).toHaveTextContent('on the Mac'))
    expect(sw()).toBeDisabled()
  })

  it('switching on posts enabled:true, is busy meanwhile, and shows the new state', async () => {
    reply(base)
    render(<PhoneAccessCard />)
    await waitFor(() => expect(sw()).toBeEnabled())
    let release: (v: unknown) => void = () => {}
    fetchMock.mockReturnValueOnce(new Promise((r) => { release = r }))
    fireEvent.click(sw())
    await waitFor(() => expect(sw()).toBeDisabled())
    expect(fetchMock).toHaveBeenLastCalledWith('/api/phone-access', expect.objectContaining({ method: 'POST', body: JSON.stringify({ enabled: true }) }))
    release({ ok: true, status: 200, json: async () => ({ ...base, state: 'on', ok: true }) })
    await waitFor(() => expect(screen.getByTestId('phone-status')).toHaveTextContent('On'))
  })

  it('consent case shows the exact Terminal command', async () => {
    reply(base)
    render(<PhoneAccessCard />)
    await waitFor(() => expect(sw()).toBeEnabled())
    reply({ ...base, ok: false, needsConsent: true, message: 'Tailscale needs a one-time approval.' })
    fireEvent.click(sw())
    const box = await screen.findByTestId('phone-consent')
    expect(box).toHaveTextContent('tailscale serve --bg --https=443 localhost:3000')
    expect(box).toHaveTextContent('Refresh')
  })

  it('Refresh reloads the status', async () => {
    reply(base)
    render(<PhoneAccessCard />)
    await waitFor(() => expect(sw()).toBeEnabled())
    reply({ ...base, state: 'on' })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh phone access status' }))
    await waitFor(() => expect(screen.getByTestId('phone-status')).toHaveTextContent('On'))
  })

  it('a failed load shows an error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('x'))
    render(<PhoneAccessCard />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not read')
  })
})
