import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SetupWizard } from './SetupWizard'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('./SourceDropzone', () => ({ SourceDropzone: () => <div data-testid="dropzone" /> }))
vi.mock('./ProcessingView', () => ({ ProcessingView: () => null }))
vi.mock('./OutlineEditor', () => ({ OutlineEditor: () => null }))
vi.mock('./PersonaCard', () => ({
  PersonaCard: ({ onRenamed }: { onRenamed?: (t: string) => void }) => <button type="button" onClick={() => onRenamed?.('Organic chemistry')}>Pretend split</button>,
}))

describe('SetupWizard', () => {
  it('says which questions of a file are imported (those with a stated answer) on the upload step', () => {
    render(<SetupWizard courseId="c1" title="Chem" initialStep="upload" />)
    expect(screen.getByText(/open questions with a written model answer \(your written answers are then checked against it\)/)).toBeInTheDocument()
    expect(screen.getByText(/imported when the file also states their answer/)).toBeInTheDocument()
  })

  it('shows the new title in the header right after a split, without a reload', () => {
    render(<SetupWizard courseId="c1" title="Chem and history" initialStep="persona" />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Chem and history')
    fireEvent.click(screen.getByRole('button', { name: 'Pretend split' }))
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Organic chemistry')
  })
})
