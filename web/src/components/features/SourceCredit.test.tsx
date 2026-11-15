import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SourceCredit } from './SourceCredit'

describe('SourceCredit', () => {
  it('names the course and links its MIT Learn page', () => {
    render(<SourceCredit courseCode="14.740x" origin="imported" />)
    expect(screen.getByTestId('source-credit')).toHaveTextContent('Course material: 14.740x Foundations of Development Policy, MITx (MIT Learn, run 3T2026)')
    expect(screen.getByRole('link', { name: 'Course page' }).getAttribute('href')).toBe('https://courses.learn.mit.edu/learn/course/course-v1:MITxT+14.740x+3T2026')
    expect(screen.queryByText(/written by AI/)).toBeNull()
  })
  it('says when the AI wrote the question', () => {
    render(<SourceCredit courseCode="14.750x" origin="generated" />)
    expect(screen.getByTestId('source-credit')).toHaveTextContent('This question was written by AI from that material.')
  })
  it('renders nothing for an unknown course', () => {
    const { container } = render(<SourceCredit courseCode="x1" origin="imported" />)
    expect(container).toBeEmptyDOMElement()
  })
})
