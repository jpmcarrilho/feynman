// Two repairs for edX exports (the crawler writes the course site's text as it shows it) before a question is accepted:
//   - `Y_{i}(0)`, `post_{t}`: sub/superscripts written with braces and no math delimiters. The renderer shows them as raw text and the
//     validator rejects them (`latex_bare_latex`), so they are put inside `$...$`.
//   - numeric problems: the crawler saves each answer box as a marked option (`- [x] Mean: 25.61`, `- [x] 0.13`). They are read as
//     numeric questions, one per answer box, because a multi-part box cannot be graded as one number.
import { escapeCurrencyDollars } from '@/lib/currencyDollars'

// The spans the renderer already reads as math (display first), and a markdown link target. Matched on text whose money dollars are escaped.
const KEEP = /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|(?<!\\)\$(?:[^$\\]|\\[\s\S])+?(?<!\\)\$|\]\([^)\s]*\)/g

// `Name_{sub}`, `Name^{sup}`, `Name_{sub}^{sup}` with an optional argument list right behind it: `Y_{i}(0)`.
const BRACE_TOKEN = /([A-Za-z][A-Za-z0-9]*)((?:[_^]\{[^{}]*\})+)((?:\((?:[^()]|\([^()]*\))*\))?)/g

const mathName = (name: string) => (name.length > 1 ? `\\text{${name}}` : name)

/** A line made only of such tokens, numbers and symbols: an equation, wrapped as one expression. */
function isEquationLine(line: string): boolean {
  if (!line.includes('=') || !new RegExp(BRACE_TOKEN.source).test(line)) return false
  return !/[A-Za-z]{2,}/.test(line.replace(BRACE_TOKEN, ' '))
}

function fixPlain(segment: string): string {
  // The segment comes from escaped text: put money dollars back
  const plain = segment.replace(/\\\$/g, '$')
  if (!/[_^]\{/.test(plain)) return plain
  return plain
    .split('\n')
    .map((line) => {
      if (!/[_^]\{/.test(line)) return line
      if (isEquationLine(line)) {
        const body = line.trim()
          .replace(BRACE_TOKEN, (_m, n: string, s: string, a: string) => `${mathName(n)}${s}${a}`)
          .replace(/\*/g, '\\cdot ')
        return line.replace(line.trim(), () => `$${body}$`)
      }
      return line.replace(BRACE_TOKEN, (_m, n: string, s: string, a: string) => `$${mathName(n)}${s}${a}$`)
    })
    .join('\n')
}

/** Text with brace sub/superscripts outside math put inside `$...$`; math spans, links and money amounts are left as written. */
export function braceNotationToMath(text: string): string {
  if (!/[_^]\{/.test(text)) return text
  const escaped = escapeCurrencyDollars(text)
  let out = ''
  let last = 0
  for (const m of escaped.matchAll(KEEP)) {
    const at = m.index ?? 0
    out += fixPlain(escaped.slice(last, at)) + m[0]
    last = at + m[0].length
  }
  out += fixPlain(escaped.slice(last))
  return out
}

// ---------------------------------------------------------------------------------------------------------------------

export type NumericPart = { label: string; value: string }

// "Mean: 25.61", "Coefficient = -0.5", "0.13", "12,967", "21%", "$4,110"
const NUMERIC_OPTION = /^(?:(.+?)\s*[:=]\s*)?\$?([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:e[+-]?\d+)?|[+-]?\.\d+)\s*%?$/i

/** Label and plain number of one marked option, or null when it is not a number. A label of one or two characters (a table cell "A") is not a label. */
export function numericOption(option: string): NumericPart | null {
  const m = option.trim().match(NUMERIC_OPTION)
  if (!m) return null
  const label = (m[1] ?? '').trim()
  if (label !== '' && label.length <= 2) return null
  return { label, value: m[2].replace(/,/g, '') }
}

/**
 * The answer boxes of an edX numeric problem: every option is marked correct and every option is a number. Returns null for
 * anything else (a survey with all options marked, a choice question), so those keep their old path.
 */
export function numericParts(choices: string[], markedCorrect: string[]): NumericPart[] | null {
  if (choices.length === 0 || markedCorrect.length !== choices.length) return null
  const parts = choices.map(numericOption)
  if (parts.some((p) => p === null)) return null
  const found = parts as NumericPart[]
  const labels = found.map((p) => p.label)
  if (found.length > 1 && (labels.some((l) => l === '') || new Set(labels).size !== labels.length)) return null
  return found
}

// ---------------------------------------------------------------------------------------------------------------------

const LETTER_PREFIX = /^\(?([a-h])[.)]\s+/i

/** The option text without its list letter ("b. Price of inputs" -> "Price of inputs"). Text without a letter is returned as is. */
export function stripChoiceLetter(option: string): string {
  return option.replace(LETTER_PREFIX, '')
}

/**
 * True when the options carry list letters in order (a, b, c, ...): the course site's own labels. They are removed on import
 * because the card numbers its options itself and shuffles generated ones, so a stored letter would be wrong or doubled.
 */
export function hasLetterPrefixes(choices: string[]): boolean {
  return choices.length >= 2 && choices.every((c, i) => c.trim().match(LETTER_PREFIX)?.[1]?.toLowerCase() === String.fromCharCode(97 + i))
}

// ---------------------------------------------------------------------------------------------------------------------

const HAS_EMBEDDED_FIGURE = /!\[[^\]]*\]\(\s*https?:\/\/[^)]+\)/

// An instruction to work on the course data starts a sentence ("Regress ...", "Run the DD regressions"); a conceptual question that only
// mentions a regression ("if you regress income on education, do you expect b > 0?") is not one.
const SENTENCE_START = '(?:^|[.?!:]\\s+|\\n)\\s*(?:now,?\\s+|next,?\\s+|first,?\\s+)?'
const NEEDS_DATA_PATTERNS: RegExp[] = [
  /\b(?:using|use|load|from|in) the (?:data|dataset|data set|datasets)\b|\b(?:the|this|our) (?:dataset|data set)\b/i,
  /\b(?:Stata|install\.packages|ggplot|geom_\w+)\b|\bin R\b|\bR or Stata\b/,
  new RegExp(`${SENTENCE_START}(?:regress\\b|run (?:an? |the |your )?(?:\\w+[- ])?(?:regressions?|dd|iv)\\b|generate (?:a |the )?(?:dummy|variable)|create a similar table|graph a scatter|load the data)`, 'im'),
  /\bscatter ?plot of the data\b|\bwe can also compute the wald estimate using iv regression\b/i,
  // a statistic computed over the course's country sample
  /\b(?:mean|median|standard deviation|minimum|maximum)\b[^.?!]*\b(?:among|across|of) (?:all|the \d+)[^.?!]*\b(?:countries|richest|poorest|students|pupils|regions)\b/i,
  new RegExp(`${SENTENCE_START}consider only (?:the )?(?:regions|people|students|countries)\\b`, 'im'),
]

/**
 * True when the question can only be answered by running code on a course dataset the app does not hold (a statistic of the
 * country sample, "regress X on Y", "using the data"). A figure or table embedded in the question counts as the data the
 * question needs, so those stay. A numeric key alone does not decide it: pure-arithmetic questions are fine.
 */
export function needsExternalData(questionText: string): boolean {
  if (HAS_EMBEDDED_FIGURE.test(questionText)) return false
  return NEEDS_DATA_PATTERNS.some((p) => p.test(questionText))
}
