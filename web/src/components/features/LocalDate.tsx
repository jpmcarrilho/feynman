'use client'

import { useSyncExternalStore } from 'react'
import { formatLocal, formatPlaceholder, type DateKind } from '@/lib/formatDate'

const subscribe = () => () => {}
/** false while rendering on the server and during hydration, true afterwards in the browser */
const useIsBrowser = () => useSyncExternalStore(subscribe, () => true, () => false)

/**
 * A date or time in the student's browser locale and time zone. The server (and hydration) show the ISO date, which
 * does not depend on any locale, so the markup always matches; the localized text replaces it right after hydration.
 * The same value therefore reads the same on a fresh load and after client-side navigation.
 */
export function LocalDate({ value, kind = 'date', className }: { value: string | number | Date; kind?: DateKind; className?: string }) {
  const browser = useIsBrowser()
  const iso = new Date(value).toISOString()
  return (
    <time dateTime={iso} className={className}>
      {browser ? formatLocal(value, kind) : formatPlaceholder(value)}
    </time>
  )
}
