import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { DiagnosisMarkdown } from './DiagnosisMarkdown'

describe('DiagnosisMarkdown currency vs math', () => {
  it('renders money amounts as literal text, not KaTeX', () => {
    const { container } = render(
      <DiagnosisMarkdown text="Your answer of $20.00 was incorrect; the correct answer is $12.80." />,
    )
    expect(container.querySelector('.katex')).toBeNull()
    expect(container.textContent).toContain('$20.00 was incorrect; the correct answer is $12.80.')
  })

  it('renders valid inline math as KaTeX', () => {
    const { container } = render(<DiagnosisMarkdown text="The mean is $\mu = 3$ and $n = 16$." />)
    expect(container.querySelectorAll('.katex').length).toBe(2)
  })

  it('renders currency and math together in a mixed sentence', () => {
    const { container } = render(
      <DiagnosisMarkdown text={'The price is $20 and the elasticity is $\\epsilon = -1.5$.'} />,
    )
    expect(container.querySelectorAll('.katex').length).toBe(1)
    expect(container.textContent).toContain('The price is $20 and the elasticity is')
  })

  it('keeps an escaped dollar literal', () => {
    const { container } = render(<DiagnosisMarkdown text="It costs \$5." />)
    expect(container.querySelector('.katex')).toBeNull()
    expect(container.textContent).toContain('It costs $5.')
  })
})
