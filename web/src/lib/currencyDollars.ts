/**
 * Escapes dollar signs that are money, not math, so remark-math leaves them alone.
 *
 * Single-dollar inline math follows the usual rule: a `$` can open math only if the character after it is not
 * whitespace; it can close math only if the character before it is not whitespace and the character after it is not a
 * digit. A `$` that is not paired with a valid partner is escaped as `\$`. A `$` that can open is superseded by a later
 * opener when no closer comes in between, so `$20 and $\epsilon = -1.5$` keeps `$20` literal and `$\epsilon ...$` as math.
 *
 * Already-escaped `\$`, `$$...$$` display math, and inline code (backtick runs) are passed through unchanged.
 */
export function escapeCurrencyDollars(text: string): string {
  const escape = new Set<number>()
  const n = text.length
  let pending: number | null = null
  let i = 0

  while (i < n) {
    const c = text[i]

    if (c === '\\') {
      i += 2
      continue
    }

    if (c === '`') {
      let run = 1
      while (text[i + run] === '`') run++
      const fence = '`'.repeat(run)
      const close = text.indexOf(fence, i + run)
      i = close === -1 ? i + run : close + run
      continue
    }

    if (c !== '$') {
      i++
      continue
    }

    if (text[i + 1] === '$') {
      if (pending !== null) {
        escape.add(pending)
        pending = null
      }
      const close = text.indexOf('$$', i + 2)
      i = close === -1 ? i + 2 : close + 2
      continue
    }

    const prev = i > 0 ? text[i - 1] : undefined
    const next = i + 1 < n ? text[i + 1] : undefined
    const canOpen = next !== undefined && !/\s/.test(next)
    const canClose = prev !== undefined && !/\s/.test(prev) && !(next !== undefined && /\d/.test(next))

    if (pending !== null && canClose) {
      pending = null
    } else if (canOpen) {
      if (pending !== null) escape.add(pending)
      pending = i
    } else {
      escape.add(i)
    }
    i++
  }

  if (pending !== null) escape.add(pending)
  if (escape.size === 0) return text

  let out = ''
  for (let k = 0; k < n; k++) {
    if (escape.has(k)) out += '\\'
    out += text[k]
  }
  return out
}
