import { describe, it, expect } from 'vitest'
import { escapeCurrencyDollars } from './currencyDollars'

describe('escapeCurrencyDollars', () => {
  it.each([
    ['Your answer of $20.00 was incorrect; the correct answer is $12.80.', 'Your answer of \\$20.00 was incorrect; the correct answer is \\$12.80.'],
    ['It costs $5 and $10.', 'It costs \\$5 and \\$10.'],
    ['V = $100. To get there you pay $12.80 at each checkpoint.', 'V = \\$100. To get there you pay \\$12.80 at each checkpoint.'],
    ['a fee of $3, $4 or $5', 'a fee of \\$3, \\$4 or \\$5'],
  ])('escapes literal currency: %s', (input, expected) => {
    expect(escapeCurrencyDollars(input)).toBe(expected)
  })

  it.each([
    '$x^2$',
    '$\\frac{\\sigma}{\\sqrt{n}}$',
    'the mean is $\\mu = 3$ and $n = 16$',
    '$2x + 1$',
    '$1{,}5$',
    '$$E[x] = \\mu$$',
    '\\$5',
  ])('leaves math and escaped dollars unchanged: %s', (input) => {
    expect(escapeCurrencyDollars(input)).toBe(input)
  })

  it('keeps the currency literal and the elasticity as math in a mixed sentence', () => {
    expect(escapeCurrencyDollars('The price is $20 and the elasticity is $\\epsilon = -1.5$.')).toBe(
      'The price is \\$20 and the elasticity is $\\epsilon = -1.5$.',
    )
  })

  it('handles a multi-line text with both literal currency and math', () => {
    const input = 'Revenue is $20.\n\nThe mean is $\\mu = 3$ and $n = 16$.\nCost is $12.80.'
    expect(escapeCurrencyDollars(input)).toBe(
      'Revenue is \\$20.\n\nThe mean is $\\mu = 3$ and $n = 16$.\nCost is \\$12.80.',
    )
  })

  it('does not touch dollars inside inline code', () => {
    expect(escapeCurrencyDollars('use `$5` as the price')).toBe('use `$5` as the price')
  })
})
