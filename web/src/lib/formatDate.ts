/**
 * The one rule for dates and times the student reads: the browser's own locale and time zone, formatted on the client.
 * Never call these while rendering on the server (its locale is not the student's); use <LocalDate> in components.
 */
const DATE_OPTIONS: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' }
const DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }

export type DateKind = 'date' | 'datetime'

function toDate(value: string | number | Date): Date | null {
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Localized text in the browser's locale and time zone; '' for an invalid date. */
export function formatLocal(value: string | number | Date, kind: DateKind = 'date'): string {
  const d = toDate(value)
  if (!d) return ''
  return d.toLocaleString(undefined, kind === 'date' ? DATE_OPTIONS : DATE_TIME_OPTIONS)
}

/** Locale-free text that is identical on the server and in the browser (ISO date, UTC); what is shown until the browser formats it. */
export function formatPlaceholder(value: string | number | Date): string {
  const d = toDate(value)
  return d ? d.toISOString().slice(0, 10) : ''
}
