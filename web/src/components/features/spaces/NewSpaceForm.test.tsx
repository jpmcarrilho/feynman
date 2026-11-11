import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { NewSpaceForm } from './NewSpaceForm'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
const create = vi.fn()
vi.mock('@/app/spaces/actions', () => ({ createStudyspaceAction: (...a: unknown[]) => create(...a) }))

beforeEach(() => vi.clearAllMocks())

describe('NewSpaceForm', () => {
  it('creates the studyspace and opens the upload step', async () => {
    create.mockResolvedValue({ ok: true, id: 'abc' })
    render(<NewSpaceForm />)
    expect(screen.getByRole('button', { name: /create and upload/i })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Test space' } })
    fireEvent.change(screen.getByLabelText(/Goal/), { target: { value: 'Pass' } })
    fireEvent.click(screen.getByRole('button', { name: /create and upload/i }))
    await waitFor(() => expect(push).toHaveBeenCalledWith('/spaces/abc/setup?step=upload'))
    expect(create).toHaveBeenCalledWith({ name: 'Test space', goal: 'Pass' })
  })

  it('shows the reason when the action refuses', async () => {
    create.mockResolvedValue({ ok: false, reason: 'The name can have at most 80 characters.' })
    render(<NewSpaceForm />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: /create and upload/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('at most 80 characters')
    expect(push).not.toHaveBeenCalled()
  })

  it('shows a counter for the name', () => {
    render(<NewSpaceForm />)
    expect(screen.getByTestId('name-count')).toHaveTextContent('0/80')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Abc' } })
    expect(screen.getByTestId('name-count')).toHaveTextContent('3/80')
  })
})
